import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Line,
  LineBasicMaterial,
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
import { MAP_H, MAP_W, TILE_M } from '@shared/constants';
import type { Overlay } from '@shared/enums';
import type { Path } from '@sim/network/pathfinder';
import type { Simulation } from '@sim/simulation';
import { idx } from '@sim/world/tiles';
import { AgentLayer } from './agentLayer';
import { BuildingLayer } from './buildingLayer';
import { CameraRig } from './cameraRig';
import { TerrainMesh } from './terrainMesh';
import { skyColor, sunIntensity } from './theme';

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
  private readonly buildings = new BuildingLayer();
  private readonly agents = new AgentLayer();
  private readonly sun: DirectionalLight;
  private readonly ambient: AmbientLight;

  /** タイル選択のハイライト。 */
  private readonly cursor: Mesh;
  /** 経路デバッグ表示用のライン。 */
  private readonly routeLine: Line;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly groundPlane: Mesh;

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

    // 経路表示
    const routeGeom = new BufferGeometry();
    routeGeom.setAttribute('position', new BufferAttribute(new Float32Array(3 * 4096), 3));
    routeGeom.setDrawRange(0, 0);
    this.routeLine = new Line(routeGeom, new LineBasicMaterial({ color: 0xff3b3b, depthTest: false }));
    this.routeLine.renderOrder = 11;
    this.routeLine.frustumCulled = false;
    this.scene.add(this.routeLine);

    // ピッキング用の不可視平面（地形の凹凸を無視した近似で十分）
    const planeGeom = new PlaneGeometry(MAP_W * TILE_M, MAP_H * TILE_M);
    planeGeom.rotateX(-Math.PI / 2);
    planeGeom.translate((MAP_W * TILE_M) / 2, 0, (MAP_H * TILE_M) / 2);
    this.groundPlane = new Mesh(planeGeom, new MeshBasicMaterial({ visible: false }));
    this.scene.add(this.groundPlane);
  }

  setOverlay(o: Overlay): void {
    this.terrain.setOverlay(o);
  }

  get overlay(): Overlay {
    return this.terrain.currentOverlay;
  }

  /** オーバーレイ値（地価など）が更新されたことを伝える。 */
  invalidateOverlay(): void {
    this.terrain.invalidateAll();
  }

  /** 画面座標からタイル index を求める。範囲外なら -1。 */
  pickTile(clientX: number, clientY: number, canvas: HTMLCanvasElement): number {
    const rect = canvas.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    const hits = this.raycaster.intersectObject(this.groundPlane, false);
    if (hits.length === 0) return -1;
    const p = hits[0]!.point;
    const tx = Math.floor(p.x / TILE_M);
    const ty = Math.floor(p.z / TILE_M);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return -1;
    return idx(tx, ty);
  }

  /** 選択中のタイルを光らせる。-1 で非表示。 */
  setCursorTile(tile: number, world: { heightDm: Uint16Array } | null): void {
    if (tile < 0) {
      this.cursor.visible = false;
      return;
    }
    const x = tile % MAP_W;
    const y = (tile / MAP_W) | 0;
    const h = world ? world.heightDm[tile]! * 0.02 : 0;
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

  render(sim: Simulation, dt: number): void {
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
    this.buildings.update(sim);
    this.agents.update(sim, this.rig.target.x, this.rig.target.z, this.rig.distance);

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
    this.buildings.dispose();
    this.agents.dispose();
    this.renderer.dispose();
  }

  /** ワールド座標（m）を返すヘルパ。 */
  static tileToWorld(tile: number): Vector3 {
    return new Vector3(((tile % MAP_W) + 0.5) * TILE_M, 0, (((tile / MAP_W) | 0) + 0.5) * TILE_M);
  }
}
