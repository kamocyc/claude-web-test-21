import { ModeBit, RoadClass } from '@shared/enums';
import { Graph, NodeKind } from '@sim/network/graph';
import type { Path } from '@sim/network/pathfinder';
import type { TransitSystem } from '@sim/network/transit';
import { idx } from '@sim/world/tiles';
import { World } from '@sim/world/world';

/** テスト用に、指定した矩形を平地にして道路グリッドを敷いた World を作る。 */
export function makeTestWorld(seed = 1): World {
  return new World(seed);
}

/** 水平・垂直の直線道路を敷く。 */
export function layRoadLine(
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cls: RoadClass = RoadClass.Street,
): number[] {
  const tiles: number[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  for (;;) {
    const t = idx(x, y);
    // テストでは地形の都合で敷けないことがないよう、地形を平地に均しておく
    world.terrain[t] = 0;
    world.slope[t] = 0;
    if (world.setRoad(t, cls)) tiles.push(t);
    else if (world.road[t] === cls) tiles.push(t);
    if (x === x1 && y === y1) break;
    if (x !== x1) x += dx;
    else if (y !== y1) y += dy;
    else break;
  }
  return tiles;
}

/** 矩形の道路グリッドを敷く。 */
export function layRoadGrid(world: World, x0: number, y0: number, w: number, h: number, step = 4): void {
  for (let y = y0; y <= y0 + h; y++) {
    for (let x = x0; x <= x0 + w; x++) {
      if ((y - y0) % step !== 0 && (x - x0) % step !== 0) continue;
      const t = idx(x, y);
      world.terrain[t] = 0;
      world.slope[t] = 0;
      world.setRoad(t, RoadClass.Street);
    }
  }
}

export function buildGraph(world: World, stations: number[] = []): Graph {
  const g = new Graph();
  g.build(world, stations);
  return g;
}

/** 線路を直線で敷く。 */
export function layRail(world: World, x0: number, y0: number, x1: number, y1: number): number[] {
  const tiles: number[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  for (;;) {
    const t = idx(x, y);
    world.terrain[t] = 0;
    world.slope[t] = 0;
    if (world.setRail(t, true)) tiles.push(t);
    if (x === x1 && y === y1) break;
    if (x !== x1) x += dx;
    else if (y !== y1) y += dy;
    else break;
  }
  return tiles;
}

/**
 * 路線つきでグラフを作り直す。
 *
 * `Graph.build()` を直接呼ばないのは、プラットフォーム・ノードの生成と
 * `TransitSystem` の束ね直しが必ず対で走らないといけないため
 * （片方だけ呼ぶと路線が持っているエッジ番号が古いままになる）。
 */
export function rebuildTransit(
  transit: TransitSystem,
  world: World,
  stations: number[] = [],
  graph: Graph = new Graph(),
): Graph {
  transit.rebuild(graph, world, stations);
  return graph;
}

/**
 * 指定したリンクが「自由流の factor 倍かかっている」と交通流が観測した状態にする。
 * 渋滞を作るのに実際に車を流す必要はなく、経路コストが読むのは実測の EMA だけ。
 */
export function congestEdges(graph: Graph, edges: Iterable<number>, factor = 5, ticks = 400): void {
  const list = Array.from(edges);
  for (let tick = 0; tick < ticks; tick++) {
    for (const e of list) graph.observeTraversal(e, graph.edgeCarFreeSec[e]! * factor, tick);
    graph.relaxLinkTimes(tick, 0.3);
  }
}

/** 経路が通っている乗車エッジ（停留所 → プラットフォーム）の本数。乗換回数の実測になる。 */
export function countBoardings(graph: Graph, path: Path): number {
  let n = 0;
  for (const e of path.edges) {
    if ((graph.edgeMask[e]! & ModeBit.Board) === 0) continue;
    if (graph.nodeKind[graph.edgeTo[e]!]! === NodeKind.Platform) n++;
  }
  return n;
}

/** 経路が乗車中エッジを 1 本でも通っているか。 */
export function usesTransit(graph: Graph, path: Path): boolean {
  return Array.from(path.edges).some((e) => (graph.edgeMask[e]! & ModeBit.Ride) !== 0);
}
