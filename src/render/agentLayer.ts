import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshLambertMaterial, Object3D, Quaternion, Vector3 } from 'three';
import {
  AGENT_DRAW_DISTANCE_M,
  LANE_OFFSET_M,
  MAP_H,
  MAP_W,
  MAX_VISIBLE_AGENTS,
  MAX_VISIBLE_TRAIN_CARS,
  MAX_VISIBLE_BUSES,
  MAX_VISIBLE_TRUCKS,
  MAX_VISIBLE_VEHICLES,
  PARKED_CARS_PER_TILE,
  PARKED_CAR_LOD_DISTANCE_M,
  PEDESTRIAN_LOD_DISTANCE_M,
  TERRAIN_HEIGHT_SCALE,
  TILE_M,
  TRAIN_CARS,
  TRAIN_CAR_LENGTH_M,
  TRAIN_DRAW_DISTANCE_M,
  VEHICLE_DRAW_DISTANCE_M,
} from '@shared/constants';
import { Activity, Mode, ModeBit } from '@shared/enums';
import { citizenPosition } from '@sim/agents/activity';
import { CitizenFlag } from '@sim/agents/citizens';
import { handleSlot } from '@sim/buildings/buildings';
import type { Simulation } from '@sim/simulation';
import { TruckState } from '@sim/economy/freight';
import { type PathPose } from '@sim/network/pathfinder';
import { VehicleKind } from '@sim/network/traffic';
import {
  TRAIN_CAR_PITCH_M,
  railPoseAt,
  traceRailLines,
  trainHeads,
  type RailLine,
  type RailPose,
  type TrainHead,
} from '@sim/network/railLines';
import { CARGO_COLORS, TRAIN_BODY_COLOR, TRAIN_HEAD_COLOR, carColor, lineColor } from './theme';

/** 1 フレームで進行方向をどれだけ目標へ寄せるか。1 = 即座（＝スナップ）。 */
const HEADING_SMOOTHING = 0.15;
import { idx, tileX, tileY } from '@sim/world/tiles';

/**
 * 移動中の市民と車両の描画。
 *
 * 位置はシミュレーションが毎 tick 更新しているのではなく、
 * (出発 tick, 到着 tick, 経路) から描画時に補間して求める。
 * これにより 1 万人分の座標更新を毎 tick 走らせずに済む。
 * さらに端数 tick を受け取って補間するので、×1 で 0.75 tick/秒しか進まない
 * シミュレーションでも 60fps で連続的に動いて見える
 * （整数 tick で補間すると 1.33 秒に 1 コマのカクつきになる）。
 *
 * カメラの近くにいるエージェントだけをインスタンス化する。
 * 引きの画では点にしかならないものに描画予算を使わない。
 */
export class AgentLayer {
  readonly group = new Object3D();
  private readonly meshes: InstancedMesh[] = [];
  private readonly pedestrians: InstancedMesh;
  private readonly cars: InstancedMesh;
  private readonly trains: InstancedMesh;
  private readonly trucks: InstancedMesh;
  private readonly buses: InstancedMesh;
  private readonly materials: MeshLambertMaterial[] = [];

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3(1, 1, 1);
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();
  private readonly tmp: PathPose = { x: 0, z: 0, heading: 0, edge: -1 };

  /** 線路の折れ線。グラフが作り直されたときだけ再計算する。 */
  private railLines: RailLine[] = [];
  private railLinesVersion = -1;
  /** 編成の先頭位置の受け皿（毎フレーム使い回す）。 */
  private readonly heads: TrainHead[] = Array.from({ length: 64 }, () => ({ distM: 0, forward: true }));
  private readonly railPose: RailPose = { x: 0, z: 0, heading: 0 };
  /** 接道タイル → そのタイルに既に置いた駐車台数。毎フレーム clear して使い回す。 */
  private readonly parkSlots = new Map<number, number>();

  /** 直近フレームで描いた数（デバッグ表示用）。 */
  visiblePedestrians = 0;
  visibleVehicles = 0;

