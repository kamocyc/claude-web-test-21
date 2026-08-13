import {
  COST_SMOOTHING_LAMBDA,
  ECONOMY_PERIODS_PER_DAY,
  ECONOMY_PERIOD_TICKS,
  FREIGHT_DISPATCH_INTERVAL,
  LUMBER_IMPORT_YEN,
  NEUTRAL_TAX_PCT,
  RAIL_BUILD_COST,
  ROAD_ACCESS_RADIUS,
  STOCKOUT_ABANDON_DAYS,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  VOLUME_DECAY,
  MAP_H,
  MAP_W,
} from '@shared/constants';
import {
  DemandKind,
  Good,
  Mode,
  ROAD_BUILD_COST,
  RoadClass,
  ZONE_NAMES_JA,
  Zone,
} from '@shared/enums';
import { ActivitySystem, newActivityStats } from '@sim/agents/activity';
import { arrayMap, type SimSnapshot } from '@sim/persistence';
import { CITIZEN_FIELDS, CitizenFlag, CitizenStore } from '@sim/agents/citizens';
import { Destinations } from '@sim/agents/destinations';
import {
  LifecycleSystem,
  createCitizen,
  householdIdCounter,
  newHouseholdId,
  resetHouseholdIds,
  setHouseholdIdCounter,
} from '@sim/agents/lifecycle';
import { Arch, archetype, isShop } from '@sim/buildings/archetypes';
import { BUILDING_FIELDS, BuildingStore, handleSlot } from '@sim/buildings/buildings';
import { computeDemand, taxPenalty, type DemandState } from '@sim/buildings/demand';
import { GrowthSystem } from '@sim/buildings/growth';
import { Clock } from '@sim/core/clock';
import type { AlertKind } from '@sim/core/events';
import { hashArrays } from '@sim/core/hash';
import { Rng } from '@sim/core/rng';
import { TimeWheel } from '@sim/core/timeWheel';
import { Budget, emptyAccrual, type Accrual, type MonthlyReport } from '@sim/economy/budget';
import { FreightSystem } from '@sim/economy/freight';
import { newProductionStats, runProduction, updateStockouts } from '@sim/economy/production';
import { Graph } from '@sim/network/graph';
import { Router } from '@sim/network/router';
import { TazMatrix } from '@sim/network/tazMatrix';
import { updateLandValue, updatePollution, updateServiceCoverage, updateTransitAccess } from '@sim/world/fields';
import { idx, tileX, tileY } from '@sim/world/tiles';
import { World } from '@sim/world/world';
import type { Command } from './commands';
import { CommandLog } from './commands';

/** UI と描画に渡す集計値。 */
export interface SimStats {
  tick: number;
  population: number;
  employed: number;
  unemployed: number;
  homeless: number;
  buildings: number;
  avgHappiness: number;
  avgCommuteMin: number;
  demand: DemandState;
  modeShare: number[];
  tripsCompleted: number;
  tripsFailed: number;
  shoppingFailed: number;
  cash: number;
  /** 今の収支（月換算）。決算を待たずに見える run-rate。 */
  finance: Accrual;
  /** 今月ここまでの建設・撤去・輸入。 */
  capexThisMonth: number;
  deficitMonths: number;
  lastReport: MonthlyReport | null;
  cacheHitRate: number;
  routeQueueDepth: number;
  searchesThisTick: number;
  trucksActive: number;
  stockouts: number;
  goodsStock: Float64Array;
  goodsProduced: Float64Array;
}

/**
 * シミュレーション全体のオーケストレータ。
 *
 * ここが tick 内のサブシステム実行順を固定し、決定論を成立させている。
 * three.js も DOM も一切参照しないので、Node 上のテストとヘッドレス実行で
 * そのまま同じコードが動く。
 */
export class Simulation {
  readonly seed: number;
  readonly world: World;
  readonly buildings = new BuildingStore();
  readonly citizens = new CitizenStore();
  readonly graph = new Graph();
  readonly router = new Router();
  readonly taz = new TazMatrix();
  readonly wheel = new TimeWheel();
  readonly clock = new Clock();
  readonly budget = new Budget();
  readonly growth = new GrowthSystem();
  readonly activity = new ActivitySystem();
  readonly lifecycle = new LifecycleSystem();
  readonly freight = new FreightSystem();
  readonly destinations = new Destinations();
  readonly commandLog = new CommandLog();

  private readonly rng: Rng;
  private readonly production = newProductionStats();
  private demand: DemandState = { residential: 0, commercial: 0, industrial: 0, agriculture: 0 };
  private lastReport: MonthlyReport | null = null;
  /** 今の収支（月換算）。経済期ごとに取り直す。 */
  private finance: Accrual = emptyAccrual();
  /**
   * 駅タイル。建物ストアから毎回導出する。
   * 並行配列として持つと「建物はあるのに交通ノードが無い駅」という
   * サイレントな不整合が必ず生まれる（実際に踏んだ）。単一の真実に寄せる。
   */
  private stationTiles: number[] = [];
  private lumberPool = 0;
  private stockoutCount = 0;
  private foodShortfall = 0;
  private dailyStats = newActivityStats();
  private pendingCommands: Command[] = [];

