/**
 * セーブデータの形式。
 *
 * 状態はほぼ全部が SoA の TypedArray なので、JSON にせず**そのままバイト列**にする。
 * 人口 2000 の街で約 1.4MB。JSON + 数値配列にすると 20 倍以上に膨らみ、
 * 書き出しと読み込みの両方で目に見えて待たされる。
 *
 * 保存しないものが 3 つある。いずれも「シードか他の状態から作り直せる」もので、
 * 保存すると形式が複雑になるうえ、古いセーブデータと実装の食い違いを生む。
 *
 * - 地形（`terrain` / `heightDm` / `slope` / `waterAccess`）… シードから再生成する
 * - 交通グラフ・TAZ 行列・経路キャッシュ・タイミングホイール … 読み込み後に作り直す
 * - 走行中の経路（市民のトリップとトラック）… 節点番号への参照なので作り直せない。
 *   読み込み時に打ち切る（市民は自宅に戻り、トラックは荷を降ろす）
 */

const MAGIC = 'JCITY1\0\0';
/**
 * 形式のバージョン。上げたら古いセーブデータは読めないものとして扱う。
 *
 * v2: 公共交通を路線ベースにした版。市民の選好配列が `prefRail` → `prefTransit` に
 * 変わり、`head` に走査カーソルと路線が入った。
 */
export const SAVE_FORMAT_VERSION = 2;

export interface SaveMeta {
  cityName: string;
  /** 保存した時刻（エポックミリ秒）。表示にだけ使う。 */
  savedAt: number;
  population: number;
  /** ゲーム内の日付（表示用）。 */
  dateJa: string;
}

/** 保存対象の配列 1 本。`name` が形式上の鍵なので、並び順は変えても構わない。 */
export interface NamedArray {
  name: string;
  data: ArrayBufferView;
}

export interface SimSnapshot {
  seed: number;
  /** JSON に載せるスカラ値と小さい配列。 */
  head: Record<string, unknown>;
  arrays: NamedArray[];
}

type Ctor = { new (buf: ArrayBuffer, offset: number, length: number): ArrayBufferView; BYTES_PER_ELEMENT: number };

const TYPES: Record<string, Ctor> = {
  u8: Uint8Array as unknown as Ctor,
  i8: Int8Array as unknown as Ctor,
  u16: Uint16Array as unknown as Ctor,
  i16: Int16Array as unknown as Ctor,
  u32: Uint32Array as unknown as Ctor,
  i32: Int32Array as unknown as Ctor,
  f32: Float32Array as unknown as Ctor,
  f64: Float64Array as unknown as Ctor,
};

function typeTag(v: ArrayBufferView): string {
  for (const [tag, ctor] of Object.entries(TYPES)) {
    if (v instanceof (ctor as unknown as { new (): unknown })) return tag;
  }
  throw new Error(`保存できない配列型です: ${v.constructor.name}`);
}

/** f64 は 8 バイト境界に載せる。ずれた offset で TypedArray を作ると例外になる。 */
const ALIGN = 8;
const alignUp = (n: number): number => (n + (ALIGN - 1)) & ~(ALIGN - 1);

export function encodeSave(snapshot: SimSnapshot, meta: SaveMeta): ArrayBuffer {
  const descriptors = snapshot.arrays.map((a) => ({
    name: a.name,
    type: typeTag(a.data),
    length: (a.data as unknown as { length: number }).length,
  }));
  const header = JSON.stringify({
    version: SAVE_FORMAT_VERSION,
    seed: snapshot.seed,
    meta,
    head: snapshot.head,
    arrays: descriptors,
  });
  const headerBytes = new TextEncoder().encode(header);

  let offset = alignUp(MAGIC.length + 4 + headerBytes.length);
  const starts: number[] = [];
  for (const a of snapshot.arrays) {
    starts.push(offset);
    offset = alignUp(offset + a.data.byteLength);
  }

  const buf = new ArrayBuffer(offset);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  new DataView(buf).setUint32(MAGIC.length, headerBytes.length, true);
  bytes.set(headerBytes, MAGIC.length + 4);
  for (let i = 0; i < snapshot.arrays.length; i++) {
    const a = snapshot.arrays[i]!.data;
    bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), starts[i]!);
  }
  return buf;
}

export function decodeSave(buf: ArrayBuffer): { snapshot: SimSnapshot; meta: SaveMeta } {
  const bytes = new Uint8Array(buf);
  if (bytes.length < MAGIC.length + 4) throw new Error('セーブデータが壊れています');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('このファイルはこのゲームのセーブデータではありません');
  }
  const headerLen = new DataView(buf).getUint32(MAGIC.length, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + headerLen))) as {
    version: number;
    seed: number;
    meta: SaveMeta;
    head: Record<string, unknown>;
    arrays: { name: string; type: string; length: number }[];
  };
  if (header.version !== SAVE_FORMAT_VERSION) {
    throw new Error(`このセーブデータは形式が違います（v${header.version}、対応しているのは v${SAVE_FORMAT_VERSION}）`);
  }

  let offset = alignUp(MAGIC.length + 4 + headerLen);
  const arrays: NamedArray[] = [];
  for (const d of header.arrays) {
    const ctor = TYPES[d.type];
    if (!ctor) throw new Error(`未知の配列型です: ${d.type}`);
    arrays.push({ name: d.name, data: new ctor(buf, offset, d.length) });
    offset = alignUp(offset + d.length * ctor.BYTES_PER_ELEMENT);
  }
  return { snapshot: { seed: header.seed, head: header.head, arrays }, meta: header.meta };
}

/** 名前で引ける形にする。読み込み側は「あるものだけ入れる」ので、欠けても落ちない。 */
export function arrayMap(arrays: readonly NamedArray[]): Map<string, ArrayBufferView> {
  const m = new Map<string, ArrayBufferView>();
  for (const a of arrays) m.set(a.name, a.data);
  return m;
}
