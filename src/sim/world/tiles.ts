import { CHUNK, CHUNKS_X, MAP_H, MAP_W, TAZ, TAZ_X, TILE_M, TILE_SPAN_M } from '@shared/constants';

/** タイル座標のユーティリティ。すべてインライン展開されうる小さな純粋関数。 */

export function idx(x: number, y: number): number {
  return y * MAP_W + x;
}
export function tileX(i: number): number {
  return i % MAP_W;
}
export function tileY(i: number): number {
  return (i / MAP_W) | 0;
}
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}

/** タイル中心のワールド座標（描画単位）。実距離ではない。 */
export function tileCenterX(i: number): number {
  return (tileX(i) + 0.5) * TILE_M;
}
export function tileCenterZ(i: number): number {
  return (tileY(i) + 0.5) * TILE_M;
}

/** マンハッタン距離（タイル）。 */
export function tileManhattan(a: number, b: number): number {
  return Math.abs(tileX(a) - tileX(b)) + Math.abs(tileY(a) - tileY(b));
}
/** ユークリッド距離（シミュレーション上の実距離 m）。 */
export function tileDistanceM(a: number, b: number): number {
  const dx = tileX(a) - tileX(b);
  const dy = tileY(a) - tileY(b);
  return Math.sqrt(dx * dx + dy * dy) * TILE_SPAN_M;
}

export function chunkOf(i: number): number {
  return ((tileY(i) / CHUNK) | 0) * CHUNKS_X + ((tileX(i) / CHUNK) | 0);
}
export function tazOf(i: number): number {
  return ((tileY(i) / TAZ) | 0) * TAZ_X + ((tileX(i) / TAZ) | 0);
}
/** TAZ の中心タイル。 */
export function tazCenterTile(taz: number): number {
  const cx = (taz % TAZ_X) * TAZ + (TAZ >> 1);
  const cy = ((taz / TAZ_X) | 0) * TAZ + (TAZ >> 1);
  return idx(cx, cy);
}

/** 4 近傍のオフセット（北・東・南・西）。roadConn のビット順もこれに一致させる。 */
export const NEIGHBOR_DX = [0, 1, 0, -1] as const;
export const NEIGHBOR_DY = [-1, 0, 1, 0] as const;

/** 4 近傍のタイル index。範囲外は -1。 */
export function neighbor(i: number, dir: number): number {
  const x = tileX(i) + NEIGHBOR_DX[dir]!;
  const y = tileY(i) + NEIGHBOR_DY[dir]!;
  return inBounds(x, y) ? idx(x, y) : -1;
}

/** 矩形範囲のタイルを列挙する。 */
export function forEachInRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fn: (i: number, x: number, y: number) => void,
): void {
  const ax = Math.max(0, Math.min(x0, x1));
  const bx = Math.min(MAP_W - 1, Math.max(x0, x1));
  const ay = Math.max(0, Math.min(y0, y1));
  const by = Math.min(MAP_H - 1, Math.max(y0, y1));
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) fn(idx(x, y), x, y);
  }
}

/** 2 タイルを結ぶ直線上のタイル列（ブレゼンハム）。道路のドラッグ敷設に使う。 */
export function lineTiles(a: number, b: number): number[] {
  const out: number[] = [];
  let x0 = tileX(a);
  let y0 = tileY(a);
  const x1 = tileX(b);
  const y1 = tileY(b);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    out.push(idx(x0, y0));
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    // 斜め移動を禁止し、必ず L 字に折る（道路グラフが対角接続にならないようにする）。
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    } else if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}
