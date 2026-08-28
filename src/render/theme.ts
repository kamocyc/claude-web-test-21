import { Color } from 'three';
import { Facade } from './buildingParts';
import { Good, Overlay, RoadClass, Season, Terrain, Zone } from '@shared/enums';

/**
 * 配色。日本の風景を意識した落ち着いた色調にする。
 * 田んぼだけは季節で色が変わり、これが街の時間経過を一番わかりやすく伝える。
 */

export const TERRAIN_COLORS: Record<number, number> = {
  [Terrain.Plain]: 0x7f9a63,
  [Terrain.Lowland]: 0x8aa86a,
  [Terrain.Forest]: 0x3f6b42,
  [Terrain.Hill]: 0x6f8a5a,
  [Terrain.Mountain]: 0x7b7a70,
  [Terrain.Freshwater]: 0x4a7fa8,
  [Terrain.Sea]: 0x2f5f86,
};

export const ZONE_COLORS: Record<number, number> = {
  [Zone.None]: 0x888888,
  [Zone.ResidentialLow]: 0x6cc06c,
  [Zone.ResidentialMid]: 0x2f9e4f,
  [Zone.CommercialLocal]: 0x5aa9e6,
  [Zone.CommercialCentral]: 0x2f6fb5,
  [Zone.IndustrialLight]: 0xe0c04a,
  [Zone.IndustrialHeavy]: 0xc9902f,
  [Zone.AgriPaddy]: 0xb7cf7a,
  [Zone.AgriField]: 0xc7a86a,
  [Zone.Forestry]: 0x2f7a45,
  [Zone.Park]: 0x8ad48a,
};

export const ROAD_COLORS: Record<number, number> = {
  [RoadClass.None]: 0x000000,
  [RoadClass.Street]: 0x8f8f8a,
  [RoadClass.Avenue]: 0x7c7c78,
  [RoadClass.Boulevard]: 0x6b6b68,
};

/** 田んぼの季節色。春=代掻きの水面、夏=青々とした緑、秋=黄金、冬=刈田。 */
export const PADDY_SEASON_COLORS: Record<number, number> = {
  [Season.Spring]: 0x8fb6c9,
  [Season.Summer]: 0x5aa84a,
  [Season.Autumn]: 0xd8b34a,
  [Season.Winter]: 0xa08a68,
};

/**
 * 自家用車の車体色。日本の保有台数の色分布に寄せてある（白・銀・黒で 8 割）。
 * 累積確率 0..99 の閾値と対で持つ。
 */
export const CAR_COLORS: { upTo: number; color: number }[] = [
  { upTo: 40, color: 0xe8e8e8 }, // 白（パール含む）
  { upTo: 65, color: 0xa8adb2 }, // シルバー
  { upTo: 85, color: 0x2a2d33 }, // 黒
  { upTo: 93, color: 0x3a5a8a }, // 紺
  { upTo: 100, color: 0x8f3a3a }, // 赤
];

export function carColor(hash: number): number {
  const h = hash % 100;
  for (const c of CAR_COLORS) {
    if (h < c.upTo) return c.color;
  }
  return CAR_COLORS[CAR_COLORS.length - 1]!.color;
}

/**
 * トラックの車体色。積荷で塗り分ける。
 * 何がどこへ流れているかが、街を眺めるだけで読み取れるようにするため。
 */
export const CARGO_COLORS: Record<number, number> = {
  [Good.None]: 0x8a8f95, // 空車（帰路）
  [Good.Rice]: 0xd9c67a,
  [Good.Vegetables]: 0x5a9a4a,
  [Good.Logs]: 0x7a5a38,
  [Good.Lumber]: 0xc09a5e,
  [Good.Food]: 0xd97f3a,
  [Good.ConsumerGoods]: 0x4a6a9a,
};

/**
 * 路線の色。バスの車体と路線一覧で同じ色を使うので、
 * 「いま走っているのがどの系統か」が地図の上で分かる。
 * 日本の路線図でよく使われる色から、隣り合っても見分けの付く順に並べてある。
 */
