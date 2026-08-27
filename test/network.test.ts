import { describe, expect, it } from 'vitest';
import { COST_SMOOTHING_LAMBDA, MAX_CONGESTION_FACTOR } from '@shared/constants';
import { Mode, ModeBit, OneWay, RoadClass } from '@shared/enums';
import { Pathfinder } from '@sim/network/pathfinder';
import { PathCache } from '@sim/network/pathCache';
import { Rng } from '@sim/core/rng';
import { idx } from '@sim/world/tiles';
import type { Graph } from '@sim/network/graph';
import { TransitSystem } from '@sim/network/transit';
import { buildGraph, layRail, layRoadGrid, layRoadLine, makeTestWorld, rebuildTransit } from './helpers';

describe('マルチモーダルグラフ', () => {
  it('駅と線路をつなぐ路線があると、徒歩では行けない場所へ行ける', () => {
    const world = makeTestWorld();
    // 離れた 2 か所に道路、その間を線路で結ぶ
    layRoadLine(world, 20, 20, 26, 20);
    layRoadLine(world, 20, 80, 26, 80);
    layRail(world, 22, 21, 22, 79);
    const stationA = idx(23, 21);
    const stationB = idx(23, 79);
    world.terrain[stationA] = 0;
    world.terrain[stationB] = 0;

    // 線路と駅だけを置けば、路線は自動で生成される。
    const transit = new TransitSystem();
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(20, 80)]!;

    // 徒歩だけでは到達できない（道路が分断されている）
    expect(finder.search(graph, a, b, Mode.Walk)).toBeNull();
    // 公共交通なら到達できる
    const byTransit = finder.search(graph, a, b, Mode.Transit);
    expect(byTransit).not.toBeNull();
    // 乗車エッジと乗車中エッジを実際に通っている
    const masks = Array.from(byTransit!.edges).map((e) => graph.edgeMask[e]!);
    expect(masks.some((m) => (m & ModeBit.Board) !== 0)).toBe(true);
    expect(masks.some((m) => (m & ModeBit.Ride) !== 0)).toBe(true);
  });

  it('駅を撤去すると公共交通で到達できなくなる', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 26, 20);
    layRoadLine(world, 20, 80, 26, 80);
    layRail(world, 22, 21, 22, 79);
    const stationA = idx(23, 21);
    const stationB = idx(23, 79);

    const transit = new TransitSystem();
    const withStations = rebuildTransit(transit, world, [stationA, stationB]);
    const finder = new Pathfinder();
    expect(
      finder.search(withStations, withStations.roadNodeAt[idx(20, 20)]!, withStations.roadNodeAt[idx(20, 80)]!, Mode.Transit),
    ).not.toBeNull();

    // 片方の駅を外すと、停留所が 1 つしかない路線は成立しない。
    const oneStation = rebuildTransit(new TransitSystem(), world, [stationA]);
    expect(
      finder.search(oneStation, oneStation.roadNodeAt[idx(20, 20)]!, oneStation.roadNodeAt[idx(20, 80)]!, Mode.Transit),
    ).toBeNull();
  });

  it('自動車は線路の上を走れない', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 26, 20);
    layRoadLine(world, 20, 80, 26, 80);
    layRail(world, 22, 21, 22, 79);
    const graph = buildGraph(world, [idx(23, 21), idx(23, 79)]);
    const finder = new Pathfinder();
    expect(
      finder.search(graph, graph.roadNodeAt[idx(20, 20)]!, graph.roadNodeAt[idx(20, 80)]!, Mode.Car),
    ).toBeNull();
  });

  it('踏切では道路と線路が共存する', () => {
    const world = makeTestWorld();
    const road = layRoadLine(world, 20, 30, 40, 30);
    layRail(world, 30, 20, 30, 40);
    const crossing = idx(30, 30);
    expect(world.road[crossing]).not.toBe(RoadClass.None);
    expect(world.rail[crossing]).toBe(1);
    expect(world.isLevelCrossing(crossing)).toBe(true);
    // 道路は分断されていない
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    expect(finder.search(graph, graph.roadNodeAt[road[0]!]!, graph.roadNodeAt[road[road.length - 1]!]!, Mode.Car)).not.toBeNull();
  });
});

