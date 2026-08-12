import { COST_PERTURBATION, MAX_EXPANSIONS_PER_PATH } from '@shared/constants';
import { MODE_EDGE_MASK, MODE_MAX_SPEED_KMH, type Mode } from '@shared/enums';
import { BinaryHeap } from '@sim/core/heap';
import { hashUnit } from '@sim/core/rng';
import type { Graph } from './graph';

export interface Path {
  /** 通過ノード列。 */
  nodes: Int32Array;
  /** 通過エッジ列（nodes.length - 1 本）。 */
  edges: Int32Array;
  /** 体感所要時間（秒）。 */
  costSec: number;
  /** 実距離 (m)。運賃計算に使う。 */
  lengthM: number;
  mode: Mode;
  /** 構築時点の Graph.version。古くなったキャッシュの判定に使う。 */
  version: number;
}

export interface SearchStats {
  expansions: number;
  found: boolean;
}

/**
 * プール済み・アロケーションフリーの A*。
 *
 * dist をクエリごとに 0 クリアしないための stamp（クエリ ID）方式を使う。
 * ノード数が増えても 1 クエリの前処理が O(1) になる。
 */
export class Pathfinder {
  private dist = new Float64Array(0);
  private stamp = new Uint32Array(0);
  private parentEdge = new Int32Array(0);
  private parentNode = new Int32Array(0);
  private heap = new BinaryHeap(4096);
  private queryId = 0;

  readonly stats: SearchStats = { expansions: 0, found: false };

  private ensure(nodeCount: number): void {
    if (this.dist.length >= nodeCount) return;
    const cap = Math.max(nodeCount, 1024);
    this.dist = new Float64Array(cap);
    this.stamp = new Uint32Array(cap);
    this.parentEdge = new Int32Array(cap);
    this.parentNode = new Int32Array(cap);
    this.queryId = 0;
  }

  /**
   * start から goal への最小コスト経路。見つからなければ null。
   *
   * @param perturbSeed 市民 ID など。ゼロ以外を渡すと、その主体固有の
   *   ±5% のコスト摂動が掛かる。等コストの並行ルートに流れを分散させ、
   *   全員が同じ 1 本に殺到するのを防ぐ（確率的利用者均衡の簡易版）。
   * @param budget このクエリで許すノード展開数。
   */
  search(
    graph: Graph,
    start: number,
    goal: number,
    mode: Mode,
    perturbSeed = 0,
    budget = MAX_EXPANSIONS_PER_PATH,
  ): Path | null {
    this.stats.expansions = 0;
    this.stats.found = false;
    if (start < 0 || goal < 0 || start >= graph.nodeCount || goal >= graph.nodeCount) return null;
    this.ensure(graph.nodeCount);
    const qid = ++this.queryId;
    // 32bit を一周したら全体をリセットして偽陽性を避ける。
    if (qid === 0xffffffff) {
      this.stamp.fill(0);
      this.queryId = 1;
    }

    const modeMask = MODE_EDGE_MASK[mode]!;
    const maxSpeedMs = (MODE_MAX_SPEED_KMH[mode]! * 1000) / 3600;
    const heur = (nd: number): number => graph.straightLineM(nd, goal) / maxSpeedMs;

    const perturb = perturbSeed !== 0 ? 1 + (hashUnit(perturbSeed) * 2 - 1) * COST_PERTURBATION : 1;

    this.heap.clear();
    this.dist[start] = 0;
    this.stamp[start] = qid;
    this.parentEdge[start] = -1;
    this.parentNode[start] = -1;
    this.heap.push(heur(start), start);

    let expansions = 0;
    let found = false;

    while (this.heap.size > 0) {
      const u = this.heap.pop();
      if (u === goal) {
        found = true;
        break;
      }
      if (++expansions > budget) break;

      const du = this.dist[u]!;
      const e0 = graph.edgeStart[u]!;
      const e1 = graph.edgeStart[u + 1]!;
      for (let e = e0; e < e1; e++) {
        if ((graph.edgeMask[e]! & modeMask) === 0) continue;
        const v = graph.edgeTo[e]!;
        const w = graph.edgeCost(e, mode) * perturb;
        const nd = du + w;
        if (this.stamp[v] === qid && this.dist[v]! <= nd) continue;
        this.stamp[v] = qid;
        this.dist[v] = nd;
        this.parentEdge[v] = e;
        this.parentNode[v] = u;
        this.heap.push(nd + heur(v), v);
      }
    }

    this.stats.expansions = expansions;
    this.stats.found = found;
    if (!found) return null;

    // 経路を復元
    let count = 0;
    for (let v = goal; v !== -1 && v !== start; v = this.parentNode[v]!) count++;
    const nodes = new Int32Array(count + 1);
    const edges = new Int32Array(count);
    let lengthM = 0;
    let v = goal;
    for (let k = count; k > 0; k--) {
      nodes[k] = v;
      const pe = this.parentEdge[v]!;
      edges[k - 1] = pe;
      lengthM += graph.edgeLenM[pe]!;
      v = this.parentNode[v]!;
    }
    nodes[0] = start;

    return {
      nodes,
      edges,
      costSec: this.dist[goal]! / perturb, // 摂動を戻して比較可能なコストにする
      lengthM,
      mode,
      version: graph.version,
    };
  }