  constructor(seed = 42) {
    this.seed = seed;
    resetHouseholdIds();
    this.world = new World(seed);
    this.rng = new Rng(seed).fork('sim');
    this.rebuildNetwork();
  }

  // ---------------- コマンド ----------------

  /** コマンドを積む。適用は次の tick 境界。 */
  enqueue(cmd: Command): void {
    this.pendingCommands.push(cmd);
  }

  /**
   * 溜まっているコマンドを今すぐ適用する。
   *
   * 一時停止中は tick が回らないので、道路を引いても何も起きず、課金もされず、
   * 警告も出なかった。停止して街を作るのは普通の遊び方なので、
   * 停止中はアプリ側から毎フレームこれを呼ぶ。
   */
  flushCommands(): void {
    this.applyCommands();
  }

  private applyCommands(): void {
    if (this.pendingCommands.length === 0) return;
    for (const cmd of this.pendingCommands) {
      this.commandLog.record(this.clock.tick, cmd);
      this.apply(cmd);
    }
    this.pendingCommands.length = 0;
  }

  private apply(cmd: Command): void {
    switch (cmd.t) {
      case 'buildRoad': {
        let built = 0;
        let blockedByTerrain = 0;
        let outOfMoney = false;
        for (const tile of cmd.tiles) {
          const cost = ROAD_BUILD_COST[cmd.cls]!;
          if (this.world.road[tile] === cmd.cls) continue;
          if (!this.world.canBuildRoad(tile)) {
            blockedByTerrain++;
            continue;
          }
          if (!this.budget.spend(cost)) {
            outOfMoney = true;
            break;
          }
          this.clearBuildingAt(tile);
          if (this.world.setRoad(tile, cmd.cls)) built++;
          else this.budget.refund(cost);
        }
        if (built > 0) this.onNetworkChanged();
        else if (outOfMoney) this.notify('budgetDeficit', cmd.tiles[0] ?? 0, '資金が足りず道路を敷けませんでした');
        else if (blockedByTerrain > 0) {
          this.notify('noRoadAccess', cmd.tiles[0] ?? 0, '海・河川・山地・急斜面には道路を敷けません');
        }
        break;
      }
      case 'buildRail': {
        let built = 0;
        let blocked = 0;
        let outOfMoney = false;
        for (const tile of cmd.tiles) {
          if (this.world.rail[tile] !== 0) continue;
          if (!this.world.canBuildRail(tile)) {
            blocked++;
            continue;
          }
          if (!this.budget.spend(RAIL_BUILD_COST)) {
            outOfMoney = true;
            break;
          }
          this.clearBuildingAt(tile);
          if (this.world.setRail(tile, true)) built++;
          else this.budget.refund(RAIL_BUILD_COST);
        }
        if (built > 0) this.onNetworkChanged();
        else if (outOfMoney) this.notify('budgetDeficit', cmd.tiles[0] ?? 0, '資金が足りず線路を敷けませんでした');
        else if (blocked > 0) this.notify('noRoadAccess', cmd.tiles[0] ?? 0, 'ここには線路を敷けません');
        break;
      }
      case 'zonePaint': {
        let changed = 0;
        let rejected = 0;
        for (const tile of cmd.tiles) {
          if (this.world.setZone(tile, cmd.zone)) changed++;
          else if (cmd.zone !== Zone.None && this.world.zone[tile] !== cmd.zone) rejected++;
        }
        if (changed > 0) this.growth.markDirty();
        else if (rejected > 0) {
          // 水田は低湿地のみ、林業は森林のみ、といった地形制約で弾かれた場合
          this.notify(
            'noRoadAccess',
            cmd.tiles[0] ?? 0,
            `${ZONE_NAMES_JA[cmd.zone] ?? '用途地域'}はこの地形には指定できません`,
          );
        }
        break;
      }
      case 'placeBuilding': {
        const a = archetype(cmd.archetype);
        // 先に置けるかを見る。黙って何も起きないと、プレイヤは
        // 「ゲームが反応していない」としか受け取れない。
        if (!this.canPlace(cmd.archetype, cmd.tile)) {
          this.notify(
            'noRoadAccess',
            cmd.tile,
            `${a.nameJa}はここに建てられません（道路・線路・既存の建物・急斜面・水面は不可）`,
          );
          break;
        }
        if (!this.budget.spend(a.buildCost)) {
          this.notify('budgetDeficit', cmd.tile, `資金が足りません（${a.nameJa} は ${a.buildCost.toLocaleString('ja-JP')}円）`);
          break;
        }
        const handle = this.buildings.create(this.world, cmd.archetype, cmd.tile, 1);
        if (handle === 0) {
          this.budget.refund(a.buildCost);
          this.notify('noRoadAccess', cmd.tile, `${a.nameJa}はここに建てられません`);
          break;
        }
        if (cmd.archetype === Arch.Station) {
          this.refreshStations();
          this.onNetworkChanged();
          updateTransitAccess(this.world, this.stationTiles);
        }
        this.refreshFields();
        this.destinations.markDirty();
        this.growth.markDirty();
        break;
      }
      case 'bulldoze': {
        let networkChanged = false;
        let removedBuilding = false;
        for (const tile of cmd.tiles) {
          if (this.clearBuildingAt(tile)) {
            this.destinations.markDirty();
            removedBuilding = true;
          }
          if (this.world.road[tile] !== RoadClass.None) {
            this.world.setRoad(tile, RoadClass.None);
            networkChanged = true;
          }
          if (this.world.rail[tile] !== 0) {
            this.world.setRail(tile, false);
            networkChanged = true;
          }
          if (this.world.zone[tile] !== Zone.None) {
            this.world.setZone(tile, Zone.None);
            this.growth.markDirty();
          }
        }
        if (removedBuilding) this.refreshFields();
        if (networkChanged) this.onNetworkChanged();
        break;
      }
      case 'setTax':
        this.budget.setTax(cmd.zone, cmd.pct);
        break;
      case 'setSpeed':
        // 速度はプレゼンテーション層の関心事。ログには残すが sim は何もしない。
        break;
      default:
        break;
    }
  }

