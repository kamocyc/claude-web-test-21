import { CORNER_RADIUS_M } from '@shared/constants';
import type { Graph } from './graph';

/**
 * ノード列（折れ線）の上の 1 点を、角を丸めた曲線として返す。**描画専用**。
 *
 * 道路も線路もタイルの中心を直線で結んだ折れ線なので、そのまま置くと
 * 交差点や分岐に 90 度の角が立つ。車や電車はそこを 1 フレームで曲がり、
 * 向きも瞬間的に入れ替わる。
 *
 * 角の前後 `CORNER_RADIUS_M` を 2 次ベジエ 1 本に差し替えると、位置も接線も
 * 途切れなくつながる。制御点が角のノードそのものなので、直進のときは
 * 3 点が等間隔に並んで元の直線に戻る（分岐を書かなくていい）。
 *
 * 半径は隣り合う 2 本の短い方の 45% で頭打ちにする。連続した角で
 * フィレット同士が食い合わないようにするため。上限は呼び出し側が渡す
 * （道路は停止線に合わせて小さい ―― `ROAD_CORNER_RADIUS_M`）。
 */

/** 折れ線上の 1 点の姿勢（描画単位）。 */
export interface CurvePose {
  x: number;
  z: number;
  /** three.js の Y 軸回転に直接渡せる向き。 */
  heading: number;
}

/** ノード列の k 本目の区間の長さ（描画単位）。 */
export function segmentLength(graph: Graph, nodes: ArrayLike<number>, k: number): number {
  const a = nodes[k]!;
  const b = nodes[k + 1]!;
  return Math.hypot(graph.nodeX[b]! - graph.nodeX[a]!, graph.nodeZ[b]! - graph.nodeZ[a]!);
}

/**
 * @param count nodes の有効な長さ（区間は count - 1 本）
 * @param i     何本目の区間か
 * @param d     その区間の始点からの距離（描画単位）
 * @param maxRadius 角を丸める半径の上限。道路と線路で違う（`ROAD_CORNER_RADIUS_M`）。
 */
export function curvePointOnNodes(
  graph: Graph,
  nodes: ArrayLike<number>,
  count: number,
  i: number,
  d: number,
  out: CurvePose,
  maxRadius = CORNER_RADIUS_M,
): void {
  const lastSeg = count - 2;
  const len = segmentLength(graph, nodes, i);
  const a = nodes[i]!;
  const b = nodes[i + 1]!;
  const ax = graph.nodeX[a]!;
  const az = graph.nodeZ[a]!;
  const bx = graph.nodeX[b]!;
  const bz = graph.nodeZ[b]!;
  if (len <= 0) {
    out.x = ax;
    out.z = az;
    out.heading = Math.atan2(bx - ax, bz - az);
    return;
  }
  const at = Math.max(0, Math.min(len, d));
  const dx = (bx - ax) / len;
  const dz = (bz - az) / len;

  // 始点側・終点側それぞれのフィレット半径。線の端のノードには角が無いので 0。
  const radius = (k: number): number =>
    Math.min(maxRadius, segmentLength(graph, nodes, k) * 0.45, segmentLength(graph, nodes, k + 1) * 0.45);
  const rs = i > 0 ? radius(i - 1) : 0;
  const re = i < lastSeg ? radius(i) : 0;

  // 2 次ベジエの 3 点。v = 角のノード、p → q が丸める区間。
  let vx: number;
  let vz: number;
  let px: number;
  let pz: number;
  let qx: number;
  let qz: number;
  let t: number;
  if (at < rs) {
    // 始点ノードの角の後半（前の区間から入ってきた続き）。
    const prev = nodes[i - 1]!;
    const pl = segmentLength(graph, nodes, i - 1);
    const pdx = pl > 0 ? (ax - graph.nodeX[prev]!) / pl : dx;
    const pdz = pl > 0 ? (az - graph.nodeZ[prev]!) / pl : dz;
    vx = ax;
    vz = az;
    px = ax - pdx * rs;
    pz = az - pdz * rs;
    qx = ax + dx * rs;
    qz = az + dz * rs;
    t = 0.5 + at / (2 * rs);
  } else if (at > len - re) {
    // 終点ノードの角の前半。
    const nxt = nodes[i + 2]!;
    const nl = segmentLength(graph, nodes, i + 1);
    const ndx = nl > 0 ? (graph.nodeX[nxt]! - bx) / nl : dx;
    const ndz = nl > 0 ? (graph.nodeZ[nxt]! - bz) / nl : dz;
    vx = bx;
    vz = bz;
    px = bx - dx * re;
    pz = bz - dz * re;
    qx = bx + ndx * re;
    qz = bz + ndz * re;
    t = (at - (len - re)) / (2 * re);
  } else {
    out.x = ax + dx * at;
    out.z = az + dz * at;
    out.heading = Math.atan2(dx, dz);
    return;
  }

  const u = 1 - t;
  out.x = u * u * px + 2 * u * t * vx + t * t * qx;
  out.z = u * u * pz + 2 * u * t * vz + t * t * qz;
  // 接線 = ベジエの微分。曲がっている最中の向きはここから出る。
  const tx = 2 * u * (vx - px) + 2 * t * (qx - vx);
  const tz = 2 * u * (vz - pz) + 2 * t * (qz - vz);
  out.heading = tx === 0 && tz === 0 ? Math.atan2(dx, dz) : Math.atan2(tx, tz);
}
