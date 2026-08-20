import { Color } from 'three';
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

/** 建物の形状キーごとの色と高さ（レベル 1 のとき、m）。 */
export interface MeshStyle {
  color: number;
  /** レベル 1 の高さ (m)。 */
  baseHeight: number;
  /** レベルごとの追加高さ (m)。 */
  perLevel: number;
  /**
   * 屋根の形。
   *
   * 以前は `roof: boolean` で、立てば一律に 4 角錐を載せていた
   * （コメントは「切妻」と書いてあったのに、実際は方形屋根だった）。
   * 日本の街並みは切妻・寄棟・陸屋根の混在で出来ているので、
   * ここを 3 種類に分けるだけで一気にそれらしくなる。
   */
  roofKind: RoofKind;
  roofColor: number;
  /** 敷地に対する建物の占有率。小さいほど庭・空地が見える。 */
  inset: number;
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

const style = (
  color: number,
  baseHeight: number,
  perLevel: number,
  roofKind: RoofKind = RoofKind.None,
  roofColor = 0x4a4a52,
  inset = 0.78,
): MeshStyle => ({ color, baseHeight, perLevel, roofKind, roofColor, inset });

export const MESH_STYLES: Record<string, MeshStyle> = {
  // 住宅: 瓦屋根の切妻
  house: style(0xeae5d8, 5, 2.5, RoofKind.Gable, 0x69747f, 0.62),
  apartment: style(0xded8c8, 8, 3.5, RoofKind.Gable, 0x6d6a75, 0.74),
  mansion: style(0xcfcabb, 16, 8, RoofKind.Flat, 0x9c9a95, 0.84),
  tower: style(0xc4c8cf, 46, 14, RoofKind.Flat, 0x9aa0a8, 0.7),
  // 商業
  konbini: style(0xf2f2ee, 4.5, 1.5, RoofKind.Flat, 0xcfcdc6, 0.8),
  shotengai: style(0xe2ccab, 6, 2.5, RoofKind.Gable, 0x8a6350, 0.9),
  supermarket: style(0xe6e2d4, 7, 2, RoofKind.Flat, 0xc6c3ba, 0.9),
  zakkyo: style(0xd6d2c8, 14, 7, RoofKind.Flat, 0xa8a49b, 0.88),
  office: style(0xb9c4cf, 24, 11, RoofKind.Flat, 0x99a3ad, 0.86),
  // 工業
  smallfactory: style(0xbdb7a8, 6, 2, RoofKind.Gable, 0x93826a, 0.84),
  factory: style(0xa8a294, 11, 4, RoofKind.Flat, 0x6b665c, 0.9),
  sawmill: style(0x9c8b6f, 9, 3, RoofKind.Gable, 0x87735a, 0.88),
  ricemill: style(0xcfc7b2, 10, 3, RoofKind.Flat, 0x6b665c, 0.9),
  warehouse: style(0xb0aca0, 8, 2, RoofKind.Flat, 0x6b665c, 0.94),
  // 農林（背が低く、地面の色が主役）
  paddy: style(0x5aa84a, 0.35, 0, RoofKind.None, 0x4a4a52, 0.98),
  field: style(0xb08d5a, 0.5, 0, RoofKind.None, 0x4a4a52, 0.96),
  forestry: style(0x2f7a45, 3.5, 0, RoofKind.None, 0x4a4a52, 0.9),
  // 公共
  station: style(0xdfe4ea, 9, 0, RoofKind.Hip, 0x54687e, 0.9),
  school: style(0xe4dcc6, 10, 0, RoofKind.Flat, 0x74858e, 0.9),
  hospital: style(0xf0f0ee, 14, 0, RoofKind.Flat, 0xb9bcbe, 0.88),
  police: style(0xd6dce6, 6, 0, RoofKind.Hip, 0x4e6288, 0.8),
  fire: style(0xe6b8b0, 9, 0, RoofKind.Flat, 0x6b3a3a, 0.86),
  park: style(0x6fbf6f, 1.2, 0, RoofKind.None, 0x4a4a52, 0.95),
  shrine: style(0xc4553f, 7, 0, RoofKind.Hip, 0x54545e, 0.7),
  cityhall: style(0xd8d4c8, 16, 0, RoofKind.Hip, 0x5c6a78, 0.9),
  // インフラ（発電所は煙突が要るので背を高く、太陽光は地面すれすれ）
  powerplant: style(0x9aa0a4, 22, 0, RoofKind.Flat, 0x76797c, 0.82),
  solar: style(0x2b3a54, 0.8, 0, RoofKind.None, 0x4a4a52, 0.94),
  waterworks: style(0xc9d3d8, 6, 0, RoofKind.Flat, 0x8fa0a8, 0.9),
  sewage: style(0xa9b0a4, 5, 0, RoofKind.Flat, 0x7d8478, 0.92),
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
