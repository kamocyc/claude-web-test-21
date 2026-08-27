import {
  BOARD_PENALTY_MIN,
  BUS_CAPACITY,
  BUS_VEHICLE_UPKEEP,
  CROWDING_PENALTY_MAX_MIN,
  DEFAULT_HEADWAY_MIN,
  MAX_HEADWAY_MIN,
  MIN_HEADWAY_MIN,
  RAIL_SPEED_KMH,
  STOP_DWELL_SEC,
  TRAIN_CAPACITY,
  TRAIN_VEHICLE_UPKEEP,
  WAIT_WEIGHT,
} from '@shared/constants';
import { Mode, ModeBit, TransitKind } from '@shared/enums';
import { BinaryHeap } from '@sim/core/heap';
import { idx, inBounds, tileDistanceM, tileX, tileY } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import type { Graph, TransitLineSpec } from './graph';
import { Pathfinder, type Path } from './pathfinder';
import { traceRailLines } from './railLines';
import { VehicleKind, type TrafficSystem } from './traffic';

/**
 * 公共交通（路線）。**路線 = 順序つき停留所リスト ＋ 運行間隔 ＋ 種別**。
 *
 * 抽象モデル（「線路の上を鉄道モードで歩ける」）をやめて路線を実体にしたのは、
 * バスを渋滞に巻き込むため。バスの区間所要は `TrafficSystem` が実測した
 * 道路リンクの所要時間の和で、しかも実際のバス車両がその道路の車列に混ざる。
 * つまり「幹線を 1 本潰す」と、そこを通るバス路線の所要時間が本当に伸びる。
 * 電車は専用軌道なので距離 ÷ 表定速度のままで、渋滞の影響を受けない。
 * この差が出ることが、路線化のいちばんの目的。
 *
 * グラフ上の表現（プラットフォーム・ノードは `Graph.build()` が作る）:
 *
 *   停留所ノード ──乗車(Board)──> プラットフォーム(k) ──乗車中(Ride)──> プラットフォーム(k+1)
 *                <─降車(Board)──                      <─降車(Board)── 停留所ノード
 *
 * 上り／下りを別々のプラットフォーム列にしてある。1 列に双方向のエッジを張ると、
 * 終点で折り返さずに好きな向きへ乗れてしまう。列を分ければ「その向きの便に乗る」しか
 * 選べなくなり、折り返しは車両の一周時間（＝必要車両数）として正しく効く。
 *
 * ────────────────────────────────────────────────────────
 * 公開 API（simulation.ts から配線するもの）
 * ────────────────────────────────────────────────────────
 *
 * 路線の編集（いずれもグラフの作り直しが要る。呼んだ側で networkVersion を進めること）
 *   createLine(kind, stopTiles, headwayMin?) -> number   路線 id。作れなければ -1
 *   removeLine(id)                          -> boolean
 *   setHeadway(id, min)                     -> boolean   MIN/MAX_HEADWAY_MIN に丸める
 *   lines / lineById(id) / specs()                       参照と graph.build 用の記述
 *
 * ネットワークの作り直し
 *   rebuild(graph, world, stationTiles)      graph.build + 自動路線の同期 + 束ね直しを一括で
 *   rebind(graph)                            graph.build を自分で呼ぶ場合はこちら
 *
 * 毎 tick / 定期的に呼ぶもの
 *   updateCosts(graph, tick)                 edgeFixedSec に運行間隔・区間所要・混雑を書く
 *   dispatchBuses(traffic, tick)             バス車両を道路へ投入する
 *   onVehicleEvent(bus, aborted)             TrafficSystem からの到着・打ち切り通知
 *
 * 集計
 *   countRiders(path, people?)               決まった経路を渡すと区間乗車人数を数える
 *   monthlyUpkeep()                          月次維持費（車両数 × 車両単価）
 *   stats / resetDailyStats()
 *
 * セーブ
 *   toJSON() / loadJSON(data) / reset()      走行中のバスは保存しない
 */

const RAIL_MS = (RAIL_SPEED_KMH * 1000) / 3600;

/**
 * 乗車人数を「時間あたり」に均す窓の長さ（tick = 分）。
 *
 * 経路が決まった瞬間に 1 人ずつ数えるので、生の値は朝ラッシュの数分に固まって出る。
 * そのまま輸送力と比べると、混雑ペナルティが分単位で点いたり消えたりして
 * 経路選択が発振する。1 時間ぶんに均してから比べる。
 */
export const LOAD_WINDOW_TICKS = 60;
/**
 * 窓ごとの乗車人数を平滑化する係数。
 * 1.0 にすると「昨日は空いていた路線が今日は満員」で待ち時間が跳ね、
 * 小さすぎると混雑が待ち時間に出るまで半日かかる。
 */
