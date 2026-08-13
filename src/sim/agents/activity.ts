import {
  REROUTE_ETA_RATIO,
  REROUTE_PROBABILITY,
  TICKS_PER_DAY,
} from '@shared/constants';
import { Activity, Good, Mode, Purpose, Zone } from '@shared/enums';
import type { Clock } from '@sim/core/clock';
import type { Rng } from '@sim/core/rng';
import type { TimeWheel } from '@sim/core/timeWheel';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import { handleSlot } from '@sim/buildings/buildings';
import type { Graph } from '@sim/network/graph';
import {
  emptyModeTimes,
  evaluateModes,
  newModeOptions,
  sampleMode,
  type ModeOption,
  type ModeTimes,
} from '@sim/network/modeChoice';
import { pathPosition, type PathPose } from '@sim/network/pathfinder';
import type { Router } from '@sim/network/router';
import type { TazMatrix } from '@sim/network/tazMatrix';
import { MODE_NAMES_JA } from '@shared/enums';
import { tileDistanceM } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import { CitizenFlag, type CitizenStore } from './citizens';
import { SCHEDULES } from './schedules';
import type { Destinations } from './destinations';

export interface ActivityContext {
  world: World;
  buildings: BuildingStore;
  citizens: CitizenStore;
  graph: Graph;
  router: Router;
  taz: TazMatrix;
  wheel: TimeWheel;
  clock: Clock;
  rng: Rng;
  destinations: Destinations;
}

export interface ActivityStats {
  tripsStarted: number;
  tripsCompleted: number;
  tripsFailed: number;
  shoppingSuccess: number;
  shoppingFailed: number;
  /** モード別の完了トリップ数（分担率の算出用）。 */
  modeCounts: [number, number, number, number];
  commuteMinutesSum: number;
  commuteCount: number;
}

export function newActivityStats(): ActivityStats {
  return {
    tripsStarted: 0,
    tripsCompleted: 0,
    tripsFailed: 0,
    shoppingSuccess: 0,
    shoppingFailed: 0,
    modeCounts: [0, 0, 0, 0],
    commuteMinutesSum: 0,
    commuteCount: 0,
  };
}

/**
 * 市民の行動状態機械。
 *
 *   就寝 → 在宅 → (出発準備) → 移動中 → 勤務/通学/買い物/レジャー → … → 帰宅 → 就寝
 *
 * 出発準備 (WaitingForRoute) を独立した状態に切ったのが要点。経路探索の予算が
 * 尽きた市民はここに留まり、次 tick に再要求する。プレイヤから見れば出発が数分
 * ずれるだけで、フレームは落ちない。
 */
export class ActivitySystem {
  readonly stats = newActivityStats();
  /** 経路探索待ちの市民。毎 tick 処理する。 */
  private waiting: number[] = [];
  private readonly options: ModeOption[] = newModeOptions();
  private readonly times: ModeTimes = emptyModeTimes();
  private readonly profile = {
    id: 0,
    prefWalk: 0,
    prefBike: 0,
    prefCar: 0,
    prefRail: 0,
    incomeYenMo: 0,
    age: 30,
    hasCar: false,
    hasTransitPass: false,
  };
  /** インスペクタ用に選択理由を残す市民 ID（プレイヤが選択中の 1 人）。 */
  inspectedCitizen = -1;
  lastChoiceExplanation: ModeOption[] | null = null;

