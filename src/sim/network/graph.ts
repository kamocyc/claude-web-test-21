import { RAIL_SPEED_KMH, TILE_COUNT, TILE_M } from '@shared/constants';
import {
  BOARD_PENALTY_MIN,
  DEFAULT_HEADWAY_MIN,
  MAX_CONGESTION_FACTOR,
  BPR_BETA,
  WAIT_WEIGHT,
  WALK_WEIGHT,
} from '@shared/constants';
import {
  Mode,
  ModeBit,
  MODE_MAX_SPEED_KMH,
  ROAD_BPR_ALPHA,
  ROAD_CAPACITY_VPH,
  ROAD_SPEED_KMH,
  RoadClass,
} from '@shared/enums';
import type { World } from '@sim/world/world';
import { idx, inBounds, tileCenterX, tileCenterZ, tileX, tileY } from '@sim/world/tiles';

export const NodeKind = {
  Road: 0,
  Rail: 1,
  Station: 2,
} as const;

const KMH_TO_MS = 1000 / 3600;
const WALK_MS = MODE_MAX_SPEED_KMH[Mode.Walk]! * KMH_TO_MS;
const BIKE_MS = MODE_MAX_SPEED_KMH[Mode.Bike]! * KMH_TO_MS;
const RAIL_MS = RAIL_SPEED_KMH * KMH_TO_MS;

/**
 * マルチモーダル交通グラフ。CSR（圧縮行格納）の TypedArray で保持する。
 *
 * ノードは道路タイル・線路タイル・駅に 1 対 1 で対応させている。
 * セグメント縮約（次数 2 のタイルを畳む）を採らなかったのは、この規模
 * （道路 5000 タイル前後、1 tick あたりの実 A* が数本）では探索予算に十分収まり、
 * 建物の接道点がタイル単位で正確に取れる利点の方が大きいため。
 * 10 万人規模に伸ばす場合はここが最初の最適化対象になる。
 */
export class Graph {
  nodeCount = 0;
  edgeCount = 0;

  nodeTile = new Uint32Array(0);
  nodeKind = new Uint8Array(0);
  nodeX = new Float32Array(0);
  nodeZ = new Float32Array(0);

  /** CSR: node i の出辺は [edgeStart[i], edgeStart[i+1]) */
  edgeStart = new Uint32Array(1);
  edgeTo = new Uint32Array(0);
  edgeLenM = new Float32Array(0);
  edgeMask = new Uint8Array(0);
  edgeRoadClass = new Uint8Array(0);
  /** 乗降エッジなどの固定コスト（秒）。通常のエッジは 0。 */
  edgeFixedSec = new Float32Array(0);
  /** 自由流の自動車所要時間（秒）。 */
  edgeCarFreeSec = new Float32Array(0);
  /** 混雑を反映し EMA 平滑化した自動車所要時間（秒）。経路探索が読むのはこれだけ。 */
  edgeCarSec = new Float32Array(0);
  /** 直近の交通量（台/時 相当、指数減衰）。 */
  edgeVolume = new Float32Array(0);
  /** 逆向きエッジの index。交通量を双方向で見るために使う。-1 = なし。 */
  edgeReverse = new Int32Array(0);

  /** タイル → 道路ノード。-1 = なし。 */
  roadNodeAt = new Int32Array(TILE_COUNT).fill(-1);
  /** タイル → 線路ノード。 */
  railNodeAt = new Int32Array(TILE_COUNT).fill(-1);
  /** タイル → 駅ノード。 */
  stationNodeAt = new Int32Array(TILE_COUNT).fill(-1);

  /** このグラフが構築された時点の World.networkVersion。 */
  version = 0;

  /**
   * World のタイル状態からグラフを丸ごと作り直す。
   * 増分更新（セグメント分割・隣接パッチ）はバグの温床になる割に、
   * この規模では線形スキャン 1 回（1ms 未満）に対する利得がない。
   */
  build(world: World, stationTiles: readonly number[], headwayMin = DEFAULT_HEADWAY_MIN): void {
    this.roadNodeAt.fill(-1);
    this.railNodeAt.fill(-1);
    this.stationNodeAt.fill(-1);

    // --- ノードの割り当て ---
    const tiles: number[] = [];
    const kinds: number[] = [];
    for (let i = 0; i < TILE_COUNT; i++) {
      if (world.road[i] !== RoadClass.None) {
        this.roadNodeAt[i] = tiles.length;
        tiles.push(i);
        kinds.push(NodeKind.Road);
      }
    }
    for (let i = 0; i < TILE_COUNT; i++) {
      if (world.rail[i] !== 0) {
        this.railNodeAt[i] = tiles.length;
        tiles.push(i);
        kinds.push(NodeKind.Rail);
      }
    }
    for (const st of stationTiles) {
      if (this.stationNodeAt[st] !== -1) continue;
      this.stationNodeAt[st] = tiles.length;
      tiles.push(st);
      kinds.push(NodeKind.Station);
    }

    const n = tiles.length;
    this.nodeCount = n;
    this.nodeTile = new Uint32Array(n);
    this.nodeKind = new Uint8Array(n);
    this.nodeX = new Float32Array(n);
    this.nodeZ = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = tiles[k]!;
      this.nodeTile[k] = t;
      this.nodeKind[k] = kinds[k]!;
      this.nodeX[k] = tileCenterX(t);
      this.nodeZ[k] = tileCenterZ(t);
    }

