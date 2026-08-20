import { BoxGeometry, BufferAttribute, BufferGeometry } from 'three';
import { TRAIN_CAR_LENGTH_M } from '@shared/constants';

/**
 * 車両の造形。
 *
 * これまで車もバスもトラックも電車も**箱 1 つ**だった。実寸で描いてあるので
 * 縮尺は正しいのだが、近景に寄ると「色の付いた直方体が道を流れている」だけで、
 * どれがバスでどれがトラックなのかも形からは分からなかった。
 *
 * かといって車種ごとにメッシュを分けると、いま 1 種類 1 ドローコールで
 * 数千台を描いている作りが崩れる。そこで**部品（箱）を 1 つのジオメトリに
 * 焼き込み**、インスタンスは今までどおり 1 台 1 つのままにする。
 *
 * 部品ごとの塗り分けは頂点色で行うが、頂点色は**絶対色ではなく変調係数**として
 * 持たせる。three.js は `vColor = color * instanceColor` と掛け算するので、
 * 車体を白（1,1,1）、窓を暗い灰、タイヤをほぼ黒にしておけば、
 * `instanceColor` に車体色を入れるだけで
 * 「白い車の窓は明るい灰、黒い車の窓は真っ黒」と自然に付いてくる。
 *
 * ここが `buildingLayer` の「vertexColors を付けてはいけない」という注意と
 * 食い違って見えるが、あちらは**色属性を持たないジオメトリに**
 * `vertexColors: true` を付けると全部黒になる、という話。
 * ここでは色属性を必ず作るので問題にならない。
 */

/** 部品 1 つ。位置は箱の中心、単位は m。長辺（進行方向）は +Z。 */
export interface Part {
  w: number;
  h: number;
  d: number;
  x?: number;
  y?: number;
  z?: number;
  /** 変調色。0xffffff で車体色そのまま、暗い色ほど落ちる。 */
  tint?: number;
  /** X 軸まわりの回転（rad）。パンタグラフの腕のような斜めの部品に使う。 */
  rotX?: number;
}

/** 窓ガラス。白い車体なら明るい灰、黒い車体ならほぼ黒になる。 */
const GLASS = 0x5f676e;
/** タイヤ。どんな車体色でもほぼ黒になる。 */
const TYRE = 0x1e2022;
/** 下回り（シャシー・床下機器）。 */
const UNDER = 0x4a4e52;

/**
 * 箱を並べて 1 つのジオメトリに合成する。
 *
 * `BoxGeometry` は 24 頂点・36 索引の索引付きジオメトリなので、
 * 索引をずらして連結するだけで済む（非索引化すると頂点が 1.5 倍になる）。
 */
export function partsGeometry(parts: readonly Part[]): BufferGeometry {
  const geoms = parts.map((p) => {
    const g = new BoxGeometry(p.w, p.h, p.d);
    if (p.rotX) g.rotateX(p.rotX);
    g.translate(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    return g;
  });

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geoms) {
    vertexCount += g.getAttribute('position').count;
    indexCount += g.getIndex()!.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint16Array(indexCount);

  let vo = 0;
  let io = 0;
  for (let k = 0; k < geoms.length; k++) {
    const g = geoms[k]!;
    const p = parts[k]!;
    const gp = g.getAttribute('position').array as Float32Array;
    const gn = g.getAttribute('normal').array as Float32Array;
    const gi = g.getIndex()!.array as ArrayLike<number>;
    position.set(gp, vo * 3);
    normal.set(gn, vo * 3);
    const tint = p.tint ?? 0xffffff;
    const r = ((tint >> 16) & 255) / 255;
    const gcol = ((tint >> 8) & 255) / 255;
    const b = (tint & 255) / 255;
    const n = g.getAttribute('position').count;
    for (let v = 0; v < n; v++) {
      color[(vo + v) * 3] = r;
      color[(vo + v) * 3 + 1] = gcol;
      color[(vo + v) * 3 + 2] = b;
    }
    for (let i = 0; i < gi.length; i++) index[io + i] = gi[i]! + vo;
    vo += n;
    io += gi.length;
    g.dispose();
  }

  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(position, 3));
  out.setAttribute('normal', new BufferAttribute(normal, 3));
  out.setAttribute('color', new BufferAttribute(color, 3));
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}

/**
 * 自家用車。全長 4.2m・全幅 1.7m・全高 1.52m の実寸。
 * ボンネットとトランクの段差を付けるだけで、上から見ても前後が分かるようになる。
 */
