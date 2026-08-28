import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  BufferAttribute,
  type Texture,
  type WebGLRenderTarget,
} from 'three';
import { MAP_H, MAP_W, MAX_PREVIEW_TILES, TERRAIN_HEIGHT_SCALE, TILE_M } from '@shared/constants';
import { Overlay } from '@shared/enums';
import type { Path } from '@sim/network/pathfinder';
import type { Simulation } from '@sim/simulation';
import { idx } from '@sim/world/tiles';
import { AgentLayer } from './agentLayer';
import { BuildingLayer } from './buildingLayer';
import { CameraRig } from './cameraRig';
import { NatureLayer } from './natureLayer';
import { RailLayer } from './railLayer';
import { RoadLayer } from './roadLayer';
import { TerrainMesh } from './terrainMesh';
import { PostFx } from './postfx';
import { SkyDome, atmosphereAt, sunDirection, type Atmosphere } from './sky';
import { PREVIEW_BAD_COLOR, PREVIEW_OK_COLOR } from './theme';

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
  private readonly rails = new RailLayer();
  private readonly nature = new NatureLayer();
  private readonly buildings = new BuildingLayer();
  private readonly agents = new AgentLayer();
  private readonly sun: DirectionalLight;
  /** 空と地面からの回り込み。均一な AmbientLight より上下の差が出る。 */
  private readonly hemi: HemisphereLight;
  /** 太陽の反対側から当てる弱い補助光。影の中が真っ黒に潰れるのを防ぐ。 */
  private readonly fill: DirectionalLight;
  private readonly sky = new SkyDome();
  /** 環境マップ（映り込み）を焼くための小さなシーン。空だけが入っている。 */
  private readonly skyScene = new Scene();
  private readonly pmrem: PMREMGenerator;
  private envTarget: WebGLRenderTarget | null = null;
  private envDayFraction = -1;
  private readonly postfx: PostFx;
  private readonly sunDir = new Vector3();
  private atmo: Atmosphere;
  private lastFrameMs = 16;
  /** 起動からの経過秒。雲の流れに使う。 */
  private elapsed = 0;

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
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    // 物理ベースの材質は、線形で計算して最後にトーンマッピングで畳まないと
    // 昼の白壁が全部 1.0 に張り付き、階調が消える。
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // ポストエフェクトのパスも含めた合計を数えたいので、自動リセットを切って
    // フレームの頭で自分でリセットする。
    this.renderer.info.autoReset = false;

    this.rig = new CameraRig(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.rig.attach(canvas);

    // 背景は空ドームが描く。単色の background を残すと手前に出て台無しになる。
    this.scene.background = null;
    this.scene.fog = new Fog(0xcadbe8, 900, 3400);
    this.scene.add(this.sky.mesh);
    this.skyScene.add(this.sky.clone());

    this.atmo = atmosphereAt(0.5);

    this.hemi = new HemisphereLight(0xa6c8ea, 0x7d7663, 0.85);
    this.scene.add(this.hemi);

    this.sun = new DirectionalLight(0xfff6e8, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // 影のアクネ対策。斜面と壁が多いので normalBias を実寸（m）で入れる。
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.9;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.fill = new DirectionalLight(0xbcd0e8, 0.25);
    this.fill.position.set(600, 500, -700);
    this.scene.add(this.fill);

    this.pmrem = new PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    const fx = new URLSearchParams(location.search).get('fx');
    this.postfx = new PostFx(
      this.renderer,
      this.scene,
      this.rig.camera,
      fx === 'off' ? 'off' : fx === 'high' ? 'high' : 'auto',
    );

    this.scene.add(this.terrain.group);
    this.scene.add(this.nature.group);
    this.scene.add(this.roads.group);
    this.scene.add(this.rails.group);
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
    this.rails.setVisible(o === Overlay.None);
    this.nature.setVisible(o === Overlay.None);
  }

  /** いまの時刻の大気（各レイヤが夜の演出に使う）。 */
  get atmosphere(): Atmosphere {
    return this.atmo;
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
    this.rails.invalidate();
    this.nature.invalidate();
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
    const t0 = performance.now();
    this.renderer.info.reset();
    this.rig.update(dt);

    // ---- 時刻から大気・光をまとめて決める ----
    const frac = sim.clock.dayFraction;
    const atmo = atmosphereAt(frac);
    this.atmo = atmo;
    sunDirection(frac, this.sunDir);

    this.elapsed += dt;
    this.sky.update(atmo, this.sunDir, this.rig.camera.position, this.elapsed);

    // 太陽（夜は月）。注視点を基準に置くことで、影の解像度を街の見えている
    // 範囲に集中させる。マップ全体を 1 枚の影マップで覆うと 1 タイルあたり
    // 数ピクセルしか無くなり、影がただのギザギザになる。
    const dist = 1200;
    this.sun.position.set(
      this.rig.target.x + this.sunDir.x * dist,
      this.rig.target.y + this.sunDir.y * dist,
      this.rig.target.z + this.sunDir.z * dist,
    );
    this.sun.target.position.copy(this.rig.target);
    this.sun.target.updateMatrixWorld();
    this.sun.color.copy(atmo.sunColor);
    this.sun.intensity = atmo.sunIntensity;

    // 影の範囲はカメラの引き具合に合わせる。寄っているときは狭く鋭く、
    // 引いているときは広く（そのぶん粗く）。
    const span = Math.max(140, Math.min(1500, this.rig.distance * 1.15));
    const cam = this.sun.shadow.camera;
    if (cam.right !== span) {
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 200;
      cam.far = 2600;
      cam.updateProjectionMatrix();
    }
    // 影が届かないほど引いたら、影自体を切る（描く意味が無いうえに重い）
    this.sun.castShadow = this.rig.distance < 1600 && atmo.sunIntensity > 0.2;

    this.hemi.color.copy(atmo.skyLight);
    this.hemi.groundColor.copy(atmo.groundLight);
    this.hemi.intensity = atmo.ambientIntensity;
    this.fill.color.copy(atmo.skyLight);
    this.fill.intensity = 0.1 + atmo.ambientIntensity * 0.22;
    this.fill.position.set(
      this.rig.target.x - this.sunDir.x * 900,
      this.rig.target.y + 700,
      this.rig.target.z - this.sunDir.z * 900,
    );
    this.renderer.toneMappingExposure = atmo.exposure;

    // 霞は地平線の色に合わせる。カメラが寄っているときに霞ませると
    // 近景の造形が全部白くなるので、距離に応じて開始位置を押し出す。
    if (this.scene.fog) {
      const fog = this.scene.fog as Fog;
      fog.color.copy(atmo.horizon);
      // 霞み始めをカメラ距離の 2 倍より遠くに置く。ここを近くすると、
      // 街区を見下ろしている距離で「見えている街の大半」が霞に沈み、
      // せっかくの造形が白く飛んでしまう。
      // 空気遠近はカメラ距離に比例させる。俯瞰で霞を遠くへ逃がすと、
      // 手前の家と 3km 先の家が同じ濃さで描かれ、街が一枚の平面に見える。
      // 近景では霞に沈む物が視界にほとんど入らないので、下限だけ置けばよい。
      fog.near = Math.max(180, this.rig.distance * 0.5);
      fog.far = Math.max(1400, this.rig.distance * 5.5);
    }

    this.updateEnvironment(frac);

    this.terrain.update(sim);
    this.nature.update(sim);
    this.applyShadowFlags();
    this.roads.update(sim);
    this.rails.update(sim);
    this.buildings.update(sim);
    this.buildings.setTimeOfDay(frac);
    this.agents.setTimeOfDay(frac);
    this.agents.update(sim, this.rig.target.x, this.rig.target.z, this.rig.distance, tickFraction);

    // 朝は青、夕は橙に少しだけ寄せる
    const h = frac * 24;
    const warmth = h > 15 && h < 20 ? 0.9 : h > 5 && h < 8 ? -0.55 : h < 5 || h >= 20 ? -0.7 : 0.1;
    this.postfx.setMood(atmo.nightAmount, warmth);
    this.postfx.render(this.scene, this.rig.camera, this.lastFrameMs);

    this.drawCalls = this.renderer.info.render.calls;
    this.lastFrameMs = this.lastFrameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  /**
   * 影の落とし方をレイヤ全体に行き渡らせる。
   *
   * 各レイヤはメッシュを遅延生成する（建物の形が増えたときなど）ので、
   * 生成時に付け忘れると「一部の建物だけ影が出ない」ことになる。
   * 数百オブジェクトの走査は 1 フレームの予算からすれば無視できるので、
   * ここで毎フレーム押さえておく。
   */
  private applyShadowFlags(): void {
    for (const layer of [this.buildings.group, this.nature.group, this.rails.group, this.agents.group]) {
      layer.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
      });
    }
    // 道路は地面に貼り付いた薄板。影を落とさせると自分の厚みで縞が出る。
    this.roads.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = true;
    });
  }

  /**
   * 空の映り込み（環境マップ）を焼き直す。
   *
   * ガラスや車体は、映り込むものが無いと「灰色のプラスチック」にしか見えない。
   * 空を 1 枚焼いて全材質に配るだけで、金属とガラスがそれらしくなる。
   * 焼き直しは安くないので、時刻がある程度動いたときだけにする。
   */
  private updateEnvironment(dayFraction: number): void {
    if (this.envDayFraction >= 0 && Math.abs(dayFraction - this.envDayFraction) < 0.006) return;
    this.envDayFraction = dayFraction;
    const prev = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.skyScene, 0, 0.1, 100);
    this.scene.environment = this.envTarget.texture as Texture;
    // 環境マップは映り込み専用。背景としては空ドームが描く。
    this.scene.environmentIntensity = 1;
    prev?.dispose();
  }

  resize(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / Math.max(1, h));
    const dpr = this.renderer.getPixelRatio();
    this.postfx.setSize(w * dpr, h * dpr);
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
    this.nature.dispose();
    this.roads.dispose();
    this.rails.dispose();
    this.buildings.dispose();
    this.agents.dispose();
    this.sky.dispose();
    this.postfx.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
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
