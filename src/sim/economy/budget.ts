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

export interface MonthlyReport {
  month: number;
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
  cashAfter: number;
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

  /** 支出できるか判定して引き落とす。 */
  spend(amount: number): boolean {
    if (amount > this.cash) return false;
    this.cash -= amount;
    return true;
  }

  refund(amount: number): void {
    this.cash += amount;
  }

  setTax(zone: Zone, pct: number): void {
    this.taxPct[zone] = Math.max(0, Math.min(20, Math.round(pct)));
  }

  /** 住民税・固定資産税・法人税と維持費を集計して現金を更新する。 */
  closeMonth(world: World, buildings: BuildingStore, citizens: CitizenStore, month: number): MonthlyReport {
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
      const a = archetype(buildings.archetypeId[s]!);
      upkeepServices += a.upkeep;
      const revenue = buildings.revenueYen[s]!;
      buildings.revenueYen[s] = 0;
      const level = buildings.level[s]!;
      const propertyTax = Math.round(level * 9_000 * (1 + world.landValue[buildings.originTile[s]!]! / 255));
      switch (a.zone) {
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

    // インフラ維持費
    let upkeepRoads = 0;
    let upkeepRail = 0;
    for (let i = 0; i < TILE_COUNT; i++) {
      const rc = world.road[i]!;
      if (rc !== RoadClass.None) upkeepRoads += ROAD_UPKEEP[rc]!;
      if (world.rail[i] !== 0) upkeepRail += RAIL_UPKEEP;
    }

    const income = incomeResidential + incomeCommercial + incomeIndustrial + incomeAgriculture;
    const expense = upkeepRoads + upkeepRail + upkeepServices;
    const net = income - expense;
    this.cash += net;

    if (net < 0) this.deficitMonths++;
    else this.deficitMonths = 0;

    const report: MonthlyReport = {
      month,
      incomeResidential,
      incomeCommercial,
      incomeIndustrial,
      incomeAgriculture,
      upkeepRoads,
      upkeepRail,
      upkeepServices,
      income,
      expense,
      net,
      cashAfter: this.cash,
    };
    this.history.push(report);
    if (this.history.length > 120) this.history.shift();
    return report;
  }
}