  /**
   * 地価とサービス圏を取り直す。
   *
   * どちらも全タイル走査＋ぼかしなので、経済期ごとに回すと 1 tick の処理時間が
   * 倍になる（実測 0.12ms → 0.23ms）。普段は日次のままにして、プレイヤが
   * 建てた・壊した瞬間だけここで取り直す。駅や公園を置いた効果は即座に出る。
   */
  private refreshFields(): void {
    updateServiceCoverage(this.world, this.buildings);
    updateLandValue(this.world, this.buildings);
  }

  /** 操作が通らなかった理由をプレイヤに伝える。 */
  private notify(kind: AlertKind, tile: number, message: string): void {
    this.world.events.push({ t: 'alert', kind, tile, message });
  }

  /** その建物をそのタイルに置けるか（フットプリント全域を見る）。 */
  canPlace(archId: number, tile: number): boolean {
    const a = archetype(archId);
    const ox = tileX(tile);
    const oy = tileY(tile);
    for (let dy = 0; dy < a.h; dy++) {
      for (let dx = 0; dx < a.w; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
        if (!this.world.canBuildStructure(idx(x, y))) return false;
      }
    }
    return true;
  }

  /** タイル上の建物を撤去する（駅なら駅リストからも消す）。 */
  private clearBuildingAt(tile: number): boolean {
    const ref = this.world.buildingRef[tile]!;
    if (ref === 0) return false;
    const slot = ref - 1;
    if (this.buildings.alive[slot] !== 1) return false;
    const isStation = this.buildings.archetypeId[slot] === Arch.Station;
    // 住人と就業者の参照を切る
    const handle = this.buildings.handleOf(slot);
    for (const id of this.citizens.each()) {
      if (this.citizens.homeBuilding[id] === handle) this.citizens.homeBuilding[id] = 0;
      if (this.citizens.workBuilding[id] === handle) {
        this.citizens.workBuilding[id] = 0;
        this.citizens.incomeYenMo[id] = 0;
        this.citizens.set(id, CitizenFlag.Employed, false);
      }
    }
    this.buildings.destroy(this.world, slot);
    if (isStation) {
      this.refreshStations();
      updateTransitAccess(this.world, this.stationTiles);
      this.onNetworkChanged();
    }
    this.growth.markDirty();
    this.destinations.markDirty();
    return true;
  }

  // ---------------- ネットワーク ----------------

  /** 建物ストアを唯一の真実として駅タイル一覧を作り直す。 */
  private refreshStations(): void {
    this.stationTiles.length = 0;
    for (const s of this.buildings.each()) {
      if (this.buildings.archetypeId[s] === Arch.Station) this.stationTiles.push(this.buildings.originTile[s]!);
    }
  }

  private onNetworkChanged(): void {
    this.rebuildNetwork();
    this.world.events.push({ t: 'networkChanged' });
  }

  private rebuildNetwork(): void {
    this.refreshStations();
    // グラフを作り直したら必ずバージョンを進める。
    //
    // networkVersion を増やすのは World.setRoad / setRail だけで、駅は「建物」なので
    // 設置・撤去してもバージョンが動かなかった。その結果、駅を壊しても
    //   - 描画側の線路キャッシュ（agentLayer.drawTrains）
    //   - 経路キャッシュに残った、消えた駅を通る経路
    //   - 走行中の再ルート判定
    // が全部そのまま生き残り、駅の無い線路を電車が延々と往復していた。
    this.world.networkVersion++;
    this.graph.build(this.world, this.stationTiles);
    this.taz.refreshRepresentatives(this.world, this.graph);
    // 建物の接道点を取り直す（ハンドルではなくスロットで保持しているので安全）
    for (const s of this.buildings.each()) this.buildings.refreshAccess(this.world, s);
  }

