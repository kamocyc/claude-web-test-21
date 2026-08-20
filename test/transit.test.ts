import { describe, expect, it } from 'vitest';
import {
  BUS_CAPACITY,
  BUS_VEHICLE_UPKEEP,
  TRAIN_VEHICLE_UPKEEP,
  WAIT_WEIGHT,
} from '@shared/constants';
import { Mode, TransitKind } from '@shared/enums';
import { Pathfinder } from '@sim/network/pathfinder';
import { traceRailLines } from '@sim/network/railLines';
import { TrafficSystem, VehicleKind } from '@sim/network/traffic';
import { LOAD_WINDOW_TICKS, TransitSystem } from '@sim/network/transit';
import { idx } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import {
  congestEdges,
  countBoardings,
  layRail,
  layRoadLine,
  makeTestWorld,
  rebuildTransit,
  usesTransit,
} from './helpers';

/**
 * 公共交通を路線ベースにした部分のテスト。
 *
 * 見ているのは主に 2 つ。
 *   - 路線が経路探索から本当に使われ、運行間隔・混雑・渋滞が所要時間に出ること
 *   - バスは道路の状態に引きずられ、電車は引きずられないこと（路線化の一番の目的）
 */

/** 分断された 2 本の道路を線路で結んだワールド。徒歩では絶対に行き来できない。 */
function railWorld(): { world: World; stationA: number; stationB: number } {
  const world = makeTestWorld();
  layRoadLine(world, 20, 20, 26, 20);
  layRoadLine(world, 20, 80, 26, 80);
  layRail(world, 22, 21, 22, 79);
  const stationA = idx(23, 21);
  const stationB = idx(23, 79);
  world.terrain[stationA] = 0;
  world.terrain[stationB] = 0;
  return { world, stationA, stationB };
}

/** L 字に繋がった 1 本道。バス路線を引くのに使う。 */
function busWorld(): World {
  const world = makeTestWorld();
  layRoadLine(world, 20, 20, 60, 20);
  layRoadLine(world, 60, 20, 60, 60);
  return world;
}

describe('路線と経路探索', () => {
  it('停留所を跨ぐ経路が路線を使う', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    expect(transit.createLine(TransitKind.Train, [stationA, stationB])).toBeGreaterThan(0);
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    transit.updateCosts(graph, 0);

    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(20, 80)]!;

    // 徒歩では到達できない（道路が分断されている）
    expect(finder.search(graph, a, b, Mode.Walk)).toBeNull();
    const byTransit = finder.search(graph, a, b, Mode.Transit);
    expect(byTransit).not.toBeNull();
    expect(usesTransit(graph, byTransit!)).toBe(true);
    expect(countBoardings(graph, byTransit!)).toBe(1);
  });

  it('線路と駅だけで自動的に路線ができ、電車で到達できる', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    // 路線を 1 本も作っていない状態から始める
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    transit.updateCosts(graph, 0);

    expect(transit.lines).toHaveLength(1);
    expect(transit.lines[0]!.auto).toBe(true);
    expect(transit.lines[0]!.kind).toBe(TransitKind.Train);

    const finder = new Pathfinder();
    const path = finder.search(graph, graph.roadNodeAt[idx(20, 20)]!, graph.roadNodeAt[idx(20, 80)]!, Mode.Transit);
    expect(path).not.toBeNull();
    expect(usesTransit(graph, path!)).toBe(true);
  });

  it('線路の折れ線抽出は駅を見失わない（電車が描かれ続ける）', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    const lines = traceRailLines(graph);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.served)).toBe(true);
  });

  it('停留所の駅を撤去すると路線が切り離される', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Train, [stationA, stationB], 6);
    let graph = rebuildTransit(transit, world, [stationA, stationB]);
    transit.updateCosts(graph, 0);
    expect(transit.lines[0]!.stops).toBe(2);

    // 片方の駅だけを残す。停留所が 1 つになった路線は乗っても降りられない。
    graph = rebuildTransit(transit, world, [stationA]);
    transit.updateCosts(graph, 0);
    expect(transit.lines[0]!.stops).toBe(0);
    expect(transit.vehicleCount(transit.lines[0]!)).toBe(0);
    const finder = new Pathfinder();
    expect(
      finder.search(graph, graph.roadNodeAt[idx(20, 20)]!, graph.roadNodeAt[idx(20, 80)]!, Mode.Transit),
    ).toBeNull();
  });

  it('路線を消すと経路が徒歩に戻る', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    const id = transit.createLine(TransitKind.Bus, [idx(20, 20), idx(40, 20), idx(60, 20)], 6);
    let graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);

    const finder = new Pathfinder();
    const withBus = finder.search(graph, graph.roadNodeAt[idx(20, 20)]!, graph.roadNodeAt[idx(60, 20)]!, Mode.Transit)!;
    expect(withBus).not.toBeNull();
    expect(usesTransit(graph, withBus)).toBe(true);

    expect(transit.removeLine(id)).toBe(true);
    graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);
    const walked = finder.search(graph, graph.roadNodeAt[idx(20, 20)]!, graph.roadNodeAt[idx(60, 20)]!, Mode.Transit)!;
    expect(walked).not.toBeNull();
    expect(usesTransit(graph, walked)).toBe(false);
    // 徒歩に戻ったぶん確実に遅くなる
    expect(walked.costSec).toBeGreaterThan(withBus.costSec);
  });
});

