import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  BufferAttribute,
} from 'three';
import { MAP_H, MAP_W, MAX_PREVIEW_TILES, TERRAIN_HEIGHT_SCALE, TILE_M } from '@shared/constants';
import { Overlay } from '@shared/enums';
import type { Path } from '@sim/network/pathfinder';
import type { Simulation } from '@sim/simulation';
import { idx } from '@sim/world/tiles';
import { AgentLayer } from './agentLayer';
import { BuildingLayer } from './buildingLayer';
import { CameraRig } from './cameraRig';
import { RoadLayer } from './roadLayer';
import { TerrainMesh } from './terrainMesh';
import { PREVIEW_BAD_COLOR, PREVIEW_OK_COLOR, skyColor, sunIntensity } from './theme';

/**
 * 描画レイヤの統括。
 *
 * ここから sim を書き換えることは一切しない。読むだけ。
 * その一方向性のおかげで、sim は Node 上でも Worker 上でも同じように動く。
 */
export class Renderer {
  readonly scene = new Scene();
  readonly rig: CameraRig;
  private readonly renderer: WebGLRenderer;
  private readonly terrain = new TerrainMesh();
  private readonly roads = new RoadLayer();
  private readonly buildings = new BuildingLayer();
  private readonly agents = new AgentLayer();
  private readonly sun: DirectionalLight;
  private readonly ambient: AmbientLight;

  /** タイル選択のハイライト。 */
  private readonly cursor: Mesh;
  /** ドラッグ中に「これから敷かれる範囲」を光らせるインスタンス群。 */
  private readonly preview: InstancedMesh;
  private readonly previewMat = new Matrix4();
  private readonly previewPos = new Vector3();
  private readonly previewOkColor = new Color(PREVIEW_OK_COLOR);
  private readonly previewBadColor = new Color(PREVIEW_BAD_COLOR);
  /** 経路デバッグ表示用のライン。 */
  private readonly routeLine: Line;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();

  drawCalls = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.rig = new CameraRig(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.rig.attach(canvas);

    this.scene.background = new Color(0x9fc4e0);
    this.scene.fog = new Fog(0x9fc4e0, 900, 3400);

    this.ambient = new AmbientLight(0xffffff, 0.62);
    this.scene.add(this.ambient);
    this.sun = new DirectionalLight(0xfff2e0, 1.05);
    this.sun.position.set(-800, 1400, 600);
    this.scene.add(this.sun);

    this.scene.add(this.terrain.group);
    this.scene.add(this.roads.group);
    this.scene.add(this.buildings.group);
    this.scene.add(this.agents.group);

    // タイルカーソル
    const cursorGeom = new PlaneGeometry(TILE_M, TILE_M);
    cursorGeom.rotateX(-Math.PI / 2);
    this.cursor = new Mesh(
      cursorGeom,
      new MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0.45, depthTest: false }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    // ドラッグ範囲のプレビュー。1 タイル 1 インスタンス。
    const previewGeom = new PlaneGeometry(TILE_M * 0.92, TILE_M * 0.92);
    previewGeom.rotateX(-Math.PI / 2);
    this.preview = new InstancedMesh(
      previewGeom,
      new MeshBasicMaterial({ transparent: true, opacity: 0.5, depthTest: false }),
      MAX_PREVIEW_TILES,
    );
    this.preview.count = 0;
    this.preview.visible = false;
    this.preview.frustumCulled = false;
    this.preview.renderOrder = 9;
    this.scene.add(this.preview);

    // 経路表示
    const routeGeom = new BufferGeometry();
    routeGeom.setAttribute('position', new BufferAttribute(new Float32Array(3 * 4096), 3));
    routeGeom.setDrawRange(0, 0);
    this.routeLine = new Line(routeGeom, new LineBasicMaterial({ color: 0xff3b3b, depthTest: false }));
    this.routeLine.renderOrder = 11;
    this.routeLine.frustumCulled = false;
    this.scene.add(this.routeLine);
  }

  setOverlay(o: Overlay): void {
    this.terrain.setOverlay(o);
    // 情報表示のときは道路の造形を隠す。車道の板がヒートマップを覆ってしまい、
    // 「どの道が混んでいるか」というオーバーレイ本来の役目が果たせなくなる。
    this.roads.setVisible(o === Overlay.None);
  }

  get overlay(): Overlay {
    return this.terrain.currentOverlay;
  }

  /** オーバーレイ値（地価など）が更新されたことを伝える。 */
  invalidateOverlay(): void {
    this.terrain.invalidateAll();
  }

  /** 世界そのものが差し替わった（セーブデータの読み込み）ときに、全部作り直させる。 */
  invalidateAll(): void {
    this.terrain.invalidateAll();
    this.roads.invalidate();
    this.buildings.invalidate();
  }

  /**
   * 画面座標からタイル index を求める。範囲外なら -1。
   *
   * 高さ 0 の平面と交差させるだけでは、斜めから見たときにカーソルが**手前にずれる**。
   * 標高 20m の丘を仰角 40°から見ると、実際に見えている地面と高さ 0 の交点は
   * 20 / tan(40°) ≒ 24m ＝ 2 タイル以上離れる。
   *
   * そこで「今の推定高さの水平面と交差 → その位置の標高を読む」を数回繰り返す。
   * 斜面が視線より急でなければ 2〜3 回で収束する。
   */
  pickTile(clientX: number, clientY: number, canvas: HTMLCanvasElement, world?: { heightDm: Uint16Array }): number {
    const rect = canvas.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    const ray = this.raycaster.ray;
    // 上を向いている視線は地面と交わらない
    if (ray.direction.y > -1e-6) return -1;

    let height = 0;
    let tile = -1;
    for (let iter = 0; iter < 4; iter++) {
      const t = (height - ray.origin.y) / ray.direction.y;
      if (t <= 0) return -1;
      const tx = Math.floor((ray.origin.x + ray.direction.x * t) / TILE_M);
      const ty = Math.floor((ray.origin.z + ray.direction.z * t) / TILE_M);
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return -1;
      const next = idx(tx, ty);
      if (!world) return next;
      const h = world.heightDm[next]! * TERRAIN_HEIGHT_SCALE;
      if (next === tile) return next; // 同じタイルに落ち着いた
      tile = next;
      height = h;
    }
    return tile;
  }

