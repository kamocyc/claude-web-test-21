import { describe, expect, it } from 'vitest';
import {
  VEHICLES_PER_LANE,
  SIGNAL_CYCLE_STEPS,
  TILE_M,
  TILE_SPAN_M,
  TRAFFIC_STEP_SEC,
  TRAFFIC_SUBSTEPS_PER_TICK,
  VEHICLE_LENGTH_M,
} from '@shared/constants';
import { DRAWN_LANES, Mode, RoadClass } from '@shared/enums';
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
    // 生活道路は描き分けられる車線が 1 本、1 車線に 2 台
    expect(storage).toBe(VEHICLES_PER_LANE);
    for (let k = 0; k < storage; k++) {
      expect(fx.traffic.enter(fx.path, VehicleKind.Car, k, 0)).toBeGreaterThanOrEqual(0);
    }
    // 満杯。ここで入れてしまうと車が重なって描かれる。
    expect(fx.traffic.enter(fx.path, VehicleKind.Car, 99, 0)).toBe(-1);
  });

  it('リンクの収容は重ならずに描ける台数に等しい', () => {
    // 車列 1 台の占有長は描画で 6.8m、リンクは 10m。1 車線には停止線に 1 台と
    // その後ろに 1 台まで並ぶ。溜められる台数はそれ × 描き分けられる車線数。
    for (const cls of [RoadClass.Street, RoadClass.Avenue, RoadClass.Boulevard]) {
      const fx = straightRoad(30, 34, cls);
      expect(fx.traffic.storage[fx.path.edges[0]!]!).toBe(DRAWN_LANES[cls]! * VEHICLES_PER_LANE);
    }
    // 1 車線ぶんの車列がリンク長に収まっている
    const drawnPitch = (TILE_M * VEHICLE_LENGTH_M) / TILE_SPAN_M;
    expect(drawnPitch * (VEHICLES_PER_LANE - 1)).toBeLessThanOrEqual(TILE_M);
  });

  it('トラックも 1 台ぶんの場所を占める（重みで数えない）', () => {
    // トラックが交差点で食う枠は乗用車の車列の 0.22 だが、画面では 1 台ぶんの
    // 場所を取る。重みで収容を数えると 1 リンクに十数台が載って必ず重なる。
    const fx = straightRoad(30, 34);
    const storage = fx.traffic.storage[fx.path.edges[0]!]!;
    for (let k = 0; k < storage; k++) {
      expect(fx.traffic.enter(fx.path, VehicleKind.Truck, k, 0)).toBeGreaterThanOrEqual(0);
    }
    expect(fx.traffic.enter(fx.path, VehicleKind.Truck, 99, 0)).toBe(-1);
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
    const cross = idx(40, 40);
    // 東西の流れが交差点に着くまでのリンク列（下流から上流の順）
    const approach = ew.edges.slice(0, ew.edges.findIndex((e) => graph.nodeTile[graph.edgeTo[e]!] === cross) + 1).reverse();

    // 交差点のすぐ手前からも足す。端から入れるだけだと、入口のリンク自体が
    // 待ち行列になって需要が交差点まで届かず、交差点の容量を超えられない
    // （1 車線の飽和交通流率は 200 台列/時 = 3.3 台列/tick、青は半分なので
    //   1 方向あたり 1.7 台列/tick しか捌けない）。
    const ewNear = finder.search(graph, graph.roadNodeAt[idx(38, 40)]!, graph.roadNodeAt[idx(54, 40)]!, Mode.Car)!;
    const nsNear = finder.search(graph, graph.roadNodeAt[idx(40, 38)]!, graph.roadNodeAt[idx(40, 54)]!, Mode.Car)!;

    let sent = 0;
    let maxQueue = 0;
    for (let tick = 0; tick < 300; tick++) {
      for (const p of [ewNear, ew, nsNear, ns]) {
        while (traffic.enter(p, VehicleKind.Car, sent, tick) >= 0) sent++;
      }
      traffic.tick(graph, tick);
      traffic.events.length = 0;
      // 「もう車を受け入れられない」が満杯。位置で車間を取るので、
      // 台数が収容に届く前に入れなくなることがある（`isFull`）。
      let run = 0;
      for (const e of approach) {
        if (traffic.isFull(e)) run++;
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

    const ewNear = finder.search(graph, graph.roadNodeAt[idx(38, 40)]!, graph.roadNodeAt[idx(54, 40)]!, Mode.Car)!;
    const nsNear = finder.search(graph, graph.roadNodeAt[idx(40, 38)]!, graph.roadNodeAt[idx(40, 54)]!, Mode.Car)!;

    let sent = 0;
    let tick = 0;
    let queued: number[] = [];
    for (; tick < 300 && queued.length < 2; tick++) {
      for (const p of [ewNear, ew, nsNear, ns]) {
        while (traffic.enter(p, VehicleKind.Car, sent, tick) >= 0) sent++;
      }
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
    // 直前に解き終えた tick の中をなぞる（描画がそうしている）。
    // 並びを見るのはその末尾＝行列が落ち着いたところ。
    const base = (tick - 1) * 60;
    const now = base + 59;
    const a = at(queued[0]!, now);
    const b = at(queued[1]!, now);
    // 重なっていない。車列 1 台ぶん（描画単位で TILE_M の 4 割強）は離れる。
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(3);

    // 行列の中の車は、前がどいた分だけ前へ出る。**tick の境目でまとめて飛ばない。**
    //
    // 待ち行列の並びを tick の最後に 1 枚だけ配ると、行列に捕まった車は
    // 1 tick まるごと固まったあと、次の tick の頭で車列 1 台ぶん（65m）から
    // リンク 1 本ぶん（150m = 描画 1 タイル）を 1 フレームで移動する。
    // tick をまたいで 5 秒ごとに追い、1 回の移動が車列 1 台ぶんを超えないことを見る。
    // 待ち行列が空く単位がその車列 1 台ぶんなので、これがこのモデルの下限。
    const platoonM = (TILE_M * VEHICLE_LENGTH_M) / TILE_SPAN_M;
    const prev = new Map<number, { x: number; z: number }>();
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      const t0 = (tick - 1 + k) * 60;
      for (const v of queued) {
        // pose が答えられるのは tick の内側だけ。末尾ちょうどは次 tick の頭。
        for (let s = 0; s < TRAFFIC_SUBSTEPS_PER_TICK; s++) {
          if (!traffic.pose(graph, v, t0 + s * TRAFFIC_STEP_SEC, pose)) break;
          const p = prev.get(v);
          if (p) worst = Math.max(worst, Math.hypot(pose.x - p.x, pose.z - p.z));
          prev.set(v, { x: pose.x, z: pose.z });
        }
      }
      traffic.tick(graph, tick + k);
      traffic.events.length = 0;
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(platoonM + 1e-3);
  });

  it('空いている道のリンク所要は自由流ちょうど（サブステップに切り上がらない）', () => {
    // リンクを渡り終える時刻はサブステップの格子に載らない（街路は 18 秒、格子は 5 秒）。
    // 放出を格子に丸めると、空いている道でも実測所要が 20/18 = 1.111 倍で記録され、
    // 経路コストと「所要時間の倍率」に下駄が乗る。さらに車は毎リンク 2 秒ずつ
    // 停止線で固まり、1 セルごとに加減速して見える。
    const fx = straightRoad(30, 40);
    expect(fx.traffic.enter(fx.path, VehicleKind.Car, 1, 0)).toBeGreaterThanOrEqual(0);
    for (let t = 0; t < 10; t++) fx.traffic.tick(fx.graph, t);
    const free = TILE_SPAN_M / (30 / 3.6);
    for (const e of fx.path.edges) {
      if (fx.graph.edgeObsTick[e]! < 0) continue;
      expect(fx.graph.edgeObsSec[e]! / free).toBeCloseTo(1, 5);
    }
  });

  it('空いている道では止まらずに走り続ける', () => {
    // 1 台だけ走らせて、5 秒ごとの見た目の位置を追う。前も信号も無いのだから、
    // 止まっている瞬間があってはいけない。
    const fx = straightRoad(30, 40);
    expect(fx.traffic.enter(fx.path, VehicleKind.Car, 1, 0)).toBeGreaterThanOrEqual(0);
    const pose = { x: 0, z: 0, heading: 0, edge: -1 };
    let stalled = 0;
    let samples = 0;
    for (let t = 0; t < 4; t++) {
      fx.traffic.tick(fx.graph, t);
      if (fx.traffic.events.length > 0) break;
      let prev: { x: number; z: number } | null = null;
      for (let s = 0; s < TRAFFIC_SUBSTEPS_PER_TICK; s++) {
        if (!fx.traffic.pose(fx.graph, 0, t * 60 + s * TRAFFIC_STEP_SEC, pose)) break;
        if (prev) {
          samples++;
          if (Math.hypot(pose.x - prev.x, pose.z - prev.z) < 1e-3) stalled++;
        }
        prev = { x: pose.x, z: pose.z };
      }
    }
    expect(samples).toBeGreaterThan(20);
    expect(stalled).toBe(0);
  });

  it('交差点では位置も向きも連続して曲がる', () => {
    // 直角に曲がる経路。折れ線のままだと向きが 1 フレームで 90 度入れ替わる。
    const world = makeTestWorld();
    layRoadLine(world, 30, 40, 40, 40);
    layRoadLine(world, 40, 40, 40, 50);
    const graph = buildGraph(world);
    const finder = new Pathfinder();
    const path = finder.search(graph, graph.roadNodeAt[idx(30, 40)]!, graph.roadNodeAt[idx(40, 50)]!, Mode.Car)!;
    expect(path).not.toBeNull();
    const traffic = new TrafficSystem();
    traffic.rebuild(graph);
    expect(traffic.enter(path, VehicleKind.Car, 1, 0)).toBeGreaterThanOrEqual(0);

    const pose = { x: 0, z: 0, heading: 0, edge: -1 };
    let maxTurn = 0;
    let maxStep = 0;
    let turned = 0;
    for (let t = 0; t < 8; t++) {
      traffic.tick(graph, t);
      if (traffic.events.length > 0) break;
      let prev: { x: number; z: number; h: number } | null = null;
      // 描画のフレーム間隔で追う（1 tick を 60 分割）。
      for (let s = 0; s < 60; s++) {
        if (!traffic.pose(graph, 0, t * 60 + s, pose)) break;
        if (prev) {
          let d = pose.heading - prev.h;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          maxTurn = Math.max(maxTurn, Math.abs(d));
          turned += Math.abs(d);
          maxStep = Math.max(maxStep, Math.hypot(pose.x - prev.x, pose.z - prev.z));
        }
        prev = { x: pose.x, z: pose.z, h: pose.heading };
      }
    }
    // 直角ぶんはきちんと曲がる
    expect(turned).toBeGreaterThan(Math.PI / 2 - 0.2);
    // ただし 1 フレームでまとめて曲がらない（折れ線のままなら必ず π/2 が出る）
    expect(maxTurn).toBeLessThan(0.35);
    // 位置も飛ばない（1 フレーム = 1 秒ぶんの自由流距離に収まる）
    expect(maxStep).toBeLessThan((TILE_M * (30 / 3.6)) / TILE_SPAN_M + 0.05);
  });


  it('tick の途中でも位置が連続している（瞬間移動しない）', () => {
    // 車は 1 tick に 3〜4 リンク進む。描画は tick の中を 12 分割してなぞるので、
    // その各時点で「そのとき本当にいた場所」が返らないと 4 マス飛んで見える。
    const fx = straightRoad(30, 46);
    expect(fx.traffic.enter(fx.path, VehicleKind.Car, 0, 0)).toBe(0);
    const pose = { x: 0, z: 0, heading: 0, edge: -1 };
    const xs: number[] = [];
    for (let t = 0; t < 12; t++) {
      fx.traffic.tick(fx.graph, t);
      const done = fx.traffic.events.length > 0;
      fx.traffic.events.length = 0;
      // 直前に計算し終えた tick の中をなぞる（描画と同じ時刻の取り方）
      for (let k = 0; k < 12; k++) {
        if (!fx.traffic.pose(fx.graph, 0, (t + k / 12) * 60, pose)) break;
        xs.push(pose.x);
      }
      if (done) break;
    }
    expect(xs.length).toBeGreaterThan(40);
    // 東へ一直線の道なので、x は後戻りせず、1 コマの移動はリンク 1 本ぶんを超えない
    let maxStep = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i]! - xs[i - 1]!;
      expect(d).toBeGreaterThanOrEqual(-1e-6);
      maxStep = Math.max(maxStep, d);
    }
    expect(maxStep).toBeLessThanOrEqual(TILE_M * 1.01);
    // ちゃんと何リンクぶんも進んでいる（止まったまま滑らかなのでは意味がない）
    expect(xs[xs.length - 1]! - xs[0]!).toBeGreaterThan(TILE_M * 8);
  });

});