  // ---------------- tick ----------------

  tick(): void {
    this.applyCommands();
    this.router.beginTick();

    const tick = this.clock.tick;

    // --- 市民の行動 ---
    this.activity.tick(this.activityContext());

    // --- 建物の成長 ---
    // 地元の木材に、資金で買える輸入分を上乗せしたものが建設可能量になる。
    const importable = Math.floor(this.budget.cash / LUMBER_IMPORT_YEN);
    const grow = this.growth.tick(
      this.world,
      this.buildings,
      this.demand,
      this.rng,
      this.lumberPool + Math.max(0, importable),
      this.cachedPopulation,
      this.production.unmetByGood,
      this.production.stock,
      this.production.produced,
    );
    if (grow.lumberUsed > 0) this.spendLumber(grow.lumberUsed);

    // --- 物流 ---
    this.freight.update(this.buildings, tick);
    if (tick % FREIGHT_DISPATCH_INTERVAL === 0) {
      this.freight.dispatch(this.buildings, this.graph, this.router, this.taz, this.rng, tick);
    }

    // --- 渋滞（10 分ごと。EMA 平滑化が発振を抑える） ---
    if (tick % 10 === 0) {
      this.graph.updateCongestion(COST_SMOOTHING_LAMBDA * 10, VOLUME_DECAY * 10);
    }

    // --- TAZ コスト行列のローリング更新 ---
    if (tick % 4 === 0) this.taz.update(this.graph, 2);

    // --- 毎時 ---
    if (tick % TICKS_PER_HOUR === 0) {
      runProduction(this.buildings, this.clock, this.production);
      this.lumberPool = this.production.stock[Good.Lumber]!;
    }

    // --- 経済期（2 シミュレーション時間） ---
    if (tick > 0 && tick % ECONOMY_PERIOD_TICKS === 0) this.economyPass();

    // --- 毎日 ---
    if (tick > 0 && tick % TICKS_PER_DAY === 0) this.daily();

    // --- 毎月 ---
    if (tick > 0 && tick % (TICKS_PER_DAY * 30) === 0) {
      this.lastReport = this.budget.closeMonth(this.world, this.buildings, this.citizens, this.clock.month);
    }

    this.clock.tick++;
  }

  /**
   * 経済期の処理。プレイヤの操作が街に返ってくる速さを決めているのはここ。
   *
   * 地価・サービス圏・労働市場・転入は元は日次だった。1 日が 32 実分になった今、
   * 日次のままだと「駅を建てても 30 分何も起きない」「商店を建てても就業者が
   * 0 のまま」になる。1 日の長さは変えずに、経済の時間だけデフォルメする。
   */
  private economyPass(): void {
    const lctx = this.lifecycleContext();
    this.lifecycle.updateLabourMarket(lctx);
    this.cachedPopulation = this.citizens.count();
    this.immigration(lctx, this.cachedPopulation);
    // 転入した人を数に入れてから統計を確定させる。
    // 先に数えて後から入れると、着いたばかりの失業者が 1 期ぶん表に出ず、
    // 失業率が実際より低く見える（人口 1343 で失業 113 人を 4 人と表示していた）。
    this.lifecycle.refreshCounts(lctx);
    this.finance = this.budget.accrue(this.world, this.buildings, this.citizens);
  }

  private activityContext(): Parameters<ActivitySystem['tick']>[0] {
    return {
      world: this.world,
      buildings: this.buildings,
      citizens: this.citizens,
      graph: this.graph,
      router: this.router,
      taz: this.taz,
      wheel: this.wheel,
      clock: this.clock,
      rng: this.rng,
      destinations: this.destinations,
    };
  }

  private lifecycleContext(): Parameters<LifecycleSystem['daily']>[0] {
    return {
      world: this.world,
      buildings: this.buildings,
      citizens: this.citizens,
      taz: this.taz,
      clock: this.clock,
      rng: this.rng,
      wheel: this.wheel,
      activity: this.activity,
    };
  }