export const CAR_PARTS: Part[] = [
  { w: 1.7, h: 0.6, d: 4.2, y: 0.6 },
  { w: 1.62, h: 0.22, d: 1.3, y: 1.01, z: 1.35 },
  { w: 1.62, h: 0.18, d: 0.9, y: 0.99, z: -1.55 },
  { w: 1.56, h: 0.48, d: 2.0, y: 1.18, z: -0.15, tint: GLASS },
  { w: 1.48, h: 0.1, d: 1.7, y: 1.47, z: -0.25 },
  { w: 0.22, h: 0.52, d: 0.52, x: 0.8, y: 0.26, z: 1.32, tint: TYRE },
  { w: 0.22, h: 0.52, d: 0.52, x: -0.8, y: 0.26, z: 1.32, tint: TYRE },
  { w: 0.22, h: 0.52, d: 0.52, x: 0.8, y: 0.26, z: -1.32, tint: TYRE },
  { w: 0.22, h: 0.52, d: 0.52, x: -0.8, y: 0.26, z: -1.32, tint: TYRE },
];

/** 路線バス。窓の帯を高く取ると、遠目でも車と見分けが付く。 */
export const BUS_PARTS: Part[] = [
  { w: 2.36, h: 0.55, d: 7.4, y: 0.7, tint: 0xd8d8d8 },
  { w: 2.4, h: 0.75, d: 7.5, y: 1.35 },
  { w: 2.44, h: 0.9, d: 7.1, y: 2.17, tint: GLASS },
  { w: 2.4, h: 0.3, d: 7.5, y: 2.77 },
  { w: 1.3, h: 0.16, d: 2.2, y: 3.0, z: -1.0, tint: 0xdcdcdc },
  { w: 0.26, h: 0.86, d: 0.86, x: 1.12, y: 0.43, z: 2.45, tint: TYRE },
  { w: 0.26, h: 0.86, d: 0.86, x: -1.12, y: 0.43, z: 2.45, tint: TYRE },
  { w: 0.26, h: 0.86, d: 0.86, x: 1.12, y: 0.43, z: -2.1, tint: TYRE },
  { w: 0.26, h: 0.86, d: 0.86, x: -1.12, y: 0.43, z: -2.1, tint: TYRE },
];

/**
 * トラック。運転台と荷台を分ける。
 * 車体色は積荷の色なので、荷台に色が乗って「何を運んでいるか」が読める。
 */
export const TRUCK_PARTS: Part[] = [
  { w: 1.9, h: 0.25, d: 6.2, y: 0.63, tint: UNDER },
  { w: 2.2, h: 1.45, d: 1.9, y: 1.33, z: 2.2, tint: 0xdadada },
  { w: 2.24, h: 0.52, d: 1.86, y: 1.66, z: 2.2, tint: GLASS },
  { w: 2.2, h: 1.85, d: 4.2, y: 1.68, z: -1.05 },
  { w: 0.28, h: 0.9, d: 0.9, x: 1.05, y: 0.45, z: 2.1, tint: TYRE },
  { w: 0.28, h: 0.9, d: 0.9, x: -1.05, y: 0.45, z: 2.1, tint: TYRE },
  { w: 0.28, h: 0.9, d: 0.9, x: 1.05, y: 0.45, z: -0.6, tint: TYRE },
  { w: 0.28, h: 0.9, d: 0.9, x: -1.05, y: 0.45, z: -0.6, tint: TYRE },
  { w: 0.28, h: 0.9, d: 0.9, x: 1.05, y: 0.45, z: -2.2, tint: TYRE },
  { w: 0.28, h: 0.9, d: 0.9, x: -1.05, y: 0.45, z: -2.2, tint: TYRE },
];

/**
 * 電車 1 両。原点はレール面（車輪の下端）に置く。
 *
 * 台車を y<0 に出しているので、線路のバラストに車体が沈まずに載る。
 * 屋根のパンタグラフは、日本の通勤電車を電車らしく見せている一番の要素。
 */
