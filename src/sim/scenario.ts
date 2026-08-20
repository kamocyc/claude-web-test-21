import { MAP_H, MAP_W, TICKS_PER_DAY } from '@shared/constants';
import { RoadClass, Terrain, Zone } from '@shared/enums';
import { Arch } from '@sim/buildings/archetypes';
import { idx, inBounds, lineTiles } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import type { Simulation } from './simulation';

/**
 * 検証用の街を機械的に組み立てるシナリオ。
 *
 * ヘッドレス実行・統合テスト・ブラウザのデモ開始状態がすべてここを共有する。
 * 「プレイヤが妥当な操作をすれば街が発展する」という要求を、
 * 人間の操作なしに再現可能な形で検証するための土台。
 *
 * 構成は「中心市街地 ＋ 少し離れたベッドタウン ＋ それを結ぶ鉄道」。
 * 単一の市街地だけだと全部が徒歩圏に収まってしまい、通勤距離が数百 m にしかならず、
 * 鉄道も渋滞も交通手段選択も一切意味を持たなくなる。
 * 職住が分離して初めて、経路探索・分担率・混雑が実際に効くようになる
 * — 日本の私鉄沿線開発そのものの形。
 */

export interface ScenarioOptions {
  /** 中心市街地の一辺（タイル）。 */
  size?: number;
  /** 街区の一辺（この間隔で道路を敷く）。 */
  block?: number;
  /** 鉄道と駅を敷くか。 */
  withRail?: boolean;
  /** ベッドタウンを作るか。 */
  withSatellite?: boolean;
  /** 初期人口。 */
  seedPopulation?: number;
}

export interface ScenarioResult {
  center: number;
  satellite: number;
  /** 2 つの市街地を結ぶ幹線道路のタイル。テストと計測で「そこだけ広げる」ために返す。 */
  trunk: number[];
  roadTiles: number;
  zonedTiles: number;
  stations: number[];
}

/**
 * 市街地の中心を探す。
 *
 * 単に一番広い平地を選ぶと、地図の真ん中の何もない平原に街ができてしまい、
 * 森も水辺も射程外になって林業と水田が永久に成立しない。
 * 実際の日本の街と同じく「平地で建てられ、かつ森と水辺が手の届く距離にある」
 * 河口〜扇状地のような場所を選ぶ。
 */
export function findCityCenter(world: World): number {
  const step = 4;
  const near = 16;
  const far = 60;
  let best = idx(MAP_W >> 1, MAP_H >> 1);
  let bestScore = -Infinity;

  for (let y = near + 40; y < MAP_H - near - 40; y += step) {
    for (let x = near + 40; x < MAP_W - near - 40; x += step) {
      let buildable = 0;
      for (let dy = -near; dy <= near; dy += 2) {
        for (let dx = -near; dx <= near; dx += 2) {
          const t = idx(x + dx, y + dy);
          const terr = world.terrain[t]!;
          if (terr === Terrain.Plain) buildable += 3;
          else if (terr === Terrain.Lowland) buildable += 2;
          else if (terr === Terrain.Hill) buildable += 1;
          else if (terr === Terrain.Sea || terr === Terrain.Mountain) buildable -= 5;
          buildable -= world.slope[t]! * 0.02;
        }
      }
      let forest = 0;
      let paddy = 0;
      for (let dy = -far; dy <= far; dy += 4) {
        for (let dx = -far; dx <= far; dx += 4) {
          if (!inBounds(x + dx, y + dy)) continue;
          const t = idx(x + dx, y + dy);
          if (world.terrain[t] === Terrain.Forest) forest++;
          else if (world.terrain[t] === Terrain.Lowland) paddy++;
        }
      }
      const resource = Math.min(forest, 50) * 5 + Math.min(paddy, 50) * 5;
      const score = buildable + resource;
      if (score > bestScore) {
        bestScore = score;
        best = idx(x, y);
      }
    }
  }
  return best;
}

