import { describe, expect, it } from 'vitest';
import {
  SIGNAL_CYCLE_STEPS,
  TILE_SPAN_M,
  TRAFFIC_SUBSTEPS_PER_TICK,
  VEHICLE_LENGTH_M,
} from '@shared/constants';
import { Mode, RoadClass } from '@shared/enums';
import { Pathfinder, type Path } from '@sim/network/pathfinder';
import { TrafficSystem, VehicleKind } from '@sim/network/traffic';
import { idx } from '@sim/world/tiles';
import { buildGraph, layRoadLine, makeTestWorld } from './helpers';
import type { Graph } from '@sim/network/graph';

/**
 * 交通流（リンク待ち行列モデル）。
 *
 * 「車が場所を占め、追い越せず、信号で止まり、詰まると上流へあふれる」が
 * 全部ここで担保される。渋滞はこの 4 つの結果として出るので、
 * 渋滞そのものではなくこの 4 つを検査する。
 */

interface Fixture {
  graph: Graph;
  traffic: TrafficSystem;
  path: Path;
}

/** 1 本道を敷いて、その端から端までの自動車経路を作る。 */
function straightRoad(x0: number, x1: number, cls: RoadClass = RoadClass.Street): Fixture {
  const world = makeTestWorld();
  layRoadLine(world, x0, 40, x1, 40, cls);
  const graph = buildGraph(world);
  const finder = new Pathfinder();
  const a = graph.roadNodeAt[idx(x0, 40)]!;
  const b = graph.roadNodeAt[idx(x1, 40)]!;
  const path = finder.search(graph, a, b, Mode.Car)!;
  expect(path).not.toBeNull();
  const traffic = new TrafficSystem();
  traffic.rebuild(graph);
  return { graph, traffic, path };
}

/** N tick 走らせて、到着した車両の owner を出た順に返す。 */
function run(fx: Fixture, ticks: number, startTick = 0, onTick?: (tick: number) => void): number[] {
  const arrived: number[] = [];
  for (let t = startTick; t < startTick + ticks; t++) {
    onTick?.(t);
    fx.traffic.tick(fx.graph, t);
    for (const e of fx.traffic.events) {
      if (!e.aborted) arrived.push(e.owner);
    }
    fx.traffic.events.length = 0;
  }
  return arrived;
}

