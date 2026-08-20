import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import type { Simulation } from '@sim/simulation';
import { tileX, tileY } from '@sim/world/tiles';

/**
 * 線路の造形。
 *
 * これまで線路は「地形メッシュのタイルを茶色に塗っただけ」だった。
 * 実寸で描いた 3 両編成がその上を走っているのに、下に軌道が無いので、
 * 電車が茶色い帯の上を滑っているように見えていた。
 *
 * 道路レイヤと同じ作りにする。すなわち **線路のエポックが変わったときだけ**
 * 走査し、部品ごとに 1 つの InstancedMesh に詰める。
 * 毎フレーム 10 万タイルを走査するようなことはしない。
 *
 * 部品は下から順に、盛土とバラスト・枕木・レール 2 本、そして架線柱。
 * 踏切のタイルだけはバラストの代わりに踏切板を敷く
 * （道路レイヤがアスファルトを全面に敷いているので、そこに砂利が乗ると
 * 道の真ん中に土手ができてしまう）。
 */

/** レール面の高さ (m)。電車の台車をここに載せる（agentLayer の RAIL_TOP_M と対）。 */
export const RAIL_TOP_M = 0.55;

const BALLAST_H = 0.3;
/** 斜面でバラストが地面から浮かないよう、下へ埋める深さ (m)。 */
const BALLAST_SINK = 0.25;
const SLEEPER_H = 0.12;
const RAIL_H = RAIL_TOP_M - BALLAST_H - SLEEPER_H;

/** バラストの幅 (m)。単線ぶん。 */
const BALLAST_W = 4.6;
/** 軌間の半分 (m)。狭軌 1067mm。 */
const GAUGE_HALF = 0.54;
/** 枕木の間隔 (m)。実物は 0.6m 間隔だが、それだと 1 タイルに 16 本並んで潰れる。 */
const SLEEPER_PITCH = 1.25;
const SLEEPER_LEN = 2.4;
const SLEEPER_THICK = 0.5;
const RAIL_W = 0.18;

const BALLAST_COLOR = 0x93887b;
const SLEEPER_COLOR = 0x554639;
const RAIL_COLOR = 0xc3bbae;
const DECK_COLOR = 0x8e8880;
const POLE_COLOR = 0x8f9298;
const CROSSING_POST_COLOR = 0xe6e6e2;

/** 架線柱。高さと、線路中心からの張り出し。 */
const POLE_H = 6.2;
const POLE_SIDE = 3.3;
/** 架線柱を立てる間隔（タイルのハッシュの周期）。 */
const POLE_PERIOD = 2;

const MAX_BALLAST = 24_000;
const MAX_SLEEPERS = 60_000;
const MAX_RAILS = 40_000;
const MAX_POLES = 8_000;
const MAX_CROSSING = 4_000;

export class RailLayer {
  readonly group = new Object3D();
  private readonly ballast: InstancedMesh;
  private readonly sleeper: InstancedMesh;
  private readonly rail: InstancedMesh;
  private readonly pole: InstancedMesh;
  private readonly post: InstancedMesh;
  private readonly meshes: InstancedMesh[] = [];
  private readonly materials: MeshLambertMaterial[] = [];

  private lastRailEpoch = -1;
  private lastRoadEpoch = -1;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly color = new Color();

  constructor() {
    this.group.name = 'rails';
    // バラストだけは踏切で色が変わるので instanceColor を使う。他は単色。
    this.ballast = this.makeMesh(MAX_BALLAST);
    this.sleeper = this.makeMesh(MAX_SLEEPERS, SLEEPER_COLOR);
    this.rail = this.makeMesh(MAX_RAILS, RAIL_COLOR);
    this.pole = this.makeMesh(MAX_POLES, POLE_COLOR);
    this.post = this.makeMesh(MAX_CROSSING, CROSSING_POST_COLOR);
  }