const LOAD_LAMBDA = 0.5;
/** 停留所の周囲このタイル数以内の線路ノードを、その駅のホームとみなす（graph.build と同じ範囲）。 */
const STATION_RAIL_RADIUS = 2;
/** 区間の線路長を求めるダイクストラの展開上限。線路網は小さいので十分な値。 */
const RAIL_SEARCH_BUDGET = 20_000;
/** 走行中のバスの初期スロット数。 */
const INITIAL_BUS_CAPACITY = 256;

/** 路線 1 本。数十本しかないので TypedArray ではなく普通のオブジェクトで持つ。 */
export interface TransitLine {
  id: number;
  kind: TransitKind;
  /** 停留所のタイル番号（順序つき）。これと運行間隔と種別だけがセーブ対象。 */
  stopTiles: number[];
  headwayMin: number;
  /** 線路から自動生成した路線か。自動路線はセーブせず、ネットワークから作り直す。 */
  auto: boolean;

  // ---- ここから下は rebind() が graph から作り直す派生状態。保存しない。 ----
  /** 実際にグラフへ繋がった停留所の数。2 未満なら路線は機能していない。 */
  stops: number;
  /** stopTiles のうち実際に繋がったもの（駅を壊された停留所は落ちる）。 */
  liveStopTiles: number[];
  /** プラットフォーム・ノード `dir * stops + k`。 */
  platform: Int32Array;
  /** 乗車エッジ `dir * stops + k`。-1 = 張っていない（その向きの終点）。 */
  boardEdge: Int32Array;
  /** 乗車中エッジ `dir * (stops - 1) + j`。 */
  rideEdge: Int32Array;
  /** 区間の所要（秒、停車時間込み）`dir * (stops - 1) + j`。 */
  segSec: Float32Array;
  /** バスの区間ごとの道路リンク列。電車は空。 */
  segEdges: Int32Array[];
  /** バスの片道の走行経路（向きごと）。`TrafficSystem.enter()` に渡す。 */
  runPath: (Path | null)[];
  /** 集計中の区間乗車人数 `dir * (stops - 1) + j`。窓が閉じるとゼロに戻る。 */
  loadAccum: Float32Array;
  /** 平滑化した区間乗車人数（人/時）。混雑ペナルティはこれと輸送力を比べて出す。 */
  loadPerHour: Float32Array;
  /** 次にバスを出す tick（向きごと）。 */
  nextDepart: Int32Array;
  /** 走行中のバス（向きごと）。 */
  inFlight: Int32Array;
}

/** セーブに載せる形。素の JSON にできるものだけ。 */
export interface TransitSave {
  nextId: number;
  lines: { id: number; kind: number; headwayMin: number; stopTiles: number[] }[];
}

export class TransitSystem {
  private readonly lineList: TransitLine[] = [];
  private nextId = 1;

  /** バス経路と線路距離を引くための探索器。決定論のため摂動シードは常に 0。 */
  private readonly finder = new Pathfinder();
  private railDist = new Float64Array(0);
  private railStamp = new Uint32Array(0);
  private railQuery = 0;
  private readonly railHeap = new BinaryHeap(1024);

  /** エッジ → 乗車中エッジが属する路線 id と区間スロット。-1 = 乗車中エッジではない。 */
  private edgeRideLine = new Int32Array(0);
  private edgeRideSlot = new Int32Array(0);
  /** エッジ → 乗車エッジが属する路線 id。-1 = 乗車エッジではない。 */
  private edgeBoardLine = new Int32Array(0);

  // ---- 走行中のバス（SoA） ----
  private busCapacity = 0;
  private busHigh = 0;
  private busFree: number[] = [];
  private busLineId = new Int32Array(0);
  private busDir = new Int8Array(0);
  private busAlive = new Uint8Array(0);

  /** 直近に窓を閉じた tick。 */
  private lastLoadTick = 0;

  readonly stats = {
    /** 路線数（自動生成を含む）。 */
    lines: 0,
    /** 必要車両数の合計。 */
    vehicles: 0,
    /** 走行中のバス。 */
    busesRunning: 0,
    /** その日の乗車回数（乗換は 2 回と数える）。 */
    boardingsToday: 0,
    boardingsYesterday: 0,
    /** その日の延べ区間乗車人数。路線の「混み具合」の素。 */
    riderSegmentsToday: 0,
    /** 累計のバス発車回数。 */
    dispatched: 0,
    /** 渋滞などで打ち切られたバス。多いなら道路が破綻している。 */
    aborted: 0,
  };

  get lines(): readonly TransitLine[] {
    return this.lineList;
  }

  lineById(id: number): TransitLine | undefined {
    return this.lineList.find((l) => l.id === id);
  }

  /** `Graph.build()` に渡す記述。並び順が `graph.transitLines` と 1 対 1 になる。 */
  specs(): TransitLineSpec[] {
    return this.lineList.map((l) => ({ kind: l.kind, stopTiles: l.stopTiles }));
  }

  // ---------------- 路線の編集 ----------------