describe('交通流', () => {
  it('空いている道は自由流の時間で通り抜ける', () => {
    const fx = straightRoad(30, 40);
    const links = fx.path.edges.length;
    expect(links).toBe(10);
    // 生活道路 30km/h、1 リンク 150m = 18 秒。放出はサブステップ（5 秒）刻み。
    expect(fx.traffic.enter(fx.path, VehicleKind.Car, 7, 0)).toBeGreaterThanOrEqual(0);
    let arriveTick = -1;
    for (let t = 0; t < 60 && arriveTick < 0; t++) {
      fx.traffic.tick(fx.graph, t);
      if (fx.traffic.events.length > 0) {
        expect(fx.traffic.events[0]!.owner).toBe(7);
        arriveTick = t;
      }
      fx.traffic.events.length = 0;
    }
    const freeMin = (links * (TILE_SPAN_M / (30 / 3.6))) / 60;
    expect(arriveTick).toBeGreaterThanOrEqual(Math.floor(freeMin) - 1);
    expect(arriveTick).toBeLessThanOrEqual(Math.ceil(freeMin * 1.4));
  });

  it('リンクの収容台数を超えて車を入れない', () => {
    const fx = straightRoad(30, 40);
    const first = fx.path.edges[0]!;
    const storage = fx.traffic.storage[first]!;
    // 生活道路 1 車線: 150m ÷ 車列 65m = 2 台
    expect(storage).toBe(Math.floor(TILE_SPAN_M / VEHICLE_LENGTH_M));
    for (let k = 0; k < storage; k++) {
      expect(fx.traffic.enter(fx.path, VehicleKind.Car, k, 0)).toBeGreaterThanOrEqual(0);
    }
    // 満杯。ここで入れてしまうと車が重なって描かれる。
    expect(fx.traffic.enter(fx.path, VehicleKind.Car, 99, 0)).toBe(-1);
  });

  it('追い越しが起きない（出発した順に到着する）', () => {
    const fx = straightRoad(30, 46);
    const wanted = 12;
    let sent = 0;
    const arrived = run(fx, 400, 0, (t) => {
      // 入れるだけ入れる。満杯なら次の tick に回す。
      while (sent < wanted && fx.traffic.enter(fx.path, VehicleKind.Car, sent, t) >= 0) sent++;
    });
    expect(sent).toBe(wanted);
    expect(arrived.length).toBe(wanted);
    // FIFO なので owner は 0,1,2,... の順で出てくる
    expect(arrived).toEqual([...Array(wanted).keys()]);
  });

  it('行列ができると、飽和交通流率どおりにしか捌けない', () => {
    // 1 リンクだけの道に詰め込み、放出の間隔を見る
    const fx = straightRoad(30, 32);
    let sent = 0;
    const arrivalTicks: number[] = [];
    for (let t = 0; t < 200; t++) {
      while (fx.traffic.enter(fx.path, VehicleKind.Car, sent, t) >= 0) sent++;
      fx.traffic.tick(fx.graph, t);
      for (const e of fx.traffic.events) if (!e.aborted) arrivalTicks.push(t);
      fx.traffic.events.length = 0;
    }
    expect(arrivalTicks.length).toBeGreaterThan(20);
    // 生活道路 1 車線の飽和交通流率 1800 台/時 ÷ 車列 9 台 = 200 台列/時。
    // 200 tick（＝200 分）で 660 台も 20 台も通らない、という幅で押さえる。
    const perHour = (arrivalTicks.length / 200) * 60;
    expect(perHour).toBeGreaterThan(100);
    expect(perHour).toBeLessThan(260);
  });

  it('信号のある交差点では赤の間だけ車が止まる', () => {
    // 十字路を作る。交差点ノードの流入リンクにだけ信号が付く。
    const world = makeTestWorld();
    layRoadLine(world, 30, 40, 50, 40);
    layRoadLine(world, 40, 30, 40, 50);
    const graph = buildGraph(world);
    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    const finder = new Pathfinder();
    const path = finder.search(graph, graph.roadNodeAt[idx(30, 40)]!, graph.roadNodeAt[idx(50, 40)]!, Mode.Car)!;
    // 交差点（40,40）へ入るリンクは、周期の一部でしか青にならない
    const into = path.edges.find((e) => graph.nodeTile[graph.edgeTo[e]!] === idx(40, 40));
    expect(into).toBeDefined();
    const t: unknown = traffic;
    const g = t as { greenFrom: Uint8Array; greenTo: Uint8Array };
    const green = g.greenTo[into!]! - g.greenFrom[into!]!;
    expect(green).toBeGreaterThan(0);
    expect(green).toBeLessThan(SIGNAL_CYCLE_STEPS);

    // 直線の途中（信号なし）のリンクは常に青
    const midway = path.edges.find((e) => graph.nodeTile[graph.edgeTo[e]!] === idx(35, 40))!;
    expect(g.greenTo[midway]! - g.greenFrom[midway]!).toBe(SIGNAL_CYCLE_STEPS);
  });

  it('大通りは生活道路より多くの車を捌く（広げれば行列が減る）', () => {
    const measure = (cls: RoadClass): number => {
      const fx = straightRoad(30, 32, cls);
      let sent = 0;
      let arrived = 0;
      for (let t = 0; t < 120; t++) {
        while (fx.traffic.enter(fx.path, VehicleKind.Car, sent, t) >= 0) sent++;
        fx.traffic.tick(fx.graph, t);
        for (const e of fx.traffic.events) if (!e.aborted) arrived++;
        fx.traffic.events.length = 0;
      }
      return arrived;
    };
    const street = measure(RoadClass.Street);
    const boulevard = measure(RoadClass.Boulevard);
    expect(boulevard).toBeGreaterThan(street * 2);
  });

  it('下流が詰まると上流のリンクにもあふれる（渋滞が伝播する）', () => {
    // 十字路で 2 つの流れが交差点を取り合う。交差点は片方向ずつしか捌けないので、
    // 需要が容量を超えた側の待ち行列が上流へ伸びていくはず。
    const world = makeTestWorld();
    layRoadLine(world, 26, 40, 54, 40);
    layRoadLine(world, 40, 26, 40, 54);
    const graph = buildGraph(world);
    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    const finder = new Pathfinder();
    const ew = finder.search(graph, graph.roadNodeAt[idx(26, 40)]!, graph.roadNodeAt[idx(54, 40)]!, Mode.Car)!;
    const ns = finder.search(graph, graph.roadNodeAt[idx(40, 26)]!, graph.roadNodeAt[idx(40, 54)]!, Mode.Car)!;
    const t: unknown = traffic;
    const inner = t as { count: Float32Array };
    const cross = idx(40, 40);
    // 東西の流れが交差点に着くまでのリンク列（下流から上流の順）
    const approach = ew.edges.slice(0, ew.edges.findIndex((e) => graph.nodeTile[graph.edgeTo[e]!] === cross) + 1).reverse();

    let sent = 0;
    let maxQueue = 0;
    for (let tick = 0; tick < 300; tick++) {
      // 交差点のすぐ手前から東西の流れを足す。上流の端から入れるだけだと、
      // 入口そのものが待ち行列になって交差点まで需要が届かない。
      while (traffic.enter(ew, VehicleKind.Car, sent, tick) >= 0) sent++;
      while (traffic.enter(ns, VehicleKind.Car, sent, tick) >= 0) sent++;
      traffic.tick(graph, tick);
      traffic.events.length = 0;
      let run = 0;
      for (const e of approach) {
        if (inner.count[e]! >= traffic.storage[e]!) run++;
        else break;
      }
      maxQueue = Math.max(maxQueue, run);
    }
    expect(sent).toBeGreaterThan(50);
    // 交差点の直前 1 本だけでなく、その上流まで満杯が続く
    expect(maxQueue).toBeGreaterThanOrEqual(3);
  });

  it('容量の何倍を流し込んでもデッドロックしない', () => {
    // 十字路を含む格子に、収容の 3 倍を一気に投入する
    const world = makeTestWorld();
    for (let y = 30; y <= 42; y += 3) layRoadLine(world, 30, y, 42, y);
    for (let x = 30; x <= 42; x += 3) layRoadLine(world, x, 30, x, 42);
    const graph = buildGraph(world);
    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    const finder = new Pathfinder();
    const paths = [
      finder.search(graph, graph.roadNodeAt[idx(30, 30)]!, graph.roadNodeAt[idx(42, 42)]!, Mode.Car)!,
      finder.search(graph, graph.roadNodeAt[idx(42, 30)]!, graph.roadNodeAt[idx(30, 42)]!, Mode.Car)!,
      finder.search(graph, graph.roadNodeAt[idx(42, 42)]!, graph.roadNodeAt[idx(30, 30)]!, Mode.Car)!,
      finder.search(graph, graph.roadNodeAt[idx(30, 42)]!, graph.roadNodeAt[idx(42, 30)]!, Mode.Car)!,
    ];
    let sent = 0;
    let done = 0;
    const target = 120;
    for (let tick = 0; tick < 1440; tick++) {
      while (sent < target && traffic.enter(paths[sent % paths.length]!, VehicleKind.Car, sent, tick) >= 0) sent++;
      traffic.tick(graph, tick);
      done += traffic.events.length;
      traffic.events.length = 0;
      if (done >= target) break;
    }
    expect(sent).toBe(target);
    // 1 日以内に全車が（打ち切りではなく）到着まで到達すること
    expect(done).toBe(target);
    expect(traffic.stats.aborted).toBe(0);
  });

  it('1 tick は必ず同じ数のサブステップで解かれる（決定論）', () => {
    expect(SIGNAL_CYCLE_STEPS % 2).toBe(0);
    expect(TRAFFIC_SUBSTEPS_PER_TICK).toBeGreaterThan(1);
    const a = straightRoad(30, 40);
    const b = straightRoad(30, 40);
    let sentA = 0;
    let sentB = 0;
    const arrA = run(a, 200, 0, (t) => {
      while (sentA < 20 && a.traffic.enter(a.path, VehicleKind.Car, sentA, t) >= 0) sentA++;
    });
    const arrB = run(b, 200, 0, (t) => {
      while (sentB < 20 && b.traffic.enter(b.path, VehicleKind.Car, sentB, t) >= 0) sentB++;
    });
    expect(arrA).toEqual(arrB);
  });

  it('待っている車は動かず、停止線の手前に 1 台ずつ下がって並ぶ', () => {
    // 交差点の手前に行列を作る
    const world = makeTestWorld();
    layRoadLine(world, 26, 40, 54, 40);
    layRoadLine(world, 40, 26, 40, 54);
    const graph = buildGraph(world);
    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    const finder = new Pathfinder();
    const ew = finder.search(graph, graph.roadNodeAt[idx(26, 40)]!, graph.roadNodeAt[idx(54, 40)]!, Mode.Car)!;
    const ns = finder.search(graph, graph.roadNodeAt[idx(40, 26)]!, graph.roadNodeAt[idx(40, 54)]!, Mode.Car)!;
    const t: unknown = traffic;
    const inner = t as { count: Float32Array; head: Int32Array; next: Int32Array };

    let sent = 0;
    let tick = 0;
    let queued: number[] = [];
    for (; tick < 300 && queued.length < 2; tick++) {
      while (traffic.enter(ew, VehicleKind.Car, sent, tick) >= 0) sent++;
      while (traffic.enter(ns, VehicleKind.Car, sent, tick) >= 0) sent++;
      traffic.tick(graph, tick);
      traffic.events.length = 0;
      // 2 台以上いるリンクを探す
      for (const e of ew.edges) {
        if (inner.count[e]! < 2) continue;
        queued = [];
        for (let v = inner.head[e]!; v >= 0; v = inner.next[v]!) queued.push(v);
        break;
      }
    }
    expect(queued.length).toBeGreaterThanOrEqual(2);

    const pose = { x: 0, z: 0, heading: 0, edge: -1 };
    const at = (v: number, sec: number): { x: number; z: number } => {
      expect(traffic.pose(graph, v, sec, pose)).toBe(true);
      return { x: pose.x, z: pose.z };
    };
    const now = tick * 60;
    const a = at(queued[0]!, now);
    const b = at(queued[1]!, now);
    // 重なっていない。車列 1 台ぶん（描画単位で TILE_M の 4 割強）は離れる。
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(3);
    // 止まっている間は時間が進んでも位置が動かない
    const a2 = at(queued[0]!, now + 40);
    expect(a2.x).toBeCloseTo(a.x, 5);
    expect(a2.z).toBeCloseTo(a.z, 5);
  });

});