export const LINE_COLORS: number[] = [
  0x2f7fbf, 0xd9534f, 0x4caf50, 0xe8a33d, 0x8e5ea2, 0x36b8b8, 0xd06ba0, 0x7a8a3a,
];

export function lineColor(id: number): number {
  return LINE_COLORS[((id % LINE_COLORS.length) + LINE_COLORS.length) % LINE_COLORS.length]!;
}

/** 電車の車体色。先頭車だけ帯を濃くして向きが分かるようにする。 */
export const TRAIN_BODY_COLOR = 0xd8dde4;
export const TRAIN_HEAD_COLOR = 0x3f6fa8;

/** ドラッグ中のプレビュー。敷ける／敷けないを色で分ける。 */
export const PREVIEW_OK_COLOR = 0x6fe08a;
export const PREVIEW_BAD_COLOR = 0xff5555;

/**
 * 建物の形状キーごとの造形パラメータ。
 *
 * 以前は「色・高さ・屋根の形」の 3 つしか無く、どの用途も 1 つの箱に
 * 屋根が載るだけだった。ここに**階高・スパン・立面の様式・量塊のバリエーション**を
 * 足すと、同じ描画コードのまま用途ごとの顔が出せるようになる。
 *
 * - `floorH` / `bay` は窓の格子の刻み。実際の階高（住宅 2.9m、事務所 3.6m、
 *   工場 5m 前後）に合わせてあるので、隣り合う建物の窓の高さが揃い、
 *   街並みとして自然に見える。
 * - `walls` / `roofs` は候補の配列。棟ごとにハッシュで 1 つ選び、
 *   さらに `jitterColor` で散らす。「同じ色の箱の整列」が消える。
 */
export interface MeshStyle {
  /** 壁の色の候補。棟ごとにハッシュで選ぶ。 */
  walls: number[];
  /** 屋根の色の候補。 */
  roofs: number[];
  /** 立面の様式（`Facade.*`）。 */
  facade: number;
  /** 階高 (m)。窓の格子はこの高さで刻む。 */
  floorH: number;
  /** 窓のスパン (m)。 */
  bay: number;
  /** レベル 1 の高さ (m)。 */
  baseHeight: number;
  /** レベルごとの追加高さ (m)。 */
  perLevel: number;
  /**
   * 屋根の形。
   *
   * 日本の街並みは切妻・寄棟・陸屋根の混在で出来ている。
   * 陸屋根には必ずパラペットと屋上設備が載るので、`Flat` は
   * 「何も無い平らな面」ではなく「情報量の多い面」を意味する。
   */
  roofKind: RoofKind;
  /** 敷地に対する建物の占有率。小さいほど庭・空地が見える。 */
  inset: number;
  /** 量塊のバリエーション数（ハッシュで選ぶ）。 */
  variants: number;
}

/** 屋根の形。`none` は屋上に何も載せない（背の低い農地・公園など）。 */
export const RoofKind = {
  None: 'none',
  /** 切妻。棟が 1 本通る、日本の住宅でいちばん多い形。 */
  Gable: 'gable',
  /** 寄棟（方形）。4 方向に流れる。 */
  Hip: 'hip',
  /** 陸屋根。平らな屋上にパラペット（立ち上がり）を回す。 */
  Flat: 'flat',
} as const;
export type RoofKind = (typeof RoofKind)[keyof typeof RoofKind];

const style = (o: Partial<MeshStyle> & { walls: number[] }): MeshStyle => ({
  roofs: [0x4a4f56],
  facade: Facade.Residential,
  floorH: 3.0,
  bay: 2.6,
  baseHeight: 6,
  perLevel: 3,
  roofKind: RoofKind.None,
  inset: 0.78,
  variants: 1,
  ...o,
});

