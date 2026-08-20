import { CHUNK_COUNT, MAP_H, MAP_W, TILE_COUNT } from '@shared/constants';
import { OneWay, RoadClass, Terrain, Zone } from '@shared/enums';
import { type Epochs, EventRing, newEpochs } from '@sim/core/events';
import { generateTerrain } from './terrainGen';
import { chunkOf, idx, inBounds, neighbor } from './tiles';

/**
 * ワールドの全タイル状態の唯一の保持者。すべて SoA の TypedArray。
 *
 * オブジェクト配列にしない理由は具体的で、地価・公害の拡散と成長スキャンが
 * 数万タイルを定期的に舐めるから。Uint8Array 上の分離可能ブラーは数百 MB/s で回るが、
 * 同じことをオブジェクトのプロパティでやると 20〜50 倍遅く、GC 圧も生む。
 */
export class World {
  readonly terrain: Uint8Array;
  readonly heightDm: Uint16Array;
  readonly slope: Uint8Array;
  readonly waterAccess: Uint8Array;

  readonly zone = new Uint8Array(TILE_COUNT);
  readonly road = new Uint8Array(TILE_COUNT);
  /**
   * 一方通行の向き（`OneWay`）。0 = 双方向。
   * 車だけに効かせる — 徒歩と自転車は逆向きにも通す。
   */
  readonly oneWay = new Uint8Array(TILE_COUNT);
  readonly rail = new Uint8Array(TILE_COUNT);
  /** 建物 ID + 1（0 = 建物なし）。フットプリント内の全タイルが同じ値を持つ。 */
  readonly buildingRef = new Uint32Array(TILE_COUNT);

  readonly landValue = new Uint8Array(TILE_COUNT);
  readonly pollution = new Uint8Array(TILE_COUNT);
  readonly noise = new Uint8Array(TILE_COUNT);
  /** 公共サービスの到達（Service のビットマスク）。 */
  readonly svcMask = new Uint16Array(TILE_COUNT);
  /** 最寄り駅までの徒歩分。255 = 圏外。 */
  readonly transitAccess = new Uint8Array(TILE_COUNT).fill(255);

  readonly chunkEpoch = new Uint32Array(CHUNK_COUNT);
  readonly epochs: Epochs = newEpochs();
  readonly events = new EventRing();

  /** 道路グラフのバージョン。道路・線路・駅の編集で必ず増える。 */
  networkVersion = 1;

  constructor(seed: number) {
    const t = generateTerrain(seed);
    this.terrain = t.terrain;
    this.heightDm = t.heightDm;
    this.slope = t.slope;
    this.waterAccess = t.waterAccess;
  }

  // ---------- 建設可能性 ----------

  /** 道路を敷けるか。海・河川・山地・急斜面は不可。 */
  canBuildRoad(i: number): boolean {
    const t = this.terrain[i]!;
    if (t === Terrain.Sea || t === Terrain.Freshwater || t === Terrain.Mountain) return false;
    return this.slope[i]! < 90;
  }

  /**
   * 線路を敷けるか。道路より寛容（トンネル・高架の抽象）。
   * 道路のあるタイルにも敷ける = 踏切。
   */
  canBuildRail(i: number): boolean {
    const t = this.terrain[i]!;
    if (t === Terrain.Sea) return false;
    if (this.buildingRef[i] !== 0) return false;
    return this.slope[i]! < 140;
  }

  /** 踏切（道路と線路が交差しているタイル）か。描画で使う。 */
  isLevelCrossing(i: number): boolean {
    return this.road[i] !== RoadClass.None && this.rail[i] !== 0;
  }

  /** 建物が建てられる地面か。 */
  canBuildStructure(i: number): boolean {
    const t = this.terrain[i]!;
    if (t === Terrain.Sea || t === Terrain.Freshwater || t === Terrain.Mountain) return false;
    if (this.road[i] !== RoadClass.None || this.rail[i] !== 0) return false;
    if (this.buildingRef[i] !== 0) return false;
    return this.slope[i]! < 45;
  }

