import {
  BUS_PLATOON_EQUIV,
  GRIDLOCK_RELIEF_STEPS,
  MAX_TRIP_TICKS,
  VEHICLES_PER_LANE,
  SATURATION_VPH_PER_LANE,
  SIGNAL_CYCLE_STEPS,
  SIGNAL_MAJOR_GREEN_STEPS,
  SIGNAL_MIN_DEGREE,
  TICKS_PER_DAY,
  TILE_SPAN_M,
  TRAFFIC_STEP_SEC,
  TRAFFIC_SUBSTEPS_PER_TICK,
  TRUCK_PLATOON_EQUIV,
  VEHICLE_LENGTH_M,
  VEHICLE_PLATOON,
} from '@shared/constants';
import { DRAWN_LANES, Mode, ROAD_LANES, RoadClass } from '@shared/enums';
import { tileX, tileY } from '@sim/world/tiles';
import { curvePointOnNodes, segmentLength } from './curve';
import type { Graph } from './graph';
import type { Path, PathPose } from './pathfinder';

/**
 * 車両交通流のシミュレーション（リンク待ち行列モデル）。
 *
 * BPR のような「交通量からまとめて所要時間を推定する」集計モデルではなく、
 * 車両 1 台ずつが道路上の場所を占め、前の車を追い越せず、交差点の信号で止まる。
 * 渋滞はその結果として出る。所要時間は予測せず、着いたときが到着時刻になる。
 *
 * モデルの骨格（メゾスコピック。MATSim と同系統）:
 *
 *   - 有向リンクごとに FIFO の待ち行列を持つ
 *   - リンクに入った車は、まず自由流時間だけ必ずかかる（追い越し不可）
 *   - 先頭の車は「飽和交通流率」「下流の信号が青」「次のリンクに空きがある」の
 *     3 つを満たしたときだけ次のリンクへ出る
 *   - 次のリンクが満杯なら出られない。これが上流へ伸びる渋滞（spillback）になる
 *
 * 1 台が実車およそ 9 台の車列を表す（VEHICLE_PLATOON のコメントを参照）。
 * 地図が 1/15 縮尺であることと、人口が実市街地より桁で少ないことを、
 * この 1 個の係数にまとめてある。
 */

export const VehicleKind = {
  Car: 0,
  Truck: 1,
  /**
   * 路線バス。**乗用車と同じ待ち行列に載せるのがこの種別を足した理由**で、
   * バスは信号でも止まるし、前が詰まれば動けない。
   * 電車は専用軌道なのでここには一切現れない。
   */
  Bus: 2,
} as const;
export type VehicleKind = (typeof VehicleKind)[keyof typeof VehicleKind];

/**
 * 車両種別ごとの占有量（乗用車の車列 1 台 = 1）。
 * 場所（リンクの収容）と交通容量（交差点の放出枠）の両方に効く。
 */
const PLATOON_EQUIV: Record<number, number> = {
  [VehicleKind.Car]: 1,
  [VehicleKind.Truck]: TRUCK_PLATOON_EQUIV,
  [VehicleKind.Bus]: BUS_PLATOON_EQUIV,
};

/** 到着（または打ち切り）の通知。 */
export interface VehicleEvent {
  kind: VehicleKind;
  owner: number;
  /** 打ち切られた場合 true（グリッドロックや道路の作り直し）。 */
  aborted: boolean;
}

const INITIAL_VEHICLE_CAPACITY = 1024;
/**
 * 描画用に覚えておくリンク乗り換えの件数。
 * 実測で 1 tick に進むのは最大 6 リンクなので、その前の 1 件ぶんを足しても 8 で足りる。
 */
const TRAJECTORY_HISTORY = 8;
/** 道路ではない区間（駅前の歩行者エッジなど）の放出率。実質無制限。 */
const FREE_SEGMENT_RELEASE = 1000;

export class TrafficSystem {
  // ---- 車両（SoA。同時に走るのは数百台なので配列で足りる） ----
  private capacity = 0;
  private high = 0;
  private freeSlots: number[] = [];

