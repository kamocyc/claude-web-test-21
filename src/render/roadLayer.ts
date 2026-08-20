import {
  BoxGeometry,
  Color,
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import { OneWay, RoadClass, Zone } from '@shared/enums';
import type { Simulation } from '@sim/simulation';
import { neighbor, tileX, tileY } from '@sim/world/tiles';
import { ROAD_COLORS } from './theme';

/**
 * 道路の造形。
 *
 * 以前の道路は「地形メッシュのタイルに色を塗っただけ」で、幅も歩道も路面標示も
 * 無かった。実寸で描いている車と人がその上を走っているのに、道の側だけが
 * 平らな色面だったので、近景に寄るほど嘘くさくなる。
 *
 * ここでは道路タイルの上に薄い板を重ねて、車道・歩道・センターライン・
 * 停止線・横断歩道を置く。地形メッシュの色はそのまま残してあるので、
 * 情報表示（ヒートマップ）に切り替えたときはこのレイヤを丸ごと隠せば
 * 元の見え方に戻る。
 *
 * 更新は「道路のエポックが変わったとき」だけ。毎フレーム数千タイルを
 * 走査すると、それだけでフレーム予算を使い切る（建物レイヤと同じ方針）。
 */

/** 車道の半幅（描画単位）。車は ±LANE_OFFSET_M(2.2) を走るので、それを含む幅にする。 */
const CARRIAGEWAY_HALF: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 2.9,
  [RoadClass.Avenue]: 3.3,
  [RoadClass.Boulevard]: 3.8,
};
/** 歩道の外縁。歩行者は ±3.4〜4.8 を歩くので、そこを覆う。 */
const WALKWAY_OUTER = 4.9;

/** 重ね順。数 cm ずつ持ち上げて Z ファイティングを避ける。 */
const Y_ASPHALT = 0.2;
const Y_MARKING = 0.27;
const Y_WALKWAY = 0.33;

const ASPHALT_TINT = 0.86;
const WALKWAY_COLOR = 0xb9b6ad;
const MARKING_COLOR = 0xe8e6de;

/** 標示の最大数。1 タイルあたり最大でも 20 個ほどなので、道路 1 万タイルでも収まる。 */
const MAX_MARKINGS = 60_000;
const MAX_WALKWAYS = 24_000;

/** 交差点とみなす接続本数。信号もこの次数で立つ（traffic.ts の SIGNAL_MIN_DEGREE と同じ考え方）。 */
const JUNCTION_DEGREE = 3;

/** 街路樹と電柱。日本の街路は、この 2 つが並んでいるかどうかで印象が決まる。 */
const MAX_TREES = 16_000;
const MAX_POLES = 12_000;
const TRUNK_COLOR = 0x6b5540;
const LEAF_COLOR = 0x4f8f4a;
const POLE_COLOR = 0x9a978f;

export class RoadLayer {
  readonly group = new Object3D();
  private asphalt: InstancedMesh;
  private walkway: InstancedMesh;
  private marking: InstancedMesh;
  private trunk: InstancedMesh;
  private leaf: InstancedMesh;
  private pole: InstancedMesh;
  private readonly materials: MeshLambertMaterial[] = [];
  private lastEpoch = -1;
  private capacity = 0;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();

  constructor() {
    this.group.name = 'roads';
    this.asphalt = this.makeMesh(1);
    this.walkway = this.makeMesh(MAX_WALKWAYS, WALKWAY_COLOR);
    this.marking = this.makeMesh(MAX_MARKINGS, MARKING_COLOR);
    this.trunk = this.makeProp(new BoxGeometry(0.34, 1, 0.34), MAX_TREES, TRUNK_COLOR);
    this.leaf = this.makeProp(new ConeGeometry(1, 1, 6), MAX_TREES, LEAF_COLOR);
    this.pole = this.makeProp(new BoxGeometry(0.28, 1, 0.28), MAX_POLES, POLE_COLOR);
  }