  resetDailyStats(): void {
    this.stats.tripsStarted = 0;
    this.stats.tripsCompleted = 0;
    this.stats.tripsFailed = 0;
    this.stats.shoppingSuccess = 0;
    this.stats.shoppingFailed = 0;
    this.stats.modeCounts = [0, 0, 0, 0];
    this.stats.commuteMinutesSum = 0;
    this.stats.commuteCount = 0;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** 市民を明日の最初のステップに乗せる（生成時・転入時に呼ぶ）。 */
  initCitizen(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    c.state[id] = Activity.AtHome;
    c.scheduleStep[id] = 0;
    const home = c.homeBuilding[id]!;
    if (ctx.buildings.valid(home)) {
      c.currentTile[id] = ctx.buildings.originTile[handleSlot(home)]!;
    }
    this.scheduleNextStep(ctx, id);
  }

  /** この tick に起床する市民を処理する。 */
  tick(ctx: ActivityContext): void {
    const due = ctx.wheel.drain(ctx.clock.tick);
    const n = ctx.wheel.drainedCount;
    for (let k = 0; k < n; k++) {
      const id = due[k]!;
      if (!ctx.citizens.isAlive(id)) continue;
      this.onWake(ctx, id);
    }
    this.processWaiting(ctx);
  }

  // ---------------- 状態遷移 ----------------

  private onWake(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    switch (c.state[id]) {
      case Activity.Traveling:
        this.onArrive(ctx, id);
        break;
      default:
        this.beginNextStep(ctx, id);
        break;
    }
  }

  /** スケジュールの次のステップへ進む。移動が必要なら出発準備に入る。 */
  private beginNextStep(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    const tmpl = SCHEDULES[c.scheduleId[id]!] ?? SCHEDULES[0]!;
    const stepIdx = c.scheduleStep[id]! % tmpl.steps.length;
    const st = tmpl.steps[stepIdx]!;

    // スキップ判定（買い物・レジャーの寄り道）
    let skip = st.skipChance > 0 && ctx.rng.chance(st.skipChance);
    // レジャーは個人の外出嗜好で補正する
    if (!skip && st.activity === Activity.Leisure) {
      skip = ctx.rng.next() > c.leisureTaste[id]! / 255;
    }

    const dest = skip ? 0 : this.destinationFor(ctx, id, st.activity);
    if (dest === 0 || skip) {
      // 寄り道しない / 行き先が無い → その場に留めて次のステップへ。
      //
      // ここで在宅に落とすと、勤務先にいる市民が自宅へ瞬間移動してしまう。
      // 会社員は買い物 40%・レジャー 25% で寄り道するので、両方外した
      // 4 割強が「夕方に職場から消えて家に湧く」状態になり、帰宅トリップが
      // 発生していなかった（夕ラッシュがほぼ半分になっていた）。
      this.advanceStep(ctx, id);
      return;
    }

    const destSlot = handleSlot(dest);
    const destTile = ctx.buildings.originTile[destSlot]!;
    if (destTile === c.currentTile[id]) {
      this.settleAt(ctx, id, st.activity, dest);
      this.advanceStep(ctx, id);
      return;
    }

    c.destBuilding[id] = dest;
    c.purpose[id] = st.purpose;
    c.state[id] = Activity.WaitingForRoute;
    c.waitingSince[id] = ctx.clock.tick;
    this.waiting.push(id);
  }

  /** 出発準備中の市民に経路を割り当てる。 */
  private processWaiting(ctx: ActivityContext): void {
    if (this.waiting.length === 0) return;
    const c = ctx.citizens;
    const still: number[] = [];
    for (const id of this.waiting) {
      if (!c.isAlive(id) || c.state[id] !== Activity.WaitingForRoute) continue;
      const outcome = this.tryDepart(ctx, id);
      if (outcome === 'deferred') {
        still.push(id);
      }
    }
    this.waiting = still;
  }

  private tryDepart(ctx: ActivityContext, id: number): 'departed' | 'deferred' | 'failed' {
    const c = ctx.citizens;
    const dest = c.destBuilding[id]!;
    if (!ctx.buildings.valid(dest)) {
      this.failTrip(ctx, id);
      return 'failed';
    }
    const destSlot = handleSlot(dest);
    const originTile = c.currentTile[id]!;
    const originRoad = ctx.world.nearestRoadTile(originTile, 4);
    const destRoad = ctx.buildings.accessTile[destSlot]!;
    if (originRoad < 0 || destRoad < 0) {
      this.failTrip(ctx, id);
      return 'failed';
    }
    const originNode = ctx.graph.roadNodeAt[originRoad]!;
    const destNode = ctx.graph.roadNodeAt[destRoad]!;
    if (originNode < 0 || destNode < 0) {
      this.failTrip(ctx, id);
      return 'failed';
    }

    // --- 候補モードの評価。所要時間は TAZ 行列の概算を使い、実 A* は選ばれた 1 本だけ。
    const purpose = c.purpose[id]! as Purpose;
    const destZone = (ctx.buildings.zoneOf(destSlot) || Zone.None) as Zone;
    this.fillTimes(ctx, originTile, destTileOf(ctx, destSlot), originNode, destNode);
    c.fillProfile(id, this.profile);
    evaluateModes(this.profile, this.times, purpose, destZone, this.options);
    const mode = sampleMode(this.options, ctx.rng);
    if (mode === -1) {
      this.failTrip(ctx, id);
      return 'failed';
    }

    const path = ctx.router.getPath(ctx.graph, originNode, destNode, mode, id + 1);
    if (path === undefined) return 'deferred'; // 予算切れ。次 tick に再挑戦。
    if (path === null) {
      this.failTrip(ctx, id);
      return 'failed';
    }

    // --- 出発 ---
    const travelMin = Math.max(1, Math.round(path.costSec / 60));
    c.state[id] = Activity.Traveling;
    c.mode[id] = mode;
    c.tripPath[id] = path;
    c.tripDepartTick[id] = ctx.clock.tick;
    c.tripArriveTick[id] = ctx.clock.tick + travelMin;
    ctx.wheel.schedule(id, ctx.clock.tick + travelMin, ctx.clock.tick);
    this.stats.tripsStarted++;

    // 自動車・トラックはエッジの交通量に寄与する = 渋滞を作る
    if (mode === Mode.Car) {
      for (let e = 0; e < path.edges.length; e++) ctx.graph.recordTraversal(path.edges[e]!);
    }

    if (id === this.inspectedCitizen) {
      this.lastChoiceExplanation = this.options.map((o) => ({ ...o }));
    }
    return 'departed';
  }

  /** 各モードの所要時間を埋める。 */
  private fillTimes(ctx: ActivityContext, originTile: number, destTile: number, originNode: number, destNode: number): void {
    for (let m = 0; m < 4; m++) {
      const mode = m as Mode;
      // TAZ 行列で概算（配列参照 1 回）。同一 TAZ 内は行列が 0 になるので直線距離で補う。
      let sec = ctx.taz.costBetweenTiles(originTile, destTile, mode);
      // シミュレーション上の実距離を使う。tileCenterX/Z は描画単位なので、
      // ここに使うと 1/15 の距離で所要時間と運賃を見積もることになる。
      const straight = tileDistanceM(originTile, destTile);
      if (!Number.isFinite(sec) || sec <= 0) {
        // 行列がまだ埋まっていない / 同一ゾーン → 直線距離ベースの概算
        const speedMs = mode === Mode.Walk ? 1.33 : mode === Mode.Bike ? 4.2 : mode === Mode.Car ? 8.3 : 12;
        sec = (straight / speedMs) * 1.35;
        // 鉄道は駅が近くに無ければ使えない
        if (mode === Mode.Rail) {
          const a = ctx.world.transitAccess[originTile]!;
          const b = ctx.world.transitAccess[destTile]!;
          if (a >= 255 || b >= 255) sec = Infinity;
          else sec += (a + b) * 60;
        }
      } else if (mode === Mode.Rail) {
        const a = ctx.world.transitAccess[originTile]!;
        const b = ctx.world.transitAccess[destTile]!;
        if (a >= 255 || b >= 255) sec = Infinity;
      }
      this.times.sec[m] = sec;
      this.times.meters[m] = straight * 1.25; // 迂回率
    }
    // ノードが取れない（＝道路網から切り離されている）モードは使えない
    if (originNode < 0 || destNode < 0) {
      for (let m = 0; m < 4; m++) this.times.sec[m] = Infinity;
    }
  }

  /** 目的地に到着。 */
  private onArrive(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    const dest = c.destBuilding[id]!;
    const tmpl = SCHEDULES[c.scheduleId[id]!] ?? SCHEDULES[0]!;
    const st = tmpl.steps[c.scheduleStep[id]! % tmpl.steps.length]!;

    const travelMin = c.tripArriveTick[id]! - c.tripDepartTick[id]!;
    this.stats.tripsCompleted++;
    this.stats.modeCounts[c.mode[id]!]! += 1;
    c.tripsCompleted[id] = c.tripsCompleted[id]! + 1;
    if (c.purpose[id] === Purpose.Commute) {
      c.lastCommuteMin[id] = Math.min(65535, travelMin);
      this.stats.commuteMinutesSum += travelMin;
      this.stats.commuteCount++;
      // 通勤が長いほど不満が溜まる
      if (travelMin > 60) this.adjustHappiness(ctx, id, -3);
      else if (travelMin < 25) this.adjustHappiness(ctx, id, 1);
    }

    c.tripPath[id] = null;
    if (ctx.buildings.valid(dest)) {
      const slot = handleSlot(dest);
      c.currentTile[id] = ctx.buildings.originTile[slot]!;
      this.applyArrivalEffect(ctx, id, slot, st.activity);
    }
    this.settleAt(ctx, id, st.activity, dest);
    this.advanceStep(ctx, id);
  }

  /** 到着先での効果（買い物なら在庫を消費し、無ければ不満になる）。 */
  private applyArrivalEffect(ctx: ActivityContext, id: number, slot: number, activity: Activity): void {
    if (activity === Activity.Shopping) {
      const b = ctx.buildings;
      // 商店は食品を売る。在庫があれば満足、無ければ不満（＝物流の失敗が市民に伝わる経路）。
      let bought = false;
      if (b.inGoodA[slot] === Good.Food && b.inAmtA[slot]! >= 1) {
        b.inAmtA[slot] = b.inAmtA[slot]! - 1;
        bought = true;
      } else if (b.inGoodB[slot] === Good.ConsumerGoods && b.inAmtB[slot]! >= 1) {
        b.inAmtB[slot] = b.inAmtB[slot]! - 1;
        bought = true;
      }
      if (bought) {
        b.revenueYen[slot] = b.revenueYen[slot]! + 1800;
        this.stats.shoppingSuccess++;
        this.adjustHappiness(ctx, id, 2);
      } else {
        this.stats.shoppingFailed++;
        this.adjustHappiness(ctx, id, -6);
      }
    } else if (activity === Activity.Leisure) {
      const appeal = archetype(ctx.buildings.archetypeId[slot]!).leisureAppeal;
      this.adjustHappiness(ctx, id, appeal > 40 ? 3 : 1);
    }
  }

  private settleAt(ctx: ActivityContext, id: number, activity: Activity, building: number): void {
    const c = ctx.citizens;
    c.state[id] = activity;
    if (ctx.buildings.valid(building)) {
      c.currentTile[id] = ctx.buildings.originTile[handleSlot(building)]!;
    }
  }

  /** トリップ失敗。家に戻して、次のステップへ。 */
  private failTrip(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    this.stats.tripsFailed++;
    this.adjustHappiness(ctx, id, -4);
    c.tripPath[id] = null;
    const home = c.homeBuilding[id]!;
    this.settleAt(ctx, id, Activity.AtHome, home);
    this.advanceStep(ctx, id);
  }

  /** 次のスケジュールステップの時刻を計算して予約する。 */
  private advanceStep(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    const tmpl = SCHEDULES[c.scheduleId[id]!] ?? SCHEDULES[0]!;
    c.scheduleStep[id] = (c.scheduleStep[id]! + 1) % tmpl.steps.length;
    this.scheduleNextStep(ctx, id);
  }

  private scheduleNextStep(ctx: ActivityContext, id: number): void {
    const c = ctx.citizens;
    const tmpl = SCHEDULES[c.scheduleId[id]!] ?? SCHEDULES[0]!;
    const st = tmpl.steps[c.scheduleStep[id]! % tmpl.steps.length]!;
    // 個人ごとに固定のジッタ。毎日同じ人が同じ時刻に動くので、
    // 通勤 OD が繰り返され経路キャッシュがよく効く。
    const jitter = st.jitter > 0 ? ((id * 2654435761) % (st.jitter * 2)) - st.jitter : 0;
    const target = (st.startMinute + jitter + TICKS_PER_DAY) % TICKS_PER_DAY;
    const nowMin = ctx.clock.tick % TICKS_PER_DAY;
    let delta = target - nowMin;
    if (delta <= 0) delta += TICKS_PER_DAY;
    const when = ctx.clock.tick + delta;
    c.wakeTick[id] = when;
    ctx.wheel.schedule(id, when, ctx.clock.tick);
  }

  /** そのアクティビティの行き先となる建物ハンドル。 */
  private destinationFor(ctx: ActivityContext, id: number, activity: Activity): number {
    const c = ctx.citizens;
    switch (activity) {
      case Activity.AtWork:
        return c.workBuilding[id]!;
      case Activity.AtSchool:
        return ctx.destinations.pickSchool(ctx, c.currentTile[id]!);
      case Activity.Shopping:
        return ctx.destinations.pickShop(ctx, c.currentTile[id]!);
      case Activity.Business:
        return ctx.destinations.pickBusiness(ctx, c.currentTile[id]!);
      case Activity.Leisure:
        return ctx.destinations.pickLeisure(ctx, c.currentTile[id]!);
      case Activity.AtHome:
      case Activity.Sleeping:
      default:
        return c.homeBuilding[id]!;
    }
  }

  private adjustHappiness(ctx: ActivityContext, id: number, delta: number): void {
    const c = ctx.citizens;
    c.happiness[id] = Math.max(0, Math.min(255, c.happiness[id]! + delta));
  }

  /**
   * 走行中の再ルーティング。ETA を大幅に超過していて、かつ確率ゲートを通った
   * 市民だけが対象。全員が一斉に経路を変えると交通が発振するため、
   * ここを確率的にしておくことが安定性の要。
   */
  reroutePass(ctx: ActivityContext, sample: readonly number[]): void {
    const c = ctx.citizens;
    for (const id of sample) {
      if (!c.isAlive(id) || c.state[id] !== Activity.Traveling) continue;
      if (c.mode[id] !== Mode.Car) continue;
      if (!ctx.rng.chance(REROUTE_PROBABILITY)) continue;
      const path = c.tripPath[id];
      if (!path) continue;
      if (path.version !== ctx.graph.version) continue;
      const elapsed = ctx.clock.tick - c.tripDepartTick[id]!;
      const planned = c.tripArriveTick[id]! - c.tripDepartTick[id]!;
      if (elapsed < planned * REROUTE_ETA_RATIO) continue;
      // 遅れている → 到着時刻を伸ばす（実質的な渋滞の体感）
      c.tripArriveTick[id] = ctx.clock.tick + Math.max(1, Math.round(planned * 0.25));
      ctx.wheel.schedule(id, c.tripArriveTick[id]!, ctx.clock.tick);
    }
  }

  /** インスペクタ用: 交通手段の選択理由を人が読める形にする。 */
  explainLastChoice(): string[] {
    if (!this.lastChoiceExplanation) return [];
    return this.lastChoiceExplanation.map((o) => {
      if (!o.available) return `${MODE_NAMES_JA[o.mode]}: 利用不可`;
      return `${MODE_NAMES_JA[o.mode]}: ${o.timeMin.toFixed(0)}分 / ${Math.round(o.costYen)}円 / 選択率 ${(o.probability * 100).toFixed(0)}%`;
    });
  }
}

function destTileOf(ctx: ActivityContext, slot: number): number {
  return ctx.buildings.originTile[slot]!;
}

/**
 * 市民が「移動中」かつ経路を持つとき、現在位置をワールド座標で返す（描画用）。
 *
 * `tick` は端数を含んでよい。描画側はフレームごとの端数 tick を渡すことで、
 * 12 tick/秒のシミュレーションでも 60fps の滑らかな動きになる。
 */
export function citizenPosition(
  citizens: CitizenStore,
  graph: Graph,
  id: number,
  tick: number,
  out: PathPose,
): boolean {
  const path = citizens.tripPath[id];
  if (!path) return false;
  const depart = citizens.tripDepartTick[id]!;
  const arrive = citizens.tripArriveTick[id]!;
  const total = Math.max(1, arrive - depart);
  return pathPosition(graph, path, (tick - depart) / total, out);
}

export { CitizenFlag };