  /**
   * これから敷かれる範囲を光らせる。ドラッグ中に呼ぶ。
   * @param ok タイルごとの可否。false のタイルは赤くする。
   */
  setPreviewTiles(tiles: readonly number[], world: { heightDm: Uint16Array } | null, ok?: readonly boolean[]): void {
    const n = Math.min(tiles.length, MAX_PREVIEW_TILES);
    this.preview.count = n;
    this.preview.visible = n > 0;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const tile = tiles[i]!;
      const x = tile % MAP_W;
      const y = (tile / MAP_W) | 0;
      const h = world ? world.heightDm[tile]! * TERRAIN_HEIGHT_SCALE : 0;
      this.previewPos.set((x + 0.5) * TILE_M, h + 0.35, (y + 0.5) * TILE_M);
      this.previewMat.makeTranslation(this.previewPos.x, this.previewPos.y, this.previewPos.z);
      this.preview.setMatrixAt(i, this.previewMat);
      this.preview.setColorAt(i, ok && ok[i] === false ? this.previewBadColor : this.previewOkColor);
    }
    this.preview.instanceMatrix.needsUpdate = true;
    if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
  }

  /** 選択中のタイルを光らせる。-1 で非表示。 */
  setCursorTile(tile: number, world: { heightDm: Uint16Array } | null): void {
    if (tile < 0) {
      this.cursor.visible = false;
      return;
    }
    const x = tile % MAP_W;
    const y = (tile / MAP_W) | 0;
    const h = world ? world.heightDm[tile]! * TERRAIN_HEIGHT_SCALE : 0;
    this.cursor.position.set((x + 0.5) * TILE_M, h + 0.5, (y + 0.5) * TILE_M);
    this.cursor.visible = true;
  }

  /** 経路をマップ上に赤い線で描く。null で消す。 */
  showRoute(path: Path | null, sim: Simulation): void {
    const geom = this.routeLine.geometry;
    const attr = geom.getAttribute('position') as BufferAttribute;
    if (!path || path.nodes.length < 2) {
      geom.setDrawRange(0, 0);
      return;
    }
    const arr = attr.array as Float32Array;
    const n = Math.min(path.nodes.length, arr.length / 3);
    for (let i = 0; i < n; i++) {
      const node = path.nodes[i]!;
      arr[i * 3] = sim.graph.nodeX[node]!;
      arr[i * 3 + 1] = 3;
      arr[i * 3 + 2] = sim.graph.nodeZ[node]!;
    }
    attr.needsUpdate = true;
    geom.setDrawRange(0, n);
  }

  /**
   * @param tickFraction 直近 tick からの端数 (0..1)。エージェントの補間に使う。
   *   これが無いと、×1 で 0.75 tick/秒しか進まないシミュレーションのカクつきが
   *   そのまま見える（1 秒に 1 コマも動かない）。
   */
  render(sim: Simulation, dt: number, tickFraction = 0): void {
    this.rig.update(dt);

    // 時刻に応じた空と日照
    const frac = sim.clock.dayFraction;
    (this.scene.background as Color).copy(skyColor(frac));
    if (this.scene.fog) (this.scene.fog as Fog).color.copy(skyColor(frac));
    const intensity = sunIntensity(frac);
    this.sun.intensity = intensity;
    this.ambient.intensity = 0.28 + intensity * 0.34;
    // 太陽の位置も時刻で動かす（朝は東、夕は西）
    const sunAngle = (frac - 0.25) * Math.PI * 2;
    this.sun.position.set(
      this.rig.target.x - Math.cos(sunAngle) * 1400,
      Math.max(200, Math.sin(sunAngle) * 1400),
      this.rig.target.z + 500,
    );
    this.sun.target.position.copy(this.rig.target);
    this.sun.target.updateMatrixWorld();

    this.terrain.update(sim);
    this.roads.update(sim);
    this.buildings.update(sim);
    this.buildings.setTimeOfDay(frac);
    this.agents.update(sim, this.rig.target.x, this.rig.target.z, this.rig.distance, tickFraction);

    this.renderer.render(this.scene, this.rig.camera);
    this.drawCalls = this.renderer.info.render.calls;
  }

  resize(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / Math.max(1, h));
  }

  get visibleAgents(): number {
    return this.agents.visiblePedestrians;
  }
  get visibleVehicles(): number {
    return this.agents.visibleVehicles;
  }

  /** 3D 座標へカメラを寄せる。 */
  focusOn(x: number, z: number): void {
    this.rig.lookAtWorld(x, z);
  }

  dispose(): void {
    this.terrain.dispose();
    this.roads.dispose();
    this.buildings.dispose();
    this.agents.dispose();
    // カーソル・プレビュー・経路ラインも自分で捨てる（誰も解放していなかった）。
    for (const o of [this.cursor, this.preview, this.routeLine]) {
      o.geometry.dispose();
      (o.material as { dispose(): void }).dispose();
    }
    this.renderer.dispose();
  }

  /** ワールド座標（m）を返すヘルパ。 */
  static tileToWorld(tile: number): Vector3 {
    return new Vector3(((tile % MAP_W) + 0.5) * TILE_M, 0, (((tile / MAP_W) | 0) + 0.5) * TILE_M);
  }
}
