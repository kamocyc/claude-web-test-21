import {
  DEFAULT_HEADWAY_MIN,
  RAIL_SPEED_KMH,
  SIM_PER_RENDER,
  TRAIN_CARS,
  TRAIN_CAR_GAP_M,
  TRAIN_CAR_LENGTH_M,
} from '@shared/constants';
import { ModeBit } from '@shared/enums';
import { Graph, NodeKind } from './graph';

/**
 * 線路の折れ線抽出と、その上を走る電車の位置。
 *
 * シミュレーションは列車の実体を持たない。鉄道は「線路エッジ ＋ 乗降エッジに
 * 載せた運行間隔/2 の待ち時間」という抽象モデルで、そこに列車オブジェクトを
 * 足しても所要時間も分担率も 1 ミリも変わらない。決定論的状態を増やすだけになる。
 *
 * そこで列車は描画専用とし、位置はモデルが既に前提にしている
 * 運行間隔 (DEFAULT_HEADWAY_MIN) と表定速度 (RAIL_SPEED_KMH) から導出する。
 * 飾りではなく、モデルが値付けしている待ち時間そのものの可視化になっている。
 *
 * three.js に依存しない純粋な計算なので、ヘッドレスで単体テストできる。
 */

const RAIL_MS = (RAIL_SPEED_KMH * 1000) / 3600;
/**
 * 連結面間の距離。**シミュレーション実距離 (m)**。
 * 車両の寸法は描画単位で決まっているので、線路上に並べるために実距離へ直す。
 */
export const TRAIN_CAR_PITCH_M = (TRAIN_CAR_LENGTH_M + TRAIN_CAR_GAP_M) * SIM_PER_RENDER;
/** 1 編成の全長（実距離 m）。これより短い線には電車を走らせない。 */
export const TRAIN_LENGTH_M = TRAIN_CARS * TRAIN_CAR_PITCH_M;

export interface RailLine {
  /** 連続した線路ノード列。 */
  nodes: Int32Array;
  /** nodes[i] までの起点からのシミュレーション実距離 (m)。長さは nodes.length。 */
  cumM: Float32Array;
  /** 線路の全長（実距離 m）。 */
  lengthM: number;
  /**
   * この線に駅が接続しているか。
   * 駅の無い線路には誰も乗れないので電車も走らせない。
   */
  served: boolean;
}

/** 線路上の 1 点の姿勢。 */
export interface RailPose {
  x: number;
  z: number;
  heading: number;
}

/** 編成の先頭位置。 */
export interface TrainHead {
  /** 起点からの距離 (m)。 */
  distM: number;
  /** 起点 → 終点の向きに走っているか。 */
  forward: boolean;
}

/** ノード u の線路隣接を out に詰めて本数を返す。 */
function railNeighbors(graph: Graph, u: number, out: Int32Array): number {
  let n = 0;
  const e1 = graph.edgeStart[u + 1]!;
  for (let e = graph.edgeStart[u]!; e < e1; e++) {
    if ((graph.edgeMask[e]! & ModeBit.Rail) === 0) continue;
    if (n < out.length) out[n++] = graph.edgeTo[e]!;
  }
  return n;
}

/** ノードに駅への乗降エッジが生えているか。 */
function hasStation(graph: Graph, u: number): boolean {
  const e1 = graph.edgeStart[u + 1]!;
  for (let e = graph.edgeStart[u]!; e < e1; e++) {
    if (graph.edgeMask[e]! & ModeBit.Board) return true;
  }
  return false;
}

/**
 * 線路ネットワークを折れ線の集合に分解する。
 *
 * 次数 2 でないノード（端点・分岐）で切る。分岐を跨いで 1 本に繋いでしまうと
 * 電車が分岐点で不自然に折り返すので、Y 字は 3 本として扱う。
 * どこも次数 2 の閉ループは、任意の 1 点から 1 周ぶんを切り出す。
 */
