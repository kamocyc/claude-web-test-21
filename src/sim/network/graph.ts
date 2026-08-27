import { RAIL_SPEED_KMH, SIM_PER_RENDER, TILE_COUNT, TILE_SPAN_M } from '@shared/constants';
import {
  BOARD_PENALTY_MIN,
  DEFAULT_HEADWAY_MIN,
  LINK_TIME_FORGET_TICKS,
  LINK_TIME_LAMBDA,
  MAX_CONGESTION_FACTOR,
  STOP_DWELL_SEC,
  WAIT_WEIGHT,
  WALK_WEIGHT,
} from '@shared/constants';
import {
  Mode,
  ModeBit,
  OneWay,
  MODE_MAX_SPEED_KMH,
  ROAD_SPEED_KMH,
  RoadClass,
  TransitKind,
} from '@shared/enums';
import type { World } from '@sim/world/world';
import { idx, inBounds, tileCenterX, tileCenterZ, tileDistanceM, tileX, tileY } from '@sim/world/tiles';

export const NodeKind = {
  Road: 0,
  Rail: 1,
  Station: 2,
  /**
   * 路線のプラットフォーム。路線 L の停留所 k・向き d ごとに 1 ノード。
   *
   * 路線をまたいで共有しないのが要点。共有すると「同じ駅を通る 2 路線」が
   * 1 つのノードに畳まれ、乗り換えの待ち時間を 1 度も払わずに乗り継げてしまう。
   * 別ノードにしておけば、乗り換えは必ず「降車 → 停留所 → 乗車」を通り、
   * 乗車エッジに載せた待ち時間がもう一度課される。
   */
  Platform: 3,
} as const;

/**
 * `build()` に渡す路線の最小限の記述。運行間隔や混雑は `TransitSystem` の持ち物で、
 * グラフが知る必要があるのは「どの種別が、どの停留所を、どの順に通るか」だけ。
 *
 * この型を transit.ts ではなく graph.ts に置いているのは、逆にすると
 * graph.ts → transit.ts → graph.ts の循環 import になるため。
 */
export interface TransitLineSpec {
  kind: TransitKind;
  /** 停留所のタイル番号。電車なら駅タイル、バスなら道路タイル。 */
  stopTiles: readonly number[];
}

/**
 * 1 路線ぶんの、グラフ上での実体。`build()` に渡した路線と同じ並び・同じ本数で返る。
 *
 * エッジ番号まで返すのは、`TransitSystem` が毎分コストを書き込むため。
 * 毎回 CSR を舐めて「この 2 ノードを結ぶエッジ」を探し直すと、
 * 路線数 × 停留所数 × グラフの次数の走査が毎分入る。
 */
export interface TransitLineNodes {
  /** 実際に停留所として使えた要素の、spec.stopTiles 内での位置。 */
  stopIndex: Int32Array;
  /** 停留所ノード（電車 = 駅ノード、バス = 道路ノードそのもの）。 */
  stopNode: Int32Array;
  /** プラットフォーム・ノード。添字は `dir * stops + k`（dir 0 = 上り、1 = 下り）。 */
  platform: Int32Array;
  /** 乗車エッジ（停留所 → プラットフォーム）。`dir * stops + k`。-1 = 張っていない。 */
  boardEdge: Int32Array;
  /** 乗車中エッジ。`dir * (stops - 1) + j`。j は停留所 j と j+1 の間の区間。 */
  rideEdge: Int32Array;
}