/** 中心市街地から離れた、ベッドタウン向きの平地を探す。 */
function findSatelliteCenter(world: World, cx: number, cy: number, minDist: number, maxDist: number): number {
  let best = -1;
  let bestScore = -Infinity;
  const r = 14;
  for (let y = r + 4; y < MAP_H - r - 4; y += 4) {
    for (let x = r + 4; x < MAP_W - r - 4; x += 4) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < minDist || d > maxDist) continue;
      let buildable = 0;
      for (let dy = -r; dy <= r; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          const t = idx(x + dx, y + dy);
          const terr = world.terrain[t]!;
          if (terr === Terrain.Plain || terr === Terrain.Lowland) buildable += 3;
          else if (terr === Terrain.Hill) buildable += 1;
          else if (terr === Terrain.Sea || terr === Terrain.Mountain) buildable -= 6;
          buildable -= world.slope[t]! * 0.03;
        }
      }
      if (buildable > bestScore) {
        bestScore = buildable;
        best = idx(x, y);
      }
    }
  }
  return best;
}

/** 街区に割り当てる用途を決める関数の型。ring は中心からの相対距離 0..1。 */
type ZonePicker = (ring: number, bx: number, by: number, east: boolean, south: boolean) => Zone;

/** 道路グリッドを敷いて街区ごとに用途地域を塗る。 */
function layOutDistrict(
  sim: Simulation,
  cx: number,
  cy: number,
  size: number,
  block: number,
  pickZone: ZonePicker,
): void {
  const world = sim.world;
  const half = size >> 1;
  const x0 = Math.max(2, cx - half);
  const y0 = Math.max(2, cy - half);
  const x1 = Math.min(MAP_W - 3, x0 + size);
  const y1 = Math.min(MAP_H - 3, y0 + size);

  const streets: number[] = [];
  const boulevards: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((y - y0) % block !== 0 && (x - x0) % block !== 0) continue;
      const t = idx(x, y);
      if (!world.canBuildRoad(t)) continue;
      // 4 街区おきに大通りを通し、幹線と生活道路の階層を作る
      const isMain = (y - y0) % (block * 4) === 0 || (x - x0) % (block * 4) === 0;
      (isMain ? boulevards : streets).push(t);
    }
  }
  sim.enqueue({ t: 'buildRoad', cls: RoadClass.Boulevard, tiles: boulevards });
  sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: streets });
  sim.tick();

  const batches = new Map<Zone, number[]>();
  const push = (z: Zone, t: number): void => {
    let list = batches.get(z);
    if (!list) {
      list = [];
      batches.set(z, list);
    }
    list.push(t);
  };

  const blocksX = Math.floor((x1 - x0) / block);
  const blocksY = Math.floor((y1 - y0) / block);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const ix0 = x0 + bx * block + 1;
      const iy0 = y0 + by * block + 1;
      const ix1 = ix0 + block - 2;
      const iy1 = iy0 + block - 2;

      let forest = 0;
      let paddyOk = 0;
      let usable = 0;
      for (let y = iy0; y <= iy1; y++) {
        for (let x = ix0; x <= ix1; x++) {
          if (!inBounds(x, y)) continue;
          const t = idx(x, y);
          if (world.terrain[t] === Terrain.Sea || world.terrain[t] === Terrain.Mountain) continue;
          usable++;
          if (world.terrain[t] === Terrain.Forest) forest++;
          if (world.canZone(t, Zone.AgriPaddy)) paddyOk++;
        }
      }
      if (usable < 3) continue;

      const bcx = (ix0 + ix1) / 2;
      const bcy = (iy0 + iy1) / 2;
      const ring = Math.min(1, Math.hypot(bcx - cx, bcy - cy) / half);

      // 地形が用途を強制する場合を先に処理する
      let z: Zone;
      if (forest > usable * 0.5) z = Zone.Forestry;
      else if (paddyOk > usable * 0.6 && ring > 0.55) z = Zone.AgriPaddy;
      else z = pickZone(ring, bx, by, bcx > cx, bcy > cy);

      for (let y = iy0; y <= iy1; y++) {
        for (let x = ix0; x <= ix1; x++) {
          if (!inBounds(x, y)) continue;
          const t = idx(x, y);
          if (world.road[t] !== RoadClass.None) continue;
          if (world.canZone(t, z)) push(z, t);
        }
      }
    }
  }
  for (const [z, tiles] of batches) sim.enqueue({ t: 'zonePaint', zone: z, tiles });
  sim.tick();
}