  path: (Path | null)[] = [];
  /** path.edges の何本目のリンクにいるか。 */
  edgeIndex = new Int32Array(0);
  /** そのリンクに入った時刻（シミュレーション秒）。 */
  enterSec = new Float64Array(0);
  kind = new Uint8Array(0);
  owner = new Int32Array(0);
  alive = new Uint8Array(0);
  departTick = new Int32Array(0);
  /** リンク待ち行列の次の車両。-1 = 末尾。 */
  private next = new Int32Array(0);
  /**
   * サブステップ境界ごとの**リンク上の位置** 0..1。[v * (SUBSTEPS + 1) + sub]
   *
   * 位置を導出値ではなく状態として持つ理由が 2 つある。
   *
   * 1. tick の最後に並びを 1 枚だけ配ると、行列に捕まった車は 1 tick まるごと
   *    固まったあと、次の tick の頭で前の車がどいた分をまとめて飛ぶ。
   * 2. 前が抜けた瞬間に停止線までワープさせると、そこから自由流の何倍もの
   *    速さで前へ出る。実車は前が動いてから車間を詰めるのに時間が掛かる。
   *
   * そこで各サブステップで「前の位置 ＋ 自由流で進める分」「前の車の後ろ」
   * 「入ってからの経過で進める分」の一番小さい値まで進める。放出の条件に
   * 「停止線に着いていること」を足してあるので（`step`）、リンクを移る瞬間の
   * 位置は必ず 1.0 で、次のリンクの 0.0 と連続する。
   *
   * 末尾に 1 点余分に持つのは、最後のサブステップと tick の境目を
   * 補間するのに「次の点」が要るため。
   */
  posSamples = new Float32Array(0);
  /** 連続で前に進めなかったサブステップ数。グリッドロックの逃がし弁に使う。 */
  private blocked = new Int32Array(0);
  /** 車両が交差点の放出枠を食う量（乗用車の車列 = 1）。場所には使わない。 */
  private size = new Float32Array(0);
  /**
   * その車が走っている車線（0 = いちばん外側＝路肩側）。**描画専用**。
   *
   * リンクに入るときに空いている車線へ割り当て、抜けるまで変えない。
   * 毎 tick 並び順から決め直すと、前の車が抜けるたびに横へ跳ぶ。
   */
  laneOf = new Uint8Array(0);

  /**
   * 直近の軌跡（どのリンクに、いつ入ったか）。**描画専用**で、判断には一切使わない。
   *
   * 車は 1 tick に平均 2〜3 リンク（実測。自由流なら最大 6）進む。今いるリンクしか
   * 持たないと、描画側は毎 tick「数マス瞬間移動 → 停止線でじっと待つ」しか描けない。
   * tick の中の任意の時刻について、そのとき本当にいた場所を返せるように
   * リンクの乗り換えを記録しておく。
   *
   * 1 tick を平均して滑らかにする手もあるが、信号の 1 周期が 60 秒 ＝ ちょうど 1 tick なので、
   * それだと赤で止まっている様子が完全に消える。せっかくの挙動が見えなくなる。
   */
  private histEdgeIndex = new Int32Array(0);
  private histEnterSec = new Float64Array(0);
  /** リング内の最新の位置と、入っている件数。 */
  private histHead = new Uint8Array(0);
  private histCount = new Uint8Array(0);

  // ---- リンク ----
  private edgeCount = 0;
  private head = new Int32Array(0);
  private tail = new Int32Array(0);
  /** リンクにいる車両の台数。 */
  private count = new Float32Array(0);
  private credit = new Float32Array(0);
  /**
   * 収容台数（**台数**であって車列の重みではない）。
   *
   * 描き分けられる車線数 × 1 車線に並ぶ台数。トラックは交差点の枠こそ
   * 乗用車の車列の 0.22 しか食わないが、画面では 1 台ぶんの場所を占める。
   * 重みで数えると 1 リンクに 18 台のトラックが載り、必ず重なって描かれる。
   */
  storage = new Uint16Array(0);
  /** 描き分けられる車線数（`DRAWN_LANES`）。 */
  private lanes = new Uint8Array(0);
  /** 1 サブステップに放出できる台数（青のとき）。 */
  private releasePerStep = new Float32Array(0);
  /** 自由流通過時間（秒）。graph.edgeCarFreeSec の写し。 */
  private freeSec = new Float32Array(0);
  /** 周期内で青になる開始・終了サブステップ。信号が無いリンクは [0, CYCLE)。 */
  private greenFrom = new Uint8Array(0);
  private greenTo = new Uint8Array(0);
  /** 下流交差点ごとの位相ずれ。全部の信号が一斉に変わらないようにする。 */
  private phaseOffset = new Uint8Array(0);

  /** 車線ごとの「ここまで進んでよい」位置。`samplePositions` の作業用。 */
  private readonly laneCaps = new Float32Array(4);

  /** 車両がいるリンクの一覧。tick の頭で昇順に整えるので処理順は決定的。 */
  private active: number[] = [];
  private isActive = new Uint8Array(0);

  /** この tick に到着・打ち切りになった車両。呼び出し側が読んで消す。 */
  readonly events: VehicleEvent[] = [];

  /** 道路リンクの総数。混雑しているリンクの割合を出すのに使う。 */
  roadLinks = 0;