  /** 単位の箱（1×1×1、底面 y=0）。大きさは行列のスケールで決める。 */
  private makeMesh(count: number, color?: number): InstancedMesh {
    const geom = new BoxGeometry(1, 1, 1);
    geom.translate(0, 0.5, 0);
    // 建物レイヤと同じ理由で vertexColors は付けない（instanceColor だけを使う）。
    const material = new MeshLambertMaterial(color === undefined ? {} : { color });
    this.materials.push(material);
    const mesh = new InstancedMesh(geom, material, count);
    mesh.count = 0;
    // 線路は街から離れた場所に伸びていることが多いので、視錐台カリングを効かせる。
    // 更新のたびに境界球を計算し直している（update の末尾）。
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  /** 情報表示のときは隠す（道路レイヤと同じ理由）。 */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  invalidate(): void {
    this.lastRailEpoch = -1;
  }

  update(sim: Simulation): void {
    const world = sim.world;
    // 踏切は道路の有無でも変わるので、道路のエポックも見る。
    if (world.epochs.rail === this.lastRailEpoch && world.epochs.roads === this.lastRoadEpoch) return;
    this.lastRailEpoch = world.epochs.rail;
    this.lastRoadEpoch = world.epochs.roads;

    let bed = 0;
    let tie = 0;
    let steel = 0;
    let poles = 0;
    let posts = 0;

    for (let i = 0; i < TILE_COUNT; i++) {
      if (world.rail[i] === 0) continue;
      const cx = (tileX(i) + 0.5) * TILE_M;
      const cz = (tileY(i) + 0.5) * TILE_M;
      const gy = world.heightDm[i]! * TERRAIN_HEIGHT_SCALE;
      const conn = world.railConn(i);
      const crossing = world.isLevelCrossing(i);

      // 隣に線路がある向きごとに、中心から辺までの半区間を敷く。
      // こうすると曲がり角も分岐も、特別扱いを書かずに正しい形が出る。
      // 孤立したタイル（敷きかけ）は南北に 1 本通しておく。
      const dirs = conn === 0 ? 0b0101 : conn;
      for (let d = 0; d < 4; d++) {
        if (!(dirs & (1 << d))) continue;
        const alongZ = d === 0 || d === 2;
        const sign = d === 1 || d === 2 ? 1 : -1;
        const half = TILE_M / 2;
        // 中心側を少し伸ばして重ねる。伸ばさないと、交差点の真ん中に十字の隙間が空く。
        const len = half + 0.4;
        const mid = (sign * (half - 0.4)) / 2;
        const ox = alongZ ? 0 : mid;
        const oz = alongZ ? mid : 0;

        if (bed < MAX_BALLAST) {
          // 踏切はバラストではなく踏切板。高さも道路の高さまで下げる。
          // 斜面で地面から浮かないよう、少し埋めてから上へ伸ばす。
          const h = (crossing ? BALLAST_H + SLEEPER_H : BALLAST_H) + BALLAST_SINK;
          this.box(
            this.ballast,
            bed,
            cx + ox,
            gy - BALLAST_SINK,
            cz + oz,
            alongZ ? BALLAST_W : len,
            h,
            alongZ ? len : BALLAST_W,
          );
          this.ballast.setColorAt(bed, this.color.setHex(crossing ? DECK_COLOR : BALLAST_COLOR));
          bed++;
        }

        // 枕木。踏切では板の下に隠れるので置かない。
        if (!crossing) {
          const n = Math.floor(half / SLEEPER_PITCH);
          for (let k = 0; k < n && tie < MAX_SLEEPERS; k++) {
            const along = sign * (k + 0.5) * SLEEPER_PITCH;
            this.box(
              this.sleeper,
              tie,
              cx + (alongZ ? 0 : along),
              gy + BALLAST_H,
              cz + (alongZ ? along : 0),
              alongZ ? SLEEPER_LEN : SLEEPER_THICK,
              SLEEPER_H,
              alongZ ? SLEEPER_THICK : SLEEPER_LEN,
            );
            tie++;
          }
        }

        // レール 2 本。
        for (let s = -1; s <= 1; s += 2) {
          if (steel >= MAX_RAILS) break;
          this.box(
            this.rail,
            steel,
            cx + ox + (alongZ ? s * GAUGE_HALF : 0),
            gy + BALLAST_H + SLEEPER_H,
            cz + oz + (alongZ ? 0 : s * GAUGE_HALF),
            alongZ ? RAIL_W : len,
            RAIL_H,
            alongZ ? len : RAIL_W,
          );
          steel++;
        }
      }

      // --- 架線柱 ---
      // 直線区間にだけ、間を空けて立てる。日本の鉄道風景はこれで決まる。
      const straightNS = conn === 0b0101;
      const straightEW = conn === 0b1010;
      const h = (i * 2654435761) >>> 0;
      if ((straightNS || straightEW) && !crossing && h % POLE_PERIOD === 0 && poles + 1 < MAX_POLES) {
        const side = h & 0x10000 ? 1 : -1;
        const px = cx + (straightNS ? side * POLE_SIDE : 0);
        const pz = cz + (straightNS ? 0 : side * POLE_SIDE);
        this.box(this.pole, poles, px, gy, pz, 0.3, POLE_H, 0.3);
        poles++;
        // ビーム（線路の上に張り出す腕）。これが無いとただの棒に見える。
        this.box(
          this.pole,
          poles,
          px - (straightNS ? (side * POLE_SIDE) / 2 : 0),
          gy + POLE_H - 0.45,
          pz - (straightNS ? 0 : (side * POLE_SIDE) / 2),
          straightNS ? POLE_SIDE : 0.18,
          0.22,
          straightNS ? 0.18 : POLE_SIDE,
        );
        poles++;
      }

      // --- 踏切の警報機 ---
      if (crossing && posts + 4 <= MAX_CROSSING) {
        for (let k = 0; k < 4; k++) {
          const sx = k & 1 ? 1 : -1;
          const sz = k & 2 ? 1 : -1;
          this.box(this.post, posts, cx + sx * 3.4, gy + 0.35, cz + sz * 3.4, 0.24, 2.6, 0.24);
          posts++;
        }
      }
    }

    this.ballast.count = bed;
    this.sleeper.count = tie;
    this.rail.count = steel;
    this.pole.count = poles;
    this.post.count = posts;
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private box(
    mesh: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(sx, sy, sz);
    this.quat.identity();
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
  }
}