/** 建てられる場所を螺旋状に探して公共施設を置く。 */
function placeNear(sim: Simulation, arch: number, px: number, py: number, maxR = 16): boolean {
  const world = sim.world;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!inBounds(px + dx, py + dy)) continue;
        const t = idx(px + dx, py + dy);
        if (!world.canBuildStructure(t)) continue;
        if (!world.isAdjacentToRoad(t)) continue;
        const before = world.buildingRef[t];
        sim.enqueue({ t: 'placeBuilding', archetype: arch, tile: t });
        sim.tick();
        if (world.buildingRef[t] !== before) return true;
      }
    }
  }
  return false;
}

export function buildScenario(sim: Simulation, opts: ScenarioOptions = {}): ScenarioResult {
  const size = opts.size ?? 72;
  const block = opts.block ?? 6;
  const withRail = opts.withRail ?? true;
  const withSatellite = opts.withSatellite ?? true;
  const world = sim.world;

  const center = findCityCenter(world);
  const cx = center % MAP_W;
  const cy = (center / MAP_W) | 0;

  // ---------- 1. 中心市街地 ----------
  // 中心が商業、その外が中高層住居、さらに外が低層住居、東側に工業。
  layOutDistrict(sim, cx, cy, size, block, (ring, bx, by, east, south) => {
    if (ring < 0.18) return Zone.CommercialCentral;
    if (ring < 0.32) return Zone.ResidentialMid;
    if (ring < 0.4) return Zone.CommercialLocal;
    if (ring < 0.72) {
      if (east && south) return south && ring > 0.55 ? Zone.IndustrialHeavy : Zone.IndustrialLight;
      // 住宅地に近隣商業を散らして、買い物が徒歩圏で完結するようにする
      return (bx * 3 + by * 5) % 8 === 0 ? Zone.CommercialLocal : Zone.ResidentialLow;
    }
    if (east) return Zone.IndustrialLight;
    return Zone.AgriField;
  });

  // ---------- 2. ベッドタウン ----------
  // 職場をほとんど置かない。住民は中心市街地へ通勤せざるを得ず、
  // そこで初めて「どの交通手段で行くか」が本当の選択になる。
  let satellite = -1;
  let trunkTiles: number[] = [];
  const satSize = Math.round(size * 0.62);
  if (withSatellite) {
    satellite = findSatelliteCenter(world, cx, cy, size * 1.5, size * 2.4);
    if (satellite >= 0) {
      const sx = satellite % MAP_W;
      const sy = (satellite / MAP_W) | 0;
      layOutDistrict(sim, sx, sy, satSize, block, (ring, bx, by) => {
        // 商業は駅前の商店街と、住宅地に散らした最低限の店だけ。
        //
        // ここを厚くすると住民が地元で就職してしまう。実際、以前は中心に
        // 商業核を置いていたせいで雇用 1028 / 住民 1162 となり、
        // **中心市街地へ通勤する人が 1 人もいなかった**。
        // ベッドタウンとして書いたコメントに実装が追いついていなかった。
        if (ring < 0.14) return Zone.CommercialLocal;
        if (ring < 0.45) return Zone.ResidentialMid;
        if (ring < 0.85) return (bx * 5 + by * 3) % 13 === 0 ? Zone.CommercialLocal : Zone.ResidentialLow;
        return Zone.AgriField;
      });

      // 2 つの市街地を幹線道路で結ぶ（鉄道が無くても自動車で通えるように）。
      //
      // **わざと細い道にしてある。** 片側 1 車線の都市間連絡路は日本の県道として
      // 普通で、朝夕のラッシュに詰まる。実測では朝 7〜9 時に収容いっぱいになる
      // リンクの 7 割がこの幹線沿いに出る。
      // プレイヤが二車線・大通りに広げれば捌ける（青の配分と収容が同時に増えるため）。
      // ここを最初から大通りにすると、街でいちばん交通量の多い道が容量の
      // 4% で流れてしまい、交通シミュレーションが何も起こさない街になる。
      trunkTiles = lineTiles(center, satellite).filter((t) => world.canBuildRoad(t));
      sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: trunkTiles });
      sim.tick();
    }
  }

  // ---------- 3. 鉄道 ----------
  const stations: number[] = [];
  if (withRail) {
    const railPath: number[] = [];
    if (satellite >= 0) {
      // ベッドタウン → 中心市街地 → その先へ延びる 1 本の路線
      const beyondX = Math.max(4, Math.min(MAP_W - 5, cx + (cx - (satellite % MAP_W)) * 0.5));
      const beyondY = Math.max(4, Math.min(MAP_H - 5, cy + (cy - ((satellite / MAP_W) | 0)) * 0.5));
      railPath.push(...lineTiles(satellite, center));
      railPath.push(...lineTiles(center, idx(Math.round(beyondX), Math.round(beyondY))));
    } else {
      railPath.push(...lineTiles(idx(cx, Math.max(4, cy - size)), idx(cx, Math.min(MAP_H - 5, cy + size))));
    }
    const railTiles = railPath.filter((t) => world.canBuildRail(t));
    sim.enqueue({ t: 'buildRail', tiles: railTiles });
    sim.tick();

    // 路線に沿って等間隔に駅を置く
    const stationCount = 6;
    for (let k = 0; k < stationCount; k++) {
      const at = railTiles[Math.floor(((k + 0.5) / stationCount) * railTiles.length)];
      if (at === undefined) continue;
      const ax = at % MAP_W;
      const ay = (at / MAP_W) | 0;
      let placed = false;
      for (let r = 1; r <= 5 && !placed; r++) {
        for (const [dx, dy] of [
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ] as const) {
          if (!inBounds(ax + dx, ay + dy)) continue;
          const t = idx(ax + dx, ay + dy);
          const before = world.buildingRef[t];
          sim.enqueue({ t: 'placeBuilding', archetype: Arch.Station, tile: t });
          sim.tick();
          if (world.buildingRef[t] !== before) {
            stations.push(t);
            placed = true;
            break;
          }
        }
      }
    }
  }

  // ---------- 4. 公共施設 ----------
  sim.bootstrap();
  const q = Math.round(size * 0.22);
  placeNear(sim, Arch.CityHall, cx, cy);
  placeNear(sim, Arch.School, cx - q, cy - q);
  placeNear(sim, Arch.School, cx + q, cy + q);
  placeNear(sim, Arch.Hospital, cx + q, cy - q);
  placeNear(sim, Arch.Police, cx - q, cy + q);
  placeNear(sim, Arch.FireStation, cx + Math.round(q * 1.4), cy);
  placeNear(sim, Arch.Park, cx - 5, cy + 5);
  placeNear(sim, Arch.Park, cx + Math.round(q * 1.2), cy - 5);
  placeNear(sim, Arch.Shrine, cx + Math.round(q * 1.5), cy + Math.round(q * 1.5));
  if (satellite >= 0) {
    const sx = satellite % MAP_W;
    const sy = (satellite / MAP_W) | 0;
    placeNear(sim, Arch.School, sx, sy - Math.round(satSize * 0.2));
    placeNear(sim, Arch.Police, sx, sy + Math.round(satSize * 0.2));
    placeNear(sim, Arch.Park, sx + 4, sy + 4);
    placeNear(sim, Arch.Shrine, sx - Math.round(satSize * 0.3), sy);
  }

  // ---------- 5. 林業地と水田 ----------
  // 森と水辺は市街地の外にしかない。プレイヤなら支線道路を通して区画を作るので、
  // シナリオでも同じことをする。ここが無いと原木と米が手に入らず、
  // 木材（＝建設資材）と食品のサプライチェーンが立ち上がらない。
  addResourceDistrict(sim, Zone.Forestry, true, cx, cy, size * 2.2, 5);
  addResourceDistrict(sim, Zone.AgriPaddy, false, cx, cy, size * 2.2, 4);

  // TAZ 行列を一度きちんと埋めてから走らせる
  // （初日の行き先選択と交通手段選択が全部 Infinity になるのを防ぐ）
  sim.taz.computeAll(sim.graph);

  // ---------- 6. 初期人口 ----------
  if (opts.seedPopulation && opts.seedPopulation > 0) {
    const waves = 8;
    for (let w = 0; w < waves; w++) {
      for (let k = 0; k < TICKS_PER_DAY; k++) sim.tick();
      sim.seedPopulation(Math.ceil(opts.seedPopulation / waves));
    }
  }

  let roadCount = 0;
  let zonedCount = 0;
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    if (world.road[i] !== RoadClass.None) roadCount++;
    if (world.zone[i] !== Zone.None) zonedCount++;
  }
  return { center, satellite, trunk: trunkTiles, roadTiles: roadCount, zonedTiles: zonedCount, stations };
}

