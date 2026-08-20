import {
  POLLUTION_PER_UNTREATED_M3,
  POWER_PER_RESIDENT_KW,
  POWER_PER_JOB_KW,
  TILE_COUNT,
  UTILITY_GRACE_DAYS,
  WATER_PER_RESIDENT,
  WATER_INTAKE_TILES,
  WATER_PER_JOB,
} from '@shared/constants';
import { RoadClass } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import type { NamedArray } from '@sim/persistence';
import { idx, inBounds, tileX, tileY } from './tiles';
import type { World } from './world';

/**
 * 電気・上水・下水の供給。
 *
 * 専用の管路網は敷かせず、**供給は道路網の連結成分を伝わる**（電線と水道管は
 * 道路の下を通っているものとする）。CS の電線・水道管をそのまま持ち込むと、
 * 320×320 タイルでは操作が煩雑になる割に、意思決定が「繋いだかどうか」しか
 * 生まない。日本の実情（道路占用で埋設する）にも近い割り切り。
 *
 * ---------------------------------------------------------------------------
 * 公開 API（simulation.ts / UI / 描画からはここだけを見ればよい）
 * ---------------------------------------------------------------------------
 *
 *   再計算
 *     recompute(world, buildings)     連結成分・供給・需要・停電判定をまとめて取り直す。
 *                                     道路や建物が変わったとき、および経済期ごとに呼ぶ。
 *     dailyReview(buildings)          停電・断水の連続日数を 1 日進める。日次で 1 回だけ呼ぶ。
 *     reset()                         全状態を捨てる（新規ゲーム・ロード直前）。
 *
 *   問い合わせ（建物 1 つ）
 *     hasPower(slot) / hasWater(slot) いま電気／水が来ているか。
 *     isShutdown(slot)                UTILITY_GRACE_DAYS 日以上落ちていて機能停止しているか。
 *     powerOutageDays(slot) / waterOutageDays(slot)
 *                                     連続で落ちている日数（UI の建物パネル用）。
 *     componentOfBuilding(slot)       属する道路連結成分。-1 = 接道なし。
 *     componentOfTile(tile)           そのタイルの連結成分。道路以外は -1。
 *     canGrowAt(tile)                 その地区に新しい建物を受け入れる余裕があるか（成長の可否）。
 *     sewagePollutionOf(slot)         未処理下水がこの建物から出す追加公害。単位は
 *                                     `Archetype.pollution × level` と同じ ＝ fields.ts の
 *                                     `updatePollution` が originTile に積んでいる値にそのまま足せる。
 *
 *   集計（UI パネル）
 *     cityTotals()                    街全体の供給量・需要量・停電棟数。
 *     componentInfos()                連結成分ごとの同じ内訳（供給が届いていない地区の特定用）。
 *
 *   オーバーレイ（Overlay.Power / Overlay.Water で塗る）
 *     powerOverlay / waterOverlay     タイルごとの 0..255。
 *                                     0   = 供給網の外（道路も建物も無い、塗らない）
 *                                     1   = 網の中にいるのに落ちている建物
 *                                     128 = 供給がちょうど需要と釣り合っている
 *                                     255 = 需要の 2 倍以上の余裕がある
 *
 *   セーブ / ロード
 *     saveArrays(high) / restoreArrays(src, high)
 *                                     連結成分・供給・需要はすべて道路と建物から作り直せるので
 *                                     保存しない。保存が要るのは連続停電日数だけ。
 *
 *   設置制約（モジュール関数）
 *     canBuildUtility(world, archId, originTile)
 *                                     浄水場のように水辺が要る建物を弾く。
 *                                     `Simulation.canPlace` からこれを AND で足す想定。
 */



/** 浮動小数の丸め誤差で「ちょうど容量ぴったり」が落ちないようにする許容差。 */
const EPS = 1e-6;

/** 街全体、または連結成分 1 つぶんの供給・需要。UI のパネルにそのまま出せる形。 */
export interface UtilityTotals {
  /** 発電容量と電力需要 (kW)。 */
  powerSupplyKw: number;
  powerDemandKw: number;
  /** 浄水容量と上水需要 (m3/日)。 */
  waterSupply: number;
  waterDemand: number;
  /** 下水処理容量と発生量 (m3/日)。 */
  sewageCapacity: number;
  sewageDemand: number;
  /** 電気が来ていない棟数・水が来ていない棟数・機能停止している棟数。 */
  unpowered: number;
  unwatered: number;
  shutdown: number;
}