  /**
   * 路線を作る。停留所が 2 つ未満、または同じタイルの重複しか無いときは -1。
   *
   * ここではタイルが駅かどうか・道路かどうかを見ない。停留所の実体はグラフを
   * 作り直して初めて決まるし、「先に路線を引いてから駅を建てる」順序も許したいため。
   * 繋がらなかった停留所は `rebind()` が黙って落とす。
   */
  createLine(kind: TransitKind, stopTiles: readonly number[], headwayMin = DEFAULT_HEADWAY_MIN): number {
    const tiles = dedupeConsecutive(stopTiles);
    if (tiles.length < 2) return -1;
    const line = makeLine(this.nextId++, kind, tiles, clampHeadway(headwayMin), false);
    this.lineList.push(line);
    this.stats.lines = this.lineList.length;
    return line.id;
  }

  removeLine(id: number): boolean {
    const i = this.lineList.findIndex((l) => l.id === id);
    if (i < 0) return false;
    this.lineList.splice(i, 1);
    this.stats.lines = this.lineList.length;
    // 走行中のバスは経路ごと孤児になる。到着通知が来たら捨てるだけなので、
    // ここでは印を消しておけば足りる（inFlight はもう誰も読まない）。
    for (let b = 0; b < this.busHigh; b++) {
      if (this.busAlive[b] === 1 && this.busLineId[b] === id) this.busLineId[b] = -1;
    }
    return true;
  }

  /** 運行間隔を変える。グラフの作り直しは要らないが、`updateCosts()` を呼ぶまで反映されない。 */
  setHeadway(id: number, headwayMin: number): boolean {
    const line = this.lineById(id);
    if (!line) return false;
    line.headwayMin = clampHeadway(headwayMin);
    return true;
  }

  // ---------------- ネットワークの作り直し ----------------

  /**
   * グラフを路線ごと作り直す。simulation.ts はこれ 1 本を呼べばよい。
   *
   * 自動路線の同期でグラフを 2 度作る場合があるのは、鶏と卵になっているため。
   * プラットフォーム・ノードは `graph.build()` が作るが、自動路線を見つけるには
   * 線路の折れ線（＝作り終えたグラフ）が要る。1 度目で線路を読み、路線が増減したら
   * もう 1 度だけ作り直す。線路を編集した瞬間にしか起きないので実測でも問題にならない。
   */
  rebuild(graph: Graph, world: World, stationTiles: readonly number[]): void {
    graph.build(world, stationTiles, this.specs());
    if (this.syncAutoLines(graph)) graph.build(world, stationTiles, this.specs());
    this.rebind(graph);
  }

  /**
   * グラフ再構築後の束ね直し。`graph.build(world, stations, transit.specs())` の直後に呼ぶ。
   *
   * プラットフォームもエッジも番号が総取っ替えになるので、路線が持っている
   * 派生状態は全部ここで作り直す。乗車人数（loadPerHour）だけは残す。
   * 道路を 1 マス編集するたびに混雑がゼロに戻ると、待ち時間が跳ねて経路が発振する。
   */
  rebind(graph: Graph): void {
    this.edgeRideLine = new Int32Array(graph.edgeCount).fill(-1);
    this.edgeRideSlot = new Int32Array(graph.edgeCount).fill(-1);
    this.edgeBoardLine = new Int32Array(graph.edgeCount).fill(-1);

    // 並びがずれていたら、路線の記述とグラフが別物ということ。
    // 黙って壊れたエッジ番号を書き続けるより、全路線を切り離す方が安全。
    const ok = graph.transitLines.length === this.lineList.length;
    for (let li = 0; li < this.lineList.length; li++) {
      const line = this.lineList[li]!;
      const nodes = ok ? graph.transitLines[li]! : undefined;
      const stops = nodes ? nodes.stopNode.length : 0;
      line.stops = stops;
      if (!nodes || stops < 2) {
        detach(line);
        continue;
      }
      line.liveStopTiles = Array.from(nodes.stopIndex, (k) => line.stopTiles[k]!);
      line.platform = nodes.platform;
      line.boardEdge = nodes.boardEdge;
      line.rideEdge = nodes.rideEdge;
      const segs = (stops - 1) * 2;
      line.segSec = new Float32Array(segs);
      line.segEdges = [];
      line.runPath = [null, null];
      // 乗車人数は路線の形が変わっていなければ引き継ぐ。
      if (line.loadPerHour.length !== segs) {
        line.loadPerHour = new Float32Array(segs);
        line.loadAccum = new Float32Array(segs);
      } else {
        line.loadAccum = new Float32Array(segs);
      }
      for (let s = 0; s < segs; s++) line.segEdges.push(new Int32Array(0));

      if (line.kind === TransitKind.Train) this.bindTrain(graph, line, nodes.stopNode);
      else this.bindBus(graph, line, nodes.stopNode);

      // 運賃は経路の実距離で決まるので、直線距離のままにしない。
      for (let d = 0; d < 2; d++) {
        for (let j = 0; j < stops - 1; j++) {
          const e = line.rideEdge[d * (stops - 1) + j]!;
          if (e < 0) continue;
          this.edgeRideLine[e] = line.id;
          this.edgeRideSlot[e] = d * (stops - 1) + j;
        }
        for (let k = 0; k < stops; k++) {
          const e = line.boardEdge[d * stops + k]!;
          if (e >= 0) this.edgeBoardLine[e] = line.id;
        }
      }
    }
    this.refreshStats();
  }

