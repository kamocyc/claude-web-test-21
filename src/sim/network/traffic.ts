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
  VEHICLE_ACCEL_MS2,
  VEHICLE_DECEL_MS2,
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
/** 道路ではない区間（駅前の歩行者エッジなど）の放出率。実質無制限。 */
const FREE_SEGMENT_RELEASE = 1000;
/**
 * 曲がる交差点で車間を何倍にするか。
 *
 * 角を丸めた曲線の内側を通る車は、中心線より短い弧を走る（`curve.ts`）。
 * 経路の上で車列 1 台ぶん空けても、画面ではその 7 割ほどに潰れる。
 * 直進する交差点には掛けない（そこは潰れないので、容量を削るだけになる）。
 */
const CORNER_PITCH = 1.4;
/** 車列 1 台ぶんの間隔（リンク長に対する比）。 */
const PITCH_FRAC = VEHICLE_LENGTH_M / TILE_SPAN_M;
/**
 * 停止線を交差点の中心からどれだけ手前に置くか（リンク長に対する比）。
 *
 * リンクの位置 1.0 は交差点の**中心**にあたる。赤で待つ車をそこに置くと、
 * 交わる道から来た車も同じ点で待つので、画面では車体が完全に重なる。
 * 描画上の交差点は 1 タイル 10m のうち 6〜9m を占めるので、その手前で止める。
 * 進めるようになったら 1.0（＝交差点の中心）まで出てから次のリンクへ移る。
 */