const EMPTY_LINE_NODES: TransitLineNodes = {
  stopIndex: new Int32Array(0),
  stopNode: new Int32Array(0),
  platform: new Int32Array(0),
  boardEdge: new Int32Array(0),
  rideEdge: new Int32Array(0),
};

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
  /** エッジの始点ノード。交通流が交差点を引くのに使う。 */
  edgeFrom = new Uint32Array(0);
  edgeLenM = new Float32Array(0);
  edgeMask = new Uint8Array(0);
  edgeRoadClass = new Uint8Array(0);
  /** 乗降エッジなどの固定コスト（秒）。通常のエッジは 0。 */
  edgeFixedSec = new Float32Array(0);
  /** 自由流の自動車所要時間（秒）。 */
  edgeCarFreeSec = new Float32Array(0);
  /** 混雑を反映し EMA 平滑化した自動車所要時間（秒）。経路探索が読むのはこれだけ。 */
  edgeCarSec = new Float32Array(0);
  /** 交通流シミュレーションが実測したリンク通過時間の EMA（秒）。 */
  edgeObsSec = new Float32Array(0);
  /** 最後に観測した tick。古くなったリンクは自由流へ戻していく。 */
  edgeObsTick = new Int32Array(0);

  /** タイル → 道路ノード。-1 = なし。 */
  roadNodeAt = new Int32Array(TILE_COUNT).fill(-1);
  /** タイル → 線路ノード。 */
  railNodeAt = new Int32Array(TILE_COUNT).fill(-1);
  /** タイル → 駅ノード。 */
  stationNodeAt = new Int32Array(TILE_COUNT).fill(-1);

  /**
   * `build()` に渡した路線ごとのノード・エッジ番号。並びは渡した配列と 1 対 1。
   * 停留所が 2 つ未満に潰れた路線も、添字をずらさないよう空の要素で埋める。
   */
  transitLines: TransitLineNodes[] = [];

  /** このグラフが構築された時点の World.networkVersion。 */
  version = 0;

  /**
   * World のタイル状態からグラフを丸ごと作り直す。
   * 増分更新（セグメント分割・隣接パッチ）はバグの温床になる割に、
   * この規模では線形スキャン 1 回（1ms 未満）に対する利得がない。
   */
  build(world: World, stationTiles: readonly number[], lines: readonly TransitLineSpec[] = []): void {
    this.roadNodeAt.fill(-1);
    this.railNodeAt.fill(-1);
    this.stationNodeAt.fill(-1);
    this.transitLines.length = 0;

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
    // 路線のプラットフォーム。停留所ノードが出揃ってからでないと解決できないので最後に置く。
    const lineStops: { stopNode: number[]; stopTile: number[] }[] = [];
    for (const spec of lines) {
      const stopIndex: number[] = [];
      const stopNode: number[] = [];
      const stopTile: number[] = [];
      for (let k = 0; k < spec.stopTiles.length; k++) {
        const t = spec.stopTiles[k]!;
        // 電車は既存の駅ノードに、バスは道路ノードそのものに着ける。
        // バス停に専用ノードを足さないのは、道路ノードなら周囲の徒歩エッジが
        // 既に張られていて「バス停まで歩く」がそのまま成立するため。
        const nd = spec.kind === TransitKind.Train ? this.stationNodeAt[t]! : this.roadNodeAt[t]!;
        if (nd < 0) continue; // 駅を壊した・道路を剥がした停留所は黙って飛ばす
        if (stopNode.length > 0 && stopNode[stopNode.length - 1] === nd) continue; // 同じ場所の連続を潰す
        stopIndex.push(k);
        stopNode.push(nd);
        stopTile.push(t);
      }
      if (stopNode.length < 2) {
        // 停留所が 1 つ以下では乗っても降りられない。ノードもエッジも作らない。
        this.transitLines.push(EMPTY_LINE_NODES);
        lineStops.push({ stopNode: [], stopTile: [] });
        continue;
      }
      const stops = stopNode.length;
      const platform = new Int32Array(stops * 2);
      for (let d = 0; d < 2; d++) {
        for (let k = 0; k < stops; k++) {
          platform[d * stops + k] = tiles.length;
          tiles.push(stopTile[k]!);
          kinds.push(NodeKind.Platform);
        }
      }
      this.transitLines.push({
        stopIndex: Int32Array.from(stopIndex),
        stopNode: Int32Array.from(stopNode),
        platform,
        boardEdge: new Int32Array(stops * 2).fill(-1),
        rideEdge: new Int32Array((stops - 1) * 2).fill(-1),
      });
      lineStops.push({ stopNode, stopTile });
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

    /** @returns 登録順の仮番号。CSR に詰め替えたあとの本番の番号は perm で引く。 */
    const addEdge = (a: number, b: number, length: number, m: number, rc: number, fixed: number): number => {
      from.push(a);
      to.push(b);
      lenM.push(length);
      mask.push(m);
      rclass.push(rc);
      fixedSec.push(fixed);
      return from.length - 1;
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
        // 一方通行は「タイルから出る向き」で判定する。
        //
        // 禁じるのは**逆走だけ**にする（i の指定向きの真逆に出るのを塞ぐ）。
        // 「出る向きが指定と一致するときだけ通す」という条件にすると、
        // 一方通行の途中から脇道へ曲がることまで塞がれて、
        // 入ったら最後まで抜けられない道になる。
        // 徒歩と自転車は常に双方向（歩行者に一方通行はない）。
        const walkBits = ModeBit.Walk | ModeBit.Bike;
        const dirForward = dx === 1 ? OneWay.East : OneWay.South;
        const dirBack = dx === 1 ? OneWay.West : OneWay.North;
        const carAB = world.oneWay[i]! === dirBack ? 0 : ModeBit.Car;
        const carBA = world.oneWay[j]! === dirForward ? 0 : ModeBit.Car;
        addEdge(a, b, TILE_SPAN_M, walkBits | carAB, rc, 0);
        addEdge(b, a, TILE_SPAN_M, walkBits | carBA, rc, 0);
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
        addEdge(a, b, TILE_SPAN_M, ModeBit.Rail, 0, 0);
        addEdge(b, a, TILE_SPAN_M, ModeBit.Rail, 0, 0);
      }
    }

    // 駅: 街路 ↔ コンコース（徒歩）。
    //
    // 以前はここから線路ノードへ直接 Board エッジを張っていたが、
    // 乗車は路線のプラットフォームを経由するようになったので落とした。
    // 残しておくと「駅で線路に乗って、2 タイル先の別の駅で降りる」という、
    // 運行間隔も区間所要も払わない抜け道が経路探索に見えてしまう。
    for (const st of stationTiles) {
      const s = this.stationNodeAt[st]!;
      if (s < 0) continue;
      const x = tileX(st);
      const y = tileY(st);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!inBounds(x + dx, y + dy)) continue;
          const j = idx(x + dx, y + dy);
          const r = this.roadNodeAt[j]!;
          if (r < 0) continue;
          const d = Math.hypot(dx, dy) * TILE_SPAN_M;
          addEdge(r, s, d, ModeBit.Walk, 0, 0);
          addEdge(s, r, d, ModeBit.Walk, 0, 0);
        }
      }
    }

    // 路線: 乗車（停留所 → ホーム）・乗車中（ホーム → 次のホーム）・降車（ホーム → 停留所）。
    //
    // ここで入れるコストはあくまで初期値で、運行間隔・混雑・渋滞を織り込んだ本物は
    // `TransitSystem.updateCosts()` が `edgeFixedSec` に上書きする。
    // それでも 0 で置かないのは、TransitSystem を繋がずにグラフだけ作った場合に
    // 「乗れば無料で瞬間移動できる」経路が生まれるのを防ぐため。
    // 初期値は必ず「距離 ÷ 鉄道の表定速度」以上にしてある。これを下回ると
    // A* のヒューリスティックが非許容になり、最短でない経路を黙って返し始める。
    const seedBoardSec = (BOARD_PENALTY_MIN + (DEFAULT_HEADWAY_MIN / 2) * WAIT_WEIGHT) * 60;
    const alightSec = BOARD_PENALTY_MIN * 60;
    for (let li = 0; li < lines.length; li++) {
      const nodes = this.transitLines[li]!;
      const stopNode = lineStops[li]!.stopNode;
      const stopTile = lineStops[li]!.stopTile;
      const stops = stopNode.length;
      if (stops < 2) continue;
      for (let d = 0; d < 2; d++) {
        for (let k = 0; k < stops; k++) {
          const p = nodes.platform[d * stops + k]!;
          const sn = stopNode[k]!;
          // 上りの終点・下りの起点で乗ってもどこにも行けないので、乗車エッジを張らない。
          // 張ると A* が必ず 1 回は展開する無駄なノードになる。
          const isTerminal = d === 0 ? k === stops - 1 : k === 0;
          if (!isTerminal) nodes.boardEdge[d * stops + k] = addEdge(sn, p, 0, ModeBit.Board, 0, seedBoardSec);
          // 逆に、その向きで一度も乗れない停留所では降りようがない。
          const isOrigin = d === 0 ? k === 0 : k === stops - 1;
          if (!isOrigin) addEdge(p, sn, 0, ModeBit.Board, 0, alightSec);
        }
        for (let j = 0; j < stops - 1; j++) {
          // 上りは j → j+1、下りは j+1 → j。区間そのものは共通なので添字 j を共有する。
          const a = d === 0 ? nodes.platform[j]! : nodes.platform[stops + j + 1]!;
          const b = d === 0 ? nodes.platform[j + 1]! : nodes.platform[stops + j]!;
          const len = tileDistanceM(stopTile[j]!, stopTile[j + 1]!);
          nodes.rideEdge[d * (stops - 1) + j] = addEdge(a, b, len, ModeBit.Ride, 0, len / RAIL_MS + STOP_DWELL_SEC);
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
    // 登録順 → CSR 上の番号。路線が抱えているエッジ番号を貼り替えるのに使う。
    const perm = new Int32Array(m);
    this.edgeTo = new Uint32Array(m);
    this.edgeLenM = new Float32Array(m);
    this.edgeMask = new Uint8Array(m);
    this.edgeRoadClass = new Uint8Array(m);
    this.edgeFixedSec = new Float32Array(m);
    this.edgeCarFreeSec = new Float32Array(m);
    this.edgeCarSec = new Float32Array(m);
    this.edgeObsSec = new Float32Array(m);
    this.edgeObsTick = new Int32Array(m).fill(-1 << 20);
    this.edgeFrom = new Uint32Array(m);

    for (let e = 0; e < m; e++) {
      const a = from[e]!;
      const slot = this.edgeStart[a]! + cursor[a]!;
      cursor[a] = cursor[a]! + 1;
      perm[e] = slot;
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
      this.edgeObsSec[slot] = carSec;
      this.edgeFrom[slot] = a;
    }

    for (const nodes of this.transitLines) {
      for (let k = 0; k < nodes.boardEdge.length; k++) {
        const e = nodes.boardEdge[k]!;
        if (e >= 0) nodes.boardEdge[k] = perm[e]!;
      }
      for (let k = 0; k < nodes.rideEdge.length; k++) {
        const e = nodes.rideEdge[k]!;
        if (e >= 0) nodes.rideEdge[k] = perm[e]!;
      }
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
    // 乗降エッジと乗車中エッジは、どちらも `TransitSystem` が書き込んだ固定コストを
    // そのまま返すだけ。運行間隔・混雑・区間の実所要はすべて向こうで計算済みで、
    // ここで路線の状態を参照し始めるとグラフが交通手段のモデルを持ってしまう。
    if (bits & (ModeBit.Board | ModeBit.Ride)) return this.edgeFixedSec[edge]!;
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
      case Mode.Transit:
        if (bits & ModeBit.Rail) return len / RAIL_MS;
        return (len / WALK_MS) * WALK_WEIGHT; // アクセス・イグレスの徒歩
      default:
        return len / WALK_MS;
    }
  }

  /**
   * ノード間の直線距離（シミュレーション上の実距離 m）。A* のヒューリスティックに使う。
   *
   * nodeX/nodeZ は描画単位なので、必ず SIM_PER_RENDER を掛けて実距離に直すこと。
   * ここを掛け忘れるとヒューリスティックが実コストより小さくなりすぎて、
   * A* が「黙って」最短でない経路を返す。症状は「車が変な道を通る」だけで、
   * 目視では追えない。test/pathfinding.test.ts の
   * 「A* の結果がダイクストラと一致する」が唯一の検出手段になっている。
   */
  straightLineM(a: number, b: number): number {
    const dx = this.nodeX[a]! - this.nodeX[b]!;
    const dz = this.nodeZ[a]! - this.nodeZ[b]!;
    return Math.sqrt(dx * dx + dz * dz) * SIM_PER_RENDER;
  }

  /**
   * 交通流シミュレーションが観測したリンク通過時間を取り込む。
   *
   * 混雑を「交通量 → BPR の式」で推定するのをやめ、実際に走った車の
   * 所要時間そのものを使う。信号待ちも spillback も、この 1 つの数字に入る。
   */
  observeTraversal(edge: number, sec: number, tick: number): void {
    const t0 = this.edgeCarFreeSec[edge]!;
    if (t0 <= 0) return;
    const capped = Math.min(sec, t0 * MAX_CONGESTION_FACTOR);
    const prev = this.edgeObsSec[edge]!;
    this.edgeObsSec[edge] = prev + LINK_TIME_LAMBDA * (capped - prev);
    this.edgeObsTick[edge] = tick;
  }

  /**
   * 実測を経路探索用のコストへ流し込む（EMA 平滑化つき）。
   *
   * 平滑化なしだと「混む → 全員迂回 → 迂回路が混む」の発振が確実に起きる。
   * しばらく車が通っていないリンクは自由流へ戻す。そうしないと、
   * 一度混んだ道が誰も通らなくなったまま「混んでいる」と記録され続ける。
   */
  relaxLinkTimes(tick: number, lambda: number): void {
    const m = this.edgeCount;
    for (let e = 0; e < m; e++) {
      const rc = this.edgeRoadClass[e]!;
      if (rc === RoadClass.None) continue;
      const t0 = this.edgeCarFreeSec[e]!;
      const stale = tick - this.edgeObsTick[e]! > LINK_TIME_FORGET_TICKS;
      const target = stale ? t0 : this.edgeObsSec[e]!;
      const cur = this.edgeCarSec[e]!;
      this.edgeCarSec[e] = cur + lambda * (target - cur);
    }
  }

  /** 逆向きのエッジ。道路は必ず双方向なので、往路から復路を作るのに使える。-1 = なし。 */
  reverseEdge(edge: number): number {
    const a = this.edgeFrom[edge]!;
    const b = this.edgeTo[edge]!;
    const s0 = this.edgeStart[b]!;
    const s1 = this.edgeStart[b + 1]!;
    for (let k = s0; k < s1; k++) {
      if (this.edgeTo[k] === a) return k;
    }
    return -1;
  }

  /** 自由流に対する遅延倍率。1 = 空いている。 */
  delayFactor(edge: number): number {
    const t0 = this.edgeCarFreeSec[edge]!;
    return t0 > 0 ? this.edgeCarSec[edge]! / t0 : 1;
  }
}