/** 日本の住宅でよく見る外壁（サイディング・モルタル）の色。 */
const HOUSE_WALLS = [0xd8ccb0, 0xc9c0a4, 0xbfbcb0, 0xd4c39c, 0xb0bcc0, 0xc6b294, 0xdcd6c4, 0xa89c88, 0xbfa88c];
/** 瓦・スレートの色。 */
const HOUSE_ROOFS = [0x5a6670, 0x4b555e, 0x6b5f4e, 0x3e4952, 0x776a58, 0x8a6a52];
/** コンクリート・タイル貼りの中高層。 */
const RC_WALLS = [0xc6bca4, 0xb6ae9c, 0xcfc9ba, 0xa8b0b0, 0xbdae92, 0xc8c4bc, 0x9c968a, 0xb8a894];

export const MESH_STYLES: Record<string, MeshStyle> = {
  // ---- 住宅 ----
  house: style({
    walls: HOUSE_WALLS,
    roofs: HOUSE_ROOFS,
    facade: Facade.Residential,
    floorH: 2.85,
    bay: 2.1,
    baseHeight: 5.7,
    perLevel: 1.6,
    roofKind: RoofKind.Gable,
    inset: 0.6,
    variants: 4,
  }),
  apartment: style({
    walls: [0xd2c8ac, 0xc4ba9c, 0xd8d2c0, 0xb6bcb8, 0xc8b494, 0xbaa88c],
    roofs: HOUSE_ROOFS,
    facade: Facade.Residential,
    floorH: 2.85,
    bay: 3.2,
    baseHeight: 8.55,
    perLevel: 2.85,
    roofKind: RoofKind.Gable,
    inset: 0.72,
    variants: 3,
  }),
  mansion: style({
    walls: RC_WALLS,
    roofs: [0x9c9a95],
    facade: Facade.Residential,
    floorH: 3.0,
    bay: 3.3,
    baseHeight: 15,
    perLevel: 6,
    roofKind: RoofKind.Flat,
    inset: 0.82,
    variants: 3,
  }),
  tower: style({
    walls: [0xc8ccd2, 0xbfc6ce, 0xd2d6da],
    roofs: [0x9aa0a8],
    facade: Facade.Curtain,
    floorH: 3.2,
    bay: 3.4,
    baseHeight: 48,
    perLevel: 14,
    roofKind: RoofKind.Flat,
    inset: 0.66,
    variants: 2,
  }),
  // ---- 商業 ----
  konbini: style({
    walls: [0xf2f2ee, 0xeceae2],
    roofs: [0xcfcdc6],
    facade: Facade.Shop,
    floorH: 3.6,
    bay: 2.6,
    baseHeight: 5.2,
    perLevel: 1.5,
    roofKind: RoofKind.Flat,
    inset: 0.7,
    variants: 2,
  }),
  shotengai: style({
    walls: [0xdcc4a0, 0xcfbca4, 0xe0d4bc, 0xc2b096, 0xd4bd94, 0xb8a894],
    roofs: [0x9c6f56, 0x7d6a56, 0x5e6a72, 0x8a7a5e],
    facade: Facade.Shop,
    floorH: 3.1,
    bay: 2.4,
    baseHeight: 6.5,
    perLevel: 3.1,
    roofKind: RoofKind.Gable,
    inset: 0.92,
    variants: 3,
  }),
  supermarket: style({
    walls: [0xdcd8c8, 0xd2cebe],
    roofs: [0xc6c3ba],
    facade: Facade.Shop,
    floorH: 4.4,
    bay: 3.4,
    baseHeight: 8.8,
    perLevel: 2,
    roofKind: RoofKind.Flat,
    inset: 0.88,
    variants: 2,
  }),
  zakkyo: style({
    walls: [0xc4bcaa, 0xb0aa9c, 0xccc6b8, 0xa4aeb2, 0xbcac90, 0x94989a, 0xc0a88c],
    roofs: [0xa8a49b],
    facade: Facade.Shop,
    floorH: 3.3,
    bay: 2.5,
    baseHeight: 13.5,
    perLevel: 6.6,
    roofKind: RoofKind.Flat,
    inset: 0.86,
    variants: 3,
  }),
  office: style({
    walls: [0xa9b4c0, 0xb4bcc4, 0x9ea8b2],
    roofs: [0x99a3ad],
    facade: Facade.Curtain,
    floorH: 3.6,
    bay: 3.0,
    baseHeight: 25.2,
    perLevel: 10.8,
    roofKind: RoofKind.Flat,
    inset: 0.84,
    variants: 3,
  }),
  // ---- 工業 ----
  smallfactory: style({
    walls: [0xb4afa0, 0xa8a498, 0xbcb8ac, 0x9ca4a6, 0xa89c88],
    roofs: [0x9a8a70, 0x848c92, 0x6e7278],
    facade: Facade.Industrial,
    floorH: 4.2,
    bay: 3.0,
    baseHeight: 6.3,
    perLevel: 2,
    roofKind: RoofKind.Gable,
    inset: 0.8,
    variants: 3,
  }),
  factory: style({
    walls: [0xa09a8c, 0xaca89c, 0x929a9c],
    roofs: [0x77726a],
    facade: Facade.Industrial,
    floorH: 5.5,
    bay: 3.6,
    baseHeight: 11,
    perLevel: 4,
    roofKind: RoofKind.Flat,
    inset: 0.88,
    variants: 2,
  }),
  sawmill: style({
    walls: [0xa08e72, 0x9c8b6f, 0xb0a488],
    roofs: [0x87735a],
    facade: Facade.Industrial,
    floorH: 4.5,
    bay: 3.2,
    baseHeight: 9,
    perLevel: 3,
    roofKind: RoofKind.Gable,
    inset: 0.86,
    variants: 2,
  }),
  ricemill: style({
    walls: [0xd2cab4, 0xc6c0ae],
    roofs: [0x6b665c],
    facade: Facade.Industrial,
    floorH: 4.4,
    bay: 3.2,
    baseHeight: 8.8,
    perLevel: 3,
    roofKind: RoofKind.Flat,
    inset: 0.86,
    variants: 2,
  }),
  warehouse: style({
    walls: [0xa8a498, 0x9ca09c, 0xb0aca0],
    roofs: [0x77726a],
    facade: Facade.Industrial,
    floorH: 5.0,
    bay: 3.6,
    baseHeight: 8,
    perLevel: 2,
    roofKind: RoofKind.Flat,
    inset: 0.92,
    variants: 2,
  }),
  // ---- 農林（地面の色が主役なので、造形は畦と畝だけ）----
  paddy: style({ walls: [0x7a6a52], baseHeight: 0.3, perLevel: 0, inset: 0.98 }),
  field: style({ walls: [0x8a6f4e], baseHeight: 0.3, perLevel: 0, inset: 0.96 }),
  forestry: style({ walls: [0x36703f], baseHeight: 3.5, perLevel: 0, inset: 0.9 }),
  // ---- 公共 ----
  station: style({
    walls: [0xe2e6ea, 0xd8dee4],
    roofs: [0x54687e, 0x46586a],
    facade: Facade.Institution,
    floorH: 4.0,
    bay: 2.8,
    baseHeight: 8,
    perLevel: 0,
    roofKind: RoofKind.Hip,
    inset: 0.62,
    variants: 2,
  }),
  school: style({
    walls: [0xdcd4bc, 0xd0cab4],
    roofs: [0x74858e],
    facade: Facade.Institution,
    floorH: 3.6,
    bay: 2.4,
    baseHeight: 11.5,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.94,
    variants: 1,
  }),
  hospital: style({
    walls: [0xf0f0ee, 0xe6e8ea],
    roofs: [0xb9bcbe],
    facade: Facade.Institution,
    floorH: 3.5,
    bay: 2.6,
    baseHeight: 14,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.86,
    variants: 3,
  }),
  police: style({
    walls: [0xd8dee8, 0xccd4de],
    roofs: [0x4e6288],
    facade: Facade.Institution,
    floorH: 3.4,
    bay: 2.4,
    baseHeight: 6.8,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.7,
    variants: 2,
  }),
  fire: style({
    walls: [0xe6b8b0, 0xdcaea6],
    roofs: [0x6b3a3a],
    facade: Facade.Institution,
    floorH: 3.8,
    bay: 2.6,
    baseHeight: 9.5,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.82,
    variants: 2,
  }),
  park: style({ walls: [0x6fbf6f], baseHeight: 1.2, perLevel: 0, inset: 0.95 }),
  shrine: style({
    walls: [0xc4553f, 0xb84f3c],
    roofs: [0x4a4e56, 0x3f4a52],
    facade: Facade.Plain,
    baseHeight: 4.6,
    perLevel: 0,
    roofKind: RoofKind.Hip,
    inset: 0.8,
    variants: 1,
  }),
  cityhall: style({
    walls: [0xdad6ca, 0xd0ccc0],
    roofs: [0x5c6a78],
    facade: Facade.Institution,
    floorH: 3.8,
    bay: 2.6,
    baseHeight: 15.2,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.88,
    variants: 1,
  }),
  // ---- インフラ ----
  powerplant: style({
    walls: [0x9aa0a4, 0xa6acaa],
    roofs: [0x76797c],
    facade: Facade.Industrial,
    floorH: 6.0,
    bay: 4.0,
    baseHeight: 24,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.9,
    variants: 1,
  }),
  solar: style({ walls: [0x2b3a54], baseHeight: 0.8, perLevel: 0, inset: 0.94 }),
  waterworks: style({
    walls: [0xc9d3d8, 0xbfcad0],
    roofs: [0x8fa0a8],
    facade: Facade.Institution,
    floorH: 3.6,
    bay: 2.6,
    baseHeight: 7.2,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.9,
    variants: 1,
  }),
  sewage: style({
    walls: [0xafb6aa, 0xa4aca0],
    roofs: [0x7d8478],
    facade: Facade.Institution,
    floorH: 3.6,
    bay: 2.6,
    baseHeight: 6.0,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.92,
    variants: 1,
  }),
};