describe('渋滞のフィードバック', () => {
  it('実測したリンク所要時間が経路コストに反映され、平滑化で発振しない', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 40, 20);
    const graph = buildGraph(world);
    const edge = 0;
    const free = graph.edgeCarFreeSec[edge]!;

    // 自由流の 5 倍で走っているリンクを観測し続ける
    const samples: number[] = [];
    for (let tick = 0; tick < 400; tick++) {
      graph.observeTraversal(edge, free * 5, tick);
      graph.relaxLinkTimes(tick, COST_SMOOTHING_LAMBDA * 10);
      if (tick > 200) samples.push(graph.edgeCarSec[edge]!);
    }
    expect(graph.edgeCarSec[edge]!).toBeGreaterThan(free * 3);
    // 平滑化されているので、隣り合うステップの差は値そのものに比べて十分小さい
    let maxJump = 0;
    for (let i = 1; i < samples.length; i++) maxJump = Math.max(maxJump, Math.abs(samples[i]! - samples[i - 1]!));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(maxJump).toBeLessThan(mean * 0.1);
  });

  it('上限倍率で頭打ちになる（無限大コストで A* のヒープを壊さない）', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 40, 20);
    const graph = buildGraph(world);
    const edge = 0;
    const free = graph.edgeCarFreeSec[edge]!;
    for (let tick = 0; tick < 2000; tick++) {
      graph.observeTraversal(edge, free * 1e6, tick);
      graph.relaxLinkTimes(tick, 0.5);
    }
    expect(graph.edgeCarSec[edge]!).toBeLessThanOrEqual(free * MAX_CONGESTION_FACTOR + 1e-6);
    expect(Number.isFinite(graph.edgeCarSec[edge]!)).toBe(true);
  });

  it('車が通らなくなったリンクは自由流に戻る', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 40, 20);
    const graph = buildGraph(world);
    const edge = 0;
    const free = graph.edgeCarFreeSec[edge]!;
    for (let tick = 0; tick < 300; tick++) {
      graph.observeTraversal(edge, free * 5, tick);
      graph.relaxLinkTimes(tick, 0.3);
    }
    expect(graph.edgeCarSec[edge]!).toBeGreaterThan(free * 2);
    // 観測が途絶えたら、混んでいた記録が残り続けてはいけない
    for (let tick = 300; tick < 1200; tick++) graph.relaxLinkTimes(tick, 0.3);
    expect(graph.edgeCarSec[edge]!).toBeCloseTo(free, 3);
  });

  it('混雑したリンクは自動車の経路コストを実際に押し上げる', () => {
    const world = makeTestWorld();
    layRoadGrid(world, 20, 20, 24, 24, 4);
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(44, 20)]!;
    const before = finder.search(graph, a, b, Mode.Car)!;
    expect(before).not.toBeNull();

    for (let tick = 0; tick < 300; tick++) {
      for (const e of before.edges) graph.observeTraversal(e, graph.edgeCarFreeSec[e]! * 6, tick);
      graph.relaxLinkTimes(tick, 0.3);
    }
    const after = finder.search(graph, a, b, Mode.Car)!;
    expect(after.costSec).toBeGreaterThan(before.costSec);
  });
});

describe('経路キャッシュ', () => {
  it('同じ問い合わせはキャッシュから返る', () => {
    const cache = new PathCache();
    const path = { nodes: new Int32Array([0, 1]), edges: new Int32Array([0]), costSec: 10, lengthM: 10, mode: Mode.Car, version: 5 };
    cache.set(1, 2, Mode.Car, path);
    expect(cache.get(1, 2, Mode.Car, 5)).toBe(path);
    expect(cache.hits).toBe(1);
  });

  it('ネットワークのバージョンが変わると無効になる', () => {
    const cache = new PathCache();
    const path = { nodes: new Int32Array([0, 1]), edges: new Int32Array([0]), costSec: 10, lengthM: 10, mode: Mode.Car, version: 5 };
    cache.set(1, 2, Mode.Car, path);
    expect(cache.get(1, 2, Mode.Car, 6)).toBeNull();
  });

  it('モードが違えば別のエントリになる', () => {
    const cache = new PathCache();
    const path = { nodes: new Int32Array([0, 1]), edges: new Int32Array([0]), costSec: 10, lengthM: 10, mode: Mode.Car, version: 1 };
    cache.set(1, 2, Mode.Car, path);
    expect(cache.get(1, 2, Mode.Walk, 1)).toBeNull();
  });

  it('容量を超えても上限内に収まる（メモリリークしない）', () => {
    const cache = new PathCache();
    const rng = new Rng(3);
    for (let i = 0; i < 200_000; i++) {
      const p = { nodes: new Int32Array(0), edges: new Int32Array(0), costSec: 1, lengthM: 1, mode: Mode.Car, version: 1 };
      cache.set(rng.int(100000), rng.int(100000), Mode.Car, p);
    }
    expect(cache.size).toBeLessThanOrEqual(120_000);
  });
});

