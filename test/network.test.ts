import { describe, expect, it } from 'vitest';
import { COST_SMOOTHING_LAMBDA, MAX_CONGESTION_FACTOR } from '@shared/constants';
import { Mode, ModeBit, RoadClass } from '@shared/enums';
import { Pathfinder } from '@sim/network/pathfinder';
import { PathCache } from '@sim/network/pathCache';
import { Rng } from '@sim/core/rng';
import { idx } from '@sim/world/tiles';
import { buildGraph, layRail, layRoadGrid, layRoadLine, makeTestWorld } from './helpers';

describe('マルチモーダルグラフ', () => {
  it('駅が徒歩レイヤと鉄道レイヤを接続する', () => {
    const world = makeTestWorld();
    // 離れた 2 か所に道路、その間を線路で結ぶ
    layRoadLine(world, 20, 20, 26, 20);
    layRoadLine(world, 20, 80, 26, 80);
    layRail(world, 22, 21, 22, 79);
    const stationA = idx(23, 21);
    const stationB = idx(23, 79);
    world.terrain[stationA] = 0;
    world.terrain[stationB] = 0;

    const graph = buildGraph(world, [stationA, stationB]);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(20, 80)]!;

    // 徒歩だけでは到達できない（道路が分断されている）
    expect(finder.search(graph, a, b, Mode.Walk)).toBeNull();
    // 鉄道なら到達できる
    const byRail = finder.search(graph, a, b, Mode.Rail);
    expect(byRail).not.toBeNull();
    // 乗降エッジを実際に通っている
    const usedBoard = Array.from(byRail!.edges).some((e) => (graph.edgeMask[e]! & ModeBit.Board) !== 0);
    expect(usedBoard).toBe(true);
  });

  it('駅を撤去すると鉄道で到達できなくなる', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 26, 20);
    layRoadLine(world, 20, 80, 26, 80);
    layRail(world, 22, 21, 22, 79);
    const stationA = idx(23, 21);
    const stationB = idx(23, 79);

    const withStations = buildGraph(world, [stationA, stationB]);
    const finder = new Pathfinder();
    expect(
      finder.search(withStations, withStations.roadNodeAt[idx(20, 20)]!, withStations.roadNodeAt[idx(20, 80)]!, Mode.Rail),
    ).not.toBeNull();

    // 片方の駅を外す
    const oneStation = buildGraph(world, [stationA]);
    expect(
      finder.search(oneStation, oneStation.roadNodeAt[idx(20, 20)]!, oneStation.roadNodeAt[idx(20, 80)]!, Mode.Rail),
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
