import { MAX_TRUCKS, REORDER_FRACTION, TRUCK_CAPACITY } from '@shared/constants';
import { Good, Mode } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import type { Rng } from '@sim/core/rng';
import type { Graph } from '@sim/network/graph';
import type { Path } from '@sim/network/pathfinder';
import type { Router } from '@sim/network/router';
import type { TazMatrix } from '@sim/network/tazMatrix';
import { tazOf } from '@sim/world/tiles';

/**
 * 物流。消費側の在庫が減ったら発注し、供給側からトラックが出る。
 *
 * 重要なのは、トラックが市民と同じ道路グラフを A* で走り、
 * **同じエッジの交通量に加算される**こと。つまり工場を市街地の反対側に置けば、
 * その物流が実際に通勤路を混雑させる。悪い都市計画が渋滞として返る仕組み。
 */

export const TruckState = {
  Outbound: 0, // 供給元 → 消費先
  Returning: 1, // 消費先 → 供給元
} as const;

export interface FreightStats {
  active: number;
  dispatched: number;
  delivered: number;
  failedNoPath: number;
  failedNoSupplier: number;
  /** 経路探索の予算切れで見送った件数。物流が滞る主因になりうるので必ず観測する。 */
  deferredBudget: number;
  /** 在庫が足りていて発注不要だった件数。 */
  skippedStocked: number;
  /** トラック上限に達して打ち切った回数。 */
  cappedTrucks: number;
}

/** トラック（SoA）。 */
export class TruckStore {
  capacity: number;
  high = 0;
  private freeList: number[] = [];

  alive: Uint8Array;
  fromSlot: Int32Array;
  toSlot: Int32Array;
  good: Uint8Array;
  amount: Float32Array;
  state: Uint8Array;
  departTick: Uint32Array;
  arriveTick: Uint32Array;
  path: (Path | null)[] = [];

  constructor(capacity = MAX_TRUCKS) {
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.fromSlot = new Int32Array(capacity);
    this.toSlot = new Int32Array(capacity);
    this.good = new Uint8Array(capacity);
    this.amount = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.departTick = new Uint32Array(capacity);
    this.arriveTick = new Uint32Array(capacity);
    for (let i = 0; i < capacity; i++) this.path.push(null);
  }

  alloc(): number {
    const s = this.freeList.pop();
    if (s !== undefined) return s;
    if (this.high >= this.capacity) return -1;
    return this.high++;
  }

  free(i: number): void {
    this.alive[i] = 0;
    this.path[i] = null;
    this.freeList.push(i);
  }

  count(): number {
    let c = 0;
    for (let i = 0; i < this.high; i++) if (this.alive[i] === 1) c++;
    return c;
  }

  *each(): Generator<number> {
    for (let i = 0; i < this.high; i++) if (this.alive[i] === 1) yield i;
  }
}

export class FreightSystem {
  readonly trucks = new TruckStore();
  /** 累計値（日次リセットされない）。検証と UI の累積表示に使う。 */
  totalDispatched = 0;
  totalDelivered = 0;
  readonly stats: FreightStats = {
    active: 0,
    dispatched: 0,
    delivered: 0,
    failedNoPath: 0,
    failedNoSupplier: 0,
    deferredBudget: 0,
    skippedStocked: 0,
    cappedTrucks: 0,
  };
  /** 資源ごとの供給元インデックス（在庫を持つ建物）。 */
  private suppliers = new Map<Good, number[]>();
  private rebuildCountdown = 0;
  /** 入力を必要とする建物のリストと、走査位置。 */
  private consumers: number[] = [];
  private cursor = 0;
  /** 稼働中トラック数（O(n) の再カウントを避けるため増減で持つ）。 */
  private activeTrucks = 0;
  /**
   * (消費建物スロット * 2 + 入力番号) -> 供給元スロット。取引先の固定。
   * インスペクタで「どこから仕入れているか」を出すためにも使う。
   */
  private lastSupplier = new Map<number, number>();

  /** 消費建物がどこから仕入れているか（建物インスペクタ用）。 */
  supplierOf(consumerSlot: number, inputIndex: number): number {
    return this.lastSupplier.get(consumerSlot * 2 + inputIndex) ?? -1;
  }