  private daily(): void {
    // 場の更新（重いのでまとめて 1 日 1 回）
    updatePollution(this.world, this.buildings);
    updateLandValue(this.world, this.buildings);
    updateServiceCoverage(this.world, this.buildings);

    // 商店の欠品
    const so = updateStockouts(this.buildings);
    this.stockoutCount = so.stockouts;
    this.foodShortfall = so.foodShortfall;

    // 欠品が続いた「商店」を廃業させる（悪い物流がプレイヤに返る主要な経路）。
    //
    // 廃業させるのは小売だけで、工場や製材所は在庫が無くても操業を止めるだけにする。
    // 生産施設まで取り壊すと、サプライチェーンが立ち上がる前に上流が全滅し、
    // 「製材所が建つ → 原木が届く前に潰れる → 木材が永久に出ない」という
    // 出口のないループに入る（実際にこれで工業地帯が空のままになった）。
    for (const s of this.buildings.each()) {
      if (this.buildings.stockoutDays[s]! < STOCKOUT_ABANDON_DAYS) continue;
      const a = archetype(this.buildings.archetypeId[s]!);
      if (!isShop(a.id)) {
        // 生産施設は猶予を長く取る。サプライチェーンが立ち上がるには数週間かかる。
        // ただし永久に残すと、動かない工場が区画を占拠し続け、
        // 本当に必要な業種（製材所・食品工場）が入る土地が無くなる。
        if (this.buildings.stockoutDays[s]! < STOCKOUT_ABANDON_DAYS * 5) {
          if (this.buildings.stockoutDays[s]! % 10 === 0) {
            this.world.events.push({
              t: 'alert',
              kind: 'materialShortage',
              tile: this.buildings.originTile[s]!,
              message: `${a.nameJa}が原材料不足で操業できていません`,
            });
          }
          continue;
        }
        this.world.events.push({
          t: 'alert',
          kind: 'materialShortage',
          tile: this.buildings.originTile[s]!,
          message: `${a.nameJa}が原材料不足のまま操業できず廃業しました`,
        });
        this.buildings.destroy(this.world, s);
        this.growth.markDirty();
        continue;
      }
      this.world.events.push({
        t: 'alert',
        kind: 'stockout',
        tile: this.buildings.originTile[s]!,
        message: `${a.nameJa}が商品切れで閉店しました`,
      });
      this.buildings.destroy(this.world, s);
      this.growth.markDirty();
      this.destinations.markDirty();
    }

    // 建物のレベルアップ・廃墟化
    this.growth.dailyReview(this.world, this.buildings);

    // ライフサイクル
    const lctx = this.lifecycleContext();
    this.lifecycle.daily(lctx);

    // 需要の再計算
    const pop = this.citizens.count();
    this.cachedPopulation = pop;
    const stats = this.activity.stats;
    this.demand = computeDemand({
      population: pop,
      workforce: this.lifecycle.stats.employed + this.lifecycle.stats.unemployed,
      vacantJobs: this.lifecycle.stats.jobIndex.totalVacant,
      vacantDwellings: this.lifecycle.stats.housingIndex.totalVacant,
      dwellings: this.lifecycle.stats.housingIndex.totalDwellings,
      avgHappiness: this.averageHappiness(),
      unmetShoppingTrips: stats.shoppingFailed,
      retailCapacity: this.destinations.shopCount,
      unmetInputDemand: this.production.unmetInputDemand,
      industryCapacity: this.production.industryCapacity,
      foodShortfall: this.foodShortfall,
      foodDemand: Math.max(1, pop * 0.5),
      lumberShortfall: this.growth.lumberShortfall,
      starvedFraction:
        this.production.inputConsumingBuildings > 0
          ? this.production.starvedBuildings / this.production.inputConsumingBuildings
          : 0,
      taxPct: this.budget.taxPct,
    });

    // 転入は経済期ごとに回す（economyPass）

    // 日次統計を確定させてリセット
    this.dailyStats = { ...stats, modeCounts: [...stats.modeCounts] as [number, number, number, number] };
    this.activity.resetDailyStats();
    this.freight.resetPeriodStats();
    this.router.cache.resetStats();
    this.destinations.rebuild(this.buildings);
  }

  /**
   * 転入。
   *
   * **建設needs と転入needs を同じ信号で判定してはいけない。**
   * 「空き家が多い」は *これ以上家を建てるな* という信号であって、
   * *人が引っ越して来るな* という信号ではない。むしろ空き家があるからこそ移り住める。
   *
   * 両者を `demand.residential` ひとつで見ていたため、
   * 家が建った瞬間に空き家率 100% で需要がマイナスに振れ、
   * 「家は建つ → 全部空き家 → 需要マイナス → 誰も来ない → 永久に人口 0」
   * というデッドロックに入っていた。
   *
   * 転入は「空き住戸があるか」と「街が住むに値するか」で決める。
   */
  private immigration(lctx: Parameters<LifecycleSystem['daily']>[0], pop: number): void {
    const vacant = this.lifecycle.stats.housingIndex.totalVacant;
    if (vacant <= 0) return;

    const employed = this.lifecycle.stats.employed;
    const unemployed = this.lifecycle.stats.unemployed;
    const employable = employed + unemployed;
    // 求人が余っていれば人は来る。失業者が余っていれば来ない。
    // 人口 0 のときは「まだ誰も試していない新天地」として少し前向きに見る。
    const jobBalance =
      employable > 0
        ? Math.max(-1, Math.min(1, (this.lifecycle.stats.jobIndex.totalVacant - unemployed) / employable))
        : 0.3;
    const happiness = this.averageHappiness();
    const taxPct = this.budget.taxPct[Zone.ResidentialLow] ?? NEUTRAL_TAX_PCT;

    let appeal =
      0.45 +
      0.35 * jobBalance +
      0.3 * ((happiness - 110) / 145) -
      0.02 * taxPenalty(taxPct);
    appeal = Math.max(0, Math.min(1, appeal));
    if (appeal <= 0.02) return;

    // 小さいうちは流入を厚くする。人口比だけで決めると、街を作り始めた直後は
    // 1 日数人しか来ず、家だけが並んで誰も住んでいない状態が延々と続く。
    //
    // 1 日分の枠を経済期の数で割って少しずつ入れる。日の境界でまとめて入れると、
    // 人口が 32 実分に 1 回だけ跳ねる階段になり「家を建てても誰も来ない」に見える。
    const base = (pop < 400 ? 70 : Math.max(12, pop * 0.03)) / ECONOMY_PERIODS_PER_DAY;
    const wanted = Math.ceil(appeal * Math.min(base, vacant));
    if (wanted > 0) this.lifecycle.immigrate(lctx, Math.min(120, wanted));
  }