/** 連結成分 1 つの内訳。「どの地区が足りていないか」を UI に出すためのもの。 */
export interface ComponentInfo extends UtilityTotals {
  /** 連結成分 ID。`componentOfTile` / `componentOfBuilding` が返す値。 */
  component: number;
  /** この成分に属する道路タイル数。地区の大きさの目安。 */
  roadTiles: number;
  /** この成分に接道している建物の数。 */
  buildings: number;
  /**
   * その成分を代表する道路タイル（成分内で最小の index）。
   * 通知でカメラを飛ばす先に使う。決定論のため「最小」で固定する。
   */
  sampleTile: number;
}

function emptyTotals(): UtilityTotals {
  return {
    powerSupplyKw: 0,
    powerDemandKw: 0,
    waterSupply: 0,
    waterDemand: 0,
    sewageCapacity: 0,
    sewageDemand: 0,
    unpowered: 0,
    unwatered: 0,
    shutdown: 0,
  };
}

/**
 * その建物をそこに建てられるか（電気・水道まわりの追加制約だけを見る）。
 * 地形・既存建物・道路の判定は `World.canBuildStructure` の仕事なので二重にはやらない。
 */
export function canBuildUtility(world: World, archId: number, originTile: number): boolean {
  const a = archetype(archId);
  if (!a.needsWaterAccess) return true;
  // フットプリントのどこか 1 タイルでも取水圏に入っていればよい。
  // 全タイルを要求すると 2×2 の浄水場が川の真横にしか建たなくなる。
  const ox = tileX(originTile);
  const oy = tileY(originTile);
  for (let dy = 0; dy < a.h; dy++) {
    for (let dx = 0; dx < a.w; dx++) {
      const x = ox + dx;
      const y = oy + dy;
      if (!inBounds(x, y)) continue;
      if (world.waterAccess[idx(x, y)]! <= WATER_INTAKE_TILES) return true;
    }
  }
  return false;
}

/**
 * 電気・水道の状態を持つシステム。
 *
 * タイル全域を舐める配列（連結成分ラベル・オーバーレイ）はすべて SoA の TypedArray。
 * オブジェクト配列にすると 10 万タイルの走査でフレーム予算を使い切る
 * （理由は `fields.ts` の冒頭コメントと同じ）。
 */
export class UtilitySystem {
  /** 道路タイル → 連結成分 ID。道路でないタイルは -1。 */
  private readonly compOf = new Int32Array(TILE_COUNT).fill(-1);
  /** ラベル付け BFS の作業キュー。毎回確保すると GC 圧になるので使い回す。 */
  private readonly queue = new Int32Array(TILE_COUNT);

  /** オーバーレイ用のタイル値 0..255。意味はファイル先頭の一覧を参照。 */
  readonly powerOverlay = new Uint8Array(TILE_COUNT);
  readonly waterOverlay = new Uint8Array(TILE_COUNT);

  /** 連結成分の数。以下の成分別配列はこの長さぶんだけ意味を持つ。 */
  componentCount = 0;

  // ---- 成分別（添字 = 成分 ID）----
  private compCap = 0;
  private compRoadTiles = new Int32Array(0);
  private compSampleTile = new Int32Array(0);
  private compBuildings = new Int32Array(0);
  /** 成分ごとの停電・断水・機能停止の棟数。「どの地区が落ちているか」を UI に出す。 */
  private compUnpowered = new Int32Array(0);
  private compUnwatered = new Int32Array(0);
  private compShutdown = new Int32Array(0);
  private compPowerSupply = new Float64Array(0);
  private compPowerDemand = new Float64Array(0);
  private compWaterSupply = new Float64Array(0);
  /** 連結成分を数え直した時点の `World.networkVersion`。 */
  private labelVersion = -1;
  private compWaterDemand = new Float64Array(0);
  private compSewageCapacity = new Float64Array(0);
  private compSewageDemand = new Float64Array(0);
  /** 割り当て済みの需要（打ち切り判定の走行合計）。 */
  private compUsedPower = new Float64Array(0);
  private compUsedWater = new Float64Array(0);
  /** 打ち切り済みフラグ。1 になった成分は、以降のスロットを無条件に落とす。 */
  private compCutPower = new Uint8Array(0);
  private compCutWater = new Uint8Array(0);
  /** 下水の未処理率 0..1。 */
  private compUntreated = new Float64Array(0);
  /** オーバーレイに塗る成分別のバイト値。 */
  private compPowerByte = new Uint8Array(0);
  private compWaterByte = new Uint8Array(0);

