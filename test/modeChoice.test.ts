import { describe, expect, it } from 'vitest';
import { Mode, Purpose, Zone } from '@shared/enums';
import { Rng } from '@sim/core/rng';
import {
  emptyModeTimes,
  evaluateModes,
  newModeOptions,
  sampleMode,
  valueOfTime,
  type TravelerProfile,
} from '@sim/network/modeChoice';

function profile(over: Partial<TravelerProfile> = {}): TravelerProfile {
  return {
    id: 1,
    prefWalk: 0,
    prefBike: 0,
    prefCar: 0,
    prefTransit: 0,
    incomeYenMo: 300_000,
    age: 35,
    hasCar: true,
    hasTransitPass: false,
    ...over,
  };
}

/** 全モードが同じ所要時間・距離になる状況を作る。 */
function times(sec: number, meters: number) {
  const t = emptyModeTimes();
  for (let m = 0; m < 4; m++) {
    t.sec[m] = sec;
    t.meters[m] = meters;
  }
  return t;
}

describe('交通手段の選択', () => {
  it('確率の総和が 1 になる', () => {
    const out = newModeOptions();
    evaluateModes(profile(), times(900, 3000), Purpose.Commute, Zone.CommercialCentral, out);
    const sum = out.reduce((a, o) => a + o.probability, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('自動車を持たない市民は自動車を選ばない', () => {
    const out = newModeOptions();
    evaluateModes(profile({ hasCar: false }), times(900, 3000), Purpose.Commute, Zone.ResidentialLow, out);
    expect(out[Mode.Car]!.available).toBe(false);
    expect(out[Mode.Car]!.probability).toBe(0);
  });

  it('18 歳未満は自動車を選べない', () => {
    const out = newModeOptions();
    evaluateModes(profile({ age: 16 }), times(900, 3000), Purpose.Commute, Zone.ResidentialLow, out);
    expect(out[Mode.Car]!.available).toBe(false);
  });

  it('鉄道が到達不能なら鉄道の確率は 0', () => {
    const out = newModeOptions();
    const t = times(900, 3000);
    t.sec[Mode.Transit] = Infinity;
    evaluateModes(profile(), t, Purpose.Commute, Zone.CommercialCentral, out);
    expect(out[Mode.Transit]!.probability).toBe(0);
    expect(out.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 6);
  });

  it('自動車の所要時間が延びるほど自動車の選択確率は単調に下がる', () => {
    const out = newModeOptions();
    let prev = Infinity;
    for (const carSec of [600, 900, 1200, 1800, 2400, 3600]) {
      const t = times(900, 3000);
      t.sec[Mode.Car] = carSec;
      evaluateModes(profile(), t, Purpose.Commute, Zone.ResidentialLow, out);
      const p = out[Mode.Car]!.probability;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it('自動車への個人的な好みが強いほど自動車が選ばれやすい', () => {
    const out = newModeOptions();
    let prev = -1;
    for (const pref of [-20, -10, 0, 10, 20]) {
      evaluateModes(profile({ prefCar: pref }), times(900, 3000), Purpose.Commute, Zone.ResidentialLow, out);
      const p = out[Mode.Car]!.probability;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('都心は駐車探索時間の分だけ自動車が不利になる', () => {
    const out = newModeOptions();
    evaluateModes(profile(), times(900, 3000), Purpose.Commute, Zone.ResidentialLow, out);
    const suburb = out[Mode.Car]!.probability;
    evaluateModes(profile(), times(900, 3000), Purpose.Commute, Zone.CommercialCentral, out);
    const downtown = out[Mode.Car]!.probability;
    expect(downtown).toBeLessThan(suburb);
  });

  it('定期券があると通勤の鉄道運賃が 0 になり、鉄道が選ばれやすくなる', () => {
    const out = newModeOptions();
    evaluateModes(profile({ hasTransitPass: false }), times(1500, 6000), Purpose.Commute, Zone.CommercialCentral, out);
    const noPass = out[Mode.Transit]!.probability;
    const fare = out[Mode.Transit]!.costYen;
    evaluateModes(profile({ hasTransitPass: true }), times(1500, 6000), Purpose.Commute, Zone.CommercialCentral, out);
    expect(fare).toBeGreaterThan(0);
    expect(out[Mode.Transit]!.costYen).toBe(0);
    expect(out[Mode.Transit]!.probability).toBeGreaterThan(noPass);
  });

  it('所得が高いほど時間価値が上がる', () => {
    expect(valueOfTime(600_000)).toBeGreaterThan(valueOfTime(200_000));
  });

  it('徒歩 45 分を超える距離では徒歩が選択肢から外れる', () => {
    const out = newModeOptions();
    const t = times(600, 2000);
    t.sec[Mode.Walk] = 46 * 60;
    evaluateModes(profile(), t, Purpose.Commute, Zone.ResidentialLow, out);
    expect(out[Mode.Walk]!.available).toBe(false);
  });

  it('抽選の分布が理論上の選択確率に一致する', () => {
    const out = newModeOptions();
    evaluateModes(profile(), times(900, 3000), Purpose.Commute, Zone.ResidentialLow, out);
    const expected = out.map((o) => o.probability);

    const rng = new Rng(777);
    const counts = [0, 0, 0, 0];
    const N = 40_000;
    for (let i = 0; i < N; i++) {
      const m = sampleMode(out, rng);
      if (m >= 0) counts[m]!++;
    }
    for (let m = 0; m < 4; m++) {
      const observed = counts[m]! / N;
      // 3σ 相当の許容幅
      const sd = Math.sqrt((expected[m]! * (1 - expected[m]!)) / N);
      expect(Math.abs(observed - expected[m]!)).toBeLessThan(Math.max(0.01, 4 * sd));
    }
  });

  it('どのモードも使えなければ選択できない', () => {
    const out = newModeOptions();
    const t = emptyModeTimes(); // 全モード Infinity
    evaluateModes(profile({ hasCar: false }), t, Purpose.Commute, Zone.ResidentialLow, out);
    const rng = new Rng(1);
    expect(sampleMode(out, rng)).toBe(-1);
  });
});