  /**
   * 走行中のトラックを全部降ろして、供給元インデックスも捨てる。
   *
   * セーブデータの読み込み時に呼ぶ。トラックは経路オブジェクトを抱えていて、
   * 読み込み後のグラフでは節点番号が変わっているので、そのまま走らせると
   * 存在しないエッジの上を走る。積荷は次の発注でやり直せば足りる。
   */
  reset(): void {
    for (let i = 0; i < this.trucks.high; i++) {
      if (this.trucks.alive[i] === 1) this.trucks.free(i);
    }
    this.activeTrucks = 0;
    this.suppliers.clear();
    this.consumers.length = 0;
    this.cursor = 0;
    this.rebuildCountdown = 0;
    this.lastSupplier.clear();
    this.stats.active = 0;
  }

  resetPeriodStats(): void {
    this.stats.dispatched = 0;
    this.stats.delivered = 0;
    this.stats.failedNoPath = 0;
    this.stats.failedNoSupplier = 0;
    this.stats.deferredBudget = 0;
    this.stats.skippedStocked = 0;
    this.stats.cappedTrucks = 0;
  }

  private rebuildIndexes(buildings: BuildingStore): void {
    this.suppliers.clear();
    this.consumers.length = 0;
    for (const s of buildings.each()) {
      const g = buildings.outGood[s]! as Good;
      if (g !== Good.None && buildings.outAmt[s]! >= 1) {
        let list = this.suppliers.get(g);
        if (!list) {
          list = [];
          this.suppliers.set(g, list);
        }
        list.push(s);
      }
      if (archetype(buildings.archetypeId[s]!).inputs.length > 0) this.consumers.push(s);
    }
  }

  /**
   * 発注と配車。一定間隔で呼ぶ。
   * 供給元の選定は TAZ 行列の概算だけで行い、実 A* は実際に走る 1 台分のみ。
   */
  dispatch(
    buildings: BuildingStore,
    graph: Graph,
    router: Router,
    taz: TazMatrix,
    rng: Rng,
    tick: number,
  ): void {
    if (this.rebuildCountdown-- <= 0) {
      this.rebuildIndexes(buildings);
      this.rebuildCountdown = 6;
    }
    if (this.suppliers.size === 0 || this.consumers.length === 0) return;

    let dispatchedNow = 0;
    const maxPerCall = 64;
    // 消費側は毎回同じ順に舐めるのではなく、前回の続きから回す。
    // 先頭固定にすると、リストの前方の店だけが補充され、後方の店は永久に欠品する
    // （実際にこれで街じゅうの商店が商品切れになった）。
    const scanLimit = Math.min(this.consumers.length, 400);

    for (let scanned = 0; scanned < scanLimit; scanned++) {
      if (dispatchedNow >= maxPerCall) break;
      if (this.activeTrucks >= MAX_TRUCKS) {
        this.stats.cappedTrucks++;
        break;
      }
      const consumer = this.consumers[this.cursor % this.consumers.length]!;
      this.cursor++;
      if (buildings.alive[consumer] !== 1) continue;
      const a = archetype(buildings.archetypeId[consumer]!);
      if (a.inputs.length === 0) continue;
      const consumerTile = buildings.originTile[consumer]!;
      const consumerNode = accessNode(buildings, graph, consumer);
      if (consumerNode < 0) continue;

      for (let k = 0; k < a.inputs.length; k++) {
        const need = a.inputs[k]!;
        const have = k === 0 ? buildings.inAmtA[consumer]! : buildings.inAmtB[consumer]!;
        const cap = a.storage;
        if (have >= cap * REORDER_FRACTION) {
          this.stats.skippedStocked++;
          continue;
        }

        const list = this.suppliers.get(need.good);
        if (!list || list.length === 0) {
          this.stats.failedNoSupplier++;
          continue;
        }

        // --- 取引先の選定 ---
        // 前回と同じ供給元を優先して使い続ける（取引関係の固定）。
        // 毎回ランダムに選び直すと OD ペアが毎回変わって経路キャッシュが
        // 全く効かず、探索予算を食い潰して配送そのものが成立しなくなる。
        // 実際の商取引でも仕入先はそう頻繁には変わらない。
        const key = consumer * 2 + k;
        let best = this.lastSupplier.get(key) ?? -1;
        if (best >= 0 && (buildings.alive[best] !== 1 || buildings.outAmt[best]! < 1 || best === consumer)) {
          best = -1;
        }
        if (best < 0) {
          let bestScore = -Infinity;
          const consumerTaz = tazOf(consumerTile);
          for (let attempt = 0; attempt < 8; attempt++) {
            const cand = list[rng.int(list.length)]!;
            if (buildings.alive[cand] !== 1) continue;
            if (buildings.outAmt[cand]! < 1) continue;
            if (cand === consumer) continue;
            const supTile = buildings.originTile[cand]!;
            const cost = taz.costBetweenZones(tazOf(supTile), consumerTaz, Mode.Car);
            const travelMin = Number.isFinite(cost) ? cost / 60 : 240;
            const score = buildings.outAmt[cand]! - travelMin * 1.5;
            if (score > bestScore) {
              bestScore = score;
              best = cand;
            }
          }
          if (best < 0) {
            this.stats.failedNoSupplier++;
            continue;
          }
          this.lastSupplier.set(key, best);
        }

        const supplierNode = accessNode(buildings, graph, best);
        if (supplierNode < 0) continue;

        // 摂動シードを 0 にして、同じ OD なら市民の経路と同じキャッシュ項に当てる
        const path = router.getPath(graph, supplierNode, consumerNode, Mode.Car, 0);
        if (path === undefined) {
          this.stats.deferredBudget++;
          continue; // 経路探索の予算切れ。次回に回す。
        }
        if (path === null) {
          this.stats.failedNoPath++;
          this.lastSupplier.delete(consumer * 2 + k); // 到達できない相手とは取引しない
          continue;
        }

        const truck = this.trucks.alloc();
        if (truck < 0) break;


        const amount = Math.min(TRUCK_CAPACITY, buildings.outAmt[best]!, cap - have);
        if (amount <= 0) {
          this.trucks.free(truck);
          continue;
        }
        buildings.outAmt[best] = buildings.outAmt[best]! - amount;

        const travelMin = Math.max(1, Math.round(path.costSec / 60));
        this.trucks.alive[truck] = 1;
        this.trucks.fromSlot[truck] = best;
        this.trucks.toSlot[truck] = consumer;
        this.trucks.good[truck] = need.good;
        this.trucks.amount[truck] = amount;
        this.trucks.state[truck] = TruckState.Outbound;
        this.trucks.departTick[truck] = tick;
        this.trucks.arriveTick[truck] = tick + travelMin;
        this.trucks.path[truck] = path;
        this.activeTrucks++;
        // トラックは乗用車より道路を占有する
        for (let e = 0; e < path.edges.length; e++) graph.recordTraversal(path.edges[e]!, 2.5);
        this.stats.dispatched++;
        this.totalDispatched++;
        dispatchedNow++;
      }
    }
  }