  /** 統計。 */
  readonly stats = {
    /** 走行中の車両数。 */
    running: 0,
    /** 自由流時間を過ぎても出られずにいる車両数（信号待ち・前が詰まっている）。 */
    waiting: 0,
    /** 収容いっぱいのリンク数。 */
    fullLinks: 0,
    /** 車両で重み付けした、自由流に対する所要時間の倍率。 */
    avgDelay: 1,
    /** 車がいるリンクの中で最悪の遅延倍率。 */
    worstDelay: 1,
    /** 累計の打ち切り件数。 */
    aborted: 0,
    /** いちばん詰まっているリンク。-1 = どこも詰まっていない。 */
    worstLink: -1,
  };

  /** グラフの作り直しに合わせてリンク配列を張り替える。走行中の車両は全部打ち切る。 */
  rebuild(graph: Graph): void {
    this.abortAll();
    const m = graph.edgeCount;
    this.edgeCount = m;
    this.head = new Int32Array(m).fill(-1);
    this.tail = new Int32Array(m).fill(-1);
    this.count = new Float32Array(m);
    this.credit = new Float32Array(m);
    this.storage = new Uint16Array(m);
    this.lanes = new Uint8Array(m);
    this.releasePerStep = new Float32Array(m);
    this.freeSec = new Float32Array(m);
    this.greenFrom = new Uint8Array(m);
    this.greenTo = new Uint8Array(m);
    this.phaseOffset = new Uint8Array(m);
    this.isActive = new Uint8Array(m);
    this.active.length = 0;
    this.roadLinks = 0;

    for (let e = 0; e < m; e++) {
      const rc = graph.edgeRoadClass[e]!;
      this.freeSec[e] = graph.edgeCarFreeSec[e]!;
      // 既定は「常に青」。信号の無いリンクと、万一割り当て漏れがあったリンクが
      // 永久に赤になって街が止まるのを防ぐ。
      this.greenTo[e] = SIGNAL_CYCLE_STEPS;
      if (rc === RoadClass.None) {
        // 自動車の経路は駅前の歩行者エッジを通ることがある（MODE_EDGE_MASK[Car] は
        // 徒歩ビットを含む）。ここは道路ではないので容量も信号も無い素通り区間として扱う。
        // 見落とすと放出できずに車が永久に止まり、8 時間後に打ち切られる。
        this.freeSec[e] = graph.edgeCost(e, Mode.Car);
        this.storage[e] = 0xffff;
        this.releasePerStep[e] = FREE_SEGMENT_RELEASE;
        continue;
      }
      this.roadLinks++;
      const lanes = ROAD_LANES[rc]!;
      // 収容は「重ならずに描ける台数」。描き分けられる車線数 × 1 車線に並ぶ台数。
      // 交差点で捌ける量は ROAD_LANES のままなので、道を広げる効果は保たれる。
      this.lanes[e] = DRAWN_LANES[rc]!;
      this.storage[e] = Math.max(1, this.lanes[e]! * VEHICLES_PER_LANE);
      // 実車の飽和交通流率を車列に換算し、1 サブステップぶんに割る。
      const platoonPerSec = (SATURATION_VPH_PER_LANE * lanes) / VEHICLE_PLATOON / 3600;
      this.releasePerStep[e] = platoonPerSec * TRAFFIC_STEP_SEC;
    }

    this.assignSignals(graph);
  }

  /**
   * 交差点に信号を置き、リンクごとの青の区間を決める。
   *
   * ノードの状態は持たない。位相はサブステップ数とノード index だけの関数にしてあるので、
   * セーブにも復元にも何も要らない。
   */
  private assignSignals(graph: Graph): void {
    const n = graph.nodeCount;
    const half = Math.floor(SIGNAL_CYCLE_STEPS / 2);
    for (let node = 0; node < n; node++) {
      const e0 = graph.edgeStart[node]!;
      const e1 = graph.edgeStart[node + 1]!;
      let degree = 0;
      // 軸ごとの最上位の道路種別。0 = 東西、1 = 南北。
      const best = [0, 0];
      for (let e = e0; e < e1; e++) {
        const rc = graph.edgeRoadClass[e]!;
        if (rc === RoadClass.None) continue;
        degree++;
        const ax = axisOf(graph, e);
        if (rc > best[ax]!) best[ax] = rc;
      }
      const offset = (node * 7919) % SIGNAL_CYCLE_STEPS;
      // 流入リンク（この交差点で止まる側）に青の区間を書き込む。
      for (let e = e0; e < e1; e++) {
        const rc = graph.edgeRoadClass[e]!;
        if (rc === RoadClass.None) continue;
        const incoming = this.reverseOf(graph, e);
        if (incoming < 0) continue;
        if (degree < SIGNAL_MIN_DEGREE) {
          // 直線の途中・行き止まりには信号を置かない。
          this.greenFrom[incoming] = 0;
          this.greenTo[incoming] = SIGNAL_CYCLE_STEPS;
          continue;
        }
        const ax = axisOf(graph, e);
        const other = ax === 0 ? 1 : 0;
        let from: number;
        let to: number;
        if (best[ax]! > best[other]!) {
          from = 0;
          to = SIGNAL_MAJOR_GREEN_STEPS;
        } else if (best[ax]! < best[other]!) {
          from = SIGNAL_MAJOR_GREEN_STEPS;
          to = SIGNAL_CYCLE_STEPS;
        } else {
          from = ax === 0 ? 0 : half;
          to = ax === 0 ? half : SIGNAL_CYCLE_STEPS;
        }
        this.greenFrom[incoming] = from;
        this.greenTo[incoming] = to;
        this.phaseOffset[incoming] = offset;
      }
    }
  }