describe('運行間隔', () => {
  it('運行間隔を縮めると所要時間が縮む', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    const id = transit.createLine(TransitKind.Train, [stationA, stationB], 30);
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(20, 80)]!;

    transit.updateCosts(graph, 0);
    const slow = finder.search(graph, a, b, Mode.Transit)!;

    transit.setHeadway(id, 4);
    transit.updateCosts(graph, 0);
    const fast = finder.search(graph, a, b, Mode.Transit)!;

    expect(fast.costSec).toBeLessThan(slow.costSec);
    // 待ち時間は運行間隔の半分に体感重みを掛けたぶん。乗車は 1 回なので 1 回分だけ縮む。
    const expected = ((30 - 4) / 2) * WAIT_WEIGHT * 60;
    expect(slow.costSec - fast.costSec).toBeCloseTo(expected, 3);
  });

  it('乗換のある経路は待ち時間を 2 回払う', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    const l1 = transit.createLine(TransitKind.Bus, [idx(20, 20), idx(60, 20)], 4);
    const l2 = transit.createLine(TransitKind.Bus, [idx(60, 20), idx(60, 60)], 4);
    const graph = rebuildTransit(transit, world, []);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(60, 60)]!;

    transit.updateCosts(graph, 0);
    const short = finder.search(graph, a, b, Mode.Transit)!;
    expect(short).not.toBeNull();
    // 2 路線を乗り継いでいる
    expect(countBoardings(graph, short)).toBe(2);

    transit.setHeadway(l1, 20);
    transit.setHeadway(l2, 20);
    transit.updateCosts(graph, 0);
    const long = finder.search(graph, a, b, Mode.Transit)!;
    // 乗車が 2 回あるので、運行間隔を延ばした影響も 2 回分乗る
    const perBoarding = ((20 - 4) / 2) * WAIT_WEIGHT * 60;
    expect(long.costSec - short.costSec).toBeCloseTo(perBoarding * 2, 3);
  });
});

