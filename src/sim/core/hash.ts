/** 決定論テスト用の状態ハッシュ。FNV-1a を ArrayBuffer 上で回す。 */

export function fnv1a(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 複数の TypedArray をまとめて 1 つのハッシュにする。 */
export function hashArrays(arrays: readonly ArrayBufferView[]): number {
  let h = 0x811c9dc5;
  for (const a of arrays) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    h = fnv1a(bytes, h);
  }
  return h >>> 0;
}

/** 数値列をハッシュに畳み込む（スカラーな状態用）。 */
export function hashNumbers(values: readonly number[], seed = 0x811c9dc5): number {
  const buf = new Float64Array(values);
  return fnv1a(new Uint8Array(buf.buffer), seed);
}
