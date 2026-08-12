import {
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  MONTHS_PER_YEAR,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
} from '@shared/constants';
import { Season } from '@shared/enums';

/** シミュレーション時刻。tick（= 分）を年月日時分と季節に変換するだけの純粋関数群。 */
export class Clock {
  /** 起点からの経過分。 */
  tick = 0;
  /** 開始年。 */
  readonly startYear: number;

  constructor(startYear = 1985) {
    this.startYear = startYear;
  }

  get minute(): number {
    return this.tick % TICKS_PER_HOUR;
  }
  get hour(): number {
    return Math.floor(this.tick / TICKS_PER_HOUR) % 24;
  }
  /** 起点からの通算日数。 */
  get totalDays(): number {
    return Math.floor(this.tick / TICKS_PER_DAY);
  }
  /** その日の 0 時からの経過分。 */
  get minuteOfDay(): number {
    return this.tick % TICKS_PER_DAY;
  }
  get dayOfYear(): number {
    return this.totalDays % DAYS_PER_YEAR;
  }
  get day(): number {
    return (this.dayOfYear % DAYS_PER_MONTH) + 1;
  }
  get month(): number {
    return Math.floor(this.dayOfYear / DAYS_PER_MONTH) + 1;
  }
  get year(): number {
    return this.startYear + Math.floor(this.totalDays / DAYS_PER_YEAR);
  }
  get season(): Season {
    // 3〜5月=春, 6〜8月=夏, 9〜11月=秋, 12〜2月=冬
    const m = this.month;
    if (m >= 3 && m <= 5) return Season.Spring;
    if (m >= 6 && m <= 8) return Season.Summer;
    if (m >= 9 && m <= 11) return Season.Autumn;
    return Season.Winter;
  }
  /** 1 日の中の位置 0..1。描画の日照に使う。 */
  get dayFraction(): number {
    return this.minuteOfDay / TICKS_PER_DAY;
  }

  isNewDay(): boolean {
    return this.tick % TICKS_PER_DAY === 0;
  }
  isNewMonth(): boolean {
    return this.tick % (TICKS_PER_DAY * DAYS_PER_MONTH) === 0;
  }

  formatJa(): string {
    const h = String(this.hour).padStart(2, '0');
    const mi = String(this.minute).padStart(2, '0');
    return `${this.year}年${this.month}月${this.day}日 ${h}:${mi}`;
  }
}

/** 月 (1-12) から季節を返す（Clock を作らずに使いたい場所向け）。 */
export function seasonOfMonth(month: number): Season {
  const m = ((month - 1) % MONTHS_PER_YEAR) + 1;
  if (m >= 3 && m <= 5) return Season.Spring;
  if (m >= 6 && m <= 8) return Season.Summer;
  if (m >= 9 && m <= 11) return Season.Autumn;
  return Season.Winter;
}
