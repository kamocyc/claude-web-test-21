import { MAP_H, MAP_W, ROAD_ACCESS_RADIUS } from '@shared/constants';
import { Good, Zone } from '@shared/enums';
import { idx, inBounds, tileX, tileY } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import { ARCHETYPES, archetype } from './archetypes';

/**
 * 建物ストア。SoA + 世代タグ付きハンドル。
 *
 * 世代タグが要る理由は具体的で、市民は `homeBuilding` / `workBuilding` を
 * 生涯保持する。建物が取り壊されてスロットが再利用されたとき、世代を見なければ
 * 古い参照が黙って別の建物を指す（このタイプのシミュレーションでは確実に踏むバグ）。
 */

/**
 * ハンドル = (世代 << 20) | (スロット + 1)。0 は「無効」を意味する予約値。
 *
 * スロットに +1 しているのが要点。素直に slot をそのまま入れると、
 * スロット 0 かつ世代 0 の建物（＝街で最初に建つ建物）のハンドルが 0 になり、
 * 「無効」と区別できなくなる。最初の 1 軒だけ誰も住めない、という
 * 極めて見つけにくいバグになる。
 */
export function makeHandle(slot: number, gen: number): number {
  return (((gen & 0xfff) << 20) | ((slot + 1) & 0xfffff)) >>> 0;
}
export function handleSlot(h: number): number {
  return (h & 0xfffff) - 1;
}
export function handleGen(h: number): number {
  return (h >>> 20) & 0xfff;
}

export class BuildingStore {
  capacity = 0;
  /** 使用中スロットの上限（走査範囲）。 */
  high = 0;

  alive!: Uint8Array;
  generation!: Uint16Array;
  archetypeId!: Uint8Array;
  level!: Uint8Array;
  /** 左上タイル。 */
  originTile!: Uint32Array;
  /** 接道している道路タイル。-1 相当は 0xffffffff。 */
  accessTile!: Int32Array;
  /** 接道する道路グラフのノード。グラフ再構築のたびに取り直す。 */
  accessNode!: Int32Array;

  /** 住宅: 入居世帯数 / 収容世帯数 */
  residents!: Uint16Array;
  capacityResidents!: Uint16Array;
  /** 就業: 充足数 / 定員 */
  jobsFilled!: Uint16Array;
  jobsTotal!: Uint16Array;

  /** 在庫（入力 2 種 + 出力 1 種）。 */
  inGoodA!: Uint8Array;
  inAmtA!: Float32Array;
  inGoodB!: Uint8Array;
  inAmtB!: Float32Array;
  outGood!: Uint8Array;
  outAmt!: Float32Array;

  /** 建設中に必要な木材の残り。0 で完成。 */
  constructionNeed!: Float32Array;
  /** 商品切れが続いている日数。 */
  stockoutDays!: Uint16Array;
  /** 魅力度が閾値を超え/下回り続けている日数。 */
  goodDays!: Uint16Array;
  badDays!: Uint16Array;
  /** 直近に評価した魅力度 0..255。 */
  desirability!: Uint8Array;
  /** 累計の売上（月次決算でリセット）。 */
  revenueYen!: Float64Array;

  private freeList: number[] = [];

  constructor(capacity = 8192) {
    this.grow(capacity);
  }

  private grow(capacity: number): void {
    const g = <T extends { length: number }>(old: T | undefined, make: (n: number) => T): T => {
      const next = make(capacity);
      if (old) (next as unknown as { set(a: unknown): void }).set(old);
      return next;
    };
    this.alive = g(this.alive, (n) => new Uint8Array(n));
    this.generation = g(this.generation, (n) => new Uint16Array(n));
    this.archetypeId = g(this.archetypeId, (n) => new Uint8Array(n));
    this.level = g(this.level, (n) => new Uint8Array(n));
    this.originTile = g(this.originTile, (n) => new Uint32Array(n));
    this.accessTile = g(this.accessTile, (n) => new Int32Array(n).fill(-1));
    this.accessNode = g(this.accessNode, (n) => new Int32Array(n).fill(-1));
    this.residents = g(this.residents, (n) => new Uint16Array(n));
    this.capacityResidents = g(this.capacityResidents, (n) => new Uint16Array(n));
    this.jobsFilled = g(this.jobsFilled, (n) => new Uint16Array(n));
    this.jobsTotal = g(this.jobsTotal, (n) => new Uint16Array(n));
    this.inGoodA = g(this.inGoodA, (n) => new Uint8Array(n));
    this.inAmtA = g(this.inAmtA, (n) => new Float32Array(n));
    this.inGoodB = g(this.inGoodB, (n) => new Uint8Array(n));
    this.inAmtB = g(this.inAmtB, (n) => new Float32Array(n));
    this.outGood = g(this.outGood, (n) => new Uint8Array(n));
    this.outAmt = g(this.outAmt, (n) => new Float32Array(n));
    this.constructionNeed = g(this.constructionNeed, (n) => new Float32Array(n));
    this.stockoutDays = g(this.stockoutDays, (n) => new Uint16Array(n));
    this.goodDays = g(this.goodDays, (n) => new Uint16Array(n));
    this.badDays = g(this.badDays, (n) => new Uint16Array(n));
    this.desirability = g(this.desirability, (n) => new Uint8Array(n));
    this.revenueYen = g(this.revenueYen, (n) => new Float64Array(n));
    this.capacity = capacity;
  }