describe('渋滞と区間所要', () => {
  it('道路が混むとバスの区間所要が伸びる', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Bus, [idx(20, 20), idx(60, 20)], 6);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);
    const line = transit.lines[0]!;
    const before = line.segSec[0]!;

    congestEdges(graph, line.segEdges[0]!, 5);
    transit.updateCosts(graph, 1);
    expect(line.segSec[0]!).toBeGreaterThan(before * 2);
  });

  it('電車は道路が混んでも区間所要が変わらない', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Train, [stationA, stationB], 6);
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    transit.updateCosts(graph, 0);
    const line = transit.lines[0]!;
    const before = line.segSec[0]!;

    // 地図上のすべての道路リンクを渋滞させる
    const roadEdges: number[] = [];
    for (let e = 0; e < graph.edgeCount; e++) if (graph.edgeCarFreeSec[e]! > 0) roadEdges.push(e);
    expect(roadEdges.length).toBeGreaterThan(0);
    congestEdges(graph, roadEdges, 6);
    transit.updateCosts(graph, 1);
    expect(line.segSec[0]!).toBeCloseTo(before, 6);
  });

  it('バスは実際に道路の車列に混ざる', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Bus, [idx(20, 20), idx(60, 20)], 6);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);

    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    traffic.events.length = 0;
    transit.dispatchBuses(traffic, 0);
    traffic.tick(graph, 0);

    // 上下 2 方向のバスが道路に出ている
    expect(transit.stats.dispatched).toBe(2);
    let buses = 0;
    traffic.forEachVehicle((v) => {
      if (traffic.kind[v] === VehicleKind.Bus) buses++;
    });
    expect(buses).toBeGreaterThan(0);
    // 路線が通る道路リンクのどこかを実際に占有している
    const route = transit.lines[0]!.runPath[0]!;
    expect(Array.from(route.edges).some((e) => traffic.occupancy(e) > 0)).toBe(true);
  });

  it('到着したバスは走行中から外れる', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Bus, [idx(20, 20), idx(60, 20)], 30);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);

    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    traffic.events.length = 0;
    transit.dispatchBuses(traffic, 0);
    expect(transit.stats.busesRunning).toBe(2);

    for (let tick = 0; tick < 30; tick++) {
      traffic.tick(graph, tick);
      for (const ev of traffic.events) {
        if (ev.kind === VehicleKind.Bus) transit.onVehicleEvent(ev.owner, ev.aborted);
      }
      traffic.events.length = 0;
    }
    expect(transit.stats.busesRunning).toBe(0);
    expect(transit.stats.aborted).toBe(0);
  });
});

describe('混雑', () => {
  it('定員を超えると待ち時間が伸びる', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Bus, [idx(20, 20), idx(60, 20)], 8);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);

    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(60, 20)]!;
    const empty = finder.search(graph, a, b, Mode.Transit)!;
    expect(usesTransit(graph, empty)).toBe(true);

    // 1 時間の輸送力を大きく超える人数を同じ区間に乗せる
    const capacityPerHour = (BUS_CAPACITY * 60) / 8;
    const riders = Math.ceil(capacityPerHour * 6);
    for (let i = 0; i < riders; i++) transit.countRiders(empty);
    expect(transit.stats.riderSegmentsToday).toBe(riders);
    expect(transit.stats.boardingsToday).toBe(riders);

    transit.updateCosts(graph, LOAD_WINDOW_TICKS);
    const crowded = finder.search(graph, a, b, Mode.Transit)!;
    expect(crowded.costSec).toBeGreaterThan(empty.costSec);

    // 空くと元に戻る（積み残しが恒久化しない）
    for (let w = 1; w <= 12; w++) transit.updateCosts(graph, LOAD_WINDOW_TICKS * (w + 1));
    const relieved = finder.search(graph, a, b, Mode.Transit)!;
    expect(relieved.costSec).toBeLessThan(crowded.costSec);
    expect(relieved.costSec).toBeCloseTo(empty.costSec, 3);
  });
});

describe('往復と車両数', () => {
  it('上りと下りの所要時間が等しい（終点で折り返さない）', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Bus, [idx(20, 20), idx(40, 20), idx(60, 20)], 6);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);

    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(60, 20)]!;
    const there = finder.search(graph, a, b, Mode.Transit)!;
    const back = finder.search(graph, b, a, Mode.Transit)!;
    expect(usesTransit(graph, back)).toBe(true);
    expect(back.costSec).toBeCloseTo(there.costSec, 3);
  });

  it('必要車両数は一周の所要 ÷ 運行間隔で、運行間隔を縮めると増える', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    const id = transit.createLine(TransitKind.Bus, [idx(20, 20), idx(60, 20)], 20);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);
    const line = transit.lines[0]!;

    const cycleMin = transit.cycleSec(line) / 60;
    expect(cycleMin).toBeGreaterThan(0);
    expect(transit.vehicleCount(line)).toBe(Math.max(1, Math.ceil(cycleMin / 20)));
    const few = transit.vehicleCount(line);

    transit.setHeadway(id, 4);
    expect(transit.vehicleCount(line)).toBeGreaterThan(few);
    expect(transit.monthlyUpkeep()).toBe(transit.vehicleCount(line) * BUS_VEHICLE_UPKEEP);
  });

  it('電車の維持費は電車の単価で計算される', () => {
    const { world, stationA, stationB } = railWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Train, [stationA, stationB], 10);
    const graph = rebuildTransit(transit, world, [stationA, stationB]);
    transit.updateCosts(graph, 0);
    // 手動で引いた路線が同じ線路の駅を使っているので、自動路線は作られない
    expect(transit.lines).toHaveLength(1);
    const trainLines = transit.lines.filter((l) => l.kind === TransitKind.Train);
    let vehicles = 0;
    for (const l of trainLines) vehicles += transit.vehicleCount(l);
    expect(transit.monthlyUpkeep()).toBe(vehicles * TRAIN_VEHICLE_UPKEEP);
  });
});

