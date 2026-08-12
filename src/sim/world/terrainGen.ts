import { MAP_H, MAP_W } from '@shared/constants';
import { Terrain } from '@shared/enums';
import { Rng } from '@sim/core/rng';
import { idx, inBounds } from './tiles';

/**
 * 日本的な地形の生成。
 *
 * 狙いは「平地が希少である」こと。片側が海、対角に山地の稜線、
 * 山から海へ river が下り、その氾濫原が低湿地（水田適地）になる。
 * 平野が足りないので、プレイヤは高密度化（マンション）か
 * 傾斜地への進出かを迫られる — これが日本の都市づくりのゲーム性そのもの。
 */

export interface TerrainResult {
  terrain: Uint8Array;
  heightDm: Uint16Array;
  slope: Uint8Array;
  /** 淡水（河川・湖）までのタイル距離。水田の適地判定に使う。0..255 */
  waterAccess: Uint8Array;
}

/** 決定論的な値ノイズ。格子点のハッシュを bicubic 補間する。 */
function valueNoise(seed: number, x: number, y: number, freq: number): number {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  // smoothstep
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const h = (ix: number, iy: number): number => {
    let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

function fbm(seed: number, x: number, y: number, octaves: number, baseFreq: number): number {
  let amp = 1;
  let freq = baseFreq;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(seed + o * 7919, x, y, freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export function generateTerrain(seed: number): TerrainResult {
  const rng = new Rng(seed).fork('terrain');
  const n = MAP_W * MAP_H;
  const terrain = new Uint8Array(n);
  const heightDm = new Uint16Array(n);
  const slope = new Uint8Array(n);
  const waterAccess = new Uint8Array(n).fill(255);

  const noiseSeed = rng.nextU32();

  // --- 標高場: 南west側が海、北east側に山の稜線 ---
  const raw = new Float32Array(n);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      // 海岸からの距離を 0..1 に。左下が海。
      const coastal = (x / MAP_W) * 0.45 + (y / MAP_H) * 0.55;
      // 稜線までのなだらかな立ち上がり。平野を広く取るため exponent を効かせる。
      const ridge = Math.pow(Math.max(0, coastal - 0.28) / 0.72, 1.9);
      const detail = fbm(noiseSeed, x, y, 5, 1 / 42) - 0.5;
      const h = ridge * 1.0 + detail * 0.28;
      raw[idx(x, y)] = h;
    }
  }

  // --- 河川: 高標高の点から、標高が下がる方向へ海まで降りていく ---
  // 始点は「実際に標高の高いタイル」から取る。座標だけで決め打ちすると、
  // ノイズ次第でほぼ平地から流し始めることになり、川がすぐ途切れて
  // 氾濫原（＝水田適地）がほとんど生まれない。
  const riverTiles = new Set<number>();
  const highTiles: number[] = [];
  for (let y = 4; y < MAP_H - 4; y += 3) {
    for (let x = 4; x < MAP_W - 4; x += 3) {
      if (raw[idx(x, y)]! > 0.52) highTiles.push(idx(x, y));
    }
  }

  const carveRiver = (startX: number, startY: number, width: number): void => {
    let x = startX;
    let y = startY;
    for (let step = 0; step < MAP_W * 2; step++) {
      riverTiles.add(idx(x, y));
      // 川幅を持たせる（下流ほど広い）
      const w = width + (step > MAP_W * 0.5 ? 1 : 0);
      for (let dy = -w; dy <= w; dy++) {
        for (let dx = -w; dx <= w; dx++) {
          if (inBounds(x + dx, y + dy) && Math.abs(dx) + Math.abs(dy) <= w) {
            riverTiles.add(idx(x + dx, y + dy));
          }
        }
      }
      // 8 近傍で最も低いところへ。同点は乱数で崩し、直線的な川にならないようにする。
      let bestX = x;
      let bestY = y;
      let bestH = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const h = raw[idx(nx, ny)]! + rng.float(-0.012, 0.012);
          if (h < bestH) {
            bestH = h;
            bestX = nx;
            bestY = ny;
          }
        }
      }
      if (bestX === x && bestY === y) break;
      x = bestX;
      y = bestY;
      if (raw[idx(x, y)]! < 0.02) break; // 海に到達
    }
  };
  if (highTiles.length > 0) {
    for (let k = 0; k < 4; k++) {
      const t = highTiles[rng.int(highTiles.length)]!;
      carveRiver(t % MAP_W, (t / MAP_W) | 0, 1);
    }
  }

  // --- 分類 ---
  for (let i = 0; i < n; i++) {
    const h = raw[i]!;
    if (h < 0.0) {
      terrain[i] = Terrain.Sea;
      heightDm[i] = 0;
      continue;
    }
    heightDm[i] = Math.min(65535, Math.round(h * 3000)); // 最高 300m 程度
    if (riverTiles.has(i)) {
      terrain[i] = Terrain.Freshwater;
    } else if (h > 0.62) {
      terrain[i] = Terrain.Mountain;
    } else if (h > 0.30) {
      // 中腹は森林。丘陵との境界をノイズでぼかす。
      terrain[i] = fbm(noiseSeed + 555, i % MAP_W, (i / MAP_W) | 0, 3, 1 / 26) > 0.45 ? Terrain.Forest : Terrain.Hill;
    } else if (h > 0.10) {
      terrain[i] = fbm(noiseSeed + 999, i % MAP_W, (i / MAP_W) | 0, 3, 1 / 30) > 0.62 ? Terrain.Forest : Terrain.Plain;
    } else {
      terrain[i] = Terrain.Plain;
    }
  }

  // --- 傾斜（近傍との標高差） ---
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = idx(x, y);
      const h = heightDm[i]!;
      let maxDiff = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!inBounds(x + dx, y + dy)) continue;
          maxDiff = Math.max(maxDiff, Math.abs(heightDm[idx(x + dx, y + dy)]! - h));
        }
      }
      slope[i] = Math.min(255, maxDiff);
    }
  }

  // --- 淡水からの距離（BFS）。低湿地＝水田適地の判定に使う ---
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) {
    if (terrain[i] === Terrain.Freshwater) {
      waterAccess[i] = 0;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++]!;
    const d = waterAccess[i]!;
    if (d >= 255) continue;
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (waterAccess[j]! > d + 1) {
        waterAccess[j] = d + 1;
        queue[qt++] = j;
      }
    }
  }

  // --- 海岸からの距離。沖積平野（＝水田地帯）の判定に使う ---
  const seaDist = new Uint8Array(n).fill(255);
  qh = 0;
  qt = 0;
  for (let i = 0; i < n; i++) {
    if (terrain[i] === Terrain.Sea) {
      seaDist[i] = 0;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++]!;
    const d = seaDist[i]!;
    if (d >= 40) continue;
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (seaDist[j]! > d + 1) {
        seaDist[j] = d + 1;
        queue[qt++] = j;
      }
    }
  }

  // --- 低湿地（水田適地）---
  // 河川の氾濫原と、海岸沿いの沖積平野の両方を含める。
  // 日本の水田は河口部の低平地に広がるので、両方を取らないと水田がほぼ生まれない。
  for (let i = 0; i < n; i++) {
    if (terrain[i] !== Terrain.Plain) continue;
    if (slope[i]! >= 22) continue;
    const nearRiver = waterAccess[i]! <= 14;
    const nearCoast = seaDist[i]! <= 26 && heightDm[i]! < 260;
    if (nearRiver || nearCoast) terrain[i] = Terrain.Lowland;
  }

  return { terrain, heightDm, slope, waterAccess };
}
