import { MAX_TRUCKS, REORDER_FRACTION, TRUCK_CAPACITY } from '@shared/constants';
import { Good, Mode } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import type { Rng } from '@sim/core/rng';
import type { Graph } from '@sim/network/graph';
import { reversePath, type Path } from '@sim/network/pathfinder';
import { VehicleKind, type TrafficSystem } from '@sim/network/traffic';
import type { Router } from '@sim/network/router';
import type { TazMatrix } from '@sim/network/tazMatrix';
import { tazOf } from '@sim/world/tiles';

/**
 * 物流。消費側の在庫が減ったら発注し、供給側からトラックが出る。
 *
 * 重要なのは、トラックが市民と同じ道路グラフを A* で走り、**同じ交通流に載る**こと。
 * トラックも交差点で信号待ちし、道路の枠を食う（`TRUCK_PLATOON_EQUIV`）。つまり工場を市街地の
 * 反対側に置けば、その物流が実際に通勤路を詰まらせる。悪い都市計画が渋滞として返る。
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
  /** 消費建物の何番目の入力か。輸送中の数量を戻すのに使う。 */
  inputIndex: Uint8Array;
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
    this.inputIndex = new Uint8Array(capacity);
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

  /** 発注の走査位置。セーブ／ロードで復元する。 */
  get scanCursor(): number {
    return this.cursor;
  }
  set scanCursor(v: number) {
    this.cursor = Math.max(0, Math.floor(v));
  }
  /** 稼働中トラック数（O(n) の再カウントを避けるため増減で持つ）。 */
  private activeTrucks = 0;
  /**
   * (消費建物スロット * 2 + 入力番号) -> 供給元スロット。取引先の固定。
   * インスペクタで「どこから仕入れているか」を出すためにも使う。
   */
  private lastSupplier = new Map<number, number>();
  /**
   * (消費建物スロット * 2 + 入力番号) -> 輸送中の数量。
   *
   * これが無いと、配送に時間がかかる間じゅう同じ店に何度も発注し続ける。
   * 移動が一瞬だった頃は害が出なかったが、交通流を入れて配送が実時間を食うようになった
   * 途端、同じ 1 軒に何十台も向かってトラック上限を食い潰し、資源地への道が
   * 空車と実車で恒久的に詰まった（走行中 626 台、うち 571 台がトラック）。
   */
  private inTransit = new Map<number, number>();

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
    this.inTransit.clear();
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
    traffic: TrafficSystem,
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
        const stock = k === 0 ? buildings.inAmtA[consumer]! : buildings.inAmtB[consumer]!;
        const cap = a.storage;
        // 「今ある在庫 + 向かっている荷物」で判定する。輸送中を数えないと、
        // 到着するまで同じ発注を繰り返してトラックが際限なく増える。
        const coming = this.inTransit.get(consumer * 2 + k) ?? 0;
        const have = stock + coming;
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
        const transitKey = consumer * 2 + k;
        if (amount <= 0) {
          this.trucks.free(truck);
          continue;
        }

        // 交通流へ投入する。出口のリンクが埋まっていたら積み込まずに次回へ回す。
        if (traffic.enter(path, VehicleKind.Truck, truck, tick) < 0) {
          this.trucks.free(truck);
          this.stats.deferredBudget++;
          continue;
        }
        buildings.outAmt[best] = buildings.outAmt[best]! - amount;
        this.inTransit.set(transitKey, coming + amount);
        this.trucks.inputIndex[truck] = k;

        this.trucks.alive[truck] = 1;
        this.trucks.fromSlot[truck] = best;
        this.trucks.toSlot[truck] = consumer;
        this.trucks.good[truck] = need.good;
        this.trucks.amount[truck] = amount;
        this.trucks.state[truck] = TruckState.Outbound;
        this.trucks.departTick[truck] = tick;
        this.trucks.arriveTick[truck] = tick + Math.max(1, Math.round(path.costSec / 60)); // 見込み
        this.trucks.path[truck] = path;
        this.activeTrucks++;
        this.stats.dispatched++;
        this.totalDispatched++;
        dispatchedNow++;
      }
    }
  }

  /** 輸送中の数量から、このトラックのぶんを取り除く。 */
  private clearTransit(truck: number): void {
    const key = this.trucks.toSlot[truck]! * 2 + this.trucks.inputIndex[truck]!;
    const left = (this.inTransit.get(key) ?? 0) - this.trucks.amount[truck]!;
    if (left > 0.001) this.inTransit.set(key, left);
    else this.inTransit.delete(key);
  }

  /** 統計の更新だけ。到着は交通流からの通知（onTruckEvent）で処理する。 */
  update(_buildings: BuildingStore, _tick: number): void {
    this.stats.active = this.activeTrucks;
  }

  /**
   * 交通流からの通知。トラックの往路・帰路はここで切り替わる。
   *
   * aborted は、グリッドロックの打ち切りか、走行中に道路が作り直されたとき。
   * 積荷は供給元に戻す。落とすとサプライチェーンが道路工事のたびに痩せていく。
   */
  onTruckEvent(
    buildings: BuildingStore,
    graph: Graph,
    traffic: TrafficSystem,
    truck: number,
    aborted: boolean,
    tick: number,
  ): void {
    if (this.trucks.alive[truck] !== 1) return;
    const from = this.trucks.fromSlot[truck]!;
    const to = this.trucks.toSlot[truck]!;

    if (aborted) {
      if (this.trucks.state[truck] === TruckState.Outbound) {
        // 輸送中の予約を必ず落とす。**供給元が生きているかどうかとは無関係**。
        // 以前は荷物を返す処理と一緒に alive の内側にあったので、供給元が
        // 撤去・廃業していると予約が残り続け、その消費建物は
        // 「もう来る予定がある」と判断して二度と発注しなくなっていた（＝静かに餓死する）。
        // 道路を 1 マス編集するだけで走行中のトラックは全部中断されるので、
        // 供給元の取り壊しと同時なら確実に踏む。
        this.clearTransit(truck);
        if (buildings.alive[from] === 1) {
          buildings.outAmt[from] = buildings.outAmt[from]! + this.trucks.amount[truck]!;
        }
      }
      this.trucks.free(truck);
      this.activeTrucks--;
      return;
    }

    if (this.trucks.state[truck] === TruckState.Outbound) {
      this.clearTransit(truck);
      if (buildings.alive[to] === 1) {
        const a = archetype(buildings.archetypeId[to]!);
        const good = this.trucks.good[truck]! as Good;
        const amount = this.trucks.amount[truck]!;
        if (buildings.inGoodA[to] === good) {
          buildings.inAmtA[to] = Math.min(a.storage, buildings.inAmtA[to]! + amount);
        } else if (buildings.inGoodB[to] === good) {
          buildings.inAmtB[to] = Math.min(a.storage, buildings.inAmtB[to]! + amount);
        }
        this.stats.delivered++;
        this.totalDelivered++;
      }
      // 帰路。空車も道路を占有するので、同じ交通流に載せて往路を逆にたどる。
      const outbound = this.trucks.path[truck];
      const back = outbound ? reversePath(graph, outbound) : null;
      if (back && traffic.enter(back, VehicleKind.Truck, truck, tick) >= 0) {
        this.trucks.state[truck] = TruckState.Returning;
        this.trucks.path[truck] = back;
        this.trucks.departTick[truck] = tick;
        this.trucks.arriveTick[truck] = tick + Math.max(1, Math.round(back.costSec / 60));
        return;
      }
    }

    this.trucks.free(truck);
    this.activeTrucks--;
  }
}

function accessNode(buildings: BuildingStore, graph: Graph, slot: number): number {
  const t = buildings.accessTile[slot]!;
  if (t < 0) return -1;
  return graph.roadNodeAt[t]!;
}
