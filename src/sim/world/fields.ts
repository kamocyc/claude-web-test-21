import { MAP_H, MAP_W, STATION_WALK_RADIUS, TILE_COUNT, TILE_M } from '@shared/constants';
import { Terrain } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import { idx, inBounds, tileX, tileY } from './tiles';
import type { World } from './world';

/**
 * 地価・公害・騒音・サービス到達といったスカラー場の更新。
 *
 * どれもタイル全域を舐める処理なので、SoA の Uint8Array 上で分離可能ブラー
 * （横 1 パス → 縦 1 パス）として実装する。ここがオブジェクト配列だったら
 * この関数だけでフレーム予算を使い切る。
 */

const scratchA = new Float32Array(TILE_COUNT);
const scratchB = new Float32Array(TILE_COUNT);

/** 分離可能ボックスブラー。半径 r、2 パス。 */
function boxBlur(src: Float32Array, dst: Float32Array, r: number): void {
  const inv = 1 / (2 * r + 1);
  // 横
  for (let y = 0; y < MAP_H; y++) {
    const row = y * MAP_W;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(MAP_W - 1, Math.max(0, x))]!;
    for (let x = 0; x < MAP_W; x++) {
      scratchB[row + x] = sum * inv;
      const out = row + Math.min(MAP_W - 1, Math.max(0, x - r));
      const inn = row + Math.min(MAP_W - 1, Math.max(0, x + r + 1));
      sum += src[inn]! - src[out]!;
    }
  }
  // 縦
  for (let x = 0; x < MAP_W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += scratchB[Math.min(MAP_H - 1, Math.max(0, y)) * MAP_W + x]!;
    for (let y = 0; y < MAP_H; y++) {
      dst[y * MAP_W + x] = sum * inv;
      const out = Math.min(MAP_H - 1, Math.max(0, y - r)) * MAP_W + x;
      const inn = Math.min(MAP_H - 1, Math.max(0, y + r + 1)) * MAP_W + x;
      sum += scratchB[inn]! - scratchB[out]!;
    }
  }
}

/** 公害と騒音を建物から拡散させる。 */
export function updatePollution(world: World, buildings: BuildingStore): void {
  scratchA.fill(0);
  for (const s of buildings.each()) {
    const a = archetype(buildings.archetypeId[s]!);
    if (a.pollution === 0) continue;
    scratchA[buildings.originTile[s]!] = (scratchA[buildings.originTile[s]!] ?? 0) + a.pollution * buildings.level[s]!;
  }
  boxBlur(scratchA, scratchB, 6);
  for (let i = 0; i < TILE_COUNT; i++) {
    // ブラーで薄まった分を戻すため係数を掛ける
    world.pollution[i] = Math.min(255, Math.round(scratchB[i]! * 24));
  }

  scratchA.fill(0);
  for (const s of buildings.each()) {
    const a = archetype(buildings.archetypeId[s]!);
    if (a.noise === 0) continue;
    scratchA[buildings.originTile[s]!] = (scratchA[buildings.originTile[s]!] ?? 0) + a.noise * buildings.level[s]!;
  }
  boxBlur(scratchA, scratchB, 3);
  for (let i = 0; i < TILE_COUNT; i++) {
    world.noise[i] = Math.min(255, Math.round(scratchB[i]! * 12));
  }
  world.epochs.overlay++;
}

/**
 * 公共サービスの到達範囲を建物から塗る。
 * 半径円のスタンプなので、施設数（数十）× 半径^2 で十分軽い。
 */
export function updateServiceCoverage(world: World, buildings: BuildingStore): void {
  world.svcMask.fill(0);
  for (const s of buildings.each()) {
    const a = archetype(buildings.archetypeId[s]!);
    if (a.provides === 0) continue;
    const o = buildings.originTile[s]!;
    const ox = tileX(o);
    const oy = tileY(o);
    const r = a.serviceRadius;
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        if (!inBounds(ox + dx, oy + dy)) continue;
        const t = idx(ox + dx, oy + dy);
        world.svcMask[t] = world.svcMask[t]! | a.provides;
      }
    }
  }
}

/**
 * 最寄り駅までの徒歩分を BFS で求める。
 * 「駅が街をつくる」という設計意図（私鉄の沿線開発）を成長ロジックに効かせるための入力。
 */
export function updateTransitAccess(world: World, stationTiles: readonly number[]): void {
  world.transitAccess.fill(255);
  if (stationTiles.length === 0) {
    world.epochs.overlay++;
    return;
  }
  // 徒歩速度 4.8km/h → 1 タイル (8m) = 0.1 分。整数分で持つため 10 タイル = 1 分に丸める。
  const queue = new Int32Array(TILE_COUNT);
  let qh = 0;
  let qt = 0;
  const dist = new Uint16Array(TILE_COUNT).fill(65535);
  for (const st of stationTiles) {
    dist[st] = 0;
    queue[qt++] = st;
  }
  const maxTiles = STATION_WALK_RADIUS * 10;
  while (qh < qt) {
    const i = queue[qh++]!;
    const d = dist[i]!;
    if (d >= maxTiles) continue;
    const x = tileX(i);
    const y = tileY(i);
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (world.terrain[j] === Terrain.Sea || world.terrain[j] === Terrain.Mountain) continue;
      if (dist[j]! > d + 1) {
        dist[j] = d + 1;
        queue[qt++] = j;
      }
    }
  }
  const walkMinPerTile = TILE_M / ((4.8 * 1000) / 60); // 分/タイル
  for (let i = 0; i < TILE_COUNT; i++) {
    const d = dist[i]!;
    world.transitAccess[i] = d === 65535 ? 255 : Math.min(254, Math.round(d * walkMinPerTile));
  }
  world.epochs.overlay++;
}

/**
 * 地価。地形・道路アクセス・鉄道アクセス・サービス・建物の影響を合成してぼかす。
 * 成長判定の主要な入力であり、オーバーレイとしてもプレイヤに見せる。
 */
export function updateLandValue(world: World, buildings: BuildingStore): void {
  scratchA.fill(0);
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = world.terrain[i]!;
    if (t === Terrain.Sea || t === Terrain.Mountain) continue;
    let v = 26;
    // 平坦さ
    v += Math.max(0, 20 - world.slope[i]! * 0.25);
    // 鉄道アクセス: 徒歩 5 分圏を強く優遇する
    const ta = world.transitAccess[i]!;
    if (ta < 255) v += Math.max(0, 42 - ta * 3);
    // 海・河川の眺望
    if (t === Terrain.Lowland) v += 4;
    scratchA[i] = v;
  }
  for (const s of buildings.each()) {
    const a = archetype(buildings.archetypeId[s]!);
    if (a.landValueEffect === 0) continue;
    const o = buildings.originTile[s]!;
    scratchA[o] = scratchA[o]! + a.landValueEffect * buildings.level[s]! * 6;
  }
  boxBlur(scratchA, scratchB, 5);
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = world.terrain[i]!;
    if (t === Terrain.Sea || t === Terrain.Mountain) {
      world.landValue[i] = 0;
      continue;
    }
    // 公害と騒音は地価を直接下げる
    const penalty = world.pollution[i]! * 0.35 + world.noise[i]! * 0.15;
    world.landValue[i] = Math.max(0, Math.min(255, Math.round(scratchB[i]! * 1.6 - penalty)));
  }
  world.epochs.overlay++;
}
