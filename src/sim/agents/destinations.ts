import { Good } from '@shared/enums';
import { Arch, archetype, isShop } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import { tileDistanceM } from '@sim/world/tiles';
import type { ActivityContext } from './activity';

/**
 * 買い物・レジャー・通学の行き先選択。
 *
 * 最寄りを取るのではなく重力モデルで抽選する:
 *   weight(dest) = 魅力度 × exp(-所要時間 / 減衰定数)
 * これで「たいていは近所、たまに大きな駅前へ」という人間らしい分布になり、
 * かつ 1 か所に全員が殺到しない。所要時間は TAZ 行列の概算で足りるので、
 * 行き先選びのために経路探索を呼ぶことはない。
 */
export class Destinations {
  private shops: number[] = [];
  private leisure: number[] = [];
  private schools: number[] = [];
  /** 業務移動の行き先。雇用のある事業所すべて。 */
  private workplaces: number[] = [];
  private dirty = true;

  /** 候補数の上限。多すぎると抽選コストが上がるだけで質は上がらない。 */
  private static readonly SAMPLE = 12;

  markDirty(): void {
    this.dirty = true;
  }

  rebuild(buildings: BuildingStore): void {
    this.shops.length = 0;
    this.leisure.length = 0;
    this.schools.length = 0;
    this.workplaces.length = 0;
    for (const s of buildings.each()) {
      const a = archetype(buildings.archetypeId[s]!);
      if (isShop(a.id)) this.shops.push(s);
      if (a.leisureAppeal > 0) this.leisure.push(s);
      if (a.id === Arch.School) this.schools.push(s);
      if (buildings.jobsTotal[s]! > 0) this.workplaces.push(s);
    }
    this.dirty = false;
  }

  get shopCount(): number {
    return this.shops.length;
  }
  get leisureCount(): number {
    return this.leisure.length;
  }

  /** 買い物先。在庫がある店を強く優先する（欠品が客足に跳ね返る）。 */
  pickShop(ctx: ActivityContext, fromTile: number): number {
    if (this.dirty) this.rebuild(ctx.buildings);
    return this.pickFrom(ctx, fromTile, this.shops, (slot) => {
      const b = ctx.buildings;
      const hasStock =
        (b.inGoodA[slot] === Good.Food && b.inAmtA[slot]! >= 1) ||
        (b.inGoodB[slot] === Good.ConsumerGoods && b.inAmtB[slot]! >= 1);
      const size = b.level[slot]! * 8 + 4;
      return hasStock ? size : size * 0.15; // 欠品の店も稀に選ばれる（そこで不満が発生する）
    });
  }

  pickLeisure(ctx: ActivityContext, fromTile: number): number {
    if (this.dirty) this.rebuild(ctx.buildings);
    return this.pickFrom(ctx, fromTile, this.leisure, (slot) => archetype(ctx.buildings.archetypeId[slot]!).leisureAppeal);
  }

  /** 業務移動の行き先。人の多い事業所ほど用事が多い。 */
  pickBusiness(ctx: ActivityContext, fromTile: number): number {
    if (this.dirty) this.rebuild(ctx.buildings);
    return this.pickFrom(ctx, fromTile, this.workplaces, (slot) => ctx.buildings.jobsTotal[slot]! + 2);
  }

  pickSchool(ctx: ActivityContext, fromTile: number): number {
    if (this.dirty) this.rebuild(ctx.buildings);
    return this.pickFrom(ctx, fromTile, this.schools, () => 100);
  }

  private pickFrom(
    ctx: ActivityContext,
    fromTile: number,
    pool: readonly number[],
    appealOf: (slot: number) => number,
  ): number {
    if (pool.length === 0) return 0;
    const n = Math.min(Destinations.SAMPLE, pool.length);
    const weights: number[] = [];
    const slots: number[] = [];
    // プールから等間隔＋乱数オフセットで候補を取る（毎回全件を評価しない）
    const stride = Math.max(1, Math.floor(pool.length / n));
    let start = ctx.rng.int(pool.length);
    for (let k = 0; k < n; k++) {
      const slot = pool[(start + k * stride) % pool.length]!;
      if (ctx.buildings.alive[slot] !== 1) continue;
      const destTile = ctx.buildings.originTile[slot]!;
      const distM = tileDistanceM(fromTile, destTile);
      // 距離減衰。1.5km を超えると急速に選ばれにくくなる。
      const decay = Math.exp(-distM / 1500);
      const w = Math.max(0.01, appealOf(slot)) * decay;
      slots.push(slot);
      weights.push(w);
    }
    if (slots.length === 0) return 0;
    const pick = ctx.rng.weightedPick(weights);
    if (pick < 0) return 0;
    return ctx.buildings.handleOf(slots[pick]!);
  }
}