  /**
   * 電車の区間。線路を実際に辿った長さ ÷ 表定速度。
   *
   * 停留所どうしの直線距離で済ませると、湾曲した路線や大回りの路線が
   * 「速いのに遠回り」という現実にない性質を持ってしまう。線路が繋がっていない
   * 区間（駅だけ置いて線路を敷いていない）は直線距離に落として、
   * 少なくとも所要時間がゼロにはならないようにする。
   */
  private bindTrain(graph: Graph, line: TransitLine, stopNode: Int32Array): void {
    const stops = stopNode.length;
    const railNode = new Int32Array(stops).fill(-1);
    for (let k = 0; k < stops; k++) railNode[k] = nearestRailNode(graph, graph.nodeTile[stopNode[k]!]!);
    for (let j = 0; j < stops - 1; j++) {
      const a = railNode[j]!;
      const b = railNode[j + 1]!;
      let m = a >= 0 && b >= 0 ? this.railDistanceM(graph, a, b) : Infinity;
      if (!Number.isFinite(m)) {
        m = tileDistanceM(graph.nodeTile[stopNode[j]!]!, graph.nodeTile[stopNode[j + 1]!]!);
      }
      const sec = m / RAIL_MS + STOP_DWELL_SEC;
      for (let d = 0; d < 2; d++) {
        line.segSec[d * (stops - 1) + j] = sec;
        const e = line.rideEdge[d * (stops - 1) + j]!;
        if (e >= 0) graph.edgeLenM[e] = m;
      }
    }
  }

  /**
   * バスの区間。停留所間を自動車の経路として引いて、その道路リンク列を覚える。
   *
   * リンク列を持つのが要点で、区間所要は毎回この列の `edgeCarSec`（＝交通流が実測した
   * 所要時間の EMA）を足して出す。バスだけ別に速度を仮定すると、隣を走る車が
   * 30 分かかっている道をバスが 5 分で通ってしまう。
   */
  private bindBus(graph: Graph, line: TransitLine, stopNode: Int32Array): void {
    const stops = stopNode.length;
    for (let d = 0; d < 2; d++) {
      const nodes: number[] = [];
      const edges: number[] = [];
      let lengthM = 0;
      let broken = false;
      for (let j = 0; j < stops - 1; j++) {
        // 上りは j → j+1、下りは j+1 → j。向きごとに引き直すのは、
        // 一方通行が入ったときに往路と復路が別の道になるため。
        const from = d === 0 ? stopNode[j]! : stopNode[j + 1]!;
        const to = d === 0 ? stopNode[j + 1]! : stopNode[j]!;
        const p = this.finder.search(graph, from, to, Mode.Car, 0, RAIL_SEARCH_BUDGET);
        const slot = d * (stops - 1) + j;
        if (!p) {
          // 道路が繋がっていない区間。所要はゼロにせず直線距離で置く
          // （ゼロにすると「乗れば無料でワープできる」区間になる）。
          const m = tileDistanceM(graph.nodeTile[from]!, graph.nodeTile[to]!);
          line.segSec[slot] = m / RAIL_MS + STOP_DWELL_SEC;
          broken = true;
          continue;
        }
        line.segEdges[slot] = p.edges;
        line.segSec[slot] = sumCarSec(graph, p.edges) + STOP_DWELL_SEC;
        const e = line.rideEdge[slot]!;
        if (e >= 0) graph.edgeLenM[e] = p.lengthM;
        if (nodes.length === 0) nodes.push(p.nodes[0]!);
        for (let i = 1; i < p.nodes.length; i++) nodes.push(p.nodes[i]!);
        for (const edge of p.edges) edges.push(edge);
        lengthM += p.lengthM;
      }
      // 1 区間でも繋がっていない路線にはバスを走らせない。
      // 途中で切れた経路を交通流に投入すると、バスが道の途中で消える。
      line.runPath[d] = broken || edges.length === 0
        ? null
        : {
            nodes: Int32Array.from(nodes),
            edges: Int32Array.from(edges),
            costSec: 0,
            lengthM,
            mode: Mode.Car,
            version: graph.version,
          };
    }
  }

  // ---------------- コストの更新 ----------------

