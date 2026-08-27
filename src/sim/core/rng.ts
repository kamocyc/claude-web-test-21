/**
 * 決定論的な擬似乱数。sim レイヤでは Math.random を一切使わない
 * （リプレイ・ゴールデンハッシュ検証・ヘッドレス実行がすべてこれに依存する）。
 *
 * xoshiro128** — 高速で周期 2^128-1、統計的性質も十分。
 * シードの展開には splitmix32 を使い、貧弱なシード（0 や 1）でも状態が偏らないようにする。
 */
export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    let x = seed >>> 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // 全ビット 0 の状態は不動点なので回避する。
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** 内部状態。セーブ／ロードで乱数列の続きを再現するために使う。 */
  getState(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  setState(s: readonly number[]): void {
    this.s0 = s[0]! >>> 0;
    this.s1 = s[1]! >>> 0;
    this.s2 = s[2]! >>> 0;
    this.s3 = s[3]! >>> 0;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** 32bit 符号なし整数を返す。 */
  nextU32(): number {
    const t = Math.imul(this.s1, 5);
    const result = (((t << 7) | (t >>> 25)) >>> 0) * 9;
    const tmp = (this.s1 << 9) >>> 0;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= tmp;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;

    this.s0 >>>= 0;
    this.s1 >>>= 0;
    this.s2 >>>= 0;
    this.s3 >>>= 0;
    return result >>> 0;
  }

  /** [0, 1) の浮動小数。 */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** [0, n) の整数。 */
  int(n: number): number {
    return n <= 0 ? 0 : (this.nextU32() % n) | 0;
  }

  /** [min, max] の整数。 */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** [min, max) の浮動小数。 */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** 確率 p で true。 */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 平均 mean, 標準偏差 sd の正規分布（Box-Muller）。 */
  normal(mean: number, sd: number): number {
    // u が 0 だと log が -Infinity になるため下限を入れる。
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 重み配列から 1 つ選ぶ。全重みが 0 以下なら -1。 */
  weightedPick(weights: readonly number[], count = weights.length): number {
    let total = 0;
    for (let i = 0; i < count; i++) total += Math.max(0, weights[i] ?? 0);
    if (total <= 0) return -1;
    let r = this.next() * total;
    for (let i = 0; i < count; i++) {
      r -= Math.max(0, weights[i] ?? 0);
      if (r <= 0) return i;
    }
    return count - 1;
  }

  /**
   * サブストリームを切り出す。サブシステムごとに fork しておくと、
   * ある系統に乱数呼び出しを 1 つ足しても他系統の乱数列がずれない
   * （開発中にテストが無関係な理由で壊れるのを防ぐ）。
   */
  fork(label: string): Rng {
    let h = 2166136261;
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return new Rng((this.nextU32() ^ h) >>> 0);
  }

  /** 状態の保存・復元（セーブデータ用）。 */
  saveState(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }
  loadState(s: readonly [number, number, number, number]): void {
    this.s0 = s[0] >>> 0;
    this.s1 = s[1] >>> 0;
    this.s2 = s[2] >>> 0;
    this.s3 = s[3] >>> 0;
  }
}

/**
 * ID から決定論的に [0,1) を得る。状態を持たないので、
 * 「市民ごとの固定的な癖」（コスト摂動など）に使える。
 */
export function hashUnit(a: number, b = 0): number {
  let h = (a ^ Math.imul(b, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}