describe('セーブと決定論', () => {
  it('JSON に出して読み戻すと同じ経路コストになる', () => {
    const world = busWorld();
    const transit = new TransitSystem();
    transit.createLine(TransitKind.Bus, [idx(20, 20), idx(40, 20), idx(60, 20)], 5);
    transit.createLine(TransitKind.Bus, [idx(60, 20), idx(60, 60)], 12);
    const graph = rebuildTransit(transit, world, []);
    transit.updateCosts(graph, 0);
    const finder = new Pathfinder();
    const a = graph.roadNodeAt[idx(20, 20)]!;
    const b = graph.roadNodeAt[idx(60, 60)]!;
    const before = finder.search(graph, a, b, Mode.Transit)!;

    const saved = JSON.parse(JSON.stringify(transit.toJSON())) as unknown;
    const restored = new TransitSystem();
    restored.loadJSON(saved);
    const graph2 = rebuildTransit(restored, world, []);
    restored.updateCosts(graph2, 0);
    const after = new Pathfinder().search(graph2, graph2.roadNodeAt[idx(20, 20)]!, graph2.roadNodeAt[idx(60, 60)]!, Mode.Transit)!;

    expect(restored.lines.map((l) => l.headwayMin)).toEqual([5, 12]);
    expect(after.costSec).toBeCloseTo(before.costSec, 9);
    expect(restored.monthlyUpkeep()).toBe(transit.monthlyUpkeep());
  });

  it('同じ操作を繰り返すと同じ結果になる', () => {
    const run = (): { cost: number; upkeep: number; vehicles: number; dispatched: number } => {
      const world = busWorld();
      const transit = new TransitSystem();
      const id = transit.createLine(TransitKind.Bus, [idx(20, 20), idx(40, 20), idx(60, 20)], 7);
      transit.createLine(TransitKind.Bus, [idx(60, 20), idx(60, 60)], 9);
      const graph = rebuildTransit(transit, world, []);
      const traffic = new TrafficSystem();
      traffic.rebuild(graph);
      traffic.events.length = 0;

      const finder = new Pathfinder();
      const a = graph.roadNodeAt[idx(20, 20)]!;
      const b = graph.roadNodeAt[idx(60, 60)]!;
      for (let tick = 0; tick < 90; tick++) {
        transit.updateCosts(graph, tick);
        transit.dispatchBuses(traffic, tick);
        traffic.tick(graph, tick);
        for (const ev of traffic.events) {
          if (ev.kind === VehicleKind.Bus) transit.onVehicleEvent(ev.owner, ev.aborted);
        }
        traffic.events.length = 0;
        const p = finder.search(graph, a, b, Mode.Transit);
        if (p) transit.countRiders(p, 3);
        if (tick === 45) transit.setHeadway(id, 4);
      }
      const p = finder.search(graph, a, b, Mode.Transit)!;
      let vehicles = 0;
      for (const l of transit.lines) vehicles += transit.vehicleCount(l);
      return { cost: p.costSec, upkeep: transit.monthlyUpkeep(), vehicles, dispatched: transit.stats.dispatched };
    };
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    expect(first.dispatched).toBeGreaterThan(0);
  });
});
