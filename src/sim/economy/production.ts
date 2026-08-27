import { Good, Season } from '@shared/enums';
import { archetype, isProducer } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import type { Clock } from '@sim/core/clock';
import type { UtilitySystem } from '@sim/world/utilities';


/**
 * 生産。1 シミュレーション時間に 1 回、生産建物だけを回す。
 *
 * 「入力が足りなければ出力が落ちる」を素直に実装するだけで、
 * 物流の失敗が生産の停止として現れ、それが商店の欠品として市民に届く。
 * サプライチェーンをゲームの中心に据えるには、この連鎖が途切れないことが要件。
 */

export interface ProductionStats {
  /** 資源ごとの 1 時間あたり生産量。 */
  produced: Float64Array;
  /** 資源ごとの消費量。 */
  consumed: Float64Array;
  /** 資源ごとの総在庫。 */
  stock: Float64Array;
  /** 入力不足で止まっている建物の数。 */
  starvedBuildings: number;
  /** 入力を必要とする生産施設の総数（割合を出すための分母）。 */
  inputConsumingBuildings: number;
  /** 入力不足の総量（需要モデルへ返す）。 */
  unmetInputDemand: number;
  /**
   * 資源ごとの不足量。
   * 「足りていない資源を作る建物」を建ちやすくするために使う。
   */
  unmetByGood: Float64Array;
  industryCapacity: number;
}

export function newProductionStats(): ProductionStats {
  return {
    produced: new Float64Array(8),
    consumed: new Float64Array(8),
    stock: new Float64Array(8),
    starvedBuildings: 0,
    inputConsumingBuildings: 0,
    unmetInputDemand: 0,
    unmetByGood: new Float64Array(8),
    industryCapacity: 0,
  };
}

/**
 * 田んぼの季節係数。
 * 3〜8 月は生育期で収穫なし、9 月に一年分がまとめて穫れる。
 * 倉庫の必要性と、毎年決まった時期の物流の山を生む — 繰り返し訪れるイベントとして機能する。
 */
export function paddySeasonFactor(month: number): number {
  if (month === 9) return 9; // 収穫期に一年分が集中する
  if (month === 10) return 2.5;
  if (month >= 3 && month <= 8) return 0; // 田植え〜生育期
  return 0.2; // 冬の裏作程度
}

/** 林業の季節係数。連続的だが冬はやや落ちる。 */
export function forestrySeasonFactor(season: Season): number {
  return season === Season.Winter ? 0.6 : 1;
}