  /**
   * 建設で消費した木材を、まず地元の在庫から、足りない分を輸入で賄う。
   * 輸入分は現金で支払うので、林業〜製材所を整備したプレイヤは建設費が下がる。
   */
  private spendLumber(amount: number): void {
    let remaining = amount;
    // 製材所の在庫を根こそぎ持っていかない。
    // 建設が全部さらうと、木材を原料にする町工場・工場にトラックが運ぶ分が
    // 一切残らず、日用品の生産が永久に 0 になる（実際にそうなっていた）。
    // 半分は産業向けに残し、足りない分は輸入で埋める。
    const INDUSTRY_RESERVE = 0.5;
    for (const s of this.buildings.each()) {
      if (remaining <= 0) break;
      if (this.buildings.outGood[s] !== Good.Lumber) continue;
      const available = this.buildings.outAmt[s]! * (1 - INDUSTRY_RESERVE);
      const take = Math.min(remaining, available);
      if (take <= 0) continue;
      this.buildings.outAmt[s] = this.buildings.outAmt[s]! - take;
      this.lumberPool = Math.max(0, this.lumberPool - take);
      remaining -= take;
    }
    if (remaining > 0) {
      const cost = remaining * LUMBER_IMPORT_YEN;
      this.budget.spend(Math.min(cost, this.budget.cash));
      this.importedLumber += remaining;
    }
  }

  /** これまでに輸入した木材の累計（UI 表示用）。 */
  importedLumber = 0;

  /** 人口は毎 tick 数えると重いので、日次で更新した値を使い回す。 */
  private cachedPopulation = 0;

  // ---------------- 初期化ヘルパ ----------------

  /**
   * 開始時の市街地。役所と最初の住民を置いて、街が動き出せる状態にする。
   * 何も無い状態からだと住宅需要が立たず、プレイヤが何をしても永久に街ができない。
   */
  bootstrap(): void {
    updateServiceCoverage(this.world, this.buildings);
    updateLandValue(this.world, this.buildings);
    // TAZ 行列を先に全部埋める。ローリング更新は 1 周 200 tick かかるので、
    // これが無いと最初の数分は行列が Infinity のままで、求職も行き先選びも
    // 概算にすら乗らない（シナリオ側は buildScenario で既にこれをやっている）。
    this.taz.computeAll(this.graph);
    // 初期需要。ここが 0 だと最初の 1 軒が永久に建たない。
    this.demand = { residential: 70, commercial: 25, industrial: 40, agriculture: 55 };
  }

  // ---------------- セーブ / ロード ----------------

  /**
   * 保存すべき状態を取り出す。バイト列への変換は `sim/persistence.ts` の仕事。
   *
   * 地形はシードから再生成するので保存しない。交通グラフ・TAZ 行列・経路キャッシュ・
   * タイミングホイールも、ここにある状態から作り直せるので保存しない。
   */
  snapshot(): SimSnapshot {
    const c = this.citizens;
    const b = this.buildings;
    return {
      seed: this.seed,
      head: {
        tick: this.clock.tick,
        startYear: this.clock.startYear,
        citizenHigh: c.high,
        buildingHigh: b.high,
        householdIdCounter: householdIdCounter(),
        rng: this.rng.getState(),
        cash: this.budget.cash,
        taxPct: { ...this.budget.taxPct },
        capexMonth: this.budget.capexMonth,
        deficitMonths: this.budget.deficitMonths,
        budgetHistory: this.budget.history,
        demand: this.demand,
        lastReport: this.lastReport,
        lumberPool: this.lumberPool,
        importedLumber: this.importedLumber,
        stockoutCount: this.stockoutCount,
        foodShortfall: this.foodShortfall,
        cachedPopulation: this.cachedPopulation,
        totalDispatched: this.freight.totalDispatched,
        totalDelivered: this.freight.totalDelivered,
        dailyStats: { ...this.dailyStats, modeCounts: [...this.dailyStats.modeCounts] },
      },
      arrays: [
        { name: 'world.zone', data: this.world.zone },
        { name: 'world.road', data: this.world.road },
        { name: 'world.rail', data: this.world.rail },
        { name: 'world.buildingRef', data: this.world.buildingRef },
        { name: 'world.landValue', data: this.world.landValue },
        { name: 'world.pollution', data: this.world.pollution },
        { name: 'world.noise', data: this.world.noise },
        { name: 'world.svcMask', data: this.world.svcMask },
        { name: 'world.transitAccess', data: this.world.transitAccess },
        ...BUILDING_FIELDS.map((f) => ({ name: `b.${f}`, data: b[f].subarray(0, b.high) })),
        ...CITIZEN_FIELDS.map((f) => ({ name: `c.${f}`, data: c[f].subarray(0, c.high) })),
      ],
    };
  }

