import { describe, expect, it } from 'vitest';
import { COST_SMOOTHING_LAMBDA, VOLUME_DECAY } from '@shared/constants';
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
  it('BPR は交通量に対して単調非減少で、上限で頭打ちになる', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 40, 20);
    const graph = buildGraph(world);
    const edge = 0;
    let prev = 0;
    for (const volume of [0, 300, 600, 1200, 2400, 100000]) {
      graph.edgeVolume[edge] = volume;
      // 平滑化を無効にして目標値へ一気に寄せる
      for (let k = 0; k < 400; k++) {
        graph.edgeVolume[edge] = volume;
        graph.updateCongestion(0.5, 0);
      }
      const t = graph.edgeCarSec[edge]!;
      expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = t;
    }
    // 上限倍率で頭打ち（無限大コストで A* のヒープを壊さない）
    expect(prev).toBeLessThanOrEqual(graph.edgeCarFreeSec[edge]! * 8 + 1e-6);
    expect(Number.isFinite(prev)).toBe(true);
  });

  it('平滑化により、交通量の急変でもコストが発振しない', () => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 40, 20);
    const graph = buildGraph(world);
    const edge = 0;
    const samples: number[] = [];
    // 交通量を毎回激しく振らせても、読み出されるコストは滑らかに追従するはず
    for (let step = 0; step < 200; step++) {
      graph.edgeVolume[edge] = step % 2 === 0 ? 3000 : 0;
      graph.updateCongestion(COST_SMOOTHING_LAMBDA, VOLUME_DECAY);
      if (step > 100) samples.push(graph.edgeCarSec[edge]!);
    }
    // 後半 100 ステップでの隣接差分が、値そのものに比べて十分小さいこと
    let maxJump = 0;
    for (let i = 1; i < samples.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(samples[i]! - samples[i - 1]!));
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(maxJump).toBeLessThan(mean * 0.25);
  });

  it('混雑したエッジは自動車の経路コストを実際に押し上げる', () => {
    const world = makeTestWorld();
    layRoadGrid(world, 20, 20, 24, 24, 4);
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(44, 20)]!;
    const before = finder.search(graph, a, b, Mode.Car)!;
    expect(before).not.toBeNull();

    // 経路上の全エッジを詰まらせる
    for (let k = 0; k < 300; k++) {
      for (const e of before.edges) graph.edgeVolume[e] = 5000;
      graph.updateCongestion(0.3, 0);
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
    for (let i = 0; i < 40_000; i++) {
      const p = { nodes: new Int32Array(0), edges: new Int32Array(0), costSec: 1, lengthM: 1, mode: Mode.Car, version: 1 };
      cache.set(rng.int(100000), rng.int(100000), Mode.Car, p);
    }
    expect(cache.size).toBeLessThanOrEqual(20_000);
  });
});