/**
 * 資源地（森林 / 低湿地）を探して支線道路を通し、その一帯をゾーニングする。
 * 街から離れるほど物流距離が伸びるので、近い資源地ほど価値が高い —
 * これが立地選択をゲームにする。
 */
function addResourceDistrict(
  sim: Simulation,
  zone: Zone,
  wantForest: boolean,
  cx: number,
  cy: number,
  maxRadius: number,
  count: number,
): number {
  const world = sim.world;
  const cell = 8;
  const cands: { x: number; y: number; score: number }[] = [];

  for (let y = cell; y < MAP_H - cell; y += cell) {
    for (let x = cell; x < MAP_W - cell; x += cell) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > maxRadius || dist < 10) continue;
      let good = 0;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          const t = idx(x + dx, y + dy);
          if (world.zone[t] !== Zone.None || world.buildingRef[t] !== 0) continue;
          if (world.road[t] !== RoadClass.None) continue;
          if (wantForest && world.terrain[t] !== Terrain.Forest) continue;
          if (world.canZone(t, zone)) good++;
        }
      }
      if (good < cell * cell * 0.35) continue;
      // 近いほど良い（物流コストが安い）
      cands.push({ x, y, score: good - dist * 0.2 });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  let created = 0;
  for (const c of cands) {
    if (created >= count) break;
    const cellCenter = idx(c.x + (cell >> 1), c.y + (cell >> 1));
    const hook = world.nearestRoadTile(cellCenter, 60);
    if (hook < 0) continue;
    const spur = lineTiles(hook, cellCenter).filter((t) => world.canBuildRoad(t));
    if (spur.length === 0) continue;
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: spur });
    sim.tick();

    const tiles: number[] = [];
    for (let dy = 0; dy < cell; dy++) {
      for (let dx = 0; dx < cell; dx++) {
        const t = idx(c.x + dx, c.y + dy);
        if (world.road[t] !== RoadClass.None) continue;
        if (world.canZone(t, zone)) tiles.push(t);
      }
    }
    if (tiles.length < 8) continue;
    sim.enqueue({ t: 'zonePaint', zone, tiles });
    sim.tick();
    created++;
  }
  return created;
}