    // --- 有向エッジの列挙 ---
    const from: number[] = [];
    const to: number[] = [];
    const lenM: number[] = [];
    const mask: number[] = [];
    const rclass: number[] = [];
    const fixedSec: number[] = [];

    const addEdge = (a: number, b: number, length: number, m: number, rc: number, fixed: number): void => {
      from.push(a);
      to.push(b);
      lenM.push(length);
      mask.push(m);
      rclass.push(rc);
      fixedSec.push(fixed);
    };

    // 道路: 隣接タイル間を双方向で結ぶ。徒歩・自転車・自動車が共有する。
    for (let i = 0; i < TILE_COUNT; i++) {
      const a = this.roadNodeAt[i]!;
      if (a < 0) continue;
      const x = tileX(i);
      const y = tileY(i);
      // 東と南だけ見て両方向を張れば、各ペアを 1 度ずつ処理できる。
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        if (!inBounds(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        const b = this.roadNodeAt[j]!;
        if (b < 0) continue;
        const rc = Math.min(world.road[i]!, world.road[j]!);
        addEdge(a, b, TILE_M, ModeBit.Walk | ModeBit.Bike | ModeBit.Car, rc, 0);
        addEdge(b, a, TILE_M, ModeBit.Walk | ModeBit.Bike | ModeBit.Car, rc, 0);
      }
    }

    // 線路: 隣接タイル間。鉄道モード専用。
    for (let i = 0; i < TILE_COUNT; i++) {
      const a = this.railNodeAt[i]!;
      if (a < 0) continue;
      const x = tileX(i);
      const y = tileY(i);
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        if (!inBounds(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        const b = this.railNodeAt[j]!;
        if (b < 0) continue;
        addEdge(a, b, TILE_M, ModeBit.Rail, 0, 0);
        addEdge(b, a, TILE_M, ModeBit.Rail, 0, 0);
      }
    }

    // 駅: 街路 ↔ コンコース（徒歩）、コンコース ↔ ホーム（乗降）。
    // 乗車側に「運行間隔/2 × 待ち時間重み ＋ 乗車ペナルティ」を載せることで、
    // 乗換の体感的な重さが自動的に正しく値付けされる。
    const boardSec = (BOARD_PENALTY_MIN + (headwayMin / 2) * WAIT_WEIGHT) * 60;
    const alightSec = BOARD_PENALTY_MIN * 60;
    for (const st of stationTiles) {
      const s = this.stationNodeAt[st]!;
      if (s < 0) continue;
      const x = tileX(st);
      const y = tileY(st);
      // 周囲 2 タイルの道路ノードへ徒歩接続
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!inBounds(x + dx, y + dy)) continue;
          const j = idx(x + dx, y + dy);
          const r = this.roadNodeAt[j]!;
          if (r < 0) continue;
          const d = Math.hypot(dx, dy) * TILE_M;
          addEdge(r, s, d, ModeBit.Walk, 0, 0);
          addEdge(s, r, d, ModeBit.Walk, 0, 0);
        }
      }
      // 周囲 2 タイルの線路ノードへ乗降接続
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!inBounds(x + dx, y + dy)) continue;
          const j = idx(x + dx, y + dy);
          const rn = this.railNodeAt[j]!;
          if (rn < 0) continue;
          addEdge(s, rn, 0, ModeBit.Board, 0, boardSec);
          addEdge(rn, s, 0, ModeBit.Board, 0, alightSec);
        }
      }
    }

    // --- CSR に詰める ---
    const m = from.length;
    this.edgeCount = m;
    const counts = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) {
      const slot = from[e]! + 1;
      counts[slot] = counts[slot]! + 1;
    }
    for (let k = 0; k < n; k++) counts[k + 1] = counts[k + 1]! + counts[k]!;
    this.edgeStart = counts;

    const cursor = new Uint32Array(n);
    this.edgeTo = new Uint32Array(m);
    this.edgeLenM = new Float32Array(m);
    this.edgeMask = new Uint8Array(m);
    this.edgeRoadClass = new Uint8Array(m);
    this.edgeFixedSec = new Float32Array(m);
    this.edgeCarFreeSec = new Float32Array(m);
    this.edgeCarSec = new Float32Array(m);
    this.edgeVolume = new Float32Array(m);
    this.edgeReverse = new Int32Array(m).fill(-1);

    /** CSR 上のエッジ index を (from,to) から引くための一時マップ。 */
    const edgeLookup = new Map<number, number>();

    for (let e = 0; e < m; e++) {
      const a = from[e]!;
      const slot = this.edgeStart[a]! + cursor[a]!;
      cursor[a] = cursor[a]! + 1;
      const b = to[e]!;
      this.edgeTo[slot] = b;
      this.edgeLenM[slot] = lenM[e]!;
      this.edgeMask[slot] = mask[e]!;
      this.edgeRoadClass[slot] = rclass[e]!;
      this.edgeFixedSec[slot] = fixedSec[e]!;
      const rc = rclass[e]!;
      const speed = rc > 0 ? ROAD_SPEED_KMH[rc]! * KMH_TO_MS : 0;
      const carSec = speed > 0 ? lenM[e]! / speed : 0;
      this.edgeCarFreeSec[slot] = carSec;
      this.edgeCarSec[slot] = carSec;
      edgeLookup.set(a * n + b, slot);
    }

    for (let e = 0; e < m; e++) {
      const a = from[e]!;
      const b = to[e]!;
      const slot = edgeLookup.get(a * n + b);
      const rev = edgeLookup.get(b * n + a);
      if (slot !== undefined && rev !== undefined) this.edgeReverse[slot] = rev;
    }

    this.version = world.networkVersion;
  }

  /** エッジがそのモードで通行可能か。 */
  passable(edge: number, modeMask: number): boolean {
    return (this.edgeMask[edge]! & modeMask) !== 0;
  }

  /**
   * エッジの所要「体感秒」。経路探索が読むコストはここに一本化する。
   * 自動車だけが平滑化済みの混雑コストを読む点が重要（§渋滞フィードバック）。
   */
  edgeCost(edge: number, mode: Mode): number {
    const bits = this.edgeMask[edge]!;
    if (bits & ModeBit.Board) return this.edgeFixedSec[edge]!;
    const len = this.edgeLenM[edge]!;
    switch (mode) {
      case Mode.Walk:
        return (len / WALK_MS) * WALK_WEIGHT;
      case Mode.Bike:
        // 自転車で歩道区間を押して歩く場合も考慮し、自転車不可なら徒歩速度。
        return bits & ModeBit.Bike ? len / BIKE_MS : (len / WALK_MS) * WALK_WEIGHT;
      case Mode.Car:
        if (bits & ModeBit.Car) return this.edgeCarSec[edge]!;
        return (len / WALK_MS) * WALK_WEIGHT; // 端点の徒歩区間
      case Mode.Rail:
        if (bits & ModeBit.Rail) return len / RAIL_MS;
        return (len / WALK_MS) * WALK_WEIGHT; // アクセス・イグレスの徒歩
      default:
        return len / WALK_MS;
    }
  }

  /** ノード間の直線距離 (m)。A* のヒューリスティックに使う。 */
  straightLineM(a: number, b: number): number {
    const dx = this.nodeX[a]! - this.nodeX[b]!;
    const dz = this.nodeZ[a]! - this.nodeZ[b]!;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * BPR による混雑コストの更新（EMA 平滑化つき）。
   *
   *   t = t0 * (1 + α (V/C)^β)          … 標準的な道路交通の遅延関数
   *   cost ← cost + λ (t - cost)        … MSA/day-to-day 配分に相当する平滑化
   *
   * 平滑化なしだと「混む→全員迂回→迂回路が混む」の発振が確実に起きる。
   */
  updateCongestion(lambda: number, volumeDecay: number): void {
    const m = this.edgeCount;
    for (let e = 0; e < m; e++) {
      const rc = this.edgeRoadClass[e]!;
      if (rc === RoadClass.None) continue;
      // 交通量の指数減衰（直近 1 時間の移動平均に相当）
      const v = this.edgeVolume[e]! * (1 - volumeDecay);
      this.edgeVolume[e] = v;
      const cap = ROAD_CAPACITY_VPH[rc]!;
      const alpha = ROAD_BPR_ALPHA[rc]!;
      const t0 = this.edgeCarFreeSec[e]!;
      const ratio = cap > 0 ? v / cap : 0;
      let factor = 1 + alpha * Math.pow(ratio, BPR_BETA);
      if (factor > MAX_CONGESTION_FACTOR) factor = MAX_CONGESTION_FACTOR; // 無限大コストで A* のヒープを壊さない
      const target = t0 * factor;
      this.edgeCarSec[e] = this.edgeCarSec[e]! + lambda * (target - this.edgeCarSec[e]!);
    }
  }

  /** 車両 1 台がエッジを通過したことを記録する。 */
  recordTraversal(edge: number, weight = 1): void {
    // volumeDecay = 1/60 で減衰させているので、1 台 = 60 台/時 相当の寄与になる。
    this.edgeVolume[edge] = this.edgeVolume[edge]! + weight * 60;
  }

  /** 混雑度 0..1（描画オーバーレイ用）。 */
  congestionRatio(edge: number): number {
    const rc = this.edgeRoadClass[edge]!;
    if (rc === RoadClass.None) return 0;
    const cap = ROAD_CAPACITY_VPH[rc]!;
    return cap > 0 ? Math.min(1, this.edgeVolume[edge]! / cap) : 0;
  }
}
