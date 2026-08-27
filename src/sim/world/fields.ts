import { MAP_H, MAP_W, STATION_WALK_RADIUS, TILE_COUNT, TILE_SPAN_M } from '@shared/constants';
import { Terrain } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import { idx, inBounds, tileX, tileY } from './tiles';
import type { World } from './world';
import type { UtilitySystem } from './utilities';

/**
 * 地価・公害・騒音・サービス到達といったスカラー場の更新。
 *
 * どれもタイル全域を舐める処理なので、SoA の Uint8Array 上で分離可能ブラー
 * （横 1 パス → 縦 1 パス）として実装する。ここがオブジェクト配列だったら
 * この関数だけでフレーム予算を使い切る。
 */

const scratchA = new Float32Array(TILE_COUNT);
const scratchB = new Float32Array(TILE_COUNT);
/**
 * ブラーの横パス専用の中間バッファ。
 *
 * 以前は横パスの出力先が `scratchB` だった。呼び出し側は 3 か所とも
 * `boxBlur(scratchA, scratchB, r)` と書いていて出力先も `scratchB` なので、
 * **縦パスが自分の出力を入力として読み直していた**。
 * スライディングウィンドウから抜ける行 `y - r` は既に上書き済みなので、
 * ぼけが +Y 方向へ尾を引き、総和も保存されない
 * （8×8・半径 2・中央に 100 で検証: 正 `4,4,4,4,4,0,0` に対し
 * 誤 `4,4,4,3.2,2.4,1.6,0.96`、総和 100.8）。
 * 地価・公害・騒音のすべてが南に歪んでいた。
 */
const blurTmp = new Float32Array(TILE_COUNT);

/** 分離可能ボックスブラー。半径 r、2 パス。`dst` は `src` と同じでも構わない。 */
function boxBlur(src: Float32Array, dst: Float32Array, r: number): void {
  const inv = 1 / (2 * r + 1);
  // 横
  for (let y = 0; y < MAP_H; y++) {
    const row = y * MAP_W;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(MAP_W - 1, Math.max(0, x))]!;
    for (let x = 0; x < MAP_W; x++) {
      blurTmp[row + x] = sum * inv;
      const out = row + Math.min(MAP_W - 1, Math.max(0, x - r));
      const inn = row + Math.min(MAP_W - 1, Math.max(0, x + r + 1));
      sum += src[inn]! - src[out]!;
    }
  }
  // 縦
  for (let x = 0; x < MAP_W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += blurTmp[Math.min(MAP_H - 1, Math.max(0, y)) * MAP_W + x]!;
    for (let y = 0; y < MAP_H; y++) {
      dst[y * MAP_W + x] = sum * inv;
      const out = Math.min(MAP_H - 1, Math.max(0, y - r)) * MAP_W + x;
      const inn = Math.min(MAP_H - 1, Math.max(0, y + r + 1)) * MAP_W + x;
      sum += blurTmp[inn]! - blurTmp[out]!;
    }
  }
}

/**
 * 公害と騒音を建物から拡散させる。
 *
 * 下水処理が足りていない地区は、その分だけ建物 1 棟ずつが公害源になる
 * （`utilities.sewagePollutionOf` の単位は `pollution × level` と揃えてある）。
 * 住宅は `pollution === 0` なので、**未処理下水を足すのは早期 continue より前**。
 * 順番を逆にすると、住宅地の下水があふれても公害が 1 も出ない。
 */
export function updatePollution(world: World, buildings: BuildingStore, utilities?: UtilitySystem): void {
  scratchA.fill(0);
  for (const s of buildings.each()) {
    const a = archetype(buildings.archetypeId[s]!);
    const sewage = utilities ? utilities.sewagePollutionOf(s) : 0;
    const own = a.pollution * buildings.level[s]!;
    if (own === 0 && sewage === 0) continue;
    scratchA[buildings.originTile[s]!] = (scratchA[buildings.originTile[s]!] ?? 0) + own + sewage;
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
  // 徒歩速度 4.8km/h、1 タイル = TILE_SPAN_M(150m) なので 1 タイル ≒ 1.9 分。
  // BFS はタイル数で数え、最後に分へ換算する。
  const queue = new Int32Array(TILE_COUNT);
  let qh = 0;
  let qt = 0;
  const dist = new Uint16Array(TILE_COUNT).fill(65535);
  for (const st of stationTiles) {
    dist[st] = 0;
    queue[qt++] = st;
  }
  // 探索を打ち切る距離（タイル）。
  //
  // `* 10` は 1 タイル = 8m・10 タイル = 1 分だった頃の名残で、実距離スケール
  // （1 タイル 150m）にした今は駅の徒歩圏が半径 12km になっている。
  // `STATION_WALK_RADIUS` 単体（8 タイル = 1.2km ≒ 徒歩 15 分）が本来の意図で、
  // そう直すと transitAccess が本当に駅の近くだけになり、
  // 鉄道の可用性ゲート（activity.ts）が初めて効くようになる。
  //
  // ただし今そう直すと、駅から 1.2km より遠い住民は公共交通を一切選べなくなる。
  // バス路線が入って駅までのフィーダーができるまでは、この広い圏が
  // 「自転車や送迎で駅へ出る」ぶんを肩代わりしている。路線を実装するときに
  // 徒歩圏とフィーダーを分けて数え直す。
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
  const walkMinPerTile = TILE_SPAN_M / ((4.8 * 1000) / 60); // 分/タイル
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
    // 基礎値。鉄道が無い街でも地価が成立する下限。
    // 実距離スケール以前は transitAccess が街じゅうで「徒歩 3 分」になっていて、
    // 下の鉄道ボーナスが事実上の基礎値として常時乗っていた。実距離にすると
    // それが駅の近くだけに戻るので、消えた分をここで持つ。
    let v = 50;
    // 平坦さ
    v += Math.max(0, 20 - world.slope[i]! * 0.25);
    // 鉄道アクセス: 徒歩 14 分圏（約 1.1km）を優遇する
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