  // ---- 建物別（添字 = 建物スロット）----
  private slotCap = 0;
  private bComponent = new Int32Array(0);
  private bPowerDemand = new Float64Array(0);
  private bWaterDemand = new Float64Array(0);
  private bPowered = new Uint8Array(0);
  private bWatered = new Uint8Array(0);
  /**
   * 連続で落ちている日数。**セーブが要るのはこの 2 本だけ** —
   * 連結成分も供給量も道路と建物から作り直せるが、「何日続いているか」は作り直せない。
   */
  private bPowerOutDays = new Uint16Array(0);
  private bWaterOutDays = new Uint16Array(0);

  private totals: UtilityTotals = emptyTotals();

  // ---------------- 再計算 ----------------

  /**
   * 連結成分・供給・需要・停電判定を取り直す。
   *
   * 全タイル走査は 2 回（ラベル付けとオーバーレイの初期化）で済ませてある。
   * 道路が変わったときと経済期ごと（2 シミュレーション時間に 1 回）に呼ぶ想定で、
   * 320×320 なら `updatePollution` より軽い。
   */
  recompute(world: World, buildings: BuildingStore): void {
    // 連結成分は道路が変わったときしか変わらない。建物を 1 棟置くたびに
    // 全タイルの BFS を回すと、シナリオ生成のように何千棟も置く場面で効いてくる。
    if (this.labelVersion !== world.networkVersion) {
      this.labelComponents(world);
      this.labelVersion = world.networkVersion;
    }
    this.ensureSlots(buildings.capacity);
    this.aggregate(buildings);
    this.allocate(buildings);
    this.paintOverlays(world, buildings);
  }

