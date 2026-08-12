import { NEUTRAL_TAX_PCT } from '@shared/constants';
import { DemandKind, Zone } from '@shared/enums';

/**
 * RCI（住宅・商業・工業）＋ 農業の需要モデル。
 *
 * 設計上の要点は「すべてのフィードバック項を容量で割って正規化し、範囲を clamp する」こと。
 * 素の比を使うと、この手の都市シミュレーションの経済は指数的に発散するか、
 * 逆に過減衰して人口 3000 人で永久に止まる。どちらも遊べない。
 */

export interface DemandState {
  /** -100..100 */
  residential: number;
  commercial: number;
  industrial: number;
  agriculture: number;
}

export interface DemandInputs {
  population: number;
  workforce: number;
  vacantJobs: number;
  vacantDwellings: number;
  dwellings: number;
  avgHappiness: number; // 0..255
  /** 満たされなかった買い物需要（直近 1 日の件数）。 */
  unmetShoppingTrips: number;
  retailCapacity: number;
  /** 工場・商店が受け取れなかった入力資源の量。 */
  unmetInputDemand: number;
  industryCapacity: number;
  /** 食料の不足量。 */
  foodShortfall: number;
  foodDemand: number;
  /** 木材の不足量（建設が止まっている度合い）。 */
  lumberShortfall: number;
  /** 原材料不足で操業できていない生産施設の割合 0..1。 */
  starvedFraction: number;
  taxPct: Record<number, number>;
}

/** 税率ペナルティ。中立税率を超えた分が非線形に効く。 */
export function taxPenalty(ratePct: number): number {
  const excess = Math.max(0, ratePct - NEUTRAL_TAX_PCT);
  return Math.pow(excess, 1.5) * 3.5;
}

const clamp100 = (v: number): number => Math.max(-100, Math.min(100, v));

export function computeDemand(inp: DemandInputs): DemandState {
  const safe = (n: number, d: number): number => (d > 0 ? n / d : 0);

  const taxR = taxPenalty(inp.taxPct[Zone.ResidentialLow] ?? NEUTRAL_TAX_PCT);
  const taxC = taxPenalty(inp.taxPct[Zone.CommercialLocal] ?? NEUTRAL_TAX_PCT);
  const taxI = taxPenalty(inp.taxPct[Zone.IndustrialLight] ?? NEUTRAL_TAX_PCT);
  const taxA = taxPenalty(inp.taxPct[Zone.AgriPaddy] ?? NEUTRAL_TAX_PCT);

  // 住宅: 余っている求人が多いほど人が来たがる。空き家が多ければ需要は下がる。
  // 比そのものを 1 で頭打ちにするのが重要。生の比を使うと、工業地帯を広く
  // 敷いた瞬間に求人が労働力の何倍にもなり、住宅需要が振り切って人口が爆発する。
  const residential = clamp100(
    60 * Math.min(1, safe(inp.vacantJobs, Math.max(1, inp.workforce))) +
      30 * ((inp.avgHappiness - 128) / 128) -
      45 * safe(inp.vacantDwellings, Math.max(1, inp.dwellings)) +
      // 街が空のうちは最低限の呼び水が要る（そうしないと最初の 1 軒が永久に建たない）
      (inp.population < 200 ? 40 : 0) -
      taxR,
  );

  // 商業: 満たせなかった買い物需要が主因。人口あたりの店舗数が薄ければ需要が立つ。
  const shopsPerCapita = safe(inp.retailCapacity, Math.max(1, inp.population));
  const commercial = clamp100(
    70 * safe(inp.unmetShoppingTrips, Math.max(1, inp.retailCapacity)) +
      // 目安は 40 人に 1 店。それより薄ければ需要が正になる。
      55 * Math.max(-1, Math.min(1, 1 - shopsPerCapita * 40)) * Math.min(1, inp.population / 50) -
      taxC,
  );

  // 工業: 商業や建設が求める資材の不足が主因。
  // 建設用の木材は街ができた初日から要るので、素の基礎需要を置いておく。
  // これが無いと「製材所が無い → 木材が輸入頼み → 工業需要が立たない」で
  // サプライチェーンが永久に立ち上がらない。
  // 既に建っている工場が原材料不足で止まっているのに工場を建て増しても意味がない。
  // この項が無いと「動かない町工場が数百棟」という状態に収束する（実際にそうなった）。
  const industrial = clamp100(
    35 +
      60 * safe(inp.unmetInputDemand, Math.max(1, inp.industryCapacity)) +
      35 * Math.min(1, inp.lumberShortfall / 20) +
      (inp.population > 60 && inp.industryCapacity < 4 ? 40 : 0) -
      95 * Math.max(0, Math.min(1, inp.starvedFraction)) -
      taxI,
  );

  // 農業: 食料と原木は常に必要。上と同じ理由で基礎需要を持たせる。
  const agriculture = clamp100(
    45 +
      80 * safe(inp.foodShortfall, Math.max(1, inp.foodDemand)) +
      25 * Math.min(1, inp.lumberShortfall / 20) -
      taxA,
  );

  return { residential, commercial, industrial, agriculture };
}

/** ゾーン種別 → 需要区分。 */
export function demandKindOfZone(zone: Zone): DemandKind {
  switch (zone) {
    case Zone.ResidentialLow:
    case Zone.ResidentialMid:
      return DemandKind.Residential;
    case Zone.CommercialLocal:
    case Zone.CommercialCentral:
      return DemandKind.Commercial;
    case Zone.IndustrialLight:
    case Zone.IndustrialHeavy:
      return DemandKind.Industrial;
    default:
      return DemandKind.Agriculture;
  }
}

export function demandValue(d: DemandState, kind: DemandKind): number {
  switch (kind) {
    case DemandKind.Residential:
      return d.residential;
    case DemandKind.Commercial:
      return d.commercial;
    case DemandKind.Industrial:
      return d.industrial;
    default:
      return d.agriculture;
  }
}