  /**
   * 検証用のダイクストラ。A* の最適性テストの基準として使う
   * （ヒューリスティックが非許容だと A* は黙って最短でない経路を返すため、
   *  この比較テストがプロジェクトで最も価値の高いテストになる）。
   */
  dijkstra(graph: Graph, start: number, goal: number, mode: Mode): number {
    const modeMask = MODE_EDGE_MASK[mode]!;
    const dist = new Float64Array(graph.nodeCount).fill(Infinity);
    const heap = new BinaryHeap(1024);
    dist[start] = 0;
    heap.push(0, start);
    const settled = new Uint8Array(graph.nodeCount);
    while (heap.size > 0) {
      const u = heap.pop();
      if (settled[u]) continue;
      settled[u] = 1;
      if (u === goal) return dist[u]!;
      const e1 = graph.edgeStart[u + 1]!;
      for (let e = graph.edgeStart[u]!; e < e1; e++) {
        if ((graph.edgeMask[e]! & modeMask) === 0) continue;
        const v = graph.edgeTo[e]!;
        const nd = dist[u]! + graph.edgeCost(e, mode);
        if (nd < dist[v]!) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    return Infinity;
  }
}

/** 経路上のある地点の姿勢。描画が読む。 */
export interface PathPose {
  x: number;
  z: number;
  /** three.js の Y 軸回転に直接渡せる向き。 */
  heading: number;
  /** 今いるエッジの index。徒歩区間／車道／線路の判定に使う。 */
  edge: number;
}

/**
 * 経路長に対する進捗 f (0..1) からワールド座標を求める。
 *
 * 市民もトラックも、シミュレーションは位置を持たず
 * (出発 tick, 到着 tick, 経路) しか持たない。位置はここで描画時に復元する。
 * 市民用とトラック用に同じ弧長走査を二重に書いていたのでここへ一本化した。
 *
 * `edge` を返すのが要点。自動車の経路は両端に徒歩区間を含み（駐車して歩く）、
 * 鉄道の経路は両端に駅までの徒歩区間を含む。これを見ないと
 * 「歩道を走る車」や「線路を降りて歩く電車」が描かれる。
 */
export function pathPosition(graph: Graph, path: Path, f: number, out: PathPose): boolean {
  if (path.edges.length === 0) return false;
  const target = Math.max(0, Math.min(1, f)) * path.lengthM;
  let acc = 0;
  for (let e = 0; e < path.edges.length; e++) {
    const edge = path.edges[e]!;
    const len = graph.edgeLenM[edge]!;
    if (acc + len >= target || e === path.edges.length - 1) {
      const a = path.nodes[e]!;
      const b = path.nodes[e + 1]!;
      const lf = len > 0 ? Math.max(0, Math.min(1, (target - acc) / len)) : 0;
      const ax = graph.nodeX[a]!;
      const az = graph.nodeZ[a]!;
      const bx = graph.nodeX[b]!;
      const bz = graph.nodeZ[b]!;
      out.x = ax + (bx - ax) * lf;
      out.z = az + (bz - az) * lf;
      out.heading = Math.atan2(bx - ax, bz - az);
      out.edge = edge;
      return true;
    }
    acc += len;
  }
  return false;
}