  /**
   * 乗降・乗車中エッジの `edgeFixedSec` を書き直す。数分おきに呼べばよい。
   *
   * 経路探索は `edgeCost()` 経由でここに書いた値しか見ない。つまり
   * 「運行間隔を縮めたら経路が変わる」も「道が混んだらバスが遅くなる」も、
   * すべてこの 1 本を通って初めて街に反映される。
   */
  updateCosts(graph: Graph, tick: number): void {
    this.closeLoadWindow(tick);
    for (const line of this.lineList) {
      const stops = line.stops;
      if (stops < 2) continue;
      const segs = stops - 1;
      const bus = line.kind === TransitKind.Bus;
      // 1 時間に運べる人数。運行間隔を縮めるほど増える。
      const capacityPerHour = ((bus ? BUS_CAPACITY : TRAIN_CAPACITY) * 60) / line.headwayMin;
      const waitMin = line.headwayMin / 2;

      for (let d = 0; d < 2; d++) {
        for (let j = 0; j < segs; j++) {
          const slot = d * segs + j;
          if (bus && line.segEdges[slot]!.length > 0) {
            line.segSec[slot] = sumCarSec(graph, line.segEdges[slot]!) + STOP_DWELL_SEC;
          }
          const e = line.rideEdge[slot]!;
          if (e >= 0) graph.edgeFixedSec[e] = line.segSec[slot]!;
        }
        for (let k = 0; k < stops; k++) {
          const e = line.boardEdge[d * stops + k]!;
          if (e < 0) continue;
          // 乗った直後に通る区間の混み具合で値付けする。混んでいる区間へ向かう
          // 乗車だけが重くなるので、「途中から空いてくる路線」も正しく表せる。
          const onward = d === 0 ? d * segs + k : d * segs + (k - 1);
          const load = onward >= 0 && onward < line.loadPerHour.length ? line.loadPerHour[onward]! : 0;
          graph.edgeFixedSec[e] = (BOARD_PENALTY_MIN + waitMin * WAIT_WEIGHT + crowdingMin(load, capacityPerHour, waitMin)) * 60;
        }
      }
    }
    this.refreshStats();
  }

  /** 窓を閉じて、その間の乗車人数を「人/時」に均す。 */
  private closeLoadWindow(tick: number): void {
    const elapsed = tick - this.lastLoadTick;
    if (elapsed < LOAD_WINDOW_TICKS) return;
    this.lastLoadTick = tick;
    for (const line of this.lineList) {
      for (let s = 0; s < line.loadAccum.length; s++) {
        const rate = (line.loadAccum[s]! * 60) / elapsed;
        line.loadPerHour[s] = line.loadPerHour[s]! + LOAD_LAMBDA * (rate - line.loadPerHour[s]!);
        line.loadAccum[s] = 0;
      }
    }
  }

  /**
   * 決まった経路を渡して、区間ごとの乗車人数を数える。市民が経路を選んだ時点で呼ぶ。
   *
   * 車両を 1 台ずつ動かして人を乗せ降ろしする代わりに、経路に含まれる乗車中エッジを
   * 数えるだけで済ませている。輸送力と比べたいのは「その区間を通る人数」であって、
   * 誰がどの便に乗ったかではないため。
   */
  countRiders(path: Path, people = 1): void {
    for (const e of path.edges) {
      if (e < 0 || e >= this.edgeRideLine.length) continue;
      const rideId = this.edgeRideLine[e]!;
      if (rideId >= 0) {
        const line = this.lineById(rideId);
        const slot = this.edgeRideSlot[e]!;
        if (line && slot >= 0 && slot < line.loadAccum.length) {
          line.loadAccum[slot] = line.loadAccum[slot]! + people;
          this.stats.riderSegmentsToday += people;
        }
        continue;
      }
      if (this.edgeBoardLine[e]! >= 0) this.stats.boardingsToday += people;
    }
  }

  // ---------------- バスの配車 ----------------

  /**
   * 運行間隔ごとにバスを 1 台、道路へ送り出す。毎 tick 呼んでよい。
   *
   * 台数を数えて「必要車両数だけ常に走らせる」のではなく、時刻表どおりに出して
   * 着いたら消す。渋滞で遅れれば道路上のバスが自然に増えて、その増えたバスが
   * さらに道路を占有する。これが起きてほしい挙動なので、台数で蓋をしない
   * （暴走だけは上限で止める）。
   */
  dispatchBuses(traffic: TrafficSystem, tick: number): void {
    for (const line of this.lineList) {
      if (line.kind !== TransitKind.Bus || line.stops < 2) continue;
      for (let d = 0; d < 2; d++) {
        if (tick < line.nextDepart[d]!) continue;
        const path = line.runPath[d];
        if (!path) {
          line.nextDepart[d] = tick + line.headwayMin;
          continue;
        }
        // 遅延で溜まったぶんを一気に吐き出さないための蓋。
        const limit = Math.max(2, this.vehicleCount(line));
        if (line.inFlight[d]! >= limit) {
          line.nextDepart[d] = tick + line.headwayMin;
          continue;
        }
        const slot = this.allocBus();
        if (slot < 0) return;
        // 出口のリンクが満杯なら発車できない。次の tick に出直す（時刻は進めない）。
        if (traffic.enter(path, VehicleKind.Bus, slot, tick) < 0) {
          this.freeBus(slot);
          continue;
        }
        this.busLineId[slot] = line.id;
        this.busDir[slot] = d;
        this.busAlive[slot] = 1;
        line.inFlight[d] = line.inFlight[d]! + 1;
        line.nextDepart[d] = tick + line.headwayMin;
        this.stats.dispatched++;
      }
    }
    this.refreshBusStats();
  }