  /**
   * セーブデータを流し込む。**シードが同じシミュレーションに対してのみ**呼ぶこと
   * （地形はシードから再生成されるので、違うシードだと海の上に街が乗る）。
   */
  restoreSnapshot(snap: SimSnapshot): void {
    if (snap.seed !== this.seed) throw new Error('シードが違うシミュレーションには読み込めません');
    const head = snap.head as Record<string, number & Record<string, number>>;
    const src = arrayMap(snap.arrays);
    const c = this.citizens;
    const b = this.buildings;
    const citizenHigh = Number(head.citizenHigh ?? 0);
    const buildingHigh = Number(head.buildingHigh ?? 0);
    c.ensureCapacity(citizenHigh);
    b.ensureCapacity(buildingHigh);

    const copy = (name: string, dst: { set(a: never, o: number): void }): void => {
      const v = src.get(name);
      if (v) dst.set(v as never, 0);
    };
    for (const name of ['zone', 'road', 'rail', 'buildingRef', 'landValue', 'pollution', 'noise', 'svcMask', 'transitAccess'] as const) {
      copy(`world.${name}`, this.world[name]);
    }
    for (const f of BUILDING_FIELDS) copy(`b.${f}`, b[f]);
    for (const f of CITIZEN_FIELDS) copy(`c.${f}`, c[f]);
    b.rebuildFreeList(buildingHigh);
    c.rebuildFreeList(citizenHigh);
    for (let i = 0; i < c.capacity; i++) c.tripPath[i] = null;

    this.clock.tick = Number(head.tick ?? 0);
    setHouseholdIdCounter(Number(head.householdIdCounter ?? 1));
    this.rng.setState((head.rng as unknown as number[]) ?? [1, 2, 3, 4]);
    this.budget.cash = Number(head.cash ?? 0);
    for (const [k, v] of Object.entries(head.taxPct ?? {})) this.budget.taxPct[Number(k)] = Number(v);
    this.budget.capexMonth = Number(head.capexMonth ?? 0);
    this.budget.deficitMonths = Number(head.deficitMonths ?? 0);
    this.budget.history = (head.budgetHistory as unknown as MonthlyReport[]) ?? [];
    this.demand = (head.demand as unknown as DemandState) ?? this.demand;
    this.lastReport = (head.lastReport as unknown as MonthlyReport | null) ?? null;
    this.lumberPool = Number(head.lumberPool ?? 0);
    this.importedLumber = Number(head.importedLumber ?? 0);
    this.stockoutCount = Number(head.stockoutCount ?? 0);
    this.foodShortfall = Number(head.foodShortfall ?? 0);
    this.cachedPopulation = Number(head.cachedPopulation ?? 0);
    this.freight.totalDispatched = Number(head.totalDispatched ?? 0);
    this.freight.totalDelivered = Number(head.totalDelivered ?? 0);
    if (head.dailyStats) this.dailyStats = { ...(head.dailyStats as unknown as typeof this.dailyStats) };

    // --- 保存していないものを作り直す ---
    this.pendingCommands.length = 0;
    this.freight.reset();
    this.rebuildNetwork();
    updateTransitAccess(this.world, this.stationTiles);
    this.taz.computeAll(this.graph);
    this.router.cache.clear();
    this.growth.markDirty();
    this.destinations.markDirty();
    this.destinations.rebuild(this.buildings);
    this.activity.rehydrate(this.activityContext());
    this.lifecycle.refreshCounts(this.lifecycleContext());
    this.finance = this.budget.accrue(this.world, this.buildings, this.citizens);
  }

  /**
   * テスト・ヘッドレス用: 指定した数の市民を空き住戸に流し込む。
   *
   * 通常の転入と違って経済期の外から入れるので、最後に統計を数え直す。
   * これをしないと、シナリオ生成の直後は「着いたばかりの失業者」が
   * 次の経済期まで表に出ず、失業率が実際よりずっと低く表示される。
   */
  seedPopulation(count: number): number {
    const lctx = this.lifecycleContext();
    const placed = this.lifecycle.immigrate(lctx, count);
    this.cachedPopulation = this.citizens.count();
    this.lifecycle.refreshCounts(lctx);
    return placed;
  }