  /** 到着したトラックを処理する。毎 tick。 */
  update(buildings: BuildingStore, tick: number): void {
    for (const i of this.trucks.each()) {
      if (tick < this.trucks.arriveTick[i]!) continue;
      const to = this.trucks.toSlot[i]!;
      if (this.trucks.state[i] === TruckState.Outbound) {
        if (buildings.alive[to] === 1) {
          const a = archetype(buildings.archetypeId[to]!);
          const good = this.trucks.good[i]! as Good;
          const amount = this.trucks.amount[i]!;
          if (buildings.inGoodA[to] === good) {
            buildings.inAmtA[to] = Math.min(a.storage, buildings.inAmtA[to]! + amount);
          } else if (buildings.inGoodB[to] === good) {
            buildings.inAmtB[to] = Math.min(a.storage, buildings.inAmtB[to]! + amount);
          }
          this.stats.delivered++;
          this.totalDelivered++;
        }
        // 帰路（空車も交通量に寄与する）
        this.trucks.state[i] = TruckState.Returning;
        const dur = Math.max(1, this.trucks.arriveTick[i]! - this.trucks.departTick[i]!);
        this.trucks.departTick[i] = tick;
        this.trucks.arriveTick[i] = tick + dur;
      } else {
        this.trucks.free(i);
        this.activeTrucks--;
      }
    }
    this.stats.active = this.activeTrucks;
  }
}

function accessNode(buildings: BuildingStore, graph: Graph, slot: number): number {
  const t = buildings.accessTile[slot]!;
  if (t < 0) return -1;
  return graph.roadNodeAt[t]!;
}