  /** `TrafficSystem.events` の `VehicleKind.Bus` をここへ流す。 */
  /** そのバス車両が走っている路線の id。-1 = 路線が消えた。描画で色を決めるのに使う。 */
  lineOfBus(bus: number): number {
    if (bus < 0 || bus >= this.busHigh || this.busAlive[bus] !== 1) return -1;
    return this.busLineId[bus]!;
  }

  onVehicleEvent(bus: number, aborted: boolean): void {
    if (bus < 0 || bus >= this.busHigh || this.busAlive[bus] !== 1) return;
    const line = this.lineById(this.busLineId[bus]!);
    if (line) {
      const d = this.busDir[bus]!;
      line.inFlight[d] = Math.max(0, line.inFlight[d]! - 1);
    }
    if (aborted) this.stats.aborted++;
    this.freeBus(bus);
    this.refreshBusStats();
  }

  private allocBus(): number {
    const reused = this.busFree.pop();
    if (reused !== undefined) return reused;
    const slot = this.busHigh++;
    if (slot >= this.busCapacity) {
      const cap = this.busCapacity === 0 ? INITIAL_BUS_CAPACITY : this.busCapacity * 2;
      const lineIds = new Int32Array(cap);
      lineIds.set(this.busLineId);
      this.busLineId = lineIds;
      const dirs = new Int8Array(cap);
      dirs.set(this.busDir);
      this.busDir = dirs;
      const alive = new Uint8Array(cap);
      alive.set(this.busAlive);
      this.busAlive = alive;
      this.busCapacity = cap;
    }
    return slot;
  }

  private freeBus(bus: number): void {
    this.busAlive[bus] = 0;
    this.busLineId[bus] = -1;
    this.busFree.push(bus);
  }

  // ---------------- 自動路線 ----------------

  /**
   * 線路の折れ線ごとに、端から端までの電車路線を自動生成する。
   *
   * 線路を敷いて駅を置いただけで電車が走らなくなるのは明らかな後退なので、
   * プレイヤが路線を引かなくても既定の路線が 1 本ある状態にする。
   * 手で作った路線には触らない（`auto` で区別する）。
   *
   * @returns 自動路線の集合が変わったか。変わったならグラフを作り直す必要がある。
   */
  syncAutoLines(graph: Graph): boolean {
    // プレイヤが自分で電車路線を引いた駅の一覧。
    // ここを見ずに機械的に生成すると、同じ線路に自動路線が二重に載り、
    // プレイヤが運行間隔を延ばしても「もう 1 本の見えない路線」が
    // 待ち時間を肩代わりしてしまって設定が効かなくなる。
    const manualStops = new Set<number>();
    for (const l of this.lineList) {
      if (l.auto || l.kind !== TransitKind.Train) continue;
      for (const t of l.stopTiles) manualStops.add(t);
    }

    const wanted: number[][] = [];
    for (const rl of traceRailLines(graph)) {
      if (!rl.served) continue;
      const stops: number[] = [];
      const seen = new Set<number>();
      for (const u of rl.nodes) {
        for (const st of stationsNear(graph, graph.nodeTile[u]!)) {
          if (seen.has(st)) continue;
          seen.add(st);
          stops.push(st);
        }
      }
      if (stops.length < 2) continue;
      // 手動路線がこの線路の駅を 2 つ以上使っているなら、そこはもう任せる。
      let covered = 0;
      for (const st of stops) if (manualStops.has(st)) covered++;
      if (covered >= 2) continue;
      wanted.push(stops);
    }

    const current = this.lineList.filter((l) => l.auto);
    if (current.length === wanted.length && current.every((l, i) => sameTiles(l.stopTiles, wanted[i]!))) {
      return false;
    }
    // 運行間隔だけは引き継ぐ。線路を 1 マス伸ばすたびにプレイヤの設定が
    // 既定値へ戻るのは、操作としてただの嫌がらせになる。
    const headways = current.map((l) => l.headwayMin);
    for (let i = this.lineList.length - 1; i >= 0; i--) {
      if (this.lineList[i]!.auto) this.lineList.splice(i, 1);
    }
    for (let i = 0; i < wanted.length; i++) {
      this.lineList.push(
        makeLine(this.nextId++, TransitKind.Train, wanted[i]!, headways[i] ?? DEFAULT_HEADWAY_MIN, true),
      );
    }
    this.stats.lines = this.lineList.length;
    return true;
  }

  // ---------------- 車両数・費用・統計 ----------------

  /** 一周（往復）の所要（秒）。折り返しはここに出る。 */
  cycleSec(line: TransitLine): number {
    let sum = 0;
    for (let s = 0; s < line.segSec.length; s++) sum += line.segSec[s]!;
    return sum;
  }

