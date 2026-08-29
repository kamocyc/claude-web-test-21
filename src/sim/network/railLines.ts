import {
  DEFAULT_HEADWAY_MIN,
  RAIL_SPEED_KMH,
  SIM_PER_RENDER,
  TRAIN_CARS,
  TRAIN_CAR_GAP_M,
  TRAIN_CAR_LENGTH_M,
  TRAIN_TURNAROUND_SEC,
} from '@shared/constants';
import { ModeBit } from '@shared/enums';
import { idx, inBounds, tileX, tileY } from '@sim/world/tiles';
import { curvePointOnNodes, segmentLength } from './curve';
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
/**
 * 連結面間の距離を**描画単位**で見たもの。
 *
 * 連結が保たれるかどうかは、線路に沿って測った距離ではなく画面上の直線距離で
 * 決まる。カーブでは弦が弧より短いので、線路上の距離を等間隔にすると車体どうしが
 * 近づきすぎて食い込む（実測で 19m の車体が 4.6m めり込んだ）。
 */
const CAR_PITCH_DRAW = TRAIN_CAR_LENGTH_M + TRAIN_CAR_GAP_M;
/** 1 編成の全長（実距離 m）。 */
export const TRAIN_LENGTH_M = TRAIN_CARS * TRAIN_CAR_PITCH_M;
/**
 * 編成が線路上で食う距離。**弦**を一定に保つので、カーブでは同じ編成でも
 * 線路上ではより長い距離を占める。90 度の角が連結面間のちょうど真ん中に来ると、
 * 弦 1 本ぶんに線路 1.42 本ぶんが要る。編成が線からはみ出すと端で連結が
 * 詰まるので、その最悪値を丸めて確保しておく。
 */
const CONSIST_PATH_M = TRAIN_LENGTH_M * 1.45;

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

/** 編成の位置。 */
export interface TrainHead {
  /**
   * 編成の**起点側の端**（起点に一番近い連結点）の、起点からの距離 (m)。
   *
   * 「先頭車の位置」にすると、折り返した瞬間に先頭が編成の反対の端へ飛ぶ。
   * 位置は進行方向に依らない量で持ち、向きは forward だけで表す。こうすると
   * 折り返しで入れ替わるのは「どちらが先頭車か」だけになり、車両は動かない。
   */
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

/**
 * 線路ノードの周囲 2 タイルに駅があるか。
 *
 * 以前は「Board エッジが生えているか」で見ていた。駅から線路ノードへ直接
 * 乗降エッジが張られていた頃はそれで正しかったが、乗車は路線のプラットフォームを
 * 経由するようになり、線路ノードには乗降エッジが 1 本も生えなくなった。
 * そのまま放置すると全線が served=false になり、電車が 1 本も描かれなくなる。
 * 判定の中身（駅から 2 タイル以内）は graph.build の徒歩接続と同じ範囲に揃えてある。
 */
function hasStation(graph: Graph, u: number): boolean {
  const t = graph.nodeTile[u]!;
  const x = tileX(t);
  const y = tileY(t);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      if (graph.stationNodeAt[idx(x + dx, y + dy)]! >= 0) return true;
    }
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
  const seg = line.cumM[hi]! - line.cumM[lo]!;
  const f = seg > 0 ? (d - line.cumM[lo]!) / seg : 0;
  // 折れ線のままだと分岐やカーブで向きが 1 フレームで入れ替わる。
  // 道路と同じく角を丸めた曲線の上に載せる（`curve.ts`）。
  curvePointOnNodes(graph, line.nodes, n, lo, f * segmentLength(graph, line.nodes, lo), out);
  // 戻りの列車は同じ線路を逆向きに走る。
  if (!forward) out.heading += Math.PI;
  return true;
}

/** 片道で編成が動ける距離 (m)。編成が線からはみ出さないぶんだけ短い。 */
function travelSpanM(line: RailLine): number {
  return Math.max(0, line.lengthM - CONSIST_PATH_M);
}

/** 線を端から端まで走り、折り返して戻ってくるまでの秒数（両端の停車を含む）。 */
export function shuttleCycleSec(line: RailLine): number {
  return (2 * travelSpanM(line)) / RAIL_MS + 2 * TRAIN_TURNAROUND_SEC;
}

/**
 * 時刻 tickFloat（分、端数可）における各編成の位置。
 *
 * 端から端への往復を 1 周期とし、運行間隔がちょうど DEFAULT_HEADWAY_MIN に
 * なる本数を等間隔に配る。線ごとに位相をずらして、全線の電車が
 * 同時に発車しているように見えるのを避ける。
 *
 * @returns out に書き込んだ編成数。
 */
