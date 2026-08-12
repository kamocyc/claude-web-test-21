import { describe, expect, it } from 'vitest';
import { Mode, RoadClass } from '@shared/enums';
import { Pathfinder } from '@sim/network/pathfinder';
import { Rng } from '@sim/core/rng';
import { idx } from '@sim/world/tiles';
import { buildGraph, layRoadGrid, layRoadLine, makeTestWorld } from './helpers';

/**
 * このプロジェクトで最も価値の高いテスト群。
 *
 * A* はヒューリスティックが非許容だと「黙って最短でない経路」を返す。
 * ゲーム上は「車が変な道を通る」という形でしか現れず、目視では追えない。
 * だからダイクストラとの一致を機械的に確認する。
 */
describe('経路探索', () => {
  it('直線の道路で最短経路が求まる', () => {
    const world = makeTestWorld();
    const tiles = layRoadLine(world, 20, 20, 40, 20);
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[tiles[0]!]!;
    const b = graph.roadNodeAt[tiles[tiles.length - 1]!]!;
    const path = finder.search(graph, a, b, Mode.Car);
    expect(path).not.toBeNull();
    expect(path!.nodes.length).toBe(tiles.length);
    expect(path!.costSec).toBeGreaterThan(0);
  });

  it('A* の結果がダイクストラと一致する（ヒューリスティックが許容的である証明）', () => {
    const rng = new Rng(12345);
    const finder = new Pathfinder();
    let compared = 0;

    for (let trial = 0; trial < 12; trial++) {
      const world = makeTestWorld(trial + 1);
      // ランダムな格子 + ランダムな欠落で、いびつなネットワークを作る
      const ox = 30;
      const oy = 30;
      layRoadGrid(world, ox, oy, 40, 40, rng.range(3, 6));
      // ランダムに道路を削って迂回を強制する
      for (let k = 0; k < 60; k++) {
        const t = idx(ox + rng.int(40), oy + rng.int(40));
        if (world.road[t] !== RoadClass.None) world.setRoad(t, RoadClass.None);
      }
      const graph = buildGraph(world);
      if (graph.nodeCount < 20) continue;

      for (let q = 0; q < 25; q++) {
        const a = rng.int(graph.nodeCount);
        const b = rng.int(graph.nodeCount);
        for (const mode of [Mode.Walk, Mode.Car] as const) {
          const astar = finder.search(graph, a, b, mode, 0, 1_000_000);
          const truth = finder.dijkstra(graph, a, b, mode);
          if (!Number.isFinite(truth)) {
            expect(astar).toBeNull();
          } else {
            expect(astar).not.toBeNull();
            // 浮動小数の累積誤差のみ許容する
            expect(astar!.costSec).toBeCloseTo(truth, 6);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('到達不能なら null を返す', () => {
    const world = makeTestWorld();
    const a = layRoadLine(world, 20, 20, 30, 20);
    const b = layRoadLine(world, 20, 60, 30, 60); // 完全に分離した別の道路
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const path = finder.search(graph, graph.roadNodeAt[a[0]!]!, graph.roadNodeAt[b[0]!]!, Mode.Car);
    expect(path).toBeNull();
  });

  it('道路を撤去すると経路が変わる（ネットワーク編集が反映される）', () => {
    const world = makeTestWorld();
    // 2 本の並行ルート
    layRoadLine(world, 20, 20, 20, 40);
    layRoadLine(world, 20, 40, 40, 40);
    layRoadLine(world, 40, 40, 40, 20);
    layRoadLine(world, 20, 20, 40, 20); // 直通の近道
    const finder = new Pathfinder();

    const g1 = buildGraph(world);
    const start = g1.roadNodeAt[idx(20, 20)]!;
    const goal = g1.roadNodeAt[idx(40, 20)]!;
    const short = finder.search(g1, start, goal, Mode.Car)!;
    expect(short).not.toBeNull();

    // 近道を分断する
    world.setRoad(idx(30, 20), RoadClass.None);
    const g2 = buildGraph(world);
    const detour = finder.search(g2, g2.roadNodeAt[idx(20, 20)]!, g2.roadNodeAt[idx(40, 20)]!, Mode.Car)!;
    expect(detour).not.toBeNull();
    expect(detour.costSec).toBeGreaterThan(short.costSec);
  });

  it('探索予算を超えると打ち切られる', () => {
    const world = makeTestWorld();
    layRoadGrid(world, 20, 20, 60, 60, 2);
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(80, 80)]!;
    const path = finder.search(graph, a, b, Mode.Car, 0, 10); // 予算 10 ノード
    expect(path).toBeNull();
    expect(finder.stats.expansions).toBeLessThanOrEqual(11);
  });

  it('市民ごとのコスト摂動は経路コストの評価に影響しない', () => {
    const world = makeTestWorld();
    layRoadGrid(world, 20, 20, 30, 30, 3);
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(50, 50)]!;
    const p0 = finder.search(graph, a, b, Mode.Car, 0)!;
    const p1 = finder.search(graph, a, b, Mode.Car, 9999)!;
    expect(p0).not.toBeNull();
    expect(p1).not.toBeNull();
    // 摂動は最大 ±5% なので、報告されるコストはその範囲に収まる
    expect(p1.costSec).toBeGreaterThan(p0.costSec * 0.9);
    expect(p1.costSec).toBeLessThan(p0.costSec * 1.15);
  });
});