  /** 必要車両数 = ceil(一周の所要 / 運行間隔)。運行間隔を縮めるほど増える。 */
  vehicleCount(line: TransitLine): number {
    if (line.stops < 2) return 0;
    return Math.max(1, Math.ceil(this.cycleSec(line) / 60 / line.headwayMin));
  }

  /** 月次維持費（円）。運転士の人件費が主なので、車両数にそのまま比例する。 */
  monthlyUpkeep(): number {
    let sum = 0;
    for (const line of this.lineList) {
      const per = line.kind === TransitKind.Bus ? BUS_VEHICLE_UPKEEP : TRAIN_VEHICLE_UPKEEP;
      sum += this.vehicleCount(line) * per;
    }
    return sum;
  }

  private refreshStats(): void {
    this.stats.lines = this.lineList.length;
    let vehicles = 0;
    for (const line of this.lineList) vehicles += this.vehicleCount(line);
    this.stats.vehicles = vehicles;
    this.refreshBusStats();
  }

  private refreshBusStats(): void {
    let running = 0;
    for (let b = 0; b < this.busHigh; b++) if (this.busAlive[b] === 1) running++;
    this.stats.busesRunning = running;
  }

  resetDailyStats(): void {
    // 前日ぶんを残す。日の境界の直後に統計を読むと（ヘッドレスの最終出力など）
    // 当日ぶんはまだ 0 で、「誰も乗っていない」ように見えてしまう。
    this.stats.boardingsYesterday = this.stats.boardingsToday;
    this.stats.boardingsToday = 0;
    this.stats.riderSegmentsToday = 0;
  }

  // ---------------- セーブ・ロード ----------------

  /**
   * 素の JSON へ。**走行中のバスは保存しない**。
   * 経路がノード番号への参照なので、読み込み後のグラフでは別の場所を指してしまう
   * （トラックと同じ扱い）。次の運行間隔ぶん待てば出直してくる。
   * 自動路線も保存しない。線路と駅から決定論的に作り直せるものを二重に持つと、
   * セーブデータと実際のネットワークが食い違ったときに直しようがなくなる。
   */
  toJSON(): TransitSave {
    return {
      nextId: this.nextId,
      lines: this.lineList
        .filter((l) => !l.auto)
        .map((l) => ({ id: l.id, kind: l.kind, headwayMin: l.headwayMin, stopTiles: l.stopTiles.slice() })),
    };
  }

  loadJSON(data: unknown): void {
    this.reset();
    const save = data as Partial<TransitSave> | null | undefined;
    if (!save || !Array.isArray(save.lines)) return;
    for (const raw of save.lines) {
      if (!raw || !Array.isArray(raw.stopTiles)) continue;
      const tiles = dedupeConsecutive(raw.stopTiles.map((t) => Math.floor(t)));
      if (tiles.length < 2) continue;
      const kind = raw.kind === TransitKind.Bus ? TransitKind.Bus : TransitKind.Train;
      const id = Number.isFinite(raw.id) ? Math.floor(raw.id as number) : this.nextId;
      this.lineList.push(makeLine(id, kind, tiles, clampHeadway(raw.headwayMin ?? DEFAULT_HEADWAY_MIN), false));
      this.nextId = Math.max(this.nextId, id + 1);
    }
    if (Number.isFinite(save.nextId)) this.nextId = Math.max(this.nextId, Math.floor(save.nextId as number));
    this.stats.lines = this.lineList.length;
  }

  /** 全部捨てる。セーブの読み込み前に呼ぶ。 */
  reset(): void {
    this.lineList.length = 0;
    this.nextId = 1;
    this.lastLoadTick = 0;
    this.busHigh = 0;
    this.busFree.length = 0;
    this.busAlive.fill(0);
    this.edgeRideLine = new Int32Array(0);
    this.edgeRideSlot = new Int32Array(0);
    this.edgeBoardLine = new Int32Array(0);
    this.stats.lines = 0;
    this.stats.vehicles = 0;
    this.stats.busesRunning = 0;
    this.stats.dispatched = 0;
    this.stats.aborted = 0;
    this.resetDailyStats();
  }

  // ---------------- 線路上の距離 ----------------

