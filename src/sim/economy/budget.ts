import {
  DEFAULT_TAX_PCT,
  RAIL_UPKEEP,
  STARTING_CASH_YEN,
  TILE_COUNT,
} from '@shared/constants';
import { ROAD_UPKEEP, RoadClass, Zone } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import { CitizenFlag, type CitizenStore } from '@sim/agents/citizens';
import type { World } from '@sim/world/world';

/**
 * 月次の財政。台帳は整数円で持ち、
 *   cash_t === cash_{t-1} + 収入 - 支出
 * が厳密に成り立つことをテストで担保する（浮動小数の誤差でズレると
 * 「なぜか金が減る」タイプの追いにくいバグになる）。
 */

/** 収入と維持費の内訳。現金を動かさずに今の run-rate を覗くのに使う。 */
export interface Accrual {
  incomeResidential: number;
  incomeCommercial: number;
  incomeIndustrial: number;
  incomeAgriculture: number;
  upkeepRoads: number;
  upkeepRail: number;
  upkeepServices: number;
  income: number;
  expense: number;
  net: number;
}

export interface MonthlyReport extends Accrual {
  month: number;
  /** その月の建設・撤去・木材輸入（現金は支出時点で動いている）。 */
  capex: number;
  cashAfter: number;
}

export function emptyAccrual(): Accrual {
  return {
    incomeResidential: 0,
    incomeCommercial: 0,
    incomeIndustrial: 0,
    incomeAgriculture: 0,
    upkeepRoads: 0,
    upkeepRail: 0,
    upkeepServices: 0,
    income: 0,
    expense: 0,
    net: 0,
  };
}

export class Budget {
  cash = STARTING_CASH_YEN;
  /** ゾーン種別ごとの税率 (%)。 */
  readonly taxPct: Record<number, number> = {
    [Zone.ResidentialLow]: DEFAULT_TAX_PCT,
    [Zone.ResidentialMid]: DEFAULT_TAX_PCT,
    [Zone.CommercialLocal]: DEFAULT_TAX_PCT,
    [Zone.CommercialCentral]: DEFAULT_TAX_PCT,
    [Zone.IndustrialLight]: DEFAULT_TAX_PCT,
    [Zone.IndustrialHeavy]: DEFAULT_TAX_PCT,
    [Zone.AgriPaddy]: DEFAULT_TAX_PCT,
    [Zone.AgriField]: DEFAULT_TAX_PCT,
    [Zone.Forestry]: DEFAULT_TAX_PCT,
    [Zone.Park]: 0,
    [Zone.None]: 0,
  };
  history: MonthlyReport[] = [];
  /** 赤字が続いている月数。 */
  deficitMonths = 0;
  /** 今月の建設・撤去・輸入の支出。月次報告に載せて現金の増減と帳尻を合わせる。 */
  capexMonth = 0;

  /** インフラ維持費のキャッシュ。全タイル走査なので networkVersion 単位で使い回す。 */
  private upkeepCache = { version: -1, roads: 0, rail: 0 };

  /** 支出できるか判定して引き落とす。 */
  spend(amount: number): boolean {
    if (amount > this.cash) return false;
    this.cash -= amount;
    this.capexMonth += amount;
    return true;
  }

  refund(amount: number): void {
    this.cash += amount;
    this.capexMonth -= amount;
  }

  setTax(zone: Zone, pct: number): void {
    this.taxPct[zone] = Math.max(0, Math.min(20, Math.round(pct)));
  }

  /**
   * 住民税・固定資産税・法人税と維持費を集計する。現金も売上台帳も動かさない。
   *
   * 決算と切り離してあるのは、プレイヤに「今の収支」を常時見せるため。
   * 集計しながら revenueYen をゼロにしていた頃は、月末にならないと収支が分からなかった。
   */
  accrue(world: World, buildings: BuildingStore, citizens: CitizenStore): Accrual {
    const a = emptyAccrual();
    let incomeResidential = 0;
    let incomeCommercial = 0;
    let incomeIndustrial = 0;
    let incomeAgriculture = 0;
    let upkeepServices = 0;

    // 住民税
    const rateR = this.taxPct[Zone.ResidentialLow]! / 100;
    for (const id of citizens.each()) {
      if (!citizens.has(id, CitizenFlag.Employed)) continue;
      incomeResidential += Math.round(citizens.incomeYenMo[id]! * rateR);
    }

    // 事業税（売上ベース）と固定資産税
    for (const s of buildings.each()) {
      const arch = archetype(buildings.archetypeId[s]!);
      upkeepServices += arch.upkeep;
      const revenue = buildings.revenueYen[s]!;
      const level = buildings.level[s]!;
      const propertyTax = Math.round(level * 9_000 * (1 + world.landValue[buildings.originTile[s]!]! / 255));
      switch (arch.zone) {
        case Zone.CommercialLocal:
        case Zone.CommercialCentral:
          incomeCommercial += Math.round(revenue * (this.taxPct[Zone.CommercialLocal]! / 100)) + propertyTax;
          break;
        case Zone.IndustrialLight:
        case Zone.IndustrialHeavy:
          incomeIndustrial +=
            Math.round(buildings.outAmt[s]! * 900 * (this.taxPct[Zone.IndustrialLight]! / 100)) + propertyTax;
          break;
        case Zone.AgriPaddy:
        case Zone.AgriField:
        case Zone.Forestry:
          incomeAgriculture +=
            Math.round(buildings.outAmt[s]! * 700 * (this.taxPct[Zone.AgriPaddy]! / 100)) + propertyTax;
          break;
        case Zone.ResidentialLow:
        case Zone.ResidentialMid:
          incomeResidential += propertyTax;
          break;
        default:
          break;
      }
    }

    // インフラ維持費。全タイル走査なので道路・線路が変わったときだけ数え直す。
    if (this.upkeepCache.version !== world.networkVersion) {
      let roads = 0;
      let rail = 0;
      for (let i = 0; i < TILE_COUNT; i++) {
        const rc = world.road[i]!;
        if (rc !== RoadClass.None) roads += ROAD_UPKEEP[rc]!;
        if (world.rail[i] !== 0) rail += RAIL_UPKEEP;
      }
      this.upkeepCache = { version: world.networkVersion, roads, rail };
    }

    a.incomeResidential = incomeResidential;
    a.incomeCommercial = incomeCommercial;
    a.incomeIndustrial = incomeIndustrial;
    a.incomeAgriculture = incomeAgriculture;
    a.upkeepRoads = this.upkeepCache.roads;
    a.upkeepRail = this.upkeepCache.rail;
    a.upkeepServices = upkeepServices;
    a.income = incomeResidential + incomeCommercial + incomeIndustrial + incomeAgriculture;
    a.expense = a.upkeepRoads + a.upkeepRail + a.upkeepServices;
    a.net = a.income - a.expense;
    return a;
  }

  /** 月次決算。集計をコミットして売上台帳をリセットする。 */
  closeMonth(world: World, buildings: BuildingStore, citizens: CitizenStore, month: number): MonthlyReport {
    const a = this.accrue(world, buildings, citizens);
    for (const s of buildings.each()) buildings.revenueYen[s] = 0;

    this.cash += a.net;
    if (a.net < 0) this.deficitMonths++;
    else this.deficitMonths = 0;

    const report: MonthlyReport = {
      ...a,
      month,
      capex: this.capexMonth,
      cashAfter: this.cash,
    };
    this.capexMonth = 0;
    this.history.push(report);
    if (this.history.length > 120) this.history.shift();
    return report;
  }
}
