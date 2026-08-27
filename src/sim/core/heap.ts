/**
 * TypedArray バックの二分ヒープ。A* の内側ループで使うため、
 * push/pop がオブジェクトを一切生成しないことが要件。
 */
export class BinaryHeap {
  private keys: Float64Array;
  private vals: Uint32Array;
  private n = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Uint32Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  private grow(): void {
    const cap = this.keys.length * 2;
    const k = new Float64Array(cap);
    k.set(this.keys);
    const v = new Uint32Array(cap);
    v.set(this.vals);
    this.keys = k;
    this.vals = v;
  }

  push(key: number, val: number): void {
    if (this.n === this.keys.length) this.grow();
    let i = this.n++;
    this.keys[i] = key;
    this.vals[i] = val;
    // 上方向へサイフトアップ
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** 最小キーの値を取り出す。空なら -1。 */
  pop(): number {
    if (this.n === 0) return -1;
    const top = this.vals[0]!;
    this.n--;
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n]!;
      this.vals[0] = this.vals[this.n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.n && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < this.n && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  /** 次に pop される要素のキー（取り出しはしない）。 */
  peekKey(): number {
    return this.n === 0 ? Infinity : this.keys[0]!;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
    const v = this.vals[a]!;
    this.vals[a] = this.vals[b]!;
    this.vals[b] = v;
  }
}