export function meshStyle(key: string): MeshStyle {
  return MESH_STYLES[key] ?? MESH_STYLES.house!;
}

const tmpColor = new Color();

/** オーバーレイ値 0..1 を色に変換する（青 → 緑 → 黄 → 赤）。 */
export function heatColor(v: number, out = tmpColor): Color {
  const t = Math.max(0, Math.min(1, v));
  // 色相 210°(青) → 0°(赤)
  const hue = (1 - t) * 0.58;
  out.setHSL(hue, 0.72, 0.45);
  return out;
}

/** 用途地域オーバーレイの色。 */
export function zoneColor(zone: number, out = tmpColor): Color {
  out.setHex(ZONE_COLORS[zone] ?? 0x888888);
  return out;
}

/** そのオーバーレイが値ベース（ヒートマップ）か。 */
export function isHeatOverlay(o: Overlay): boolean {
  return (
    o === Overlay.LandValue ||
    o === Overlay.Traffic ||
    o === Overlay.Pollution ||
    o === Overlay.TransitAccess ||
    o === Overlay.Power ||
    o === Overlay.Water
  );
}

/** 空の色。時刻で朝焼け〜昼〜夕焼け〜夜に変わる。 */
export function skyColor(dayFraction: number, out = tmpColor): Color {
  const h = dayFraction * 24;
  if (h < 5 || h >= 20) out.setHex(0x0e1526); // 夜
  else if (h < 7) out.setHex(0x9c7a72); // 朝焼け
  else if (h < 17) out.setHex(0x9fc4e0); // 昼
  else if (h < 19) out.setHex(0xd39a6a); // 夕焼け
  else out.setHex(0x3a3f5c); // 薄暮
  return out;
}

/** 太陽光の強さ。 */
export function sunIntensity(dayFraction: number): number {
  const h = dayFraction * 24;
  if (h < 5 || h >= 20) return 0.18;
  if (h < 7) return 0.18 + ((h - 5) / 2) * 0.9;
  if (h < 17) return 1.08;
  if (h < 20) return 1.08 - ((h - 17) / 3) * 0.9;
  return 0.18;
}