  /**
   * ワールド座標の地面の高さ (m)。
   *
   * 建物は標高の上に置いているのに、人や車だけ y=0 に置くと地面に埋まって
   * 一切見えなくなる。平野でも標高は数 m あるので、必ず地形に合わせる。
   */
  private groundAt(sim: Simulation, x: number, z: number): number {
    const tx = Math.max(0, Math.min(MAP_W - 1, Math.floor(x / TILE_M)));
    const tz = Math.max(0, Math.min(MAP_H - 1, Math.floor(z / TILE_M)));
    return sim.world.heightDm[idx(tx, tz)]! * TERRAIN_HEIGHT_SCALE;
  }

  constructor() {
    this.group.name = 'agents';

    const mk = (w: number, h: number, d: number, cap: number): InstancedMesh => {
      const geom = new BoxGeometry(w, h, d);
      geom.translate(0, h / 2, 0);
      // 建物と同じ理由で vertexColors は付けない（instanceColor だけを使う）
      const mat = new MeshLambertMaterial({});
      this.materials.push(mat);
      const mesh = new InstancedMesh(geom, mat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };

    // 人は実寸（肩幅 0.55m・身長 1.75m）。近景で見たときに建物や車と
    // 縮尺が合っていないと、街の大きさが読み取れなくなる。
    // 車両も同様に実寸。箱の長辺は必ず +Z 側（heading をそのまま Y 回転に使うため）。
    this.pedestrians = mk(0.55, 1.75, 0.35, MAX_VISIBLE_AGENTS);
    this.cars = mk(1.7, 1.45, 4.2, MAX_VISIBLE_VEHICLES);
    this.trains = mk(2.9, 3.6, TRAIN_CAR_LENGTH_M, MAX_VISIBLE_TRAIN_CARS);
    this.trucks = mk(2.2, 2.6, 6.5, MAX_VISIBLE_TRUCKS);
    // 路線バス。実車 11m は車 1 台（画面上 4.2＝実車 9 台の車列）の 3 分の 1 ほどだが、
    // それだと近景で車と見分けが付かないので、少し長めに描く。
    this.buses = mk(2.4, 3.0, 7.5, MAX_VISIBLE_BUSES);
  }

  /**
   * 進行方向の左へのオフセット。日本は左側通行なので、これを掛けないと
   * 対向車が中心線上で重なって「流れ」に見えない。
   * 前方 = (sin h, cos h)、左 = 上 × 前方 = (cos h, -sin h)。
   */
  /** 車両スロットごとの直前の向きと、そのときの出発 tick。 */
  private headingOf = new Float32Array(0);
  private headingTag = new Int32Array(0);

  private laneOffsetX(heading: number, side: number): number {
    return Math.cos(heading) * side;
  }
  private laneOffsetZ(heading: number, side: number): number {
    return -Math.sin(heading) * side;
  }

  /**
   * @param camDistance カメラと注視点の距離 (m)。これで描画範囲を決める。
   *   ズームインするほど「近くを密に」、引くほど「歩行者は省く」。
   * @param tickFraction 直近 tick からの端数 (0..1)。滑らかな補間に使う。
   */
  update(sim: Simulation, camX: number, camZ: number, camDistance: number, tickFraction = 0): void {
    let ped = 0;
    let car = 0;
    /**
     * 描画する時刻。**直前に計算し終えた tick の中**をなぞる。
     *
     * `clock.tick` は tick の最後に加算されるので、`clock.tick + 端数` は
     * まだ計算していない未来を指す。車は 1 tick に平均 4 リンク進むので、
     * それだと端数 0 の瞬間から既に「最後のリンクの終端」に着いていて、
     * 毎 tick「4 マス瞬間移動 → 停止線で待つ」に見える。
     */
    const tick = sim.clock.tick - 1 + Math.max(0, Math.min(1, tickFraction));

    // 歩行者は寄ったときだけ描く。引きの画では 1px 未満にしかならず、
    // 描画予算だけを食って何も見えない。
    const drawPedestrians = camDistance < PEDESTRIAN_LOD_DISTANCE_M;
    // 描画半径はカメラの距離に連動させる。寄ればその周辺だけを、
    // 少し引けば広く（ただし上限は設ける）。
    const pedRadius = Math.min(AGENT_DRAW_DISTANCE_M, camDistance * 2.4);
    const pedDist2 = pedRadius * pedRadius;
    const vehRadius = Math.min(VEHICLE_DRAW_DISTANCE_M, Math.max(500, camDistance * 2.2));
    const vehDist2 = vehRadius * vehRadius;
    const trainDist2 = TRAIN_DRAW_DISTANCE_M * TRAIN_DRAW_DISTANCE_M;

    const c = sim.citizens;
    // 引きの画では 1 人も描かないので、走査自体を丸ごと飛ばす。
    // 以前はここを回り続けて、全員ぶんの citizenPosition（経路のエッジを線形走査）を
    // 毎フレーム計算してから捨てていた。
    for (let id = 0; drawPedestrians && id < c.high; id++) {
      if (ped >= MAX_VISIBLE_AGENTS) break;
      if (!c.isAlive(id)) continue;
      if (c.state[id] !== Activity.Traveling) continue;
      const mode = c.mode[id]! as Mode;
      // 自動車は交通流が位置を持っているので、下の drawVehicles で描く。
      // ここで経路長から補間すると、信号待ちで止まっている車が走り続けてしまう。
      if (mode === Mode.Car) continue;
      if (!citizenPosition(c, sim.graph, id, tick, this.tmp)) continue;

      // 今どのエッジの上にいるかで見た目を決める。
      // 自動車の経路は両端に徒歩区間を含み（駐車して歩く）、鉄道の経路は
      // 両端に駅までの徒歩区間を含む。モードだけで判定すると
      // 「歩道を走る車」や「線路を降りて歩道を歩く電車」になる。
      const bits = this.tmp.edge >= 0 ? sim.graph.edgeMask[this.tmp.edge]! : 0;
      // 線路上の鉄道利用者は電車の中にいるので描かない（電車の方を描く）
      if (mode === Mode.Transit && bits & ModeBit.Rail) continue;

      const dx = this.tmp.x - camX;
      const dz = this.tmp.z - camZ;
      if (dx * dx + dz * dz > pedDist2) continue;

      const groundY = this.groundAt(sim, this.tmp.x, this.tmp.z) + 0.05;
      this.quat.setFromAxisAngle(this.axisY, this.tmp.heading);

      // 道路の中央ではなく端を歩かせる。全員が真ん中を一列で進むと、
      // 近景で見たときに人の流れではなく点線に見える。
      // 車道の外側になるよう、車線より外に置く。
      const side = LANE_OFFSET_M + 1.2 + ((id >> 1) % 3) * 0.7;
      this.pos.set(
        this.tmp.x + this.laneOffsetX(this.tmp.heading, side),
        groundY,
        this.tmp.z + this.laneOffsetZ(this.tmp.heading, side),
      );
      this.mat.compose(this.pos, this.quat, this.scl);
      this.pedestrians.setMatrixAt(ped, this.mat);
      // 服の色を人ごとに散らす。自転車は目立つ色にして見分けられるようにする。
      if (mode === Mode.Bike) {
        this.color.setHex(0xe08a3a);
      } else {
        const h = (id * 2654435761) >>> 0;
        this.color.setHSL(((h >>> 8) % 360) / 360, 0.28, 0.52 + ((h >>> 20) % 24) / 100);
      }
      this.pedestrians.setColorAt(ped, this.color);
      ped++;
    }

    // --- 立ち寄り中の市民 ---
    // 屋外に出すのは買い物中とレジャー中だけ。
    //
    // 以前は在宅・勤務中・通学中まで建物の玄関前に立たせていたが、位置が ID の
    // ハッシュで固定なので、同じ人が同じ場所に一日じゅう立ち尽くす街になっていた。
    // 買い物とレジャーは滞在が 2 時間程度で終わるので、時間とともに入れ替わる。
    if (drawPedestrians && ped < MAX_VISIBLE_AGENTS) {
      const b = sim.buildings;
      for (let id = 0; id < c.high && ped < MAX_VISIBLE_AGENTS; id++) {
        if (!c.isAlive(id)) continue;
        const st = c.state[id]!;
        if (st !== Activity.Shopping && st !== Activity.Leisure) continue;

        const tile = c.currentTile[id]!;
        // 建物のタイル中心に置くと、人が家の中に埋まって見えない。
        // その建物の接道タイル（＝玄関前の道路）に立たせる。
        // 結果として人は通りに出るので、近景で街に人がいることが分かる。
        const ref = sim.world.buildingRef[tile]!;
        let standTile = tile;
        if (ref !== 0 && b.alive[ref - 1] === 1 && b.accessTile[ref - 1]! >= 0) {
          standTile = b.accessTile[ref - 1]!;
        }
        const wx = (tileX(standTile) + 0.5) * TILE_M;
        const wz = (tileY(standTile) + 0.5) * TILE_M;
        const dx = wx - camX;
        const dz = wz - camZ;
        if (dx * dx + dz * dz > pedDist2) continue;

        // タイル内に散らす（毎フレーム同じ位置になるよう ID から決める）
        const h = (id * 2654435761) >>> 0;
        const spread = TILE_M * 0.8;
        const ox = (((h >>> 4) % 100) / 100 - 0.5) * spread;
        const oz = (((h >>> 12) % 100) / 100 - 0.5) * spread;

        this.quat.setFromAxisAngle(this.axisY, ((h >>> 24) % 360) * (Math.PI / 180));
        this.pos.set(wx + ox, this.groundAt(sim, wx + ox, wz + oz) + 0.05, wz + oz);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.pedestrians.setMatrixAt(ped, this.mat);
        this.color.setHSL(((h >>> 8) % 360) / 360, 0.26, 0.5 + ((h >>> 20) % 24) / 100);
        this.pedestrians.setColorAt(ped, this.color);
        ped++;
      }
    }

    const drawn = this.drawVehicles(sim, camX, camZ, vehDist2, tick, car);
    car = drawn.cars;
    const truck = drawn.trucks;
    car = this.drawParkedCars(sim, camX, camZ, camDistance, pedDist2, car);
    const train = this.drawTrains(sim, camX, camZ, trainDist2, tick);

    this.pedestrians.count = ped;
    this.cars.count = car;
    this.trains.count = train;
    this.trucks.count = truck;
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.visiblePedestrians = ped;
    this.visibleVehicles = car + train + truck;
  }

  /**
   * 路上駐車。
   *
   * 走行中の車だけを描くと、街に自家用車がほとんど映らない。
   * トリップは平均 3〜5 分しかないので、どの瞬間を切り取っても
   * 移動中の市民は全人口の 0.3% 程度しかいないため（人口 1300 人で同時 4 人）。
   * 車の大半は 1 日のほとんどを停まって過ごす。それを描くのが実態に近く、
   * 「この街には自家用車がこれだけある」がひと目で分かるようになる。
   *
   * 車の置き場所は「最後に使った交通手段」から決まる。車で出勤した人の車は
   * 職場に、電車で出勤した人の車は自宅に停まっている。
   *
   * @param from 走行中の車で既に使ったインスタンス数。続きから書き込む。
   * @returns 書き込み後のインスタンス数。
   */
  private drawParkedCars(
    sim: Simulation,
    camX: number,
    camZ: number,
    camDistance: number,
    maxDist2: number,
    from: number,
  ): number {
    if (camDistance >= PARKED_CAR_LOD_DISTANCE_M) return from;
    let n = from;
    const c = sim.citizens;
    const b = sim.buildings;
    this.parkSlots.clear();

    for (let id = 0; id < c.high && n < MAX_VISIBLE_VEHICLES; id++) {
      if (!c.isAlive(id)) continue;
      if (!c.has(id, CitizenFlag.OwnsCar)) continue;
      const state = c.state[id]!;
      // 運転中の車は道路の上に描かれている
      if (state === Activity.Traveling && c.mode[id] === Mode.Car) continue;

      // 車で来ているなら今いる建物、そうでなければ自宅に停まっている
      let slot = -1;
      if (c.mode[id] === Mode.Car && state !== Activity.Sleeping && state !== Activity.AtHome) {
        const ref = sim.world.buildingRef[c.currentTile[id]!]!;
        if (ref !== 0 && b.alive[ref - 1] === 1) slot = ref - 1;
      }
      if (slot < 0) {
        const home = handleSlot(c.homeBuilding[id]!);
        if (home >= 0 && b.alive[home] === 1) slot = home;
      }
      if (slot < 0) continue;
      const access = b.accessTile[slot]!;
      if (access < 0) continue;

      // 同じ接道タイルに何台も重ねない
      const wx = (tileX(access) + 0.5) * TILE_M;
      const wz = (tileY(access) + 0.5) * TILE_M;
      const dx = wx - camX;
      const dz = wz - camZ;
      // 距離の判定を駐車枠の確保より先に置く。逆にすると、視野の外にいて
      // 描かない車が枠を潰し、境界のタイルに本来より少ない台数しか並ばない。
      if (dx * dx + dz * dz > maxDist2) continue;

      const used = this.parkSlots.get(access) ?? 0;
      if (used >= PARKED_CARS_PER_TILE) continue;
      this.parkSlots.set(access, used + 1);

      // 道路の走っている向きに沿って縦列駐車させる。
      // 向きを見ずに置くと、車が道路を跨いで横向きに刺さる。
      const conn = sim.world.roadConn(access);
      const alongZ = (conn & 0b0101) !== 0 || conn === 0;
      const heading = alongZ ? 0 : Math.PI / 2;
      // 2 台ずつ、道路の左右の路肩に分ける
      const along = ((used >> 1) - 0.5) * 4.8;
      const curb = (used & 1 ? 1 : -1) * (LANE_OFFSET_M + 1.6);
      const ox = alongZ ? curb : along;
      const oz = alongZ ? along : curb;

      this.quat.setFromAxisAngle(this.axisY, heading);
      this.pos.set(wx + ox, this.groundAt(sim, wx + ox, wz + oz) + 0.05, wz + oz);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.cars.setMatrixAt(n, this.mat);
      this.color.setHex(carColor((id * 2654435761) >>> 0));
      this.cars.setColorAt(n, this.color);
      n++;
    }
    return n;
  }

  /**
   * 電車。線路の折れ線を端から端へ往復させる。
   *
   * 鉄道利用者を電車として描く（以前の実装）と、鉄道経路の両端の徒歩区間まで
   * 電車の姿で歩道を歩くことになる。運行そのものを描く方が正しく、かつ
   * 「線路を敷いたのに駅が無い」がひと目で分かるようになる。
   *
   * @returns 描いた車両数（編成数ではない）。
   */
  private drawTrains(sim: Simulation, camX: number, camZ: number, maxDist2: number, tick: number): number {
    if (this.railLinesVersion !== sim.graph.version) {
      this.railLines = traceRailLines(sim.graph);
      this.railLinesVersion = sim.graph.version;
    }
    let n = 0;
    for (const line of this.railLines) {
      if (n >= MAX_VISIBLE_TRAIN_CARS) break;
      const heads = trainHeads(line, tick, this.heads);
      for (let k = 0; k < heads && n < MAX_VISIBLE_TRAIN_CARS; k++) {
        const head = this.heads[k]!;
        const dir = head.forward ? 1 : -1;
        for (let carIdx = 0; carIdx < TRAIN_CARS && n < MAX_VISIBLE_TRAIN_CARS; carIdx++) {
          // 後続車は先頭から編成長ぶん後ろに付く
          const d = head.distM - dir * carIdx * TRAIN_CAR_PITCH_M;
          if (d < 0 || d > line.lengthM) continue;
          if (!railPoseAt(sim.graph, line, d, head.forward, this.railPose)) continue;
          const dx = this.railPose.x - camX;
          const dz = this.railPose.z - camZ;
          if (dx * dx + dz * dz > maxDist2) continue;
          this.quat.setFromAxisAngle(this.axisY, this.railPose.heading);
          // 線路は地面より一段高い扱い（軌道敷ぶん）
          this.pos.set(
            this.railPose.x,
            this.groundAt(sim, this.railPose.x, this.railPose.z) + 0.6,
            this.railPose.z,
          );
          this.mat.compose(this.pos, this.quat, this.scl);
          this.trains.setMatrixAt(n, this.mat);
          this.color.setHex(carIdx === 0 ? TRAIN_HEAD_COLOR : TRAIN_BODY_COLOR);
          this.trains.setColorAt(n, this.color);
          n++;
        }
      }
    }
    return n;
  }

  /**
   * 走行中の車両（自家用車とトラック）。
   *
   * 位置は交通流シミュレーションが持っている。信号待ちの車は停止線の手前に
   * 車列 1 台ぶんずつ下がって並ぶので、そのまま描けば行列に見える。
   * 経路長からの補間ではないので、詰まっている車は本当に止まって見える。
   */
  /**
   * 曲がり角で向きがスナップするのを抑える。
   *
   * 進行方向はリンクの両端から出しているので、交差点を曲がると 90 度が 1 フレームで入れ替わる。
   * 直前の向きから少しずつ寄せる。車両スロットは使い回されるので、
   * 出発 tick が変わっていたら別の車とみなして即座に合わせる（古い向きを引き継がない）。
   */
  private smoothHeading(vehicle: number, departTick: number, target: number): number {
    if (vehicle >= this.headingOf.length) {
      const n = Math.max(vehicle + 1, this.headingOf.length * 2, 1024);
      const h = new Float32Array(n);
      h.set(this.headingOf);
      this.headingOf = h;
      const g = new Int32Array(n).fill(-1);
      g.set(this.headingTag);
      this.headingTag = g;
    }
    let next = target;
    if (this.headingTag[vehicle] === departTick) {
      const cur = this.headingOf[vehicle]!;
      // -π..π に畳んでから寄せる。畳まないと 359 度回る。
      let d = target - cur;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      next = cur + d * HEADING_SMOOTHING;
    }
    this.headingOf[vehicle] = next;
    this.headingTag[vehicle] = departTick;
    return next;
  }

  private drawVehicles(
    sim: Simulation,
    camX: number,
    camZ: number,
    maxDist2: number,
    tick: number,
    fromCar: number,
  ): { cars: number; trucks: number } {
    let car = fromCar;
    let truck = 0;
    let bus = 0;
    const tr = sim.traffic;
    const nowSec = tick * 60;
    const t = sim.freight.trucks;
    tr.forEachVehicle((v) => {
      const kind = tr.kind[v]!;
      const isTruck = kind === VehicleKind.Truck;
      const isBus = kind === VehicleKind.Bus;
      if (isTruck && truck >= MAX_VISIBLE_TRUCKS) return;
      if (isBus && bus >= MAX_VISIBLE_BUSES) return;
      if (!isTruck && !isBus && car >= MAX_VISIBLE_VEHICLES) return;
      if (!tr.pose(sim.graph, v, nowSec, this.tmp)) return;
      const dx = this.tmp.x - camX;
      const dz = this.tmp.z - camZ;
      if (dx * dx + dz * dz > maxDist2) return;

      const heading = this.smoothHeading(v, tr.departTick[v]!, this.tmp.heading);
      this.quat.setFromAxisAngle(this.axisY, heading);
      // 左側通行。対向車が別の車線を流れる
      const ox = this.laneOffsetX(heading, LANE_OFFSET_M);
      const oz = this.laneOffsetZ(heading, LANE_OFFSET_M);
      this.pos.set(this.tmp.x + ox, this.groundAt(sim, this.tmp.x + ox, this.tmp.z + oz) + 0.05, this.tmp.z + oz);
      this.mat.compose(this.pos, this.quat, this.scl);

      const owner = tr.owner[v]!;
      if (isTruck) {
        this.trucks.setMatrixAt(truck, this.mat);
        // 帰路は空車なので無地。往路は積荷の色。
        const returning = t.alive[owner] === 1 && t.state[owner] === TruckState.Returning;
        this.color.setHex(CARGO_COLORS[returning ? 0 : t.good[owner]!] ?? CARGO_COLORS[0]!);
        this.trucks.setColorAt(truck, this.color);
        truck++;
      } else if (isBus) {
        // 車体は路線の色。路線一覧の色と揃えてあるので、
        // 「いま目の前を通ったのがどの系統か」が地図の上で分かる。
        this.buses.setMatrixAt(bus, this.mat);
        this.color.setHex(lineColor(sim.transit.lineOfBus(owner)));
        this.buses.setColorAt(bus, this.color);
        bus++;
      } else {
        this.cars.setMatrixAt(car, this.mat);
        this.color.setHex(carColor((owner * 2654435761) >>> 0));
        this.cars.setColorAt(car, this.color);
        car++;
      }
    });
    this.buses.count = bus;
    return { cars: car, trucks: truck };
  }

  dispose(): void {
    // InstancedMesh.dispose() はジオメトリを解放しない。明示的に捨てる。
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}