  /** node の出辺 e に対応する、node へ向かう逆向きのエッジ。 */
  private reverseOf(graph: Graph, e: number): number {
    const b = graph.edgeTo[e]!;
    const a = graph.edgeFrom[e]!;
    const s0 = graph.edgeStart[b]!;
    const s1 = graph.edgeStart[b + 1]!;
    for (let k = s0; k < s1; k++) {
      if (graph.edgeTo[k] === a) return k;
    }
    return -1;
  }

  private isGreen(edge: number, step: number): boolean {
    const from = this.greenFrom[edge]!;
    const to = this.greenTo[edge]!;
    if (from === 0 && to === SIGNAL_CYCLE_STEPS) return true;
    const phase = (step + this.phaseOffset[edge]!) % SIGNAL_CYCLE_STEPS;
    return phase >= from && phase < to;
  }

  // ---------------- 車両の出入り ----------------

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity === 0 ? INITIAL_VEHICLE_CAPACITY : this.capacity;
    while (cap < n) cap *= 2;
    const grow = <T extends Int32Array | Float32Array | Float64Array | Uint8Array>(
      old: T,
      make: (n: number) => T,
    ): T => {
      const next = make(cap);
      next.set(old);
      return next;
    };
    this.edgeIndex = grow(this.edgeIndex, (k) => new Int32Array(k));
    this.enterSec = grow(this.enterSec, (k) => new Float64Array(k));
    this.kind = grow(this.kind, (k) => new Uint8Array(k));
    this.owner = grow(this.owner, (k) => new Int32Array(k));
    this.alive = grow(this.alive, (k) => new Uint8Array(k));
    this.departTick = grow(this.departTick, (k) => new Int32Array(k));
    this.next = grow(this.next, (k) => new Int32Array(k));
    // cap の標本は車両ごとに SUBSTEPS + 1 件の連続領域。伸ばすときは詰め替える。
    const poss = new Float32Array(cap * (TRAFFIC_SUBSTEPS_PER_TICK + 1));
    poss.set(this.posSamples);
    this.posSamples = poss;
    this.blocked = grow(this.blocked, (k) => new Int32Array(k));
    this.size = grow(this.size, (k) => new Float32Array(k));
    this.laneOf = grow(this.laneOf, (k) => new Uint8Array(k));
    this.histHead = grow(this.histHead, (k) => new Uint8Array(k));
    this.histCount = grow(this.histCount, (k) => new Uint8Array(k));
    // 履歴は車両ごとに HIST 件の連続領域。伸ばすときは要素ごとに詰め替える。
    const hist = new Int32Array(cap * TRAJECTORY_HISTORY);
    hist.set(this.histEdgeIndex);
    this.histEdgeIndex = hist;
    const secs = new Float64Array(cap * TRAJECTORY_HISTORY);
    secs.set(this.histEnterSec);
    this.histEnterSec = secs;
    this.capacity = cap;
  }

  /**
   * 車両を経路の先頭リンクに投入する。
   * 先頭リンクが満杯なら -1 を返す（呼び出し側は次の tick に出直す）。
   */
  enter(path: Path, kind: VehicleKind, owner: number, tick: number): number {
    if (path.edges.length === 0) return -1;
    const first = path.edges[0]!;
    if (first >= this.edgeCount) return -1;
    const size = PLATOON_EQUIV[kind] ?? 1;
    if (this.count[first]! + 1 > this.storage[first]!) return -1;

    const slot = this.freeSlots.pop() ?? this.high++;
    this.ensureCapacity(this.high);
    this.size[slot] = size;
    this.path[slot] = path;
    this.edgeIndex[slot] = 0;
    this.enterSec[slot] = tick * 60;
    this.kind[slot] = kind;
    this.owner[slot] = owner;
    this.alive[slot] = 1;
    this.departTick[slot] = tick;
    this.blocked[slot] = 0;
    this.histHead[slot] = 0;
    this.histCount[slot] = 1;
    this.histEdgeIndex[slot * TRAJECTORY_HISTORY] = 0;
    this.histEnterSec[slot * TRAJECTORY_HISTORY] = tick * 60;
    this.pushLink(first, slot);
    return slot;
  }

  private pushLink(edge: number, v: number): void {
    this.laneOf[v] = this.pickLane(edge);
    this.next[v] = -1;
    const t = this.tail[edge]!;
    if (t < 0) {
      this.head[edge] = v;
      // 空いていたリンクには「1 台ぶん」の放出枠を用意しておく。
      // 飽和交通流率は行列ができて初めて効く制約なので、
      // 空いている道で先頭の 1 台を待たせると、街中の移動が一律に倍近く遅くなる。
      if (this.credit[edge]! < 1) this.credit[edge] = 1;
    } else this.next[t] = v;
    this.tail[edge] = v;
    this.count[edge] = this.count[edge]! + 1;
    if (this.isActive[edge] === 0) {
      this.isActive[edge] = 1;
      this.active.push(edge);
    }
  }

  /**
   * いちばん空いている車線を選ぶ。同数なら外側（路肩側）から埋める。
   * リンクの待ち行列は最大でも数台なので、毎回なぞって数えて構わない。
   */
  private pickLane(edge: number): number {
    const n = this.lanes[edge] ?? 1;
    if (n <= 1) return 0;
    const used = [0, 0, 0, 0];
    for (let k = this.head[edge]!; k >= 0; k = this.next[k]!) {
      const l = this.laneOf[k]!;
      if (l < used.length) used[l] = used[l]! + 1;
    }
    let best = 0;
    for (let l = 1; l < n && l < used.length; l++) {
      if (used[l]! < used[best]!) best = l;
    }
    return best;
  }

  private popLink(edge: number): number {
    const v = this.head[edge]!;
    if (v < 0) return -1;
    this.head[edge] = this.next[v]!;
    if (this.head[edge]! < 0) this.tail[edge] = -1;
    this.count[edge] = Math.max(0, this.count[edge]! - 1);
    this.next[v] = -1;
    return v;
  }

  /** 軌跡に「このリンクへ、この時刻に入った」を 1 件積む。 */
  private pushTrajectory(v: number, edgeIndex: number, nowSec: number): void {
    const head = (this.histHead[v]! + 1) % TRAJECTORY_HISTORY;
    this.histHead[v] = head;
    if (this.histCount[v]! < TRAJECTORY_HISTORY) this.histCount[v] = this.histCount[v]! + 1;
    this.histEdgeIndex[v * TRAJECTORY_HISTORY + head] = edgeIndex;
    this.histEnterSec[v * TRAJECTORY_HISTORY + head] = nowSec;
  }

  private release(v: number): void {
    this.alive[v] = 0;
    this.path[v] = null;
    this.freeSlots.push(v);
  }

  private finish(v: number, aborted: boolean): void {
    this.events.push({ kind: this.kind[v] as VehicleKind, owner: this.owner[v]!, aborted });
    if (aborted) this.stats.aborted++;
    this.release(v);
  }

  /** 走行中の車両を全部打ち切る（道路の作り直し・セーブの読み込み）。 */
  abortAll(): void {
    for (let v = 0; v < this.high; v++) {
      if (this.alive[v] === 0) continue;
      this.finish(v, true);
    }
    for (let e = 0; e < this.edgeCount; e++) {
      this.head[e] = -1;
      this.tail[e] = -1;
      this.count[e] = 0;
      this.credit[e] = 0;
      this.isActive[e] = 0;
    }
    this.active.length = 0;
  }

  /** セーブの読み込み後。イベントごと捨てる。 */
  reset(): void {
    this.abortAll();
    this.events.length = 0;
    this.high = 0;
    this.freeSlots.length = 0;
    this.path.length = 0;
    this.stats.aborted = 0;
  }

  // ---------------- 1 tick ----------------

  tick(graph: Graph, tick: number): void {
    // 空になったリンクを落として昇順に整える。処理順を tick ごとに固定するため。
    if (this.active.length > 0) {
      const keep: number[] = [];
      for (const e of this.active) {
        if (this.count[e]! > 0) keep.push(e);
        else this.isActive[e] = 0;
      }
      keep.sort((a, b) => a - b);
      this.active = keep;
    }

    for (let sub = 0; sub < TRAFFIC_SUBSTEPS_PER_TICK; sub++) {
      const at = tick * 60 + sub * TRAFFIC_STEP_SEC;
      this.samplePositions(sub, at);
      this.step(graph, at, tick * TRAFFIC_SUBSTEPS_PER_TICK + sub);
    }
    this.samplePositions(TRAFFIC_SUBSTEPS_PER_TICK, tick * 60 + 60);

    this.refreshQueueSlots(graph, tick * 60 + 60);
    this.expireLongTrips(tick);
  }

  private step(graph: Graph, nowSec: number, stepIndex: number): void {
    // active はループ中に伸びうる（下流リンクが新しく埋まる）。
    // 追加分はこのサブステップの最後で処理されるだけで、順序は決定的。
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i]!;
      if (this.count[e]! === 0) continue;

      // 赤の間は貯めない（青が明けた瞬間にまとめて放出されるのを防ぐ）が、捨てもしない。
      if (!this.isGreen(e, stepIndex)) continue;
      // 上限 1 = 「1 台ぶんより多くは貯め込めない」。
      this.credit[e] = Math.min(this.credit[e]! + this.releasePerStep[e]!, 1);

      for (;;) {
        const v = this.head[e]!;
        if (v < 0) break;
        // 自由流時間は必ずかかる。前の車を追い越せないのはここ（FIFO）。
        if (nowSec < this.enterSec[v]! + this.freeSec[e]!) break;
        // まだ停止線まで来ていない車は出せない。行列の後ろにいた車は、前が
        // どいてから車間を詰めるぶんだけ遅れて出る（実車の発進遅れ）。
        // これを省くと、描画は「詰めきる前にワープして次のリンクへ」になる。
        if (this.posSamples[v * (TRAFFIC_SUBSTEPS_PER_TICK + 1) + (stepIndex % TRAFFIC_SUBSTEPS_PER_TICK)]! < 1) break;
        if (this.credit[e]! < 1) break;
        // 大きい車ほど交差点の枠を食う。クレジットは負になってよい。
        const weight = this.size[v]!;

        const p = this.path[v]!;
        const ni = this.edgeIndex[v]! + 1;
        const last = ni >= p.edges.length;
        if (!last) {
          const nx = p.edges[ni]!;
          if (this.count[nx]! + 1 > this.storage[nx]!) {
            // 下流が詰まっている → ここで止まる。これが渋滞の伝播。
            this.blocked[v] = this.blocked[v]! + 1;
            if (this.blocked[v]! < GRIDLOCK_RELIEF_STEPS) break;
            // 逃がし弁。閉路が全部満杯になると永久に動けなくなるので、
            // 十分待った車は 1 台だけ押し込む。
          }
        }

        // 交差点を渡った「実際の」時刻。サブステップの格子には丸めない。
        //
        // 自由流でリンクを渡り終えるのは 9〜18 秒で、サブステップは 5 秒刻み。
        // 放出を格子に合わせると、車は毎リンク 1〜3 秒だけ停止線で固まってから
        // 出ていくことになり、**1 セルごとに加減速する**動きになる
        // （実測: 前も信号も無い車が走行時間の 15.5% を停止に使い、
        //   1 リンクあたり 0.98 回停止していた）。
        // さらにリンク所要が毎回切り上がるので、空いている道でも実測所要が
        // 自由流の 1.111 倍で記録され、経路コストと「所要時間の倍率」に
        // そのまま下駄が乗っていた。
        //
        // 渡り終えたのがこのサブステップの窓の中なら、その車は待っていない
        // （格子の都合で処理がここまで来ただけ）ので、渡り終えた時刻で出す。
        // 窓より前に渡り終えていた車は、信号・放出枠・下流の詰まりで実際に
        // 止まっていたので、これまで通り今の時刻で出す。
        const ready = this.enterSec[v]! + this.freeSec[e]!;
        const releaseSec = ready > nowSec - TRAFFIC_STEP_SEC ? ready : nowSec;

        this.popLink(e);
        this.credit[e] = this.credit[e]! - weight;
        graph.observeTraversal(e, releaseSec - this.enterSec[v]!, Math.floor(nowSec / 60));

        if (last) {
          this.finish(v, false);
        } else {
          const nx = p.edges[ni]!;
          this.edgeIndex[v] = ni;
          this.enterSec[v] = releaseSec;
          this.blocked[v] = 0;
          this.pushTrajectory(v, ni, releaseSec);
          this.pushLink(nx, v);
        }
      }
    }
  }

  /**
   * そのサブステップ時点の位置を 1 点ずつ記録する（`posSamples` の注記）。
   *
   * tick に 13 回走るので、走行中の車両（実測で数百台）のリンクリストを
   * 1 回なぞるだけに留める。
   */
  private samplePositions(sub: number, nowSec: number): void {
    const stride = TRAFFIC_SUBSTEPS_PER_TICK + 1;
    const cap = this.laneCaps;
    const prevSub = sub === 0 ? TRAFFIC_SUBSTEPS_PER_TICK : sub - 1;
    for (const e of this.active) {
      if (this.count[e]! <= 0) continue;
      const free = this.freeSec[e]!;
      // 1 サブステップで自由流なら進める割合。
      const perStep = free > 0 ? TRAFFIC_STEP_SEC / free : 1;
      cap.fill(1);
      for (let v = this.head[e]!; v >= 0; v = this.next[v]!) {
        const l = this.laneOf[v]!;
        const b = v * stride;
        // 入ってからの経過で進める分。
        const cruise = free > 0 ? (nowSec - this.enterSec[v]!) / free : 1;
        // このリンクに入ったのが前の標本より後なら、前の値は前のリンクのもの。
        const base = this.enterSec[v]! > nowSec - TRAFFIC_STEP_SEC ? 0 : this.posSamples[b + prevSub]!;
        this.posSamples[b + sub] = Math.max(
          0,
          Math.min(cap[l]!, cruise, base + perStep),
        );
        cap[l] = cap[l]! - VEHICLE_LENGTH_M / TILE_SPAN_M;
      }
    }
  }

  /** 走行状況の統計を取り直す（描画の位置は `posSamples` が持つ）。 */
  private refreshQueueSlots(graph: Graph, nowSec: number): void {
    let running = 0;
    let waiting = 0;
    let full = 0;
    let delaySum = 0;
    let worst = 1;
    let worstLink = -1;
    for (const e of this.active) {
      const n = this.count[e]!;
      if (n <= 0) continue;
      if (n + 1 > this.storage[e]!) full++;
      const delay = graph.delayFactor(e);
      if (delay > worst) {
        worst = delay;
        worstLink = e;
      }
      for (let v = this.head[e]!; v >= 0; v = this.next[v]!) {
        running++;
        // 台数で重み付けする。占有量（トラックは 0.22）で重み付けすると
        // 平均が 1 を下回って「自由流より速い」というあり得ない値になる。
        delaySum += delay;
        // 自由流時間を過ぎても放出の機会を 1 回以上逃している ＝ 信号待ちか、前が詰まっている。
        // 単に「自由流時間を過ぎた」で数えると、順調に走っている車まで
        // ほぼ全部が「待ち」に見える（放出はサブステップ刻みなので必ず数秒はみ出す）。
        if (nowSec >= this.enterSec[v]! + this.freeSec[e]! + TRAFFIC_STEP_SEC) waiting++;
      }
    }
    this.stats.running = running;
    this.stats.waiting = waiting;
    this.stats.fullLinks = full;
    this.stats.avgDelay = running > 0 ? delaySum / running : 1;
    this.stats.worstDelay = worst;
    this.stats.worstLink = worstLink;
  }

  /** いつまでも着かない車を打ち切る。グリッドロックの最後の受け皿。 */
  private expireLongTrips(tick: number): void {
    for (let v = 0; v < this.high; v++) {
      if (this.alive[v] === 0) continue;
      if (tick - this.departTick[v]! <= MAX_TRIP_TICKS) continue;
      const p = this.path[v]!;
      const e = p.edges[this.edgeIndex[v]!]!;
      // 待ち行列から抜く
      let prev = -1;
      for (let k = this.head[e]!; k >= 0; k = this.next[k]!) {
        if (k === v) break;
        prev = k;
      }
      if (prev < 0) this.popLink(e);
      else {
        this.next[prev] = this.next[v]!;
        if (this.tail[e] === v) this.tail[e] = prev;
        this.count[e] = Math.max(0, this.count[e]! - 1);
      }
      this.finish(v, true);
    }
  }

  // ---------------- 描画 ----------------

  /** 走行中の車両の slot を順に渡す。 */
  forEachVehicle(cb: (vehicle: number) => void): void {
    for (let v = 0; v < this.high; v++) {
      if (this.alive[v] === 1) cb(v);
    }
  }

  /**
   * 車両の見た目の位置。
   *
   * 走行中は「入ってからの経過 ÷ 自由流時間」で進み、
   * 放出待ちなら停止線から車列 1 台ぶんずつ後ろに並ぶ。
   * 信号の手前に車が整列して見えるのはここ。
   *
   * @param offsetM その地点から経路に沿って前（負なら後ろ）へずらした点を返す。
   *   前後の車軸を別々に置くのに使う（`pathCurvePoint` と `agentLayer` の注記）。
   *   単位は描画メートル。
   */
  pose(graph: Graph, v: number, nowSec: number, out: PathPose, offsetM = 0): boolean {
    if (this.alive[v] === 0) return false;
    const p = this.path[v];
    if (!p) return false;

    // その時刻にいたリンクを軌跡から引く。新しい方から見て、
    // 「もう入っていた」最初の 1 件がその瞬間の居場所。
    const base = v * TRAJECTORY_HISTORY;
    const head = this.histHead[v]!;
    const n = this.histCount[v]!;
    let slot = -1;
    for (let k = 0; k < n; k++) {
      const at = (head - k + TRAJECTORY_HISTORY) % TRAJECTORY_HISTORY;
      if (this.histEnterSec[base + at]! <= nowSec) {
        slot = at;
        break;
      }
    }
    // 履歴のどれよりも古い時刻を聞かれたら、いちばん古い記録で答える。
    if (slot < 0) slot = (head - (n - 1) + TRAJECTORY_HISTORY) % TRAJECTORY_HISTORY;

    const i = this.histEdgeIndex[base + slot]!;
    if (i >= p.edges.length) return false;
    const edge = p.edges[i]!;
    const free = this.freeSec[edge]!;
    const cruise = free > 0 ? (nowSec - this.histEnterSec[base + slot]!) / free : 1;
    // 前の車につかえるのは「今いるリンク」だけ。既に通り過ぎたリンクでは走り切っている。
    // 今いるリンクの上限はサブステップの標本から取る（`capSamples` の注記）。
    let f: number;
    if (slot === head) {
      // 今いるリンクの位置はサブステップの標本を補間して出す。
      const stride = TRAFFIC_SUBSTEPS_PER_TICK + 1;
      const u = Math.max(
        0,
        Math.min(TRAFFIC_SUBSTEPS_PER_TICK, (nowSec / TRAFFIC_STEP_SEC) % TRAFFIC_SUBSTEPS_PER_TICK),
      );
      const k0 = Math.floor(u);
      const b = v * stride;
      const p0 = this.posSamples[b + k0]!;
      const p1 = this.posSamples[b + k0 + 1]!;
      // このリンクに入る前の標本には前のリンクの位置が残っている。
      // 入ってからの経過で進める分で頭を押さえておけば、それを読んでも
      // 「入った直後なのに先の方に描かれる」ことはない。
      f = Math.min(cruise, p0 + (p1 - p0) * (u - k0));
    } else {
      // 既に通り過ぎたリンク。自由流で逆算すると、そこで行列に並んでいた車は
      // 「もう走り切っている」ことになり、tick をまたいだ瞬間にリンクの末端へ飛ぶ
      // （今いるリンクの位置は行列を反映しているのに、1 本前になった途端に
      //   反映されなくなるため）。軌跡には出た時刻も残っているので、
      // 入った時刻から出た時刻までを等速で渡ったものとして描く。
      const exitAt = (slot + 1) % TRAJECTORY_HISTORY;
      const span = this.histEnterSec[base + exitAt]! - this.histEnterSec[base + slot]!;
      f = span > 0 ? (nowSec - this.histEnterSec[base + slot]!) / span : 1;
    }
    f = Math.max(0, Math.min(1, f));

    return pathCurvePoint(graph, p, i, f, offsetM, out);
  }

  /** リンクの占有率 0..1。交通量オーバーレイに使う。 */
  occupancy(edge: number): number {
    if (edge >= this.edgeCount) return 0;
    const s = this.storage[edge]!;
    return s > 0 ? Math.min(1, this.count[edge]! / s) : 0;
  }
}