export function runProduction(
  buildings: BuildingStore,
  clock: Clock,
  stats: ProductionStats,
  utilities?: UtilitySystem,
): void {
  stats.produced.fill(0);
  stats.consumed.fill(0);
  stats.stock.fill(0);
  stats.starvedBuildings = 0;
  stats.inputConsumingBuildings = 0;
  stats.unmetInputDemand = 0;
  stats.unmetByGood.fill(0);
  stats.industryCapacity = 0;

  const month = clock.month;
  const season = clock.season;

  for (const s of buildings.each()) {
    const archId = buildings.archetypeId[s]!;
    const a = archetype(archId);

    // 在庫の集計（欠品判定と UI 表示に使う）
    if (buildings.inGoodA[s] !== Good.None) stats.stock[buildings.inGoodA[s]!]! += buildings.inAmtA[s]!;
    if (buildings.inGoodB[s] !== Good.None) stats.stock[buildings.inGoodB[s]!]! += buildings.inAmtB[s]!;
    if (buildings.outGood[s] !== Good.None) stats.stock[buildings.outGood[s]!]! += buildings.outAmt[s]!;

    if (!isProducer(archId)) continue;
    // 電気か水が止まって機能停止している事業所は生産しない。
    // 在庫の集計より後に置くのは、止まっていても倉庫の中身は在庫として数えたいため。
    if (utilities?.isShutdown(s)) continue;

    const level = buildings.level[s]!;
    const total = buildings.jobsTotal[s]!;
    // 稼働率に下限を置く。田んぼも製材所も、求人が埋まっていなくても
    // 経営者自身が動かしている。下限が無いと「郊外の農地は誰も通わない →
    // 生産ゼロ → 食料が永久に出ない」というデッドロックになる。
    const fill = total > 0 ? buildings.jobsFilled[s]! / total : 1;
    const staffed = total > 0 ? 0.35 + 0.65 * fill : 1;
    stats.industryCapacity += a.outputPerHour * level;

    // 季節
    let seasonFactor = 1;
    if (a.output === Good.Rice) seasonFactor = paddySeasonFactor(month);
    else if (a.output === Good.Logs) seasonFactor = forestrySeasonFactor(season);

    // 入力の充足率。全部必須 (anyInput=false) なら最小値、
    // どちらでもよい (anyInput=true) なら合算で見る。
    let inputRatio = 1;
    if (a.inputs.length > 0) {
      let wantedTotal = 0;
      let haveTotal = 0;
      let minRatio = 1;
      for (let k = 0; k < a.inputs.length; k++) {
        const need = a.inputs[k]!;
        const have = k === 0 ? buildings.inAmtA[s]! : buildings.inAmtB[s]!;
        const wanted = a.outputPerHour * level * need.per;
        wantedTotal += wanted;
        haveTotal += have;
        const r = wanted > 0 ? Math.min(1, have / wanted) : 1;
        if (r < minRatio) minRatio = r;
        if (r < 1) stats.unmetByGood[need.good]! += wanted - have;
      }
      if (a.anyInput) {
        const perOutput = a.inputs[0]!.per;
        const wantedOne = a.outputPerHour * level * perOutput;
        inputRatio = wantedOne > 0 ? Math.min(1, haveTotal / wantedOne) : 1;
      } else {
        inputRatio = minRatio;
      }
      stats.inputConsumingBuildings++;
      if (inputRatio < 1) stats.unmetInputDemand += Math.max(0, wantedTotal - haveTotal);
      if (inputRatio < 0.25) stats.starvedBuildings++;
    }

    const rate = a.outputPerHour * level * staffed * inputRatio * seasonFactor;
    if (rate <= 0) continue;

    // 入力を消費。anyInput なら在庫の多い方から先に使う。
    if (a.anyInput && a.inputs.length === 2) {
      let remaining = rate * a.inputs[0]!.per;
      const takeA = Math.min(remaining, buildings.inAmtA[s]!);
      buildings.inAmtA[s] = buildings.inAmtA[s]! - takeA;
      stats.consumed[a.inputs[0]!.good]! += takeA;
      remaining -= takeA;
      if (remaining > 0) {
        const takeB = Math.min(remaining, buildings.inAmtB[s]!);
        buildings.inAmtB[s] = buildings.inAmtB[s]! - takeB;
        stats.consumed[a.inputs[1]!.good]! += takeB;
      }
    } else {
      for (let k = 0; k < a.inputs.length; k++) {
        const need = a.inputs[k]!;
        const used = rate * need.per;
        if (k === 0) buildings.inAmtA[s] = Math.max(0, buildings.inAmtA[s]! - used);
        else buildings.inAmtB[s] = Math.max(0, buildings.inAmtB[s]! - used);
        stats.consumed[need.good]! += used;
      }
    }
    // 出力を積む（在庫上限まで）
    const cap = a.storage;
    const before = buildings.outAmt[s]!;
    buildings.outAmt[s] = Math.min(cap, before + rate);
    stats.produced[a.output]! += buildings.outAmt[s]! - before;
  }
}

/**
 * 商店の欠品日数を更新する。日次。
 * 在庫ゼロが続いた商店は最終的に廃業する — 悪い物流設計がプレイヤに返る主要な経路。
 */
export function updateStockouts(buildings: BuildingStore): { stockouts: number; foodShortfall: number } {
  let stockouts = 0;
  let foodShortfall = 0;
  for (const s of buildings.each()) {
    const a = archetype(buildings.archetypeId[s]!);
    if (a.inputs.length === 0) continue;
    const wantsFood = buildings.inGoodA[s] === Good.Food;
    const empty = buildings.inAmtA[s]! < 1 && (buildings.inGoodB[s] === Good.None || buildings.inAmtB[s]! < 1);
    if (empty) {
      buildings.stockoutDays[s] = buildings.stockoutDays[s]! + 1;
      stockouts++;
      if (wantsFood) foodShortfall += a.storage * 0.2;
    } else {
      buildings.stockoutDays[s] = 0;
    }
  }
  return { stockouts, foodShortfall };
}

/** 資源の総量を数える（質量保存テスト用）。 */
export function totalOfGood(buildings: BuildingStore, good: Good): number {
  let sum = 0;
  for (const s of buildings.each()) {
    if (buildings.inGoodA[s] === good) sum += buildings.inAmtA[s]!;
    if (buildings.inGoodB[s] === good) sum += buildings.inAmtB[s]!;
    if (buildings.outGood[s] === good) sum += buildings.outAmt[s]!;
  }
  return sum;
}