/** 2 つのタイルを結ぶ有向エッジ。見つからなければ -1。 */
function edgeBetween(graph: Graph, from: number, to: number): number {
  const a = graph.roadNodeAt[from]!;
  const b = graph.roadNodeAt[to]!;
  for (let e = graph.edgeStart[a]!; e < graph.edgeStart[a + 1]!; e++) {
    if (graph.edgeTo[e] === b) return e;
  }
  return -1;
}

describe('一方通行', () => {
  it('逆走のエッジからは車のビットが落ちる（歩行者と自転車は通れる）', () => {
    const world = makeTestWorld();
    // 東西に 1 本の道。真ん中の数マスを東向きの一方通行にする。
    layRoadLine(world, 20, 40, 40, 40);
    for (let x = 26; x <= 34; x++) world.setOneWay(idx(x, 40), OneWay.East);

    const graph = buildGraph(world);
    const forward = edgeBetween(graph, idx(33, 40), idx(34, 40));
    const backward = edgeBetween(graph, idx(34, 40), idx(33, 40));
    expect(graph.edgeMask[forward]! & ModeBit.Car).not.toBe(0);
    // 逆走だけが塞がる。徒歩と自転車のビットは残る（歩行者に一方通行はない）。
    expect(graph.edgeMask[backward]! & ModeBit.Car).toBe(0);
    expect(graph.edgeMask[backward]! & ModeBit.Walk).not.toBe(0);
    expect(graph.edgeMask[backward]! & ModeBit.Bike).not.toBe(0);
  });

  it('車は一方通行を迂回する', () => {
    const world = makeTestWorld();
    // 迂回できる格子。中央の 1 行だけを東向きの一方通行にする。
    layRoadGrid(world, 20, 20, 12, 4);
    const row = 20 + 4; // 格子の 2 本目の東西路
    for (let x = 22; x <= 30; x++) {
      if (world.road[idx(x, row)] !== RoadClass.None) world.setOneWay(idx(x, row), OneWay.East);
    }

    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const east = graph.roadNodeAt[idx(32, row)]!;
    const west = graph.roadNodeAt[idx(20, row)]!;
    const path = finder.search(graph, east, west, Mode.Car);
    expect(path).not.toBeNull();
    // 逆走のエッジを 1 本も含まない
    const usedWrongWay = Array.from(path!.edges).some((e) => (graph.edgeMask[e]! & ModeBit.Car) === 0);
    expect(usedWrongWay).toBe(false);
    // 一方通行が無ければもっと短い（＝迂回している）
    for (let x = 22; x <= 30; x++) world.setOneWay(idx(x, row), OneWay.None);
    const free = buildGraph(world);
    const direct = finder.search(free, free.roadNodeAt[idx(32, row)]!, free.roadNodeAt[idx(20, row)]!, Mode.Car);
    expect(path!.lengthM).toBeGreaterThan(direct!.lengthM);
  });

  it('一方通行から脇道へ曲がることは塞がない', () => {
    const world = makeTestWorld();
    // 東西の本線と、その途中から南へ伸びる脇道
    layRoadLine(world, 20, 40, 40, 40);
    layRoadLine(world, 30, 40, 30, 50);
    for (let x = 26; x <= 34; x++) world.setOneWay(idx(x, 40), OneWay.East);

    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const west = graph.roadNodeAt[idx(20, 40)]!;
    const south = graph.roadNodeAt[idx(30, 50)]!;
    // 一方通行を東へ進んでから南へ折れる経路が成立する。
    // 「指定の向きに出るときだけ通す」という実装にすると、ここが塞がって
    // 入ったら最後まで抜けられない道になる。
    expect(finder.search(graph, west, south, Mode.Car)).not.toBeNull();
  });

  it('道路を消すと一方通行も消える', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 40, 40, 40);
    const t = idx(30, 40);
    world.setOneWay(t, OneWay.East);
    expect(world.oneWay[t]).toBe(OneWay.East);
    world.setRoad(t, RoadClass.None);
    expect(world.oneWay[t]).toBe(OneWay.None);
  });
});