export function traceRailLines(graph: Graph): RailLine[] {
  const lines: RailLine[] = [];
  if (graph.nodeCount === 0) return lines;

  const nb = new Int32Array(8);
  const degree = new Int32Array(graph.nodeCount).fill(-1);
  const railNodes: number[] = [];
  for (let u = 0; u < graph.nodeCount; u++) {
    if (graph.nodeKind[u] !== NodeKind.Rail) continue;
    degree[u] = railNeighbors(graph, u, nb);
    railNodes.push(u);
  }

  // 無向辺の使用済みフラグ。有向エッジ 2 本を 1 本として扱う。
  const used = new Set<number>();
  const key = (a: number, b: number): number => (a < b ? a * graph.nodeCount + b : b * graph.nodeCount + a);

  /** start から first へ向かって、次数 2 のノードを辿れるだけ辿る。 */
  const walk = (start: number, first: number): void => {
    const nodes: number[] = [start];
    let prev = start;
    let cur = first;
    for (;;) {
      if (used.has(key(prev, cur))) break;
      used.add(key(prev, cur));
      nodes.push(cur);
      if (cur === start) break; // 1 周した
      if (degree[cur] !== 2) break; // 端点か分岐で止める
      const n = railNeighbors(graph, cur, nb);
      let next = -1;
      for (let k = 0; k < n; k++) {
        if (nb[k]! !== prev) next = nb[k]!;
      }
      if (next < 0) break;
      prev = cur;
      cur = next;
    }
    if (nodes.length < 2) return;
    lines.push(buildLine(graph, nodes));
  };

  // まず端点・分岐から伸ばす
  for (const u of railNodes) {
    if (degree[u] === 2) continue;
    const n = railNeighbors(graph, u, nb);
    for (let k = 0; k < n; k++) {
      if (used.has(key(u, nb[k]!))) continue;
      walk(u, nb[k]!);
    }
  }
  // 残りは閉ループ
  for (const u of railNodes) {
    const n = railNeighbors(graph, u, nb);
    for (let k = 0; k < n; k++) {
      if (used.has(key(u, nb[k]!))) continue;
      walk(u, nb[k]!);
    }
  }
  return lines;
}

function buildLine(graph: Graph, nodes: number[]): RailLine {
  const n = nodes.length;
  const arr = new Int32Array(n);
  const cum = new Float32Array(n);
  let served = false;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const u = nodes[i]!;
    arr[i] = u;
    if (i > 0) {
      const p = nodes[i - 1]!;
      // nodeX/nodeZ は描画単位。電車の速度は実距離で決まるので実距離に直す。
      acc +=
        Math.hypot(graph.nodeX[u]! - graph.nodeX[p]!, graph.nodeZ[u]! - graph.nodeZ[p]!) * SIM_PER_RENDER;
    }
    cum[i] = acc;
    if (!served && hasStation(graph, u)) served = true;
  }
  return { nodes: arr, cumM: cum, lengthM: acc, served };
}

/**
 * 起点から distM（実距離 m）の地点の姿勢を求める。forward=false なら向きを反転する。
 * 返す x/z は描画単位（cumM 内での比率で補間するので単位の混在は起きない）。
 */
export function railPoseAt(graph: Graph, line: RailLine, distM: number, forward: boolean, out: RailPose): boolean {
  const n = line.nodes.length;
  if (n < 2) return false;
  const d = Math.max(0, Math.min(line.lengthM, distM));

  // cumM は単調増加なので二分探索できる
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (line.cumM[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const a = line.nodes[lo]!;
  const b = line.nodes[hi]!;
  const seg = line.cumM[hi]! - line.cumM[lo]!;
  const f = seg > 0 ? (d - line.cumM[lo]!) / seg : 0;
  const ax = graph.nodeX[a]!;
  const az = graph.nodeZ[a]!;
  const bx = graph.nodeX[b]!;
  const bz = graph.nodeZ[b]!;
  out.x = ax + (bx - ax) * f;
  out.z = az + (bz - az) * f;
  out.heading = forward ? Math.atan2(bx - ax, bz - az) : Math.atan2(ax - bx, az - bz);
  return true;
}

/** 線を端から端まで走って戻るのに掛かる秒数。 */
export function shuttleCycleSec(line: RailLine): number {
  return (2 * line.lengthM) / RAIL_MS;
}

/**
 * 時刻 tickFloat（分、端数可）における各編成の先頭位置。
 *
 * 端から端への往復を 1 周期とし、運行間隔がちょうど DEFAULT_HEADWAY_MIN に
 * なる本数を等間隔に配る。線ごとに位相をずらして、全線の電車が
 * 同時に発車しているように見えるのを避ける。
 *
 * @returns out に書き込んだ編成数。
 */
export function trainHeads(line: RailLine, tickFloat: number, out: TrainHead[]): number {
  if (!line.served || line.lengthM < TRAIN_LENGTH_M) return 0;
  const cycle = shuttleCycleSec(line);
  const oneWay = cycle / 2;
  const headwaySec = DEFAULT_HEADWAY_MIN * 60;
  const count = Math.max(1, Math.min(out.length, Math.round(cycle / headwaySec)));
  const spacing = cycle / count;
  // 線ごとの位相。起点ノード id から決めるので、毎フレーム同じ値になる。
  const offset = (line.nodes[0]! * 37) % cycle;
  const timeSec = tickFloat * 60;

  for (let k = 0; k < count; k++) {
    let phase = (timeSec + offset + k * spacing) % cycle;
    if (phase < 0) phase += cycle;
    const h = out[k]!;
    if (phase < oneWay) {
      h.distM = phase * RAIL_MS;
      h.forward = true;
    } else {
      h.distM = (cycle - phase) * RAIL_MS;
      h.forward = false;
    }
  }
  return count;
}
