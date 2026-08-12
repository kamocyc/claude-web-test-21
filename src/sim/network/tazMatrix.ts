import { MODE_COUNT, MODE_EDGE_MASK, type Mode } from '@shared/enums';
import { TAZ_COUNT, TAZ } from '@shared/constants';
import { BinaryHeap } from '@sim/core/heap';
import { tazCenterTile, tazOf } from '@sim/world/tiles';
import type { Graph } from './graph';
import type { World } from '@sim/world/world';

/**
 * 交通解析ゾーン (TAZ) 間のコスト行列。
 *
 * これがこのプロジェクトの経路探索性能を支える最大の仕掛け。
 * 「どこで働くか」「どこで買い物するか」「どの交通手段にするか」「どの工場から仕入れるか」
 * — こうした *意思決定* は所要時間の概算しか必要としないのに、素朴に作ると
 * すべてが実経路探索を呼んでしまう。ゾーン単位の行列に落とせば配列参照 1 回で済む。
 * 実際の A* が必要なのは「実際に移動する経路が要る」ときだけになる。
 *
 * 更新は 1 tick に数ゾーンずつのローリング方式。全体が数十 tick で一巡すれば
 * 十分な鮮度（これが効くのはどれも緩やかに変化する判断だけなので）。
 */
export class TazMatrix {
  /** [mode][from * TAZ_COUNT + to] = 体感所要秒。到達不能は Infinity。 */
  readonly cost: Float64Array[] = [];
  /** 各 TAZ の代表ノード（中心に最も近い道路ノード）。-1 = 道路なし。 */
  readonly repNode = new Int32Array(TAZ_COUNT).fill(-1);

  private cursor = 0;
  private dist = new Float64Array(0);
  private heap = new BinaryHeap(4096);
  /** 全 TAZ を一巡した回数。 */
  sweeps = 0;

  constructor() {
    for (let m = 0; m < MODE_COUNT; m++) {
      this.cost.push(new Float64Array(TAZ_COUNT * TAZ_COUNT).fill(Infinity));
    }
  }

  /** グラフ再構築後に代表ノードを取り直す。 */
  refreshRepresentatives(world: World, graph: Graph): void {
    for (let z = 0; z < TAZ_COUNT; z++) {
      const center = tazCenterTile(z);
      const road = world.nearestRoadTile(center, TAZ >> 1);
      this.repNode[z] = road >= 0 ? graph.roadNodeAt[road]! : -1;
    }
  }

  /**
   * ローリング更新。1 回の呼び出しで `zonesPerCall` ゾーン × 全モードを再計算する。
   */
  update(graph: Graph, zonesPerCall = 2): void {
    if (this.dist.length < graph.nodeCount) this.dist = new Float64Array(Math.max(graph.nodeCount, 1024));
    for (let k = 0; k < zonesPerCall; k++) {
      const z = this.cursor;
      this.cursor = (this.cursor + 1) % TAZ_COUNT;
      if (this.cursor === 0) this.sweeps++;
      for (let m = 0; m < MODE_COUNT; m++) this.computeRow(graph, z, m as Mode);
    }
  }

  /** 全ゾーンを即座に計算する（テスト・初期化用）。 */
  computeAll(graph: Graph): void {
    if (this.dist.length < graph.nodeCount) this.dist = new Float64Array(Math.max(graph.nodeCount, 1024));
    for (let z = 0; z < TAZ_COUNT; z++) {
      for (let m = 0; m < MODE_COUNT; m++) this.computeRow(graph, z, m as Mode);
    }
  }

  private computeRow(graph: Graph, from: number, mode: Mode): void {
    const row = this.cost[mode]!;
    const base = from * TAZ_COUNT;
    const src = this.repNode[from]!;
    if (src < 0) {
      row.fill(Infinity, base, base + TAZ_COUNT);
      return;
    }
    const n = graph.nodeCount;
    const dist = this.dist;
    dist.fill(Infinity, 0, n);
    const modeMask = MODE_EDGE_MASK[mode]!;
    const heap = this.heap;
    heap.clear();
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size > 0) {
      const u = heap.pop();
      const du = dist[u]!;
      const e1 = graph.edgeStart[u + 1]!;
      for (let e = graph.edgeStart[u]!; e < e1; e++) {
        if ((graph.edgeMask[e]! & modeMask) === 0) continue;
        const v = graph.edgeTo[e]!;
        const nd = du + graph.edgeCost(e, mode);
        if (nd < dist[v]!) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    for (let z = 0; z < TAZ_COUNT; z++) {
      const rep = this.repNode[z]!;
      row[base + z] = rep < 0 ? Infinity : dist[rep]!;
    }
  }

  /** タイル間の概算所要時間（秒）。到達不能は Infinity。 */
  costBetweenTiles(a: number, b: number, mode: Mode): number {
    return this.cost[mode]![tazOf(a) * TAZ_COUNT + tazOf(b)]!;
  }

  costBetweenZones(a: number, b: number, mode: Mode): number {
    return this.cost[mode]![a * TAZ_COUNT + b]!;
  }
}