  /** 立体の小物（街路樹・電柱）。底面を y=0 に合わせた単位の高さで持つ。 */
  private makeProp(geom: BoxGeometry | ConeGeometry, count: number, color: number): InstancedMesh {
    geom.translate(0, 0.5, 0);
    const material = new MeshLambertMaterial({ color });
    this.materials.push(material);
    const mesh = new InstancedMesh(geom, material, count);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * 単位平面（1×1、XZ 平面、原点中心）のインスタンス群を作る。
   * 大きさは行列のスケールで決めるので、ジオメトリは 1 種類で足りる。
   */
  private makeMesh(count: number, color?: number): InstancedMesh {
    const geom = new PlaneGeometry(1, 1);
    geom.rotateX(-Math.PI / 2);
    // 建物レイヤと同じ理由で vertexColors は付けない（instanceColor だけを使う）。
    const material = new MeshLambertMaterial(color === undefined ? {} : { color });
    this.materials.push(material);
    const mesh = new InstancedMesh(geom, material, count);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  /** 情報表示に切り替えたときは隠す。地形の色（ヒートマップ）をそのまま見せるため。 */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** セーブデータを読み込んだときのように、エポックが「進まずに変わる」場合に使う。 */
  invalidate(): void {
    this.lastEpoch = -1;
  }

  update(sim: Simulation): void {
    if (sim.world.epochs.roads === this.lastEpoch) return;
    this.lastEpoch = sim.world.epochs.roads;

    const world = sim.world;
    let roads = 0;
    for (let i = 0; i < TILE_COUNT; i++) if (world.road[i] !== RoadClass.None) roads++;
    if (roads > this.capacity) {
      this.capacity = Math.max(1024, roads * 2);
      this.group.remove(this.asphalt);
      this.asphalt.geometry.dispose();
      this.asphalt.dispose();
      this.asphalt = this.makeMesh(this.capacity);
    }

    let a = 0;
    let w = 0;
    let m = 0;
    let tree = 0;
    let pole = 0;

    for (let i = 0; i < TILE_COUNT; i++) {
      const cls = world.road[i]!;
      if (cls === RoadClass.None) continue;
      const x = tileX(i);
      const y = tileY(i);
      const cx = (x + 0.5) * TILE_M;
      const cz = (y + 0.5) * TILE_M;
      const gy = world.heightDm[i]! * TERRAIN_HEIGHT_SCALE;
      const conn = world.roadConn(i);
      const half = CARRIAGEWAY_HALF[cls]!;

      // --- 車道 ---
      // タイル全面に敷く。交差点や曲がり角でも隙間ができないのが利点で、
      // 幅の違いは歩道の内側の位置で表現する。
      this.place(this.asphalt, a, cx, gy + Y_ASPHALT, cz, TILE_M, TILE_M, 0);
      this.color.setHex(ROAD_COLORS[cls]!);
      this.color.multiplyScalar(ASPHALT_TINT);
      this.asphalt.setColorAt(a, this.color);
      a++;

      // --- 歩道 ---
      // 「隣に道路が無い向き」の辺に置く。直進タイルなら左右の 2 辺、
      // 十字路なら 0 辺（横断部）、曲がり角なら外側の 2 辺になり、
      // 特別扱いを 1 つも書かずに正しい形が出る。
      for (let d = 0; d < 4; d++) {
        if (conn & (1 << d)) continue;
        if (w >= MAX_WALKWAYS) break;
        const width = WALKWAY_OUTER - half;
        const mid = (WALKWAY_OUTER + half) / 2;
        // d: 0=北, 1=東, 2=南, 3=西
        const ox = d === 1 ? mid : d === 3 ? -mid : 0;
        const oz = d === 2 ? mid : d === 0 ? -mid : 0;
        const along = TILE_M;
        const sx = d === 1 || d === 3 ? width : along;
        const sz = d === 1 || d === 3 ? along : width;
        this.place(this.walkway, w, cx + ox, gy + Y_WALKWAY, cz + oz, sx, sz, 0);
        w++;

        // 街路樹。市街地の歩道にだけ、間を空けて植える。
        // 全部のタイルに植えると並木というより生垣になり、
        // 田畑の間の農道にまで街路樹が並んで日本の風景から外れる。
        const facing = neighbor(i, d);
        const z = facing >= 0 ? world.zone[facing]! : Zone.None;
        const dense =
          z === Zone.ResidentialMid ||
          z === Zone.CommercialLocal ||
          z === Zone.CommercialCentral ||
          z === Zone.Park;
        // 低層住宅地は庭木が主役で街路樹はまばら。ここを密にすると郊外が並木道になる。
        const sparse = z === Zone.ResidentialLow;
        const h = ((i * 2654435761) >>> 0) + d;
        const period = dense ? 3 : sparse ? 7 : 0;
        if (period > 0 && tree < MAX_TREES && h % period === 0) {
          const tx = cx + ox;
          const tz = cz + oz;
          const size = 2.6 + ((h >>> 5) % 7) * 0.22;
          this.placeProp(this.trunk, tree, tx, gy, tz, 1, size * 0.6);
          this.placeProp(this.leaf, tree, tx, gy + size * 0.5, tz, size * 0.42, size * 0.8);
          tree++;
        }
        // 電柱。日本の街路の見た目を決めているのは、実のところこれ。
        if (pole < MAX_POLES && h % 7 === 2) {
          this.placeProp(this.pole, pole, cx + ox * 1.02, gy, cz + oz * 1.02, 1, 7.5);
          pole++;
        }
      }

      // --- センターライン ---
      // 直進タイル（対向する 2 方向だけが繋がっている）にだけ引く。
      // 交差点に引くと標示が団子になって、かえって道の形が読めなくなる。
      const straightNS = conn === 0b0101;
      const straightEW = conn === 0b1010;
      if ((straightNS || straightEW) && m + 2 < MAX_MARKINGS) {
        const lineW = cls === RoadClass.Boulevard ? 0.5 : 0.22;
        if (cls === RoadClass.Street) {
          // 生活道路は破線。1 タイルに 2 本置くと、走っていて流れて見える。
          for (let k = 0; k < 2; k++) {
            const off = (k - 0.5) * (TILE_M / 2);
            const px = straightEW ? cx + off : cx;
            const pz = straightEW ? cz : cz + off;
            const sx = straightEW ? TILE_M * 0.34 : lineW;
            const sz = straightEW ? lineW : TILE_M * 0.34;
            this.place(this.marking, m, px, gy + Y_MARKING, pz, sx, sz, 0);
            m++;
          }
        } else {
          const sx = straightEW ? TILE_M : lineW;
          const sz = straightEW ? lineW : TILE_M;
          this.place(this.marking, m, cx, gy + Y_MARKING, cz, sx, sz, 0);
          m++;
        }
      }

      // --- 一方通行の矢印 ---
      // 進める向きに矢じりを置く。標示が無いと、一方通行にしたことが
      // 地図の上で一切分からない（車が来なくなった理由が読めない）。
      const ow = world.oneWay[i]!;
      if (ow !== OneWay.None && m + 3 < MAX_MARKINGS) {
        const ax = ow === OneWay.East ? 1 : ow === OneWay.West ? -1 : 0;
        const az = ow === OneWay.South ? 1 : ow === OneWay.North ? -1 : 0;
        // 軸（細長い板）＋ 矢じり（先端を細くするために 2 枚重ねる）
        this.place(this.marking, m, cx, gy + Y_MARKING, cz, ax !== 0 ? 4.4 : 0.5, az !== 0 ? 4.4 : 0.5, 0);
        m++;
        for (let k = 0; k < 2; k++) {
          const back = 0.7 + k * 0.7;
          const wide = 2.2 - k * 1.0;
          this.place(
            this.marking,
            m,
            cx + ax * (2.2 - back),
            gy + Y_MARKING,
            cz + az * (2.2 - back),
            ax !== 0 ? 0.6 : wide,
            az !== 0 ? 0.6 : wide,
            0,
          );
          m++;
        }
      }

      // --- 横断歩道と停止線 ---
      // 信号のある交差点（次数 3 以上）の各流入部に置く。
      if (world.roadDegree(i) >= JUNCTION_DEGREE) {
        for (let d = 0; d < 4; d++) {
          if (!(conn & (1 << d))) continue;
          if (m + 8 >= MAX_MARKINGS) break;
          const edge = TILE_M / 2 - 1.1;
          const ex = d === 1 ? edge : d === 3 ? -edge : 0;
          const ez = d === 2 ? edge : d === 0 ? -edge : 0;
          // 縞は歩行者の進む向きに対して直角 = 道路の向きに沿って伸びる。
          const alongRoad = d === 0 || d === 2;
          for (let k = -2; k <= 2; k++) {
            const spread = k * 1.35;
            const px = cx + ex + (alongRoad ? spread : 0);
            const pz = cz + ez + (alongRoad ? 0 : spread);
            const sx = alongRoad ? 0.62 : 1.9;
            const sz = alongRoad ? 1.9 : 0.62;
            this.place(this.marking, m, px, gy + Y_MARKING, pz, sx, sz, 0);
            m++;
          }
        }
      }
    }

    this.asphalt.count = a;
    this.walkway.count = w;
    this.marking.count = m;
    this.trunk.count = tree;
    this.leaf.count = tree;
    this.pole.count = pole;
    for (const mesh of [this.asphalt, this.walkway, this.marking, this.trunk, this.leaf, this.pole]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** 小物を置く。`radius` は水平方向の倍率、`height` は高さ。 */
  private placeProp(
    mesh: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(radius, height, radius);
    this.quat.identity();
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  private place(
    mesh: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sz: number,
    rotY: number,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(sx, 1, sz);
    this.quat.setFromAxisAngle(this.axisY, rotY);
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  dispose(): void {
    for (const mesh of [this.asphalt, this.walkway, this.marking, this.trunk, this.leaf, this.pole]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
  }
}