  /**
   * 道路タイルを連結成分に分ける（4 近傍の BFS）。
   *
   * 一方通行は無視する。電線と水道管に向きは無いので、
   * `oneWay` を見ると「車が入れない袋小路だけ停電する」という説明のつかない挙動になる。
   */
  private labelComponents(world: World): void {
    this.compOf.fill(-1);
    let n = 0;
    for (let start = 0; start < TILE_COUNT; start++) {
      if (world.road[start] === RoadClass.None || this.compOf[start] !== -1) continue;
      this.ensureComponents(n + 1);
      const comp = n++;
      let qh = 0;
      let qt = 0;
      this.compOf[start] = comp;
      this.queue[qt++] = start;
      let tiles = 0;
      while (qh < qt) {
        const i = this.queue[qh++]!;
        tiles++;
        const x = tileX(i);
        const y = tileY(i);
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
          const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
          if (!inBounds(nx, ny)) continue;
          const j = idx(nx, ny);
          if (world.road[j] === RoadClass.None || this.compOf[j] !== -1) continue;
          this.compOf[j] = comp;
          this.queue[qt++] = j;
        }
      }
      this.compRoadTiles[comp] = tiles;
      // 外側の走査が index 昇順なので、始点が必ずその成分の最小 index になる。
      this.compSampleTile[comp] = start;
    }
    this.componentCount = n;
  }

  /** 成分ごとの供給量と需要量を集計する。 */
  private aggregate(buildings: BuildingStore): void {
    const n = this.componentCount;
    this.compBuildings.fill(0, 0, n);
    this.compPowerSupply.fill(0, 0, n);
    this.compPowerDemand.fill(0, 0, n);
    this.compWaterSupply.fill(0, 0, n);
    this.compWaterDemand.fill(0, 0, n);
    this.compSewageCapacity.fill(0, 0, n);
    this.compSewageDemand.fill(0, 0, n);

    for (let s = 0; s < buildings.high; s++) {
      if (buildings.alive[s] !== 1) {
        // スロットは使い回されるので、死んだスロットの日数を掃除しておく。
        // 残すと、同じスロットに建った新築が初日から「3 日連続停電」で機能停止する。
        this.bComponent[s] = -1;
        this.bPowered[s] = 0;
        this.bWatered[s] = 0;
        this.bPowerOutDays[s] = 0;
        this.bWaterOutDays[s] = 0;
        continue;
      }
      const access = buildings.accessTile[s]!;
      const comp = access >= 0 ? this.compOf[access]! : -1;
      this.bComponent[s] = comp;

      // 需要は「実際に住んでいる人／働いている人」ではなく定員で数える。
      // 実入居で数えると、転入・離職のたびに需要が揺れ、発電所がぎりぎりの街が
      // 経済期ごとに点いたり消えたりする。定員基準なら、プレイヤは
      // 「この街区を建てたらいくら要るか」を先に見積もれる。
      // capacityResidents は「世帯数」ではなく**収容人数**（増減も人単位）。
      const residents = buildings.capacityResidents[s]!;
      const jobs = buildings.jobsTotal[s]!;
      const pd = residents * POWER_PER_RESIDENT_KW + jobs * POWER_PER_JOB_KW;
      const wd = residents * WATER_PER_RESIDENT + jobs * WATER_PER_JOB;
      this.bPowerDemand[s] = pd;
      this.bWaterDemand[s] = wd;
      if (comp < 0) continue;

      const a = archetype(buildings.archetypeId[s]!);
      const lv = buildings.level[s]!;
      this.compBuildings[comp] = this.compBuildings[comp]! + 1;
      this.compPowerDemand[comp] = this.compPowerDemand[comp]! + pd;
      this.compWaterDemand[comp] = this.compWaterDemand[comp]! + wd;
      // 使った水はそのまま下水になる。上水と下水を別の需要式にすると、
      // プレイヤが覚えることが 1 つ増えるだけで判断は変わらない。
      this.compSewageDemand[comp] = this.compSewageDemand[comp]! + wd;
      this.compPowerSupply[comp] = this.compPowerSupply[comp]! + a.powerKw * lv;
      this.compWaterSupply[comp] = this.compWaterSupply[comp]! + a.waterM3 * lv;
      this.compSewageCapacity[comp] = this.compSewageCapacity[comp]! + a.sewageM3 * lv;
    }
  }

  /**
   * 供給を建物に割り当て、足りないぶんを落とす。
   *
   * **スロット昇順で打ち切る**（乱数で選ばない）。乱数だと同じセーブから同じ街に
   * ならず、決定論が壊れる。しかも毎期ちがう建物が落ちるので、プレイヤから見ると
   * 街じゅうがちらつくだけで原因が読めない。
   *
   * 打ち切りは「以降を全部落とす」であって「入るものを詰める」ではない。
   * 詰めてしまうと、大きなマンションが落ちた直後に小さなコンビニだけが生き残る、
   * という説明のつかない虫食いになる。古い区画から順に生き残るほうが、
   * 「街の外れから停電する」という読める挙動になる。
   */
  private allocate(buildings: BuildingStore): void {
    const n = this.componentCount;
    this.compUsedPower.fill(0, 0, n);
    this.compUsedWater.fill(0, 0, n);
    this.compCutPower.fill(0, 0, n);
    this.compCutWater.fill(0, 0, n);
    this.compUnpowered.fill(0, 0, n);
    this.compUnwatered.fill(0, 0, n);
    this.compShutdown.fill(0, 0, n);

    const t = emptyTotals();
    for (let s = 0; s < buildings.high; s++) {
      if (buildings.alive[s] !== 1) continue;
      const comp = this.bComponent[s]!;
      let powered = 0;
      let watered = 0;
      if (comp >= 0) {
        const pd = this.bPowerDemand[s]!;
        if (this.compCutPower[comp] === 0 && this.compUsedPower[comp]! + pd <= this.compPowerSupply[comp]! + EPS) {
          this.compUsedPower[comp] = this.compUsedPower[comp]! + pd;
          powered = 1;
        } else {
          this.compCutPower[comp] = 1;
        }
        const wd = this.bWaterDemand[s]!;
        if (this.compCutWater[comp] === 0 && this.compUsedWater[comp]! + wd <= this.compWaterSupply[comp]! + EPS) {
          this.compUsedWater[comp] = this.compUsedWater[comp]! + wd;
          watered = 1;
        } else {
          this.compCutWater[comp] = 1;
        }
      }
      this.bPowered[s] = powered;
      this.bWatered[s] = watered;
      // 復旧は即座に効かせる。日の境界でしか数え直さないと、発電所を建て直しても
      // 翌日まで街が止まったままになり、猶予を置いた意味が消える。
      if (powered === 1) this.bPowerOutDays[s] = 0;
      if (watered === 1) this.bWaterOutDays[s] = 0;
      const down = this.isShutdown(s);
      if (powered === 0) t.unpowered++;
      if (watered === 0) t.unwatered++;
      if (down) t.shutdown++;
      if (comp >= 0) {
        if (powered === 0) this.compUnpowered[comp] = this.compUnpowered[comp]! + 1;
        if (watered === 0) this.compUnwatered[comp] = this.compUnwatered[comp]! + 1;
        if (down) this.compShutdown[comp] = this.compShutdown[comp]! + 1;
      }
    }

    for (let c = 0; c < n; c++) {
      t.powerSupplyKw += this.compPowerSupply[c]!;
      t.powerDemandKw += this.compPowerDemand[c]!;
      t.waterSupply += this.compWaterSupply[c]!;
      t.waterDemand += this.compWaterDemand[c]!;
      t.sewageCapacity += this.compSewageCapacity[c]!;
      t.sewageDemand += this.compSewageDemand[c]!;
      const sd = this.compSewageDemand[c]!;
      this.compUntreated[c] = sd > 0 ? Math.max(0, Math.min(1, (sd - this.compSewageCapacity[c]!) / sd)) : 0;
      this.compPowerByte[c] = ratioByte(this.compPowerSupply[c]!, this.compPowerDemand[c]!);
      this.compWaterByte[c] = ratioByte(this.compWaterSupply[c]!, this.compWaterDemand[c]!);
    }
    this.totals = t;
  }

  /**
   * オーバーレイを塗る。道路タイルと建物のフットプリントだけを塗り、
   * 残りは 0（＝供給網の外）にする。田畑や山まで塗ると「どこまで電気が来ているか」が
   * かえって読めなくなる — 見たいのは供給網そのものの形。
   */
  private paintOverlays(world: World, buildings: BuildingStore): void {
    this.powerOverlay.fill(0);
    this.waterOverlay.fill(0);
    for (let i = 0; i < TILE_COUNT; i++) {
      const c = this.compOf[i]!;
      if (c < 0) continue;
      this.powerOverlay[i] = this.compPowerByte[c]!;
      this.waterOverlay[i] = this.compWaterByte[c]!;
    }
    for (let s = 0; s < buildings.high; s++) {
      if (buildings.alive[s] !== 1) continue;
      const comp = this.bComponent[s]!;
      // 1 は「網の中にいるのに落ちている」を表す予約値。0（網の外）と区別できるように
      // しておかないと、停電中の建物と山林が同じ色になる。
      const pv = comp < 0 ? 0 : this.bPowered[s] === 1 ? this.compPowerByte[comp]! : 1;
      const wv = comp < 0 ? 0 : this.bWatered[s] === 1 ? this.compWaterByte[comp]! : 1;
      const a = archetype(buildings.archetypeId[s]!);
      const ox = tileX(buildings.originTile[s]!);
      const oy = tileY(buildings.originTile[s]!);
      for (let dy = 0; dy < a.h; dy++) {
        for (let dx = 0; dx < a.w; dx++) {
          const x = ox + dx;
          const y = oy + dy;
          if (!inBounds(x, y)) continue;
          const tile = idx(x, y);
          this.powerOverlay[tile] = pv;
          this.waterOverlay[tile] = wv;
        }
      }
    }
    world.epochs.overlay++;
  }

  // ---------------- 日次 ----------------

  /**
   * 停電・断水の連続日数を進める。日の境界で 1 回だけ呼ぶこと。
   *
   * すぐに機能停止させないのは、発電所を建て替える一瞬（撤去 → 設置の 1 tick）で
   * 街全体が止まってしまうため。`UTILITY_GRACE_DAYS` 日ぶんの猶予を置くと、
   * 「うっかり」は許され、「放置」だけが罰される。
   * 復旧側のリセットは `recompute` が即座にやるので、ここは増やすだけでよい。
   */
  dailyReview(buildings: BuildingStore): void {
    for (let s = 0; s < buildings.high; s++) {
      if (buildings.alive[s] !== 1) continue;
      if (this.bPowered[s] === 1) this.bPowerOutDays[s] = 0;
      else this.bPowerOutDays[s] = Math.min(65535, this.bPowerOutDays[s]! + 1);
      if (this.bWatered[s] === 1) this.bWaterOutDays[s] = 0;
      else this.bWaterOutDays[s] = Math.min(65535, this.bWaterOutDays[s]! + 1);
    }
    // 機能停止の棟数だけ数え直す（供給そのものは変わっていないので再割り当ては不要）。
    let shutdown = 0;
    this.compShutdown.fill(0, 0, this.componentCount);
    for (let s = 0; s < buildings.high; s++) {
      if (buildings.alive[s] !== 1 || !this.isShutdown(s)) continue;
      shutdown++;
      const comp = this.bComponent[s]!;
      if (comp >= 0) this.compShutdown[comp] = this.compShutdown[comp]! + 1;
    }
    this.totals.shutdown = shutdown;
  }

  // ---------------- 問い合わせ ----------------

  hasPower(slot: number): boolean {
    return slot >= 0 && slot < this.slotCap && this.bPowered[slot] === 1;
  }
  hasWater(slot: number): boolean {
    return slot >= 0 && slot < this.slotCap && this.bWatered[slot] === 1;
  }
  /** 停電・断水が `UTILITY_GRACE_DAYS` 日続いて機能停止しているか。 */
  isShutdown(slot: number): boolean {
    if (slot < 0 || slot >= this.slotCap) return false;
    return this.bPowerOutDays[slot]! >= UTILITY_GRACE_DAYS || this.bWaterOutDays[slot]! >= UTILITY_GRACE_DAYS;
  }
  powerOutageDays(slot: number): number {
    return slot >= 0 && slot < this.slotCap ? this.bPowerOutDays[slot]! : 0;
  }
  waterOutageDays(slot: number): number {
    return slot >= 0 && slot < this.slotCap ? this.bWaterOutDays[slot]! : 0;
  }
  /** 建物が属する道路連結成分。-1 = 接道していない（＝何も届かない）。 */
  componentOfBuilding(slot: number): number {
    return slot >= 0 && slot < this.slotCap ? this.bComponent[slot]! : -1;
  }
  /** タイルの連結成分。道路でないタイルは -1。 */
  componentOfTile(tile: number): number {
    return tile >= 0 && tile < TILE_COUNT ? this.compOf[tile]! : -1;
  }

  /**
   * 未処理の下水がこの建物から出す追加公害。
   *
   * 値の単位は `Archetype.pollution × level` と同じにしてある。`fields.ts` の
   * `updatePollution` は建物ごとに `scratchA[originTile] += pollution * level` を
   * 積んでいるので、その 1 行の隣にこれを足すだけで配線が済む（fields.ts 側で
   *   `scratchA[o] += utilities.sewagePollutionOf(s)`
   * とするだけ。ぼかしと係数はそのまま使える）。
   *
   * 発生源に返しているのは、下水処理場を建てなかった罰が「汚水を出している街区」に
   * 出るほうが読めるから。処理場の場所に集中させると、処理場が無い街では
   * 公害の置き場所が無くなる。
   */
  /**
   * そのタイルの地区に、新しい建物を受け入れる余裕があるか。
   * 需要が供給を超えている地区では成長を止める（`GrowthSystem` から呼ぶ）。
   * 接道していないタイル（連結成分の外）は、成長の可否をここでは判定しない。
   */
  canGrowAt(tile: number): boolean {
    const c = this.componentOfTile(tile);
    if (c < 0) {
      // 道路タイルでない = 建設候補の宅地。隣接する道路の地区で判定する。
      const near = this.nearestComponent(tile);
      if (near < 0) return true;
      return this.componentHasHeadroom(near);
    }
    return this.componentHasHeadroom(c);
  }

  private componentHasHeadroom(c: number): boolean {
    return (
      this.compPowerDemand[c]! <= this.compPowerSupply[c]! && this.compWaterDemand[c]! <= this.compWaterSupply[c]!
    );
  }

  /** 4 近傍に道路があればその地区。無ければ -1。 */
  private nearestComponent(tile: number): number {
    const x = tileX(tile);
    const y = tileY(tile);
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 1 ? 1 : d === 3 ? -1 : 0);
      const ny = y + (d === 0 ? -1 : d === 2 ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const c = this.compOf[idx(nx, ny)]!;
      if (c >= 0) return c;
    }
    return -1;
  }

  sewagePollutionOf(slot: number): number {
    if (slot < 0 || slot >= this.slotCap) return 0;
    const comp = this.bComponent[slot]!;
    // 接道していない建物の下水はどこにも流れない = 全量が未処理。
    const untreated = comp < 0 ? 1 : this.compUntreated[comp]!;
    if (untreated <= 0) return 0;
    return this.bWaterDemand[slot]! * untreated * POLLUTION_PER_UNTREATED_M3;
  }

  // ---------------- 集計 ----------------

  /** 街全体の供給・需要。UI のインフラパネル用。 */
  cityTotals(): UtilityTotals {
    return { ...this.totals };
  }

  /**
   * 連結成分ごとの内訳。道路が分断されている街では、街全体の合計が足りていても
   * 一部の地区だけ停電しうる。それを UI で見せるための入り口。
   * 建物も供給も無い成分（造成しただけの道路）は落とす。
   */
  componentInfos(): ComponentInfo[] {
    const out: ComponentInfo[] = [];
    for (let c = 0; c < this.componentCount; c++) {
      if (this.compBuildings[c] === 0) continue;
      out.push({
        component: c,
        roadTiles: this.compRoadTiles[c]!,
        buildings: this.compBuildings[c]!,
        sampleTile: this.compSampleTile[c]!,
        powerSupplyKw: this.compPowerSupply[c]!,
        powerDemandKw: this.compPowerDemand[c]!,
        waterSupply: this.compWaterSupply[c]!,
        waterDemand: this.compWaterDemand[c]!,
        sewageCapacity: this.compSewageCapacity[c]!,
        sewageDemand: this.compSewageDemand[c]!,
        unpowered: this.compUnpowered[c]!,
        unwatered: this.compUnwatered[c]!,
        shutdown: this.compShutdown[c]!,
      });
    }
    return out;
  }

  // ---------------- セーブ / ロード ----------------

  /**
   * セーブに載せる配列。
   * 連結成分・供給量・需要量・停電フラグはすべて道路と建物から作り直せるので保存しない
   * （保存すると、道路の敷き方を変えた実装に古いセーブを読ませたときに矛盾する）。
   * 作り直せないのは「何日続けて落ちているか」だけ。
   */
  saveArrays(high: number): NamedArray[] {
    this.ensureSlots(high);
    return [
      { name: 'u.powerOutDays', data: this.bPowerOutDays.subarray(0, high) },
      { name: 'u.waterOutDays', data: this.bWaterOutDays.subarray(0, high) },
    ];
  }

  /**
   * セーブから復元する。読み込み直後に `recompute` を呼べば、
   * 供給・需要・停電判定は道路と建物から作り直される。
   * 古いセーブ（この配列が無い版）は 0 のままで、単に「停電歴なし」から始まる。
   */
  restoreArrays(src: Map<string, ArrayBufferView>, high: number): void {
    this.ensureSlots(high);
    const p = src.get('u.powerOutDays');
    if (p) this.bPowerOutDays.set(p as Uint16Array, 0);
    const w = src.get('u.waterOutDays');
    if (w) this.bWaterOutDays.set(w as Uint16Array, 0);
  }

  /** 全状態を捨てる（新規ゲーム・ロード直前）。 */
  reset(): void {
    this.labelVersion = -1;
    this.compOf.fill(-1);
    this.powerOverlay.fill(0);
    this.waterOverlay.fill(0);
    this.componentCount = 0;
    this.bComponent.fill(-1);
    this.bPowered.fill(0);
    this.bWatered.fill(0);
    this.bPowerOutDays.fill(0);
    this.bWaterOutDays.fill(0);
    this.bPowerDemand.fill(0);
    this.bWaterDemand.fill(0);
    this.totals = emptyTotals();
  }

  // ---------------- 内部: 配列の伸長 ----------------

  /**
   * 成分別配列を確保する。成分数は道路の敷き方で決まるので上限が読めない。
   * 倍々で伸ばして、道路を敷くたびに確保し直すのを避ける。
   */
  private ensureComponents(n: number): void {
    if (n <= this.compCap) return;
    let cap = Math.max(64, this.compCap);
    while (cap < n) cap *= 2;
    const gi = (old: Int32Array): Int32Array<ArrayBuffer> => {
      const next = new Int32Array(cap);
      next.set(old);
      return next;
    };
    const gf = (old: Float64Array): Float64Array<ArrayBuffer> => {
      const next = new Float64Array(cap);
      next.set(old);
      return next;
    };
    const gu = (old: Uint8Array): Uint8Array<ArrayBuffer> => {
      const next = new Uint8Array(cap);
      next.set(old);
      return next;
    };
    this.compRoadTiles = gi(this.compRoadTiles);
    this.compSampleTile = gi(this.compSampleTile);
    this.compBuildings = gi(this.compBuildings);
    this.compUnpowered = gi(this.compUnpowered);
    this.compUnwatered = gi(this.compUnwatered);
    this.compShutdown = gi(this.compShutdown);
    this.compPowerSupply = gf(this.compPowerSupply);
    this.compPowerDemand = gf(this.compPowerDemand);
    this.compWaterSupply = gf(this.compWaterSupply);
    this.compWaterDemand = gf(this.compWaterDemand);
    this.compSewageCapacity = gf(this.compSewageCapacity);
    this.compSewageDemand = gf(this.compSewageDemand);
    this.compUsedPower = gf(this.compUsedPower);
    this.compUsedWater = gf(this.compUsedWater);
    this.compCutPower = gu(this.compCutPower);
    this.compCutWater = gu(this.compCutWater);
    this.compUntreated = gf(this.compUntreated);
    this.compPowerByte = gu(this.compPowerByte);
    this.compWaterByte = gu(this.compWaterByte);
    this.compCap = cap;
  }

  /** 建物別配列を `BuildingStore` の容量に合わせる。 */
  private ensureSlots(n: number): void {
    if (n <= this.slotCap) return;
    let cap = Math.max(1024, this.slotCap);
    while (cap < n) cap *= 2;
    const bi = new Int32Array(cap).fill(-1);
    bi.set(this.bComponent);
    this.bComponent = bi;
    const bpd = new Float64Array(cap);
    bpd.set(this.bPowerDemand);
    this.bPowerDemand = bpd;
    const bwd = new Float64Array(cap);
    bwd.set(this.bWaterDemand);
    this.bWaterDemand = bwd;
    const bp = new Uint8Array(cap);
    bp.set(this.bPowered);
    this.bPowered = bp;
    const bw = new Uint8Array(cap);
    bw.set(this.bWatered);
    this.bWatered = bw;
    const bpo = new Uint16Array(cap);
    bpo.set(this.bPowerOutDays);
    this.bPowerOutDays = bpo;
    const bwo = new Uint16Array(cap);
    bwo.set(this.bWaterOutDays);
    this.bWaterOutDays = bwo;
    this.slotCap = cap;
  }
}

/**
 * 供給／需要の比をオーバーレイのバイト値にする。
 * 128 = ちょうど釣り合っている、255 = 2 倍以上の余裕、1 = ほぼ供給なし。
 * 0 は「供給網の外」に予約してあるので返さない。
 */
function ratioByte(supply: number, demand: number): number {
  if (supply <= 0 && demand <= 0) return 0;
  if (demand <= 0) return 255;
  const r = supply / demand;
  return Math.max(1, Math.min(255, Math.round(r * 127.5)));
}
