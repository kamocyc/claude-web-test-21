import { Activity, Purpose } from '@shared/enums';

/**
 * 生活パターンのテンプレート。市民 1 人ずつに配列を持たせず、
 * 「テンプレート ID + ステップ番号 + 個人ジッタ」だけを持たせる。
 *
 * ジッタが重要で、これがラッシュのピークを「時刻の分布」に変える。
 * 全員が 8:00 ちょうどに出発すると、経路探索予算が 1 tick で吹き飛ぶ。
 */

export const ScheduleKind = {
  OfficeWorker: 0, // 会社員
  ShiftWorker: 1, // シフト勤務
  Student: 2, // 学生
  Homemaker: 3, // 主婦・主夫
  Retired: 4, // 高齢者
  Unemployed: 5, // 無職
  NightShift: 6, // 夜勤
} as const;
export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];

export const SCHEDULE_NAMES_JA: Record<number, string> = {
  [ScheduleKind.OfficeWorker]: '会社員',
  [ScheduleKind.ShiftWorker]: 'シフト勤務',
  [ScheduleKind.Student]: '学生',
  [ScheduleKind.Homemaker]: '主婦・主夫',
  [ScheduleKind.Retired]: '高齢者',
  [ScheduleKind.Unemployed]: '無職',
  [ScheduleKind.NightShift]: '夜勤',
};

export interface ScheduleStep {
  /** このステップで向かう先（Activity）。 */
  activity: Activity;
  /** 移動の目的。交通手段選択のバイアスに使う。 */
  purpose: Purpose;
  /** 出発する時刻（分、0-1439）。 */
  startMinute: number;
  /** 出発時刻のばらつき（±分）。 */
  jitter: number;
  /** そのステップをスキップする確率（0..1）。買い物・レジャーの寄り道に使う。 */
  skipChance: number;
}

export interface ScheduleTemplate {
  kind: ScheduleKind;
  steps: ScheduleStep[];
}

const step = (
  activity: Activity,
  purpose: Purpose,
  startMinute: number,
  jitter: number,
  skipChance = 0,
): ScheduleStep => ({ activity, purpose, startMinute, jitter, skipChance });

const H = (h: number, m = 0): number => h * 60 + m;

export const SCHEDULES: ScheduleTemplate[] = [
  {
    kind: ScheduleKind.OfficeWorker,
    steps: [
      step(Activity.AtWork, Purpose.Commute, H(8, 0), 45),
      step(Activity.Shopping, Purpose.Shopping, H(18, 30), 40, 0.55),
      step(Activity.Leisure, Purpose.Leisure, H(19, 30), 40, 0.75),
      step(Activity.AtHome, Purpose.Home, H(20, 30), 50),
      step(Activity.Sleeping, Purpose.Home, H(23, 30), 40),
    ],
  },
  {
    kind: ScheduleKind.ShiftWorker,
    steps: [
      step(Activity.AtWork, Purpose.Commute, H(6, 30), 40),
      step(Activity.Shopping, Purpose.Shopping, H(16, 0), 40, 0.5),
      step(Activity.AtHome, Purpose.Home, H(17, 0), 40),
      step(Activity.Sleeping, Purpose.Home, H(22, 0), 40),
    ],
  },
  {
    kind: ScheduleKind.Student,
    steps: [
      step(Activity.AtSchool, Purpose.School, H(7, 40), 25),
      step(Activity.Leisure, Purpose.Leisure, H(15, 40), 40, 0.5),
      step(Activity.AtHome, Purpose.Home, H(17, 30), 50),
      step(Activity.Sleeping, Purpose.Home, H(22, 30), 40),
    ],
  },
  {
    kind: ScheduleKind.Homemaker,
    steps: [
      step(Activity.Shopping, Purpose.Shopping, H(10, 0), 60),
      step(Activity.AtHome, Purpose.Home, H(11, 30), 50),
      step(Activity.Leisure, Purpose.Leisure, H(14, 30), 60, 0.6),
      step(Activity.AtHome, Purpose.Home, H(16, 0), 50),
      step(Activity.Sleeping, Purpose.Home, H(23, 0), 45),
    ],
  },
  {
    kind: ScheduleKind.Retired,
    steps: [
      step(Activity.Leisure, Purpose.Leisure, H(8, 30), 60, 0.25),
      step(Activity.AtHome, Purpose.Home, H(10, 30), 50),
      step(Activity.Shopping, Purpose.Shopping, H(14, 0), 60, 0.4),
      step(Activity.AtHome, Purpose.Home, H(15, 30), 50),
      step(Activity.Sleeping, Purpose.Home, H(21, 30), 45),
    ],
  },
  {
    kind: ScheduleKind.Unemployed,
    steps: [
      step(Activity.Leisure, Purpose.Leisure, H(11, 0), 90, 0.35),
      step(Activity.AtHome, Purpose.Home, H(13, 0), 60),
      step(Activity.Shopping, Purpose.Shopping, H(16, 0), 60, 0.6),
      step(Activity.AtHome, Purpose.Home, H(17, 30), 60),
      step(Activity.Sleeping, Purpose.Home, H(23, 0), 60),
    ],
  },
  {
    kind: ScheduleKind.NightShift,
    steps: [
      step(Activity.AtWork, Purpose.Commute, H(21, 30), 40),
      step(Activity.AtHome, Purpose.Home, H(6, 30), 40),
      step(Activity.Sleeping, Purpose.Home, H(8, 0), 40),
    ],
  },
];

/** 年齢・就業状態から生活パターンを決める。 */
export function pickSchedule(age: number, employed: boolean, retired: boolean, nightShift: boolean): ScheduleKind {
  if (age < 6) return ScheduleKind.Homemaker; // 未就学児は保護者と同じリズム
  if (age < 22 && !employed) return ScheduleKind.Student;
  if (retired) return ScheduleKind.Retired;
  if (!employed) return ScheduleKind.Unemployed;
  if (nightShift) return ScheduleKind.NightShift;
  return ScheduleKind.OfficeWorker;
}
