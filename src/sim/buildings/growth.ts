import {
  ABANDON_PATIENCE_DAYS,
  CONSTRUCTION_LUMBER,
  GROWTH_SCAN_PER_TICK,
  TILE_COUNT,
  UPGRADE_PATIENCE_DAYS,
} from '@shared/constants';
import { Service, Zone } from '@shared/enums';
import type { Rng } from '@sim/core/rng';
import { idx, inBounds, tileX, tileY } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import { ZONE_ARCHETYPES, archetype } from './archetypes';
import type { BuildingStore } from './buildings';
import { type DemandState, demandKindOfZone, demandValue } from './demand';

/**
 * ゾーンタイルの成長スキャン。
 *
 * 全タイル走査はしない。ゾーン指定済みかつ空きのタイルだけをインデックスに持ち、
 * そこから毎 tick 少数をサンプリングして評価する。
 *
 * 魅力度 S を 2 乗して確率に使うのが要点。良い場所から順に埋まり、
 * 条件の悪い土地は圧力が高まるまで空いたままになる — これが「街らしい構造」を生む。
 * 線形にすると全域が一様に埋まって、のっぺりした街になる。
 */
export class GrowthSystem {
  /** ゾーン指定済みで空きのタイル。 */
  private candidates: number[] = [];
  private cursor = 0;
  private dirty = true;
  /** 建設待ちで木材が足りない件数（需要モデルへ返す）。 */
  lumberShortfall = 0;

  markDirty(): void {
    this.dirty = true;
  }

  private rebuildIndex(world: World): void {
    this.candidates.length = 0;
    for (let i = 0; i < TILE_COUNT; i++) {
      if (world.zone[i] !== Zone.None && world.buildingRef[i] === 0) this.candidates.push(i);
    }
    this.cursor = 0;
    this.dirty = false;
  }

  /**
   * タイルの魅力度 0..1。
   * 鉄道アクセスの重みを地価に次ぐ大きさにしてあるのは意図的な設計判断で、
   * 「駅を先に敷いて周りをゾーニングしたプレイヤが報われる」ようにするため。
   */
  desirability(world: World, tile: number, zone: Zone): number {
    // 接道が無ければ絶対に建たない。道路設計をゲームにする一番の要。
    if (!hasRoadAccess(world, tile)) return 0;

    const lv = world.landValue[tile]! / 255;
    const ta = world.transitAccess[tile]!;
    const transit = ta >= 255 ? 0 : Math.exp(-ta / 8);
    const svc = world.svcMask[tile]!;
    const svcScore =
      (((svc & Service.Education) !== 0 ? 1 : 0) +
        ((svc & Service.Health) !== 0 ? 1 : 0) +
        ((svc & Service.Safety) !== 0 ? 1 : 0) +
        ((svc & Service.Park) !== 0 ? 1 : 0)) /
      4;
    const flat = 1 - Math.min(1, world.slope[tile]! / 120);
    const poll = world.pollution[tile]! / 255;
    const noise = world.noise[tile]! / 255;

    let s = 0.28 * lv + 0.22 * transit + 0.16 * svcScore + 0.08 * flat + 0.2;

    switch (zone) {
      case Zone.ResidentialLow:
      case Zone.ResidentialMid:
        s -= 0.30 * poll + 0.18 * noise;
        break;
      case Zone.CommercialLocal:
      case Zone.CommercialCentral:
        // 商業は人通り（＝周囲の建物密度）を好む
        s += 0.10 * neighborDensity(world, tile);
        s -= 0.14 * poll;
        break;
      case Zone.IndustrialLight:
      case Zone.IndustrialHeavy:
        // 工業は地価が安い方が良い。公害も気にしない。
        s = 0.10 * (1 - lv) + 0.30 * transit * 0.4 + 0.10 * flat + 0.35;
        break;
      case Zone.AgriPaddy:
        s = 0.5 + 0.3 * (1 - Math.min(1, world.waterAccess[tile]! / 10)) - 0.2 * poll;
        break;
      case Zone.AgriField:
        s = 0.45 + 0.2 * flat - 0.2 * poll;
        break;
      case Zone.Forestry:
        s = 0.5 - 0.15 * poll;
        break;
      case Zone.Park:
        s = 0.6;
        break;
      default:
        break;
    }
    return Math.max(0, Math.min(1, s));
  }