export function trainHeads(line: RailLine, tickFloat: number, out: TrainHead[]): number {
  // 編成がカーブぶんの余裕を含めて収まらない線には走らせない。
  // 収まらないまま走らせると、線の端で連結点が頭打ちになって車両が重なる。
  if (!line.served || line.lengthM < CONSIST_PATH_M) return 0;
  const cycle = shuttleCycleSec(line);
  const headwaySec = DEFAULT_HEADWAY_MIN * 60;
  const count = Math.max(1, Math.min(out.length, Math.round(cycle / headwaySec)));
  const spacing = cycle / count;
  // 線ごとの位相。起点ノード id から決めるので、毎フレーム同じ値になる。
  const offset = (line.nodes[0]! * 37) % cycle;
  const timeSec = tickFloat * 60;

  const span = travelSpanM(line);
  const runSec = span / RAIL_MS;

  for (let k = 0; k < count; k++) {
    let phase = (timeSec + offset + k * spacing) % cycle;
    if (phase < 0) phase += cycle;
    const h = out[k]!;
    // 1 周期 = 往路 → 終端で停車 → 復路 → 起点で停車。
    //
    // distM は編成の起点側の端なので、往路も復路も同じ [0, span] を往復する
    // だけになる。折り返しでは forward が反転するだけで、距離は連続している。
    if (phase < runSec) {
      h.distM = phase * RAIL_MS;
      h.forward = true;
    } else if (phase < runSec + TRAIN_TURNAROUND_SEC) {
      // 終端で停車。向きが変わるのは停車のちょうど真ん中。車両の位置は動かず、
      // 入れ替わるのは「どちらの端が先頭車か」だけ（＝運転士が反対側の
      // 運転台へ移る）。発車と同時にやると、動き出す瞬間に編成の見た目が変わる。
      h.distM = span;
      h.forward = phase < runSec + TRAIN_TURNAROUND_SEC / 2;
    } else if (phase < 2 * runSec + TRAIN_TURNAROUND_SEC) {
      h.distM = span - (phase - runSec - TRAIN_TURNAROUND_SEC) * RAIL_MS;
      h.forward = false;
    } else {
      h.distM = 0;
      h.forward = phase >= 2 * runSec + 1.5 * TRAIN_TURNAROUND_SEC;
    }
  }
  return count;
}

/**
 * 連結点 c0 から線路を進み、**画面上の直線距離**がちょうど CAR_PITCH_DRAW に
 * なる線路上の距離を返す。
 *
 * 線路に沿った距離を等間隔にするのではなく、隣の車との弦を一定に保つ。車体は
 * 連結点から連結点までの剛体なので、これが「連結が外れない」の定義そのものに
 * なる。カーブでは弧より弦が短いぶん、線路上ではより遠くまで進むことになる。
 *
 * 弦は距離に対してほぼ比例して伸びるので、`いまの弦 → 目標` の比を掛ける
 * 反復が下から単調に収束する。直線なら 1 回で当たる。
 */
function advanceByChord(graph: Graph, line: RailLine, d0: number, c0: RailPose, tmp: RailPose): number {
  let step = CAR_PITCH_DRAW * SIM_PER_RENDER;
  const room = line.lengthM - d0;
  for (let it = 0; it < 6; it++) {
    if (step >= room) return line.lengthM;
    railPoseAt(graph, line, d0 + step, true, tmp);
    const chord = Math.hypot(tmp.x - c0.x, tmp.z - c0.z);
    if (chord <= 1e-4) break;
    const scale = CAR_PITCH_DRAW / chord;
    if (Math.abs(scale - 1) < 1e-4) break;
    step *= scale;
  }
  return Math.min(line.lengthM, d0 + step);
}

/**
 * 編成の各車両の姿勢を、先頭車から順に out に詰める。
 *
 * 連結点を線路の上に鎖のように並べ、車体はその 2 点を結ぶ棒として置く。車体の
 * 端は連結点から (CAR_PITCH_DRAW - TRAIN_CAR_LENGTH_M) / 2 だけ内側にあるので、
 * カーブで隣の車と角度が付いても、離れられるのは連結面のすきま
 * (TRAIN_CAR_GAP_M) までに限られる。車両の**中心**を線路上で等間隔に置く方式だと、
 * 角では中心どうしの直線距離が縮んで車体が食い込み、逆に角をまたぐ組では
 * 連結面が離れる。
 *
 * @param couplers 連結点の作業領域。両数 + 1 以上必要。
 * @returns out に書き込んだ両数。
 */
export function trainCarPoses(
  graph: Graph,
  line: RailLine,
  head: TrainHead,
  couplers: RailPose[],
  out: RailPose[],
): number {
  const cars = Math.min(TRAIN_CARS, out.length, couplers.length - 1);
  if (cars < 1) return 0;
  let d = Math.max(0, Math.min(line.lengthM, head.distM));
  if (!railPoseAt(graph, line, d, true, couplers[0]!)) return 0;
  for (let j = 1; j <= cars; j++) {
    d = advanceByChord(graph, line, d, couplers[j - 1]!, couplers[j]!);
    railPoseAt(graph, line, d, true, couplers[j]!);
  }
  for (let j = 0; j < cars; j++) {
    const lo = couplers[j]!;
    const hi = couplers[j + 1]!;
    // 先頭車は進行方向の端。往路なら距離が大きい側から数える。
    const slot = head.forward ? cars - 1 - j : j;
    const pose = out[slot]!;
    pose.x = (lo.x + hi.x) / 2;
    pose.z = (lo.z + hi.z) / 2;
    pose.heading = Math.atan2(hi.x - lo.x, hi.z - lo.z) + (head.forward ? 0 : Math.PI);
  }
  return cars;
}
