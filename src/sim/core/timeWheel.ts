import { TICKS_PER_DAY } from '@shared/constants';

/**
 * タイミングホイール。1 万人を毎 tick 全走査しない、という設計の中心。
 *
 * 各市民は「次に何かが起きる tick」だけを持ち、その tick のバケツに入る。
 * 1 人あたり 1 日 6〜10 イベントなので、1 万人でも 1 tick 平均 50〜70 件しか処理しない。
 * 在宅中・勤務中の市民は文字通りゼロコストになる。
 *
 * バケツ数はホイールの周長。これより先の予約はオーバーフロー配列に入り、
 * 周回のたびに回収される。
 */
const WHEEL_SIZE = 2048;
const WHEEL_MASK = WHEEL_SIZE - 1;

export class TimeWheel {
  /** バケツごとの ID 配列。要素数は buckets[i].length ではなく counts[i] を見る。 */
  private buckets: Uint32Array[] = [];
  private counts = new Uint32Array(WHEEL_SIZE);
  /** ホイールの周長より先の予約: [tick, id] のペアを平坦化して保持。 */
  private overflow: number[] = [];
  private drained = new Uint32Array(256);

  constructor() {
    for (let i = 0; i < WHEEL_SIZE; i++) this.buckets.push(new Uint32Array(16));
  }

  /** 指定 tick に id を起床させる。 */
  schedule(id: number, absoluteTick: number, currentTick: number): void {
    if (absoluteTick - currentTick >= WHEEL_SIZE) {
      this.overflow.push(absoluteTick, id);
      return;
    }
    const slot = absoluteTick & WHEEL_MASK;
    let arr = this.buckets[slot]!;
    const c = this.counts[slot]!;
    if (c === arr.length) {
      const next = new Uint32Array(arr.length * 2);
      next.set(arr);
      this.buckets[slot] = next;
      arr = next;
    }
    arr[c] = id;
    this.counts[slot] = c + 1;
  }

  /**
   * この tick に起床する ID を返す。返り値は次回 drain まで有効な内部バッファ。
   * 戻り値の長さは第 2 の返り値ではなく `drainedCount` で取得する。
   */
  drain(currentTick: number): Uint32Array {
    // オーバーフローの回収は 1 日 1 回で十分（周長 2048 > 1440 tick/日）。
    if (currentTick % TICKS_PER_DAY === 0 && this.overflow.length > 0) {
      const keep: number[] = [];
      for (let i = 0; i < this.overflow.length; i += 2) {
        const t = this.overflow[i]!;
        const id = this.overflow[i + 1]!;
        if (t - currentTick < WHEEL_SIZE) this.schedule(id, t, currentTick);
        else keep.push(t, id);
      }
      this.overflow = keep;
    }

    const slot = currentTick & WHEEL_MASK;
    const n = this.counts[slot]!;
    if (this.drained.length < n) this.drained = new Uint32Array(Math.max(n, this.drained.length * 2));
    this.drained.set(this.buckets[slot]!.subarray(0, n));
    this.counts[slot] = 0;
    this.drainedCount = n;
    return this.drained;
  }

  drainedCount = 0;

  /** 現在予約されている総件数（デバッグ用）。 */
  pending(): number {
    let total = this.overflow.length / 2;
    for (let i = 0; i < WHEEL_SIZE; i++) total += this.counts[i]!;
    return total;
  }
}