  /**
   * 1 tick 分のスキャン。建設・レベルアップ・廃墟化を判定する。
   * @param lumberAvailable 建設に使える木材の総量（消費した分を返す）
   */
  tick(
    world: World,
    buildings: BuildingStore,
    demand: DemandState,
    rng: Rng,
    lumberAvailable: number,
    cityPopulation: number,
  ): { lumberUsed: number } {
    if (this.dirty) this.rebuildIndex(world);
    if (this.candidates.length === 0) return { lumberUsed: 0 };

    let lumberUsed = 0;
    let shortfall = 0;
    const scan = Math.min(GROWTH_SCAN_PER_TICK, this.candidates.length);

    for (let k = 0; k < scan; k++) {
      const ci = this.cursor % this.candidates.length;
      this.cursor++;
      const tile = this.candidates[ci]!;
      const zone = world.zone[tile]! as Zone;

      // インデックスが古い（ゾーン解除済み・建物が建った）ら詰めて捨てる
      if (zone === Zone.None || world.buildingRef[tile] !== 0) {
        this.candidates[ci] = this.candidates[this.candidates.length - 1]!;
        this.candidates.pop();
        if (this.candidates.length === 0) break;
        continue;
      }

      const d = demandValue(demand, demandKindOfZone(zone));
      if (d <= 0) continue;

      const s = this.desirability(world, tile, zone);
      if (s <= 0) continue;

      // 確率 = k * 需要 * S^2
      const p = 0.02 * (d / 100) * s * s;
      if (!rng.chance(p)) continue;

      // 木材が要る（林業チェーンが街の成長速度を律速する）
      if (lumberAvailable - lumberUsed < CONSTRUCTION_LUMBER) {
        shortfall++;
        continue;
      }

      const archId = pickArchetype(zone, s, rng, cityPopulation);
      if (archId < 0) continue;
      const a = archetype(archId);
      const level = a.minLevel;
      // フットプリントが入るか
      if (!footprintFree(world, tile, a.w, a.h)) continue;

      const handle = buildings.create(world, archId, tile, level);
      if (handle !== 0) {
        lumberUsed += CONSTRUCTION_LUMBER;
        this.candidates[ci] = this.candidates[this.candidates.length - 1]!;
        this.candidates.pop();
        if (this.candidates.length === 0) break;
      }
    }

    this.lumberShortfall = shortfall;
    return { lumberUsed };
  }

  /**
   * 日次の建物評価。レベルアップと廃墟化。
   * 全建物を毎日 1 回だけ見る（建物数は数千オーダーなので十分軽い）。
   */
  dailyReview(world: World, buildings: BuildingStore): void {
    for (const s of buildings.each()) {
      const a = archetype(buildings.archetypeId[s]!);
      if (a.playerPlaced) continue;
      const tile = buildings.originTile[s]!;
      const zone = a.zone;
      const des = this.desirability(world, tile, zone);
      buildings.desirability[s] = Math.round(des * 255);

      // 接道が失われたら即座に廃墟カウントを進める
      const lostAccess = buildings.accessTile[s]! < 0;
      const starved = buildings.stockoutDays[s]! > 0;

      if (des > 0.62 && !lostAccess && !starved) {
        buildings.goodDays[s] = buildings.goodDays[s]! + 1;
        buildings.badDays[s] = 0;
        if (buildings.goodDays[s]! >= UPGRADE_PATIENCE_DAYS) {
          buildings.levelUp(world, s);
        }
      } else if (des < 0.22 || lostAccess) {
        buildings.badDays[s] = buildings.badDays[s]! + 1;
        buildings.goodDays[s] = 0;
        if (buildings.badDays[s]! >= ABANDON_PATIENCE_DAYS) {
          world.events.push({
            t: 'alert',
            kind: lostAccess ? 'noRoadAccess' : 'abandoned',
            tile,
            message: `${a.nameJa}が廃墟になりました`,
          });
          buildings.destroy(world, s);
          this.markDirty();
        }
      } else {
        buildings.goodDays[s] = 0;
        buildings.badDays[s] = 0;
      }
    }
  }
}

function footprintFree(world: World, origin: number, w: number, h: number): boolean {
  const ox = tileX(origin);
  const oy = tileY(origin);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!inBounds(ox + dx, oy + dy)) return false;
      const t = idx(ox + dx, oy + dy);
      if (world.buildingRef[t] !== 0) return false;
      if (!world.canBuildStructure(t)) return false;
      // フットプリント全域が同じゾーンであること
      if (world.zone[t] !== world.zone[origin]) return false;
    }
  }
  return true;
}

/** 接道判定。建物のフットプリントに隣接する道路があるか。 */
function hasRoadAccess(world: World, tile: number): boolean {
  if (world.isAdjacentToRoad(tile)) return true;
  // 2 タイル先まで許容（角地・区画の奥）
  return world.nearestRoadTile(tile, 2) >= 0;
}

/** 周囲 3 タイルの建物密度 0..1。商店街が連なるのを促す。 */
function neighborDensity(world: World, tile: number): number {
  const x = tileX(tile);
  const y = tileY(tile);
  let n = 0;
  let total = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      total++;
      if (world.buildingRef[idx(x + dx, y + dy)] !== 0) n++;
    }
  }
  return total > 0 ? n / total : 0;
}

/** ゾーンと魅力度からアーキタイプを選ぶ。魅力度が高いほど高密度の建物が出る。 */
function pickArchetype(zone: Zone, desirability: number, rng: Rng, cityPopulation: number): number {
  const all = ZONE_ARCHETYPES[zone];
  if (!all || all.length === 0) return -1;
  // 市の規模に達していない建物は候補から外す（タワーマンションは大都市になってから）。
  // ただし全部外れたら、その用途地域で最も条件の緩い建物だけは残す。
  // 空リストを返してしまうと、そのゾーンには永久に何も建たなくなり、
  // 「人口が増えないと家が建たず、家が建たないと人口が増えない」で街が固まる。
  let list = all.filter((id) => cityPopulation >= archetype(id).minCityPopulation);
  if (list.length === 0) {
    let easiest = all[0]!;
    for (const id of all) {
      if (archetype(id).minCityPopulation < archetype(easiest).minCityPopulation) easiest = id;
    }
    list = [easiest];
  }
  // 魅力度が高いほどリストの後ろ（＝高密度）に寄せる
  const weights = list.map((id) => {
    const a = archetype(id);
    const density = a.minLevel / 5;
    // desirability と density が近いものを好む
    return Math.exp(-Math.abs(desirability - density) * 4) + 0.05;
  });
  const pick = rng.weightedPick(weights);
  return pick < 0 ? list[0]! : list[pick]!;
}