  /** そのゾーン種別をそのタイルに指定できるか（地形的な制約）。 */
  canZone(i: number, zone: Zone): boolean {
    const t = this.terrain[i]!;
    if (t === Terrain.Sea || t === Terrain.Freshwater || t === Terrain.Mountain) return false;
    if (this.road[i] !== RoadClass.None || this.rail[i] !== 0) return false;
    switch (zone) {
      case Zone.AgriPaddy:
        // 水田は低湿地（河川の氾濫原・海岸の沖積平野）に限る。
        return t === Terrain.Lowland && this.slope[i]! < 22;
      case Zone.AgriField:
        return t !== Terrain.Forest && this.slope[i]! < 50;
      case Zone.Forestry:
        return t === Terrain.Forest;
      default:
        return this.slope[i]! < 45;
    }
  }

  // ---------- 変更（すべてダーティ通知を伴う） ----------

  markDirty(i: number): void {
    const c = chunkOf(i);
    this.chunkEpoch[c] = (this.chunkEpoch[c]! + 1) >>> 0;
    this.events.push({ t: 'chunkDirty', chunk: c });
  }

  setZone(i: number, zone: Zone): boolean {
    if (zone !== Zone.None && !this.canZone(i, zone)) return false;
    if (this.zone[i] === zone) return false;
    this.zone[i] = zone;
    this.epochs.zoning++;
    this.markDirty(i);
    return true;
  }

  setRoad(i: number, cls: RoadClass): boolean {
    if (cls !== RoadClass.None && !this.canBuildRoad(i)) return false;
    if (this.road[i] === cls) return false;
    // 道路は建物・ゾーンを上書きする（撤去は呼び出し側が建物を消してから呼ぶ）。
    // 線路とは共存する = 踏切。これを禁じると鉄道が道路グリッドで寸断され、
    // 路線がつながらなくなる。
    this.road[i] = cls;
    if (cls !== RoadClass.None) this.zone[i] = Zone.None;
    // 道路を消したら一方通行も消す。残すと、あとで敷き直したときに
    // 見えない一方通行が復活して「なぜか車が来ない道」になる。
    else this.oneWay[i] = OneWay.None;
    this.epochs.roads++;
    this.networkVersion++;
    this.markDirty(i);
    // 接続形状が変わるので隣接タイルも再構築対象にする。
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && this.road[nb] !== RoadClass.None) this.markDirty(nb);
    }
    return true;
  }

  /**
   * 一方通行の向きを設定する。道路のないタイルには付かない。
   * 交通グラフの張り方が変わるので `networkVersion` を進める。
   */
  setOneWay(i: number, dir: number): boolean {
    if (this.road[i] === RoadClass.None) dir = OneWay.None;
    if (this.oneWay[i] === dir) return false;
    this.oneWay[i] = dir;
    this.epochs.roads++;
    this.networkVersion++;
    this.markDirty(i);
    return true;
  }

  setRail(i: number, on: boolean): boolean {
    const v = on ? 1 : 0;
    if (on && !this.canBuildRail(i)) return false;
    if (this.rail[i] === v) return false;
    this.rail[i] = v;
    if (on) this.zone[i] = Zone.None; // 道路は残す（踏切）
    this.epochs.rail++;
    this.networkVersion++;
    this.markDirty(i);
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && this.rail[nb] !== 0) this.markDirty(nb);
    }
    return true;
  }

  /** 道路の接続ビットマスク（北=1, 東=2, 南=4, 西=8）。描画とグラフ構築で使う。 */
  roadConn(i: number): number {
    if (this.road[i] === RoadClass.None) return 0;
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && this.road[nb] !== RoadClass.None) m |= 1 << d;
    }
    return m;
  }

  railConn(i: number): number {
    if (this.rail[i] === 0) return 0;
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && this.rail[nb] !== 0) m |= 1 << d;
    }
    return m;
  }

  /** 道路の次数（接続本数）。交差点・行き止まりの判定に使う。 */
  roadDegree(i: number): number {
    const m = this.roadConn(i);
    return ((m >> 0) & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
  }

  /** タイルが道路に接しているか。 */
  isAdjacentToRoad(i: number): boolean {
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && this.road[nb] !== RoadClass.None) return true;
    }
    return false;
  }

  /** 半径内で最も近い道路タイル。見つからなければ -1。 */
  nearestRoadTile(i: number, radius: number): number {
    const x0 = i % MAP_W;
    const y0 = (i / MAP_W) | 0;
    let best = -1;
    let bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (!inBounds(x, y)) continue;
        const j = idx(x, y);
        if (this.road[j] === RoadClass.None) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
    }
    return best;
  }

  /** タイル座標がマップ内かつ有効か。 */
  static valid(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
  }
}
