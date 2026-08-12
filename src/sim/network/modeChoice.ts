import {
  CAR_COST_PER_KM_YEN,
  LOGIT_THETA,
  MAX_BIKE_M,
  MAX_WALK_MIN,
  MODE_ASC,
  PARKING_SEARCH_MIN,
  PURPOSE_MODE_BIAS,
  RAIL_FARE_BASE_YEN,
  RAIL_FARE_CAP_YEN,
  RAIL_FARE_PER_KM_YEN,
  VOT_BASE_YEN_PER_MIN,
} from '@shared/constants';
import { MODE_COUNT, Mode, type Purpose, type Zone } from '@shared/enums';
import type { Rng } from '@sim/core/rng';

/** 1 モード分の評価結果。市民インスペクタにそのまま出す。 */
export interface ModeOption {
  mode: Mode;
  available: boolean;
  /** 体感所要時間（分）。 */
  timeMin: number;
  /** 金銭費用（円）。 */
  costYen: number;
  /** 一般化費用（体感分）。小さいほど良い。 */
  generalizedMin: number;
  /** 効用。大きいほど選ばれやすい。 */
  utility: number;
  /** 選択確率。 */
  probability: number;
}

/** 交通手段選択に必要な市民側のパラメータ。 */
export interface TravelerProfile {
  id: number;
  /** モード別の個人的な好み（体感分の加算）。正で好き。 */
  prefWalk: number;
  prefBike: number;
  prefCar: number;
  prefRail: number;
  /** 月収（円）。時間価値に効く。 */
  incomeYenMo: number;
  age: number;
  hasCar: boolean;
  /** 定期券。通勤・通学時の鉄道運賃を 0 にする。日本の通勤鉄道分担率を強く支える要素。 */
  hasTransitPass: boolean;
}

/** 各モードの所要時間（秒）と距離 (m)。到達不能なら Infinity。 */
export interface ModeTimes {
  sec: [number, number, number, number];
  meters: [number, number, number, number];
}

export function emptyModeTimes(): ModeTimes {
  return { sec: [Infinity, Infinity, Infinity, Infinity], meters: [0, 0, 0, 0] };
}

/** 時間価値 (円/分)。所得が高いほど時間を金で買う。 */
export function valueOfTime(incomeYenMo: number): number {
  return VOT_BASE_YEN_PER_MIN + incomeYenMo / 12000;
}

function preferenceOf(p: TravelerProfile, mode: Mode): number {
  switch (mode) {
    case Mode.Walk:
      return p.prefWalk;
    case Mode.Bike:
      return p.prefBike;
    case Mode.Car:
      return p.prefCar;
    case Mode.Rail:
      return p.prefRail;
    default:
      return 0;
  }
}

function fareYen(mode: Mode, meters: number, p: TravelerProfile, purpose: Purpose): number {
  const km = meters / 1000;
  switch (mode) {
    case Mode.Car:
      return km * CAR_COST_PER_KM_YEN;
    case Mode.Rail: {
      // 定期券があれば通勤・通学の運賃は 0。
      if (p.hasTransitPass && (purpose === 0 || purpose === 1)) return 0;
      return Math.min(RAIL_FARE_CAP_YEN, RAIL_FARE_BASE_YEN + km * RAIL_FARE_PER_KM_YEN);
    }
    default:
      return 0;
  }
}

/**
 * 多項ロジットによる交通手段選択。
 *
 *   GC_m = 体感所要分 + 運賃/時間価値 + 駐車探索分
 *   U_m  = -GC_m + ASC_m + 個人の好み_m + 目的バイアス[目的][m]
 *   P(m) = exp(U_m/θ) / Σ exp(U_k/θ)
 *
 * argmax ではなく確率的に引くのが重要。同じ条件の市民が全員同じ選択をすると
 * 交通量が全か無かで振れて、街が壊れて見える。分担「率」として出したい。
 */
export function evaluateModes(
  profile: TravelerProfile,
  times: ModeTimes,
  purpose: Purpose,
  destZone: Zone,
  out: ModeOption[],
): ModeOption[] {
  const vot = valueOfTime(profile.incomeYenMo);
  const bias = PURPOSE_MODE_BIAS[purpose] ?? PURPOSE_MODE_BIAS[0]!;

  for (let m = 0; m < MODE_COUNT; m++) {
    const mode = m as Mode;
    const sec = times.sec[m]!;
    const meters = times.meters[m]!;
    const timeMin = sec / 60;

    let available = Number.isFinite(sec);
    // --- 利用可能性のハードゲート（ロジットの前に適用する） ---
    if (mode === Mode.Car && (!profile.hasCar || profile.age < 18)) available = false;
    if (mode === Mode.Bike && (profile.age < 10 || profile.age > 75 || meters > MAX_BIKE_M)) available = false;
    if (mode === Mode.Walk && timeMin > MAX_WALK_MIN) available = false;

    const costYen = available ? fareYen(mode, meters, profile, purpose) : 0;
    const parking = mode === Mode.Car ? (PARKING_SEARCH_MIN[destZone] ?? 0) : 0;
    const generalized = available ? timeMin + costYen / vot + parking : Infinity;
    const utility = available
      ? -generalized + MODE_ASC[mode]! + preferenceOf(profile, mode) + (bias[m] ?? 0)
      : -Infinity;

    const o = out[m]!;
    o.mode = mode;
    o.available = available;
    o.timeMin = available ? timeMin : Infinity;
    o.costYen = costYen;
    o.generalizedMin = generalized;
    o.utility = utility;
    o.probability = 0;
  }

  // --- ソフトマックス（オーバーフロー回避のため最大値を引く） ---
  let maxU = -Infinity;
  for (let m = 0; m < MODE_COUNT; m++) {
    const u = out[m]!.utility;
    if (u > maxU) maxU = u;
  }
  if (!Number.isFinite(maxU)) {
    // どのモードも使えない。
    for (let m = 0; m < MODE_COUNT; m++) out[m]!.probability = 0;
    return out;
  }
  let sum = 0;
  for (let m = 0; m < MODE_COUNT; m++) {
    const o = out[m]!;
    if (!o.available) continue;
    const e = Math.exp((o.utility - maxU) / LOGIT_THETA);
    o.probability = e;
    sum += e;
  }
  if (sum > 0) {
    for (let m = 0; m < MODE_COUNT; m++) out[m]!.probability /= sum;
  }
  return out;
}

/** 確率にしたがって 1 つ引く。利用可能なモードが無ければ -1。 */
export function sampleMode(options: readonly ModeOption[], rng: Rng): Mode | -1 {
  let r = rng.next();
  for (let m = 0; m < options.length; m++) {
    const p = options[m]!.probability;
    if (p <= 0) continue;
    r -= p;
    if (r <= 0) return options[m]!.mode;
  }
  // 浮動小数の端数対策: 確率が正の最後のモードを返す。
  for (let m = options.length - 1; m >= 0; m--) {
    if (options[m]!.probability > 0) return options[m]!.mode;
  }
  return -1;
}

export function newModeOptions(): ModeOption[] {
  const out: ModeOption[] = [];
  for (let m = 0; m < MODE_COUNT; m++) {
    out.push({
      mode: m as Mode,
      available: false,
      timeMin: Infinity,
      costYen: 0,
      generalizedMin: Infinity,
      utility: -Infinity,
      probability: 0,
    });
  }
  return out;
}