  /** ハンドルが今も同じ建物を指しているか。 */
  valid(handle: number): boolean {
    if (handle === 0) return false;
    const s = handleSlot(handle);
    return s >= 0 && s < this.capacity && this.alive[s] === 1 && (this.generation[s]! & 0xfff) === handleGen(handle);
  }

  handleOf(slot: number): number {
    return makeHandle(slot, this.generation[slot]! & 0xfff);
  }

  /** 建物を生成する。失敗したら 0。 */
  create(world: World, archId: number, originTile: number, level: number): number {
    const a = archetype(archId);
    // フットプリント全域が空いていること
    const ox = tileX(originTile);
    const oy = tileY(originTile);
    for (let dy = 0; dy < a.h; dy++) {
      for (let dx = 0; dx < a.w; dx++) {
        if (!inBounds(ox + dx, oy + dy)) return 0;
        if (!world.canBuildStructure(idx(ox + dx, oy + dy))) return 0;
      }
    }

    let slot = this.freeList.pop();
    if (slot === undefined) {
      if (this.high >= this.capacity) this.grow(this.capacity * 2);
      slot = this.high++;
    }

    this.alive[slot] = 1;
    this.archetypeId[slot] = archId;
    this.level[slot] = level;
    this.originTile[slot] = originTile;
    this.residents[slot] = 0;
    this.capacityResidents[slot] = a.households * level;
    this.jobsFilled[slot] = 0;
    this.jobsTotal[slot] = a.jobs * level;
    this.inGoodA[slot] = a.inputs[0]?.good ?? Good.None;
    this.inGoodB[slot] = a.inputs[1]?.good ?? Good.None;
    this.inAmtA[slot] = 0;
    this.inAmtB[slot] = 0;
    this.outGood[slot] = a.output;
    this.outAmt[slot] = 0;
    this.stockoutDays[slot] = 0;
    this.goodDays[slot] = 0;
    this.badDays[slot] = 0;
    this.desirability[slot] = 0;
    this.revenueYen[slot] = 0;
    this.constructionNeed[slot] = 0;

    const handle = this.handleOf(slot);
    for (let dy = 0; dy < a.h; dy++) {
      for (let dx = 0; dx < a.w; dx++) {
        const t = idx(ox + dx, oy + dy);
        world.buildingRef[t] = slot + 1;
        world.markDirty(t);
      }
    }
    this.refreshAccess(world, slot);
    world.epochs.buildings++;
    world.events.push({ t: 'buildingSpawned', id: slot });
    return handle;
  }

  /** 接道タイルを取り直す。 */
  refreshAccess(world: World, slot: number): void {
    const a = archetype(this.archetypeId[slot]!);
    const origin = this.originTile[slot]!;
    const ox = tileX(origin);
    const oy = tileY(origin);
    // フットプリントの中心から最寄りの道路を探す
    const center = idx(Math.min(MAP_W - 1, ox + (a.w >> 1)), Math.min(MAP_H - 1, oy + (a.h >> 1)));
    this.accessTile[slot] = world.nearestRoadTile(center, ROAD_ACCESS_RADIUS);
  }

  destroy(world: World, slot: number): void {
    if (this.alive[slot] !== 1) return;
    const a = archetype(this.archetypeId[slot]!);
    const origin = this.originTile[slot]!;
    const ox = tileX(origin);
    const oy = tileY(origin);
    for (let dy = 0; dy < a.h; dy++) {
      for (let dx = 0; dx < a.w; dx++) {
        if (!inBounds(ox + dx, oy + dy)) continue;
        const t = idx(ox + dx, oy + dy);
        if (world.buildingRef[t] === slot + 1) {
          world.buildingRef[t] = 0;
          world.markDirty(t);
        }
      }
    }
    this.alive[slot] = 0;
    // 世代を進めることで、生き残っている古いハンドルが無効になる。
    this.generation[slot] = (this.generation[slot]! + 1) & 0xfff;
    this.freeList.push(slot);
    world.epochs.buildings++;
    world.events.push({ t: 'buildingRemoved', id: slot });
  }

  /** レベルを 1 段上げる。 */
  levelUp(world: World, slot: number): boolean {
    const a = archetype(this.archetypeId[slot]!);
    const lv = this.level[slot]!;
    if (lv >= a.maxLevel) return false;
    this.level[slot] = lv + 1;
    this.capacityResidents[slot] = a.households * (lv + 1);
    this.jobsTotal[slot] = a.jobs * (lv + 1);
    this.goodDays[slot] = 0;
    world.epochs.buildings++;
    world.events.push({ t: 'buildingLeveled', id: slot, level: lv + 1 });
    return true;
  }

  /** 生存している建物スロットを列挙する。 */
  *each(): Generator<number> {
    for (let s = 0; s < this.high; s++) {
      if (this.alive[s] === 1) yield s;
    }
  }

  count(): number {
    let c = 0;
    for (let s = 0; s < this.high; s++) if (this.alive[s] === 1) c++;
    return c;
  }

  /** 建物が属する用途分類。 */
  zoneOf(slot: number): Zone {
    return ARCHETYPES[this.archetypeId[slot]!]!.zone;
  }
}