/**
 * 経路上の 1 点を、角を丸めた曲線として返す（`curve.ts`）。**描画専用**。
 *
 * @param i    経路の何本目のリンクか
 * @param f    そのリンク上の位置 0..1
 * @param offM ここから経路に沿って前（負なら後ろ）へずらす距離（描画メートル）。
 *   前後の車軸を別々に置くのに使う。
 */
function pathCurvePoint(
  graph: Graph,
  p: Path,
  i: number,
  f: number,
  offM: number,
  out: PathPose,
): boolean {
  const count = p.nodes.length;
  const last = p.edges.length - 1;

  // offM ぶん、折れ線に沿って進む（リンクをまたいでよい）。
  let idx = i;
  let d = f * segmentLength(graph, p.nodes, idx) + offM;
  for (let guard = 0; guard < 8 && d < 0 && idx > 0; guard++) {
    idx--;
    d += segmentLength(graph, p.nodes, idx);
  }
  for (let guard = 0; guard < 8; guard++) {
    const len = segmentLength(graph, p.nodes, idx);
    if (d <= len || idx >= last) break;
    d -= len;
    idx++;
  }

  curvePointOnNodes(graph, p.nodes, count, idx, d, out);
  out.edge = p.edges[idx]!;
  return true;
}

/** リンクの方位。0 = 東西、1 = 南北。信号の現示を 2 つに分けるのに使う。 */
function axisOf(graph: Graph, edge: number): number {
  const a = graph.nodeTile[graph.edgeFrom[edge]!]!;
  const b = graph.nodeTile[graph.edgeTo[edge]!]!;
  return tileX(a) !== tileX(b) ? 0 : tileY(a) !== tileY(b) ? 1 : 0;
}

/** 1 日ぶんのサブステップ数。テストで位相を確かめるときに使う。 */
export const SUBSTEPS_PER_DAY = TICKS_PER_DAY * TRAFFIC_SUBSTEPS_PER_TICK;