const L = TRAIN_CAR_LENGTH_M;
export const TRAIN_PARTS: Part[] = [
  { w: 2.5, h: 0.55, d: 3.2, y: -0.28, z: L * 0.29, tint: 0x2e3236 },
  { w: 2.5, h: 0.55, d: 3.2, y: -0.28, z: -L * 0.29, tint: 0x2e3236 },
  { w: 2.8, h: 0.55, d: L * 0.97, y: 0.28, tint: UNDER },
  { w: 2.9, h: 1.15, d: L, y: 1.13 },
  { w: 2.94, h: 0.95, d: L * 0.9, y: 2.18, tint: GLASS },
  { w: 2.9, h: 0.65, d: L, y: 2.98 },
  { w: 2.62, h: 0.22, d: L, y: 3.41, tint: 0xc0c4c8 },
  { w: 1.4, h: 0.18, d: L * 0.32, y: 3.61, tint: 0xcacdd0 },
  { w: 1.2, h: 0.1, d: 1.2, y: 3.57, z: -L * 0.32, tint: 0x6a6e72 },
  { w: 0.1, h: 0.06, d: 1.9, y: 4.02, z: -L * 0.32 + 0.55, rotX: 0.62, tint: 0x6a6e72 },
  { w: 1.3, h: 0.07, d: 0.12, y: 4.48, z: -L * 0.32 + 1.05, tint: 0x6a6e72 },
];

/**
 * 夜の灯り。
 *
 * こちらは変調ではなく**そのままの色**で描く（`MeshBasicMaterial` ＋
 * `instanceColor` なし）。夜の街で光って見えてほしいので、光源の影響を受けない
 * 材質を使う。建物の窓を夜に灯すのと同じ考え方。
 */
const HEAD_LAMP = 0xfff3d0;
const TAIL_LAMP = 0xff3b2f;
const CABIN_LAMP = 0xffe6ad;

/**
 * 車内灯を窓の枚数だけ並べる。全長 `length` を `n` 等分し、
 * 各区画の 7 割を光らせて 3 割を柱として残す。
 */
function lampWindows(w: number, h: number, length: number, y: number, n: number): Part[] {
  const pitch = length / n;
  const out: Part[] = [];
  for (let k = 0; k < n; k++) {
    out.push({ w, h, d: pitch * 0.7, y, z: (k - (n - 1) / 2) * pitch, tint: CABIN_LAMP });
  }
  return out;
}

export const CAR_LAMPS: Part[] = [
  { w: 0.3, h: 0.18, d: 0.1, x: 0.62, y: 0.78, z: 2.11, tint: HEAD_LAMP },
  { w: 0.3, h: 0.18, d: 0.1, x: -0.62, y: 0.78, z: 2.11, tint: HEAD_LAMP },
  { w: 0.26, h: 0.16, d: 0.1, x: 0.66, y: 0.84, z: -2.11, tint: TAIL_LAMP },
  { w: 0.26, h: 0.16, d: 0.1, x: -0.66, y: 0.84, z: -2.11, tint: TAIL_LAMP },
];

export const BUS_LAMPS: Part[] = [
  { w: 0.36, h: 0.22, d: 0.1, x: 0.85, y: 0.95, z: 3.76, tint: HEAD_LAMP },
  { w: 0.36, h: 0.22, d: 0.1, x: -0.85, y: 0.95, z: 3.76, tint: HEAD_LAMP },
  { w: 0.32, h: 0.2, d: 0.1, x: 0.9, y: 1.0, z: -3.76, tint: TAIL_LAMP },
  { w: 0.32, h: 0.2, d: 0.1, x: -0.9, y: 1.0, z: -3.76, tint: TAIL_LAMP },
  // 車内灯。窓 1 枚ずつに割る。帯 1 本で光らせると蛍光管が走っているように見える。
  ...lampWindows(2.46, 0.8, 7.0, 2.17, 5),
];

export const TRUCK_LAMPS: Part[] = [
  { w: 0.34, h: 0.2, d: 0.1, x: 0.85, y: 0.9, z: 3.16, tint: HEAD_LAMP },
  { w: 0.34, h: 0.2, d: 0.1, x: -0.85, y: 0.9, z: 3.16, tint: HEAD_LAMP },
  { w: 0.3, h: 0.18, d: 0.1, x: 0.9, y: 0.95, z: -3.16, tint: TAIL_LAMP },
  { w: 0.3, h: 0.18, d: 0.1, x: -0.9, y: 0.95, z: -3.16, tint: TAIL_LAMP },
];

export const TRAIN_LAMPS: Part[] = [
  ...lampWindows(2.96, 0.85, L * 0.88, 2.18, 8),
  { w: 0.34, h: 0.22, d: 0.1, x: 0.9, y: 1.5, z: L / 2, tint: HEAD_LAMP },
  { w: 0.34, h: 0.22, d: 0.1, x: -0.9, y: 1.5, z: L / 2, tint: HEAD_LAMP },
];