  /**
   * 線路エッジだけを辿った a → b の距離 (m)。届かなければ Infinity。
   *
   * `Pathfinder` を使えないのは、鉄道ビットがどのモードのマスクにも
   * 入っていないため（乗客はプラットフォームを渡り歩くので、線路の上は歩けない）。
   * 線路網はタイル数千のオーダーなので、素直なダイクストラで足りる。
   */
  private railDistanceM(graph: Graph, a: number, b: number): number {
    if (a === b) return 0;
    if (this.railDist.length < graph.nodeCount) {
      this.railDist = new Float64Array(graph.nodeCount);
      this.railStamp = new Uint32Array(graph.nodeCount);
      this.railQuery = 0;
    }
    const qid = ++this.railQuery;
    if (qid === 0xffffffff) {
      this.railStamp.fill(0);
      this.railQuery = 1;
    }
    this.railHeap.clear();
    this.railDist[a] = 0;
    this.railStamp[a] = qid;
    this.railHeap.push(0, a);
    let expansions = 0;
    while (this.railHeap.size > 0) {
      const u = this.railHeap.pop();
      if (u === b) return this.railDist[u]!;
      if (++expansions > RAIL_SEARCH_BUDGET) break;
      const du = this.railDist[u]!;
      const e1 = graph.edgeStart[u + 1]!;
      for (let e = graph.edgeStart[u]!; e < e1; e++) {
        if ((graph.edgeMask[e]! & ModeBit.Rail) === 0) continue;
        const v = graph.edgeTo[e]!;
        const nd = du + graph.edgeLenM[e]!;
        if (this.railStamp[v] === qid && this.railDist[v]! <= nd) continue;
        this.railStamp[v] = qid;
        this.railDist[v] = nd;
        this.railHeap.push(nd, v);
      }
    }
    return Infinity;
  }
}

// ---------------- 補助 ----------------

function clampHeadway(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_HEADWAY_MIN;
  return Math.max(MIN_HEADWAY_MIN, Math.min(MAX_HEADWAY_MIN, min));
}

/** 同じタイルが続いているところを畳む。停留所が 0 距離だと区間所要が 0 になる。 */
function dedupeConsecutive(tiles: readonly number[]): number[] {
  const out: number[] = [];
  for (const t of tiles) {
    if (!Number.isFinite(t) || t < 0) continue;
    if (out.length > 0 && out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
}

function sameTiles(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function makeLine(
  id: number,
  kind: TransitKind,
  stopTiles: number[],
  headwayMin: number,
  auto: boolean,
): TransitLine {
  return {
    id,
    kind,
    stopTiles,
    headwayMin,
    auto,
    stops: 0,
    liveStopTiles: [],
    platform: new Int32Array(0),
    boardEdge: new Int32Array(0),
    rideEdge: new Int32Array(0),
    segSec: new Float32Array(0),
    segEdges: [],
    runPath: [null, null],
    loadAccum: new Float32Array(0),
    loadPerHour: new Float32Array(0),
    nextDepart: new Int32Array(2),
    inFlight: new Int32Array(2),
  };
}

/** グラフから切り離す（停留所が足りない・駅を壊された路線）。 */
function detach(line: TransitLine): void {
  line.stops = 0;
  line.liveStopTiles = [];
  line.platform = new Int32Array(0);
  line.boardEdge = new Int32Array(0);
  line.rideEdge = new Int32Array(0);
  line.segSec = new Float32Array(0);
  line.segEdges = [];
  line.runPath = [null, null];
}

/** リンク列の実測所要（秒）の和。バスの区間所要はこれがすべて。 */
function sumCarSec(graph: Graph, edges: Int32Array): number {
  let sum = 0;
  for (const e of edges) sum += graph.edgeCarSec[e]!;
  return sum;
}

/**
 * 混雑ペナルティ（分）。定員を超えたぶんを待ち時間に上乗せする ＝ 積み残し。
 *
 * 乗車人数が輸送力の r 倍なら、平均して r 回に 1 回しか乗れない ＝
 * 待ち時間が (r - 1) 本ぶん余計にかかる、という素朴な見立て。
 * 上限を置くのは、一度あふれた路線のコストが無限に伸びて
 * 「誰も乗らない → 空く → 全員戻る」の振動になるのを防ぐため。
 */
function crowdingMin(loadPerHour: number, capacityPerHour: number, waitMin: number): number {
  if (capacityPerHour <= 0 || loadPerHour <= capacityPerHour) return 0;
  const excess = loadPerHour / capacityPerHour - 1;
  return Math.min(CROWDING_PENALTY_MAX_MIN, excess * waitMin * WAIT_WEIGHT);
}

/** タイル t の周囲にある駅タイル（グラフの徒歩接続と同じ範囲）。 */
function stationsNear(graph: Graph, t: number): number[] {
  const out: number[] = [];
  const x = tileX(t);
  const y = tileY(t);
  for (let dy = -STATION_RAIL_RADIUS; dy <= STATION_RAIL_RADIUS; dy++) {
    for (let dx = -STATION_RAIL_RADIUS; dx <= STATION_RAIL_RADIUS; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (graph.stationNodeAt[j]! >= 0) out.push(j);
    }
  }
  return out;
}

/** 駅タイルのいちばん近くにある線路ノード。見つからなければ -1。 */
function nearestRailNode(graph: Graph, t: number): number {
  const x = tileX(t);
  const y = tileY(t);
  let best = -1;
  let bestD = Infinity;
  for (let dy = -STATION_RAIL_RADIUS; dy <= STATION_RAIL_RADIUS; dy++) {
    for (let dx = -STATION_RAIL_RADIUS; dx <= STATION_RAIL_RADIUS; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      const n = graph.railNodeAt[idx(x + dx, y + dy)]!;
      if (n < 0) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
  }
  return best;
}