  /** 世帯を 1 つ手動で作る（テスト用）。 */
  addCitizen(age: number, homeHandle: number): number {
    const lctx = {
      world: this.world,
      buildings: this.buildings,
      citizens: this.citizens,
      taz: this.taz,
      clock: this.clock,
      rng: this.rng,
      wheel: this.wheel,
      activity: this.activity,
    };
    const id = createCitizen(lctx, age, homeHandle, newHouseholdId());
    this.activity.initCitizen(
      {
        world: this.world,
        buildings: this.buildings,
        citizens: this.citizens,
        graph: this.graph,
        router: this.router,
        taz: this.taz,
        wheel: this.wheel,
        clock: this.clock,
        rng: this.rng,
        destinations: this.destinations,
      },
      id,
    );
    return id;
  }

  // ---------------- 集計 ----------------

  averageHappiness(): number {
    let sum = 0;
    let n = 0;
    for (const id of this.citizens.each()) {
      sum += this.citizens.happiness[id]!;
      n++;
    }
    return n === 0 ? 128 : sum / n;
  }

  stats(): SimStats {
    const s = this.dailyStats;
    const totalTrips = s.modeCounts.reduce((a, b) => a + b, 0);
    return {
      tick: this.clock.tick,
      population: this.citizens.count(),
      employed: this.lifecycle.stats.employed,
      unemployed: this.lifecycle.stats.unemployed,
      homeless: this.lifecycle.stats.homeless,
      buildings: this.buildings.count(),
      avgHappiness: this.averageHappiness(),
      avgCommuteMin: s.commuteCount > 0 ? s.commuteMinutesSum / s.commuteCount : 0,
      demand: this.demand,
      modeShare: totalTrips > 0 ? s.modeCounts.map((c) => c / totalTrips) : [0, 0, 0, 0],
      tripsCompleted: s.tripsCompleted,
      tripsFailed: s.tripsFailed,
      shoppingFailed: s.shoppingFailed,
      cash: this.budget.cash,
      finance: this.finance,
      capexThisMonth: this.budget.capexMonth,
      deficitMonths: this.budget.deficitMonths,
      lastReport: this.lastReport,
      cacheHitRate: this.router.cache.hitRate,
      routeQueueDepth: this.activity.waitingCount,
      searchesThisTick: this.router.searchesThisTick,
      trucksActive: this.freight.stats.active,
      stockouts: this.stockoutCount,
      goodsStock: this.production.stock,
      goodsProduced: this.production.produced,
    };
  }

  /** 決定論テスト用の状態ハッシュ。 */
  stateHash(): number {
    return hashArrays([
      this.world.zone,
      this.world.road,
      this.world.rail,
      this.world.buildingRef,
      this.buildings.alive.subarray(0, this.buildings.high),
      this.buildings.level.subarray(0, this.buildings.high),
      this.citizens.flags.subarray(0, this.citizens.high),
      this.citizens.age.subarray(0, this.citizens.high),
      this.citizens.state.subarray(0, this.citizens.high),
      this.citizens.homeBuilding.subarray(0, this.citizens.high),
      this.citizens.workBuilding.subarray(0, this.citizens.high),
    ]);
  }

  /** 現在の駅タイル一覧（描画用）。 */
  get stations(): readonly number[] {
    return this.stationTiles;
  }

  /** タイル座標のヘルパを外部に公開する。 */
  static tileAt(x: number, y: number): number {
    return idx(x, y);
  }
  static tileToXY(tile: number): { x: number; y: number } {
    return { x: tileX(tile), y: tileY(tile) };
  }

  /** 需要区分ごとの値（UI の需要バー用）。 */
  demandOf(kind: DemandKind): number {
    switch (kind) {
      case DemandKind.Residential:
        return this.demand.residential;
      case DemandKind.Commercial:
        return this.demand.commercial;
      case DemandKind.Industrial:
        return this.demand.industrial;
      default:
        return this.demand.agriculture;
    }
  }

  /** 市民の接道ノード（デバッグ・インスペクタ用）。 */
  accessNodeOfBuilding(handle: number): number {
    if (!this.buildings.valid(handle)) return -1;
    const t = this.buildings.accessTile[handleSlot(handle)]!;
    return t < 0 ? -1 : this.graph.roadNodeAt[t]!;
  }

  /** 2 タイル間の経路を求める（経路探索デバッグツール用）。 */
  debugPath(fromTile: number, toTile: number, mode: Mode) {
    const a = this.world.nearestRoadTile(fromTile, ROAD_ACCESS_RADIUS);
    const b = this.world.nearestRoadTile(toTile, ROAD_ACCESS_RADIUS);
    if (a < 0 || b < 0) return null;
    const na = this.graph.roadNodeAt[a]!;
    const nb = this.graph.roadNodeAt[b]!;
    if (na < 0 || nb < 0) return null;
    const p = this.router.getPath(this.graph, na, nb, mode, 0);
    return p ?? null;
  }
}
