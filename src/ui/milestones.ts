import { RoadClass, Zone } from '@shared/enums';
import { Arch } from '@sim/buildings/archetypes';

/**
 * マイルストーン（人口による解禁）。
 *
 * 最初から全部の道具を渡すと、何から手を付ければいいのか分からなくなる。
 * 人口が増えるにつれて選択肢が増えていく形にすることで、
 * 「次に何ができるようになるか」が街を育てる動機になる。
 */

/** ツールの識別子。ロック判定のキーになる。 */
export type UnlockKey =
  | `road:${number}`
  | `zone:${number}`
  | `place:${number}`
  | 'rail';

export interface Milestone {
  /** 到達に必要な人口。 */
  population: number;
  /** 到達時の呼称。 */
  nameJa: string;
  /** ここで解禁されるもの。 */
  unlocks: UnlockKey[];
  /** 解禁内容の説明（UI 表示用）。 */
  summaryJa: string;
}

export const MILESTONES: Milestone[] = [
  {
    population: 0,
    nameJa: '開拓地',
    unlocks: [
      `road:${RoadClass.Street}`,
      `zone:${Zone.ResidentialLow}`,
      `zone:${Zone.AgriField}`,
      `zone:${Zone.None}`,
      `place:${Arch.CityHall}`,
      `place:${Arch.Park}`,
    ],
    summaryJa: '生活道路・低層住居・畑・公園・役所',
  },
  {
    population: 40,
    nameJa: '集落',
    unlocks: [
      `zone:${Zone.CommercialLocal}`,
      `zone:${Zone.AgriPaddy}`,
      `zone:${Zone.Forestry}`,
      `place:${Arch.Police}`,
    ],
    summaryJa: '近隣商業・水田・林業・交番',
  },
  {
    population: 150,
    nameJa: '村',
    unlocks: [`road:${RoadClass.Avenue}`, `zone:${Zone.IndustrialLight}`, `place:${Arch.School}`],
    summaryJa: '二車線道路・準工業・学校',
  },
  {
    population: 400,
    nameJa: '町',
    unlocks: ['rail', `place:${Arch.Station}`, `place:${Arch.FireStation}`, `zone:${Zone.ResidentialMid}`],
    summaryJa: '鉄道・駅・消防署・中高層住居',
  },
  {
    population: 1000,
    nameJa: '市',
    unlocks: [
      `road:${RoadClass.Boulevard}`,
      `zone:${Zone.CommercialCentral}`,
      `zone:${Zone.IndustrialHeavy}`,
      `place:${Arch.Hospital}`,
      `place:${Arch.Shrine}`,
    ],
    summaryJa: '大通り・商業地域・工業地域・病院・神社',
  },
  {
    population: 3000,
    nameJa: '中核市',
    unlocks: [],
    summaryJa: 'オフィスビルが建つようになる',
  },
  {
    population: 6000,
    nameJa: '中核都市',
    unlocks: [],
    summaryJa: 'タワーマンションが建つようになる',
  },
];

/** 現在の人口で到達しているマイルストーンの index。 */
export function currentMilestone(population: number): number {
  let i = 0;
  for (let k = 0; k < MILESTONES.length; k++) {
    if (population >= MILESTONES[k]!.population) i = k;
  }
  return i;
}

/** 次のマイルストーン。すべて到達済みなら null。 */
export function nextMilestone(population: number): Milestone | null {
  for (const m of MILESTONES) {
    if (population < m.population) return m;
  }
  return null;
}

/** そのツールが解禁されているか。 */
export function isUnlocked(key: UnlockKey, population: number): boolean {
  for (const m of MILESTONES) {
    if (population < m.population) continue;
    if (m.unlocks.includes(key)) return true;
  }
  return false;
}

/** そのツールを解禁するのに必要な人口。解禁済み・存在しない場合は 0。 */
export function requiredPopulation(key: UnlockKey): number {
  for (const m of MILESTONES) {
    if (m.unlocks.includes(key)) return m.population;
  }
  return 0;
}
