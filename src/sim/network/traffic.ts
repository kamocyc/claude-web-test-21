import {
  GRIDLOCK_RELIEF_STEPS,
  MAX_TRIP_TICKS,
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
import { Mode, ROAD_LANES, RoadClass } from '@shared/enums';
import { tileX, tileY } from '@sim/world/tiles';
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
} as const;
export type VehicleKind = (typeof VehicleKind)[keyof typeof VehicleKind];

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
   * その車が進んでよいリンク上の位置の上限（0..1）。描画専用。
   *
   * 先頭は停止線（1.0）まで、後続は前の車より車列 1 台ぶん手前まで。
   * 「同じ tick に 2 台入った」ときに重なって描かれるのを防ぐ。
   */
  queueCap = new Float32Array(0);
  /** 連続で前に進めなかったサブステップ数。グリッドロックの逃がし弁に使う。 */
  private blocked = new Int32Array(0);
  /** 車両が占める大きさ（乗用車の車列 = 1）。場所と交通容量の両方に使う。 */
  private size = new Float32Array(0);

  // ---- リンク ----
  private edgeCount = 0;
  private head = new Int32Array(0);
  private tail = new Int32Array(0);
  /** リンク上の占有量（乗用車の車列を 1 とする単位）。トラックは 0.22。 */
  private count = new Float32Array(0);
  private credit = new Float32Array(0);
  /** 収容台数。長さ × 車線数 ÷ 車列長。 */
  storage = new Uint16Array(0);
  /** 1 サブステップに放出できる台数（青のとき）。 */
  private releasePerStep = new Float32Array(0);
  /** 自由流通過時間（秒）。graph.edgeCarFreeSec の写し。 */
  private freeSec = new Float32Array(0);
  /** 周期内で青になる開始・終了サブステップ。信号が無いリンクは [0, CYCLE)。 */
  private greenFrom = new Uint8Array(0);
  private greenTo = new Uint8Array(0);
  /** 下流交差点ごとの位相ずれ。全部の信号が一斉に変わらないようにする。 */
  private phaseOffset = new Uint8Array(0);

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
      this.storage[e] = Math.max(1, Math.floor((TILE_SPAN_M * lanes) / VEHICLE_LENGTH_M));
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
    this.queueCap = grow(this.queueCap, (k) => new Float32Array(k));
    this.blocked = grow(this.blocked, (k) => new Int32Array(k));
    this.size = grow(this.size, (k) => new Float32Array(k));
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
    const size = kind === VehicleKind.Truck ? TRUCK_PLATOON_EQUIV : 1;
    if (this.count[first]! + size > this.storage[first]!) return -1;

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
    this.pushLink(first, slot);
    return slot;
  }

  private pushLink(edge: number, v: number): void {
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
    this.count[edge] = this.count[edge]! + this.size[v]!;
    if (this.isActive[edge] === 0) {
      this.isActive[edge] = 1;
      this.active.push(edge);
    }
  }

  private popLink(edge: number): number {
    const v = this.head[edge]!;
    if (v < 0) return -1;
    this.head[edge] = this.next[v]!;
    if (this.head[edge]! < 0) this.tail[edge] = -1;
    this.count[edge] = Math.max(0, this.count[edge]! - this.size[v]!);
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
      this.step(graph, tick * 60 + sub * TRAFFIC_STEP_SEC, tick * TRAFFIC_SUBSTEPS_PER_TICK + sub);
    }

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
        if (this.credit[e]! < 1) break;
        // 大きい車ほど交差点の枠を食う。クレジットは負になってよい。
        const weight = this.size[v]!;

        const p = this.path[v]!;
        const ni = this.edgeIndex[v]! + 1;
        const last = ni >= p.edges.length;
        if (!last) {
          const nx = p.edges[ni]!;
          if (this.count[nx]! + this.size[v]! > this.storage[nx]!) {
            // 下流が詰まっている → ここで止まる。これが渋滞の伝播。
            this.blocked[v] = this.blocked[v]! + 1;
            if (this.blocked[v]! < GRIDLOCK_RELIEF_STEPS) break;
            // 逃がし弁。閉路が全部満杯になると永久に動けなくなるので、
            // 十分待った車は 1 台だけ押し込む。
          }
        }

        this.popLink(e);
        this.credit[e] = this.credit[e]! - weight;
        graph.observeTraversal(e, nowSec - this.enterSec[v]!, Math.floor(nowSec / 60));

        if (last) {
          this.finish(v, false);
        } else {
          const nx = p.edges[ni]!;
          this.edgeIndex[v] = ni;
          this.enterSec[v] = nowSec;
          this.blocked[v] = 0;
          this.pushLink(nx, v);
        }
      }
    }
  }

  /** 描画のために、待ち行列の何番目かを配り直す。 */
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
      let cap = 1;
      for (let v = this.head[e]!; v >= 0; v = this.next[v]!) {
        this.queueCap[v] = Math.max(0, cap);
        cap -= VEHICLE_LENGTH_M / TILE_SPAN_M;
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
        this.count[e] = Math.max(0, this.count[e]! - this.size[v]!);
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
   */
  pose(graph: Graph, v: number, nowSec: number, out: PathPose): boolean {
    if (this.alive[v] === 0) return false;
    const p = this.path[v];
    if (!p) return false;
    const i = this.edgeIndex[v]!;
    const edge = p.edges[i]!;
    const free = this.freeSec[edge]!;
    const cruise = free > 0 ? (nowSec - this.enterSec[v]!) / free : 1;
    const f = Math.max(0, Math.min(cruise, this.queueCap[v]!));

    const a = p.nodes[i]!;
    const b = p.nodes[i + 1]!;
    const ax = graph.nodeX[a]!;
    const az = graph.nodeZ[a]!;
    const bx = graph.nodeX[b]!;
    const bz = graph.nodeZ[b]!;
    out.x = ax + (bx - ax) * f;
    out.z = az + (bz - az) * f;
    out.heading = Math.atan2(bx - ax, bz - az);
    out.edge = edge;
    return true;
  }

  /** リンクの占有率 0..1。交通量オーバーレイに使う。 */
  occupancy(edge: number): number {
    if (edge >= this.edgeCount) return 0;
    const s = this.storage[edge]!;
    return s > 0 ? Math.min(1, this.count[edge]! / s) : 0;
  }
}

/** リンクの方位。0 = 東西、1 = 南北。信号の現示を 2 つに分けるのに使う。 */
function axisOf(graph: Graph, edge: number): number {
  const a = graph.nodeTile[graph.edgeFrom[edge]!]!;
  const b = graph.nodeTile[graph.edgeTo[edge]!]!;
  return tileX(a) !== tileX(b) ? 0 : tileY(a) !== tileY(b) ? 1 : 0;
}

/** 1 日ぶんのサブステップ数。テストで位相を確かめるときに使う。 */
export const SUBSTEPS_PER_DAY = TICKS_PER_DAY * TRAFFIC_SUBSTEPS_PER_TICK;