const STOP_LINE_SETBACK = 0.25;

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
  /** その標本のときにいたリンク（`path.edges` の添字）。`posSamples` と対。 */
  private edgeSamples = new Int32Array(0);
  /**
   * その標本のリンクに入った時刻（秒）。
   *
   * 放出はサブステップの格子に丸めていない（`step` の注記）ので、標本と標本の
   * あいだでリンクを移る。乗り換えの時刻を残しておかないと、その 5 秒を
   * まるごと等速で按分することになり、交差点の手前で止まって見えたあと
   * 自由流の 1.4 倍で飛び出す。
   */
  private enterSamples = new Float64Array(0);
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
   * 走行速度（シミュレーション上の m/s）。
   *
   * 位置を「進めるところまで進める」で決めると、赤信号でも渋滞の最後尾でも
   * 全速から一瞬で停止し、青になった瞬間に全速へ戻る。速度を状態として持ち、
   * 加速度・減速度で変化させることで、停止と発進に溜めができる。
   */
  speedOf = new Float32Array(0);

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
  /** 車線ごとの、前を走っている車の速度 (m/s)。`samplePositions` の作業用。 */
  private readonly laneLeadSpeed = new Float32Array(4);
  /**
   * リンクごとの最後尾の車の位置（0..1）。車がいなければ 2（＝十分遠い）。
   *
   * 交差点をまたぐ車間を作るのに使う。リンクの中だけで車間を取っても、
   * 停止線の車（位置 1.0）と、その先のリンクに入ったばかりの車（位置 0.3）は
   * 交差点をはさんで 3m しか離れず、画面では車体がめり込む。
   */
  private tailPos = new Float32Array(0);

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
    this.tailPos = new Float32Array(m).fill(2);
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
    const edges = new Int32Array(cap * (TRAFFIC_SUBSTEPS_PER_TICK + 1));
    edges.set(this.edgeSamples);
    this.edgeSamples = edges;
    const ent = new Float64Array(cap * (TRAFFIC_SUBSTEPS_PER_TICK + 1));
    ent.set(this.enterSamples);
    this.enterSamples = ent;
    this.blocked = grow(this.blocked, (k) => new Int32Array(k));
    this.size = grow(this.size, (k) => new Float32Array(k));
    this.laneOf = grow(this.laneOf, (k) => new Uint8Array(k));
    this.speedOf = grow(this.speedOf, (k) => new Float32Array(k));
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
    // 走り出しの速度は自由流。道に出るまでの加速は建物側の話で、ここでは
    // 「もう流れに乗っている」ものとして扱う。0 から始めると、空いている道でも
    // 最初のリンクだけ所要が伸びて経路コストに乗ってしまう。
    this.speedOf[slot] = this.freeSec[first]! > 0 ? TILE_SPAN_M / this.freeSec[first]! : TILE_SPAN_M;
    // 標本を経路の先頭で埋めておく。tick の途中で投入された車（物流の折り返し）は
    // その tick のあいだ標本が書かれないので、埋めないと前の車の値が読まれる。
    const stride = TRAFFIC_SUBSTEPS_PER_TICK + 1;
    for (let k = 0; k < stride; k++) {
      this.posSamples[slot * stride + k] = 0;
      this.edgeSamples[slot * stride + k] = 0;
      this.enterSamples[slot * stride + k] = tick * 60;
    }
    this.pushLink(first, slot);
    return slot;
  }

  private pushLink(edge: number, v: number): void {
    this.laneOf[v] = this.pickLane(edge);
    // 入った車は入口（位置 0）にいる。次の車が同じサブステップで入ってきて
    // 重なるのを防ぐため、標本を待たずにここで最後尾を更新する。
    this.tailPos[edge] = 0;
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
      this.samplePositions(graph, sub, at, tick * TRAFFIC_SUBSTEPS_PER_TICK + sub);
      this.step(graph, at, tick * TRAFFIC_SUBSTEPS_PER_TICK + sub);
    }
    this.samplePositions(graph, TRAFFIC_SUBSTEPS_PER_TICK, tick * 60 + 60, (tick + 1) * TRAFFIC_SUBSTEPS_PER_TICK);

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
        // 交差点の先の車との間隔もここで効く（`tailPos` の注記）。
        if (this.posSamples[v * (TRAFFIC_SUBSTEPS_PER_TICK + 1) + (stepIndex % TRAFFIC_SUBSTEPS_PER_TICK)]! < 1) {
          this.blocked[v] = this.blocked[v]! + 1;
          if (this.blocked[v]! < GRIDLOCK_RELIEF_STEPS) break;
        }
        if (this.credit[e]! < 1) break;
        // 大きい車ほど交差点の枠を食う。クレジットは負になってよい。
        const weight = this.size[v]!;

        const p = this.path[v]!;
        const ni = this.edgeIndex[v]! + 1;
        const last = ni >= p.edges.length;
        if (!last) {
          const nx = p.edges[ni]!;
          // 次のリンクの入口に、車列 1 台ぶんの空きが要る。台数だけで見ると
          // 相次いで入った 2 台がどちらも入口（位置 0）に描かれて重なる。
          const need = axisOf(graph, e) === axisOf(graph, nx) ? PITCH_FRAC : PITCH_FRAC * CORNER_PITCH;
          if (this.tailPos[nx]! < need || this.count[nx]! + 1 > this.storage[nx]!) {
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
          this.pushLink(nx, v);
          // 標本はサブステップの頭（＝放出前）に取っている。放出時刻は格子に
          // 丸めていないので、そのままだと「この時刻にはもう次のリンクにいた」
          // という事実と食い違い、描画は交差点の手前で一拍止まってから
          // 自由流の 1.4 倍で飛び出す。動かした車の標本はここで取り直す。
          const stride = TRAFFIC_SUBSTEPS_PER_TICK + 1;
          const sub = stepIndex % TRAFFIC_SUBSTEPS_PER_TICK;
          const sample = v * stride + sub;
          const freeNext = this.freeSec[nx]!;
          // 入った先で前を走っている車（同じ車線）の後ろに収める。経過時間だけで
          // 置くと、その車の車間より前に出てしまい、次のサブステップで上限に
          // 引き戻される ―― 画面では後ろへワープする。
          let ahead = 2;
          for (let q = this.head[nx]!; q >= 0 && q !== v; q = this.next[q]!) {
            if (this.laneOf[q] === this.laneOf[v]) ahead = this.posSamples[q * stride + sub]!;
          }
          const limit = ahead >= 2 ? 1 : Math.max(0, ahead - PITCH_FRAC);
          this.edgeSamples[sample] = ni;
          this.enterSamples[sample] = releaseSec;
          // 進んだ量は自由流ではなく**いまの速度**で測る（減速中に交差点を
          // 渡ることがある）。
          const moved = (this.speedOf[v]! * (nowSec - releaseSec)) / TILE_SPAN_M;
          this.posSamples[sample] = freeNext > 0 ? Math.max(0, Math.min(limit, moved)) : 0;
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
  private samplePositions(graph: Graph, sub: number, nowSec: number, stepIndex: number): void {
    const stride = TRAFFIC_SUBSTEPS_PER_TICK + 1;
    const cap = this.laneCaps;
    const lead = this.laneLeadSpeed;
    const prevSub = sub === 0 ? TRAFFIC_SUBSTEPS_PER_TICK : sub - 1;
    for (const e of this.active) {
      if (this.count[e]! <= 0) {
        this.tailPos[e] = 2;
        continue;
      }
      const free = this.freeSec[e]!;
      // 1 サブステップで自由流なら進める割合。
      const perStep = free > 0 ? TRAFFIC_STEP_SEC / free : 1;
      /** このリンクの自由流速度 (m/s)。 */
      const vFree = free > 0 ? TILE_SPAN_M / free : TILE_SPAN_M;
      const green = this.isGreen(e, stepIndex);
      cap.fill(1);
      lead.fill(vFree);
      const first = [true, true, true, true];
      // その車線の先頭が「止まらずに通り抜けられる」か。
      const through = [false, false, false, false];
      let tail = 2;
      for (let v0 = this.head[e]!; v0 >= 0; v0 = this.next[v0]!) {
        const l = this.laneOf[v0]!;
        const b = v0 * stride;
        // 入ってからの経過で進める分。
        const cruise = free > 0 ? (nowSec - this.enterSec[v0]!) / free : 1;
        // 前の標本が別のリンクのものなら引き継がない。リンクに入ったのは
        // サブステップの途中（放出時刻は格子に丸めていない）なので、
        // 0 から数え直すと 1 サブステップぶん取りこぼして所要が水増しされる。
        // 入った時刻から数えた分を初期値にする。
        const base =
          this.edgeSamples[b + prevSub] === this.edgeIndex[v0]
            ? this.posSamples[b + prevSub]!
            : Math.max(0, cruise - perStep);
        if (first[l]) {
          // この車線の先頭。
          first[l] = false;
          // **渡り切れると分かったときだけ交差点に入る。**
          //
          // 位置 1.0 は交差点の中心にあたる。赤や、放出枠待ち、先が詰まっている
          // といった理由でそこに留まると、交わる道から来た車と同じ点に重なって
          // 描かれる。渡れないうちは停止線（`STOP_LINE_SETBACK` ぶん手前）で待たせる。
          //
          // 既に停止線より前に出ている車は下げない。下げると画面では
          // 後ろへワープするので、そのまま渡らせる（黄で入った車と同じ扱い）。
          let canGo = green && this.credit[e]! >= 1;
          const p = this.path[v0];
          const ni = this.edgeIndex[v0]! + 1;
          if (p && ni < p.edges.length) {
            const nx = p.edges[ni]!;
            // 曲がる交差点では広めに空ける。角を丸めた内側の弧は中心線より
            // 短いので、経路上で同じだけ空けても画面では詰まって見える。
            const need = axisOf(graph, e) === axisOf(graph, nx) ? PITCH_FRAC : PITCH_FRAC * CORNER_PITCH;
            const ahead = this.tailPos[nx]!;
            if (ahead < need || this.count[nx]! + 1 > this.storage[nx]!) canGo = false;
            // 交差点の先の車との間隔。渡れる場合でも、詰めすぎないように押さえる。
            if (ahead < need) cap[l] = Math.min(cap[l]!, Math.max(base, 1 - (need - ahead)));
          }
          if (!canGo) cap[l] = Math.min(cap[l]!, Math.max(base, 1 - STOP_LINE_SETBACK));
          // 渡り切れるなら、この上限は「止まる場所」ではない（そのまま次の
          // リンクへ抜ける）。減速の目標にしないよう印を付ける。
          through[l] = canGo && cap[l]! >= 1;
          lead[l] = 0;
        }

        // --- 速度を加速度・減速度で動かす ---
        //
        // 「進めるところまで進める」だと、赤信号でも渋滞の最後尾でも全速から
        // 一瞬で止まり、青になった瞬間に全速に戻る。前方の制約（停止線・前の車）
        // までに前の車の速度まで落とせる速度を上限にし、そこへ向けて
        // 加速度ぶんずつ寄せる。
        let v = this.speedOf[v0]! + VEHICLE_ACCEL_MS2 * TRAFFIC_STEP_SEC;
        if (!through[l]) {
          const gapM = Math.max(0, cap[l]! - base) * TILE_SPAN_M;
          const vLead = lead[l]!;
          const vSafe = Math.sqrt(Math.max(0, vLead * vLead + 2 * VEHICLE_DECEL_MS2 * gapM));
          if (v > vSafe) v = vSafe;
        }
        if (v > vFree) v = vFree;
        if (v < 0) v = 0;
        const want = base + (v * TRAFFIC_STEP_SEC) / TILE_SPAN_M;
        // 前方の制約で頭打ちになった分は速度に返す（頭打ちのまま速度だけ
        // 上がっていくと、制約が外れた瞬間に飛び出す）。
        // そのまま次のリンクへ抜ける車にとって、リンクの端（1.0）は制約ではない。
        // ここで頭打ちにすると、リンクを渡るたびに速度が落ちて所要が伸びる。
        const held = through[l] ? want : Math.min(cap[l]!, want);
        this.speedOf[v0] = Math.max(0, ((held - base) * TILE_SPAN_M) / TRAFFIC_STEP_SEC);
        // `cruise` は「入ってからの経過で進める分」。リンクに入った直後だけ
        // 効く頭打ちで、前方の制約ではないので速度には返さない。
        const pos = Math.max(0, Math.min(cap[l]!, held, cruise));
        this.posSamples[b + sub] = pos;
        this.edgeSamples[b + sub] = this.edgeIndex[v0]!;
        this.enterSamples[b + sub] = this.enterSec[v0]!;
        if (pos < tail) tail = pos;
        // 次の車の上限は「前の車が**実際にいる位置**」の車列 1 台ぶん後ろ。
        //
        // 前の車の*上限*から引くと、上限だけが下がった（交差点の先に車が入った、
        // 赤になった）ときに、前の車は動いていないのに後ろの車の上限だけが
        // 下がる。上限は位置より前にあるので差は最大で車列 1 台ぶんあり、
        // 後ろの車が実際に後戻りして描かれていた（実測で 0.06% のフレーム）。
        //
        // 位置から引けば、位置は必ず単調に増えるので上限も単調に増える。
        // どの車も後ろへ動かないことが構成から保証される。
        cap[l] = pos - PITCH_FRAC;
        lead[l] = this.speedOf[v0]!;
        through[l] = false;
      }
      this.tailPos[e] = tail;
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
   * **サブステップごとに記録した「どのリンクの、どこにいたか」を補間するだけ**で、
   * 自由流時間からの逆算は一切しない。逆算に頼ると、行列で停止線に張り付いていた
   * 車が「もう走り切っている／まだ半分」と食い違い、tick をまたいだ瞬間に
   * 数メートル飛んで後続にめり込む。位置そのものを残しておけば食い違いようがない。
   *
   * 標本の間でリンクをまたいでいたら、その間を等速で渡ったものとして按分する。
   * リンクの境目は「前のリンクの 1.0 ＝ 次のリンクの 0.0」で同じ地点なので、
   * ここで切れ目は出ない。
   *
   * @param offsetM その地点から経路に沿って前（負なら後ろ）へずらした点を返す。
   *   前後の車軸を別々に置くのに使う（`pathCurvePoint` と `agentLayer` の注記）。
   *   単位は描画メートル。
   */
  pose(graph: Graph, v: number, nowSec: number, out: PathPose, offsetM = 0): boolean {
    if (this.alive[v] === 0) return false;
    const p = this.path[v];
    if (!p) return false;

    const stride = TRAFFIC_SUBSTEPS_PER_TICK + 1;
    const b = v * stride;
    const u = Math.max(
      0,
      Math.min(TRAFFIC_SUBSTEPS_PER_TICK, (nowSec / TRAFFIC_STEP_SEC) % TRAFFIC_SUBSTEPS_PER_TICK),
    );
    const k0 = Math.floor(u);
    const frac = u - k0;

    let i = this.edgeSamples[b + k0]!;
    let f = this.posSamples[b + k0]!;
    const i1 = this.edgeSamples[b + k0 + 1]!;
    const f1 = this.posSamples[b + k0 + 1]!;
    if (i1 === i) {
      f += (f1 - f) * frac;
    } else if (i1 === i + 1) {
      // 標本の間でリンクを 1 本またいだ。またいだ時刻が分かっているので、
      // 前後を別々に等速で結ぶ。境目（前のリンクの 1.0 ＝ 次の 0.0）で
      // つながるので切れ目は出ない。
      // 標本 k の時刻は「この tick の頭 + k * サブステップ」。
      const tickStart = nowSec - (nowSec % 60);
      const at0 = tickStart + k0 * TRAFFIC_STEP_SEC;
      const at1 = at0 + TRAFFIC_STEP_SEC;
      // 次のリンクに入った時刻。標本の間にあるはずだが、念のため挟み込む。
      const crossAt = Math.max(at0, Math.min(at1, this.enterSamples[b + k0 + 1]!));
      if (nowSec < crossAt) {
        // まだ前のリンク。そこから停止線（1.0）までを等速で。
        const span = crossAt - at0;
        f = span > 0 ? f + (1 - f) * ((nowSec - at0) / span) : 1;
      } else {
        // もう次のリンク。入口（0.0）から次の標本までを等速で。
        const span = at1 - crossAt;
        i = i1;
        f = span > 0 ? f1 * ((nowSec - crossAt) / span) : f1;
      }
    } else if (i1 > i) {
      // 2 本以上またいだ（ごく短い区間）。距離で按分する。
      const total = i1 - i + (f1 - f);
      f += total * frac;
      while (f >= 1 && i < i1) {
        f -= 1;
        i++;
      }
    }
    if (i >= p.edges.length) return false;

    return pathCurvePoint(graph, p, i, Math.max(0, Math.min(1, f)), offsetM, out);
  }

  /**
   * そのリンクがもう車を受け入れられないか。
   *
   * 台数が収容に達したときだけでなく、**入口に車列 1 台ぶんの空きが無い**
   * ときも満杯。位置で車間を取るようになったので、台数が収容に届く前に
   * 入れなくなる（＝そこから上流へ行列が伸びる）ことがある。
   *
   * 統計の「混雑リンク」（`stats.fullLinks`）には使わない。自由流の車が
   * 入った直後も一時的に真になるので、混み具合の指標としては騒がしい。
   */
  isFull(edge: number): boolean {
    if (edge >= this.edgeCount) return false;
    return this.count[edge]! + 1 > this.storage[edge]! || this.tailPos[edge]! < PITCH_FRAC;
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
