import { Color } from 'three';
import { Overlay, RoadClass, Season, Terrain, Zone } from '@shared/enums';

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

/** 建物の形状キーごとの色と高さ（レベル 1 のとき、m）。 */
export interface MeshStyle {
  color: number;
  /** レベル 1 の高さ (m)。 */
  baseHeight: number;
  /** レベルごとの追加高さ (m)。 */
  perLevel: number;
  /** 切妻の瓦屋根を載せるか（日本的意匠）。 */
  roof: boolean;
  roofColor: number;
  /** 敷地に対する建物の占有率。小さいほど庭・空地が見える。 */
  inset: number;
}

const style = (
  color: number,
  baseHeight: number,
  perLevel: number,
  roof = false,
  roofColor = 0x4a4a52,
  inset = 0.78,
): MeshStyle => ({ color, baseHeight, perLevel, roof, roofColor, inset });

export const MESH_STYLES: Record<string, MeshStyle> = {
  // 住宅: 瓦屋根の切妻
  house: style(0xe8e3d6, 5, 2.5, true, 0x4a5560, 0.66),
  apartment: style(0xdcd6c6, 8, 3.5, true, 0x54525c, 0.78),
  mansion: style(0xcfcabb, 16, 8, false, 0x4a4a52, 0.84),
  tower: style(0xc4c8cf, 46, 14, false, 0x4a4a52, 0.7),
  // 商業
  konbini: style(0xf2f2ee, 4.5, 1.5, false, 0x4a4a52, 0.8),
  shotengai: style(0xe0c9a8, 6, 2.5, true, 0x6b4a3a, 0.92),
  supermarket: style(0xe6e2d4, 7, 2, false, 0x4a4a52, 0.9),
  zakkyo: style(0xd6d2c8, 14, 7, false, 0x4a4a52, 0.88),
  office: style(0xb9c4cf, 24, 11, false, 0x4a4a52, 0.86),
  // 工業
  smallfactory: style(0xbdb7a8, 6, 2, true, 0x7a6a55, 0.86),
  factory: style(0xa8a294, 11, 4, false, 0x6b665c, 0.9),
  sawmill: style(0x9c8b6f, 9, 3, true, 0x6b5a45, 0.9),
  ricemill: style(0xcfc7b2, 10, 3, false, 0x6b665c, 0.9),
  warehouse: style(0xb0aca0, 8, 2, false, 0x6b665c, 0.94),
  // 農林（背が低く、地面の色が主役）
  paddy: style(0x5aa84a, 0.35, 0, false, 0x4a4a52, 0.98),
  field: style(0xb08d5a, 0.5, 0, false, 0x4a4a52, 0.96),
  forestry: style(0x2f7a45, 3.5, 0, false, 0x4a4a52, 0.9),
  // 公共
  station: style(0xdfe4ea, 9, 0, true, 0x3a4a5a, 0.9),
  school: style(0xe4dcc6, 10, 0, true, 0x5a6a72, 0.9),
  hospital: style(0xf0f0ee, 14, 0, false, 0x4a4a52, 0.88),
  police: style(0xd6dce6, 6, 0, true, 0x3a4a6a, 0.8),
  fire: style(0xe6b8b0, 9, 0, false, 0x6b3a3a, 0.86),
  park: style(0x6fbf6f, 1.2, 0, false, 0x4a4a52, 0.95),
  shrine: style(0xc4553f, 7, 0, true, 0x3a3a42, 0.7),
  cityhall: style(0xd8d4c8, 16, 0, true, 0x44505c, 0.9),
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
  return o === Overlay.LandValue || o === Overlay.Traffic || o === Overlay.Pollution || o === Overlay.TransitAccess;
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
