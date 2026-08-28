import {
  AdditiveBlending,
  Color,
  DoubleSide,
  InstancedMesh,
  Material,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
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
  TRAIN_DRAW_DISTANCE_M,
  VEHICLE_DRAW_DISTANCE_M,
} from '@shared/constants';
import { Activity, Mode, ModeBit } from '@shared/enums';
import { idx, tileX, tileY } from '@sim/world/tiles';
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
import { CARGO_COLORS, TRAIN_BODY_COLOR, carColor, lineColor } from './theme';
import { surface } from './materials';
import { LIMB_PIVOT_Y, bodyGeometry, limbGeometry, simpleGeometry } from './pedestrianParts';
import {
  CAR_KIND_COUNT,
  CarKind,
  beamGeometry,
  busBeamSpec,
  busGeometry,
  busLampGeometry,
  carBeamSpec,
  carGeometry,
  carKind,
  carLampGeometry,
  trainBeamSpec,
  trainGeometry,
  trainLampGeometry,
  truckBeamSpec,
  truckGeometry,
  truckLampGeometry,
} from './vehicleParts';
import { atmosphereAt } from './sky';

/**
 * レール面の高さ (m)。線路レイヤが敷くバラスト・枕木・レールの厚みの合計。
 * 電車の台車をここに載せる。
 */
const RAIL_TOP_M = 0.55;

/** 1 フレームで進行方向をどれだけ目標へ寄せるか。1 = 即座（＝スナップ）。 */
const HEADING_SMOOTHING = 0.15;

/**
 * 路面（アスファルトの上面）の高さ (m)。
 *
 * 道路レイヤは地面より 0.16m 高いところに舗装を敷いている。地面の高さに
 * そのまま車を置くと、車輪が舗装に 16cm めり込んで「沈んだ箱」になる。
 * 舗装のすぐ上に乗せると、車体の下に落ちる影も正しく路面に届く。
 * （道路レイヤは別のレイヤなので、値がずれたらここも直すこと。）
 */
const ROAD_SURFACE_M = 0.18;

/**
 * 歩道の上面の高さ (m)。舗装 0.16 + 縁石 0.22。
 * 人は車道ではなく歩道の上を歩くので、車と同じ高さに置くと足首まで沈む。
 */
const WALK_SURFACE_M = 0.38;

/** これより暗くなったら灯りを点ける（`atmosphereAt().nightAmount`）。 */
const LAMP_ON = 0.12;

/**
 * 手足を持つ人の上限と、そこまでの距離 (m)。
 *
 * 手足付きの人は 1 人あたり 3 つの行列（胴・手足 2 組）を書くので、
 * 4000 人ぶん回すと行列だけで 1 万 2000 回になる。手足が読めるのは
 * せいぜい 150m 先までなので、そこから先は 1 行列の簡易形に落とす。
 */
const MAX_ANIMATED_PEDS = 1200;
const PED_ANIM_DISTANCE_M = 170;

/**
 * 歩調。tick（1 分）あたりの位相。標準速度では 0.75 tick/秒 進むので、
 * 2π × 8.4 / 0.75 ≒ 1 秒で 1 歩 1 往復になる。
 */
const WALK_RATE = 8.4;
/** 手足の振れ幅 (rad)。大きすぎると行進に見える。 */
const WALK_SWING = 0.42;

/** タイプごとのインスタンス群（本体と、夜の灯り）。 */
interface Fleet {
  body: InstancedMesh;
  lamps: InstancedMesh | null;
  count: number;
}

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
 *
 * メッシュの割り方には 3 つの理由がある。
 *
 * 1. **車種でメッシュを分ける。** 軽・セダン・ワンボックスは形が違うので
 *    ジオメトリを共有できない。分けるとドローコールが 3 つになるが、
 *    路上に降りたときに「同じ箱が色違いで並んでいる」のが解消される。
 *    1 台 1 インスタンスなのは変わらないので、台数が増えても call は増えない。
 * 2. **人の手足を別メッシュにする。** InstancedMesh は 1 インスタンス 1 行列
 *    なので、1 つのメッシュの中で部品ごとに角度を変えることができない。
 *    手足を振らせるには、胴と手足を別のインスタンス群にするしかない。
 * 3. **空の InstancedMesh は `visible = false` にする。** count = 0 でも
 *    描画リストには載ってドローコールを 1 つ消費する。昼は灯りと路面の光の
 *    メッシュが 6 つ丸ごと不要になるので、ここだけで 6 call 浮く。
 */
export class AgentLayer {
  readonly group = new Object3D();
  private readonly meshes: InstancedMesh[] = [];
  private readonly materials: Material[] = [];
  /** 影を落としてはいけないメッシュ（灯り・路面の光）。 */
  private readonly noShadow: InstancedMesh[] = [];

  /** 遠景・立ち止まっている人。1 インスタンス 1 行列。 */
  private readonly pedSimple: InstancedMesh;
  /** 近景の人。胴と手足 2 組を別インスタンスにして歩かせる。 */
  private readonly pedBody: InstancedMesh;
  private readonly pedLimbs: [InstancedMesh, InstancedMesh];

  /** 自家用車。軽・セダン・ワンボックスで形が違うのでメッシュを分ける。 */
  private readonly cars: Fleet[] = [];
  private readonly trucks: Fleet;
  private readonly buses: Fleet;
  /** 電車。先頭車・中間車・最後尾で顔と幌が違う。 */
  private readonly trains: Fleet[] = [];

  /** 前照灯が路面に落とす光。全車種で 1 つのメッシュを共有する。 */
  private readonly beams: InstancedMesh;
  private readonly beamMaterial: MeshBasicMaterial;
  private beamCount = 0;
  /** 車種ごとの光の板の置き方（車体の座標系での相対行列）。 */
  private readonly carBeamLocal: Matrix4[] = [];
  private readonly truckBeamLocal: Matrix4;
  private readonly busBeamLocal: Matrix4;
  private readonly trainBeamLocal: Matrix4;

  /** 灯りの明るさ 0..1。`atmosphereAt().nightAmount` をそのまま使う。 */
  private nightAmount = 0;
  private readonly lampMaterials: MeshBasicMaterial[] = [];

  private readonly mat = new Matrix4();
  private readonly mat2 = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3(1, 1, 1);
  private readonly quat = new Quaternion();
  private readonly quat2 = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly axisX = new Vector3(1, 0, 0);
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

  /** 今フレームで書き込んだ人の数（putPerson が進める）。 */
  private animCount = 0;
  private simpleCount = 0;

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

    // 人。布と肌なので粗く、映り込みは弱い。
    this.pedSimple = this.makeMesh(simpleGeometry(), MAX_VISIBLE_AGENTS, 0.86, 0.02);
    this.pedBody = this.makeMesh(bodyGeometry(), MAX_ANIMATED_PEDS, 0.86, 0.02);
    this.pedLimbs = [
      this.makeMesh(limbGeometry(1), MAX_ANIMATED_PEDS, 0.86, 0.02),
      this.makeMesh(limbGeometry(-1), MAX_ANIMATED_PEDS, 0.86, 0.02),
    ];

    // 車両は部品（車体・窓・ガラス・車輪）を焼き込んだジオメトリ 1 つ。
    // インスタンスは 1 台 1 つなので、1 車種 1 ドローコールのままでいられる。
    // 長辺は必ず +Z 側（heading をそのまま Y 回転に使うため）。
    //
    // 塗装は「粗さ低め・金属度中くらい」に置く。1 つの材質で窓もタイヤも
    // 兼ねるので極端な値にはできないが、環境マップ（空）の映り込みが乗るだけで、
    // 同じ形でもプラスチックの塊から塗装された金属に見え方が変わる。
    for (let k = 0; k < CAR_KIND_COUNT; k++) {
      const kind = k as CarKind;
      this.cars.push({
        body: this.makeMesh(carGeometry(kind), MAX_VISIBLE_VEHICLES, 0.34, 0.34, 1.25),
        lamps: this.makeLamps(carLampGeometry(kind), MAX_VISIBLE_VEHICLES),
        count: 0,
      });
      const b = carBeamSpec(kind);
      this.carBeamLocal.push(beamLocal(b));
    }
    this.trucks = {
      body: this.makeMesh(truckGeometry(), MAX_VISIBLE_TRUCKS, 0.42, 0.24, 1.15),
      lamps: this.makeLamps(truckLampGeometry(), MAX_VISIBLE_TRUCKS),
      count: 0,
    };
    this.buses = {
      body: this.makeMesh(busGeometry(), MAX_VISIBLE_BUSES, 0.36, 0.3, 1.2),
      lamps: this.makeLamps(busLampGeometry(), MAX_VISIBLE_BUSES),
      count: 0,
    };
    // 先頭車 → 中間車 → 最後尾。最後尾は先頭車の顔を後ろ向きに付けたもの。
    for (const face of [1, 0, -1] as const) {
      this.trains.push({
        body: this.makeMesh(trainGeometry(face), MAX_VISIBLE_TRAIN_CARS, 0.34, 0.3, 1.2),
        lamps: this.makeLamps(trainLampGeometry(face), MAX_VISIBLE_TRAIN_CARS),
        count: 0,
      });
    }

    this.truckBeamLocal = beamLocal(truckBeamSpec());
    this.busBeamLocal = beamLocal(busBeamSpec());
    this.trainBeamLocal = beamLocal(trainBeamSpec());

    // 路面に落ちる光。加算合成なので、暗い路面ほど明るく浮かび上がる。
    this.beamMaterial = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      // 路面に寝かせる板なので、裏表どちらから見ても描く（法線に頼らない）。
      side: DoubleSide,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    this.materials.push(this.beamMaterial);
    this.beams = new InstancedMesh(beamGeometry(), this.beamMaterial, MAX_VISIBLE_VEHICLES);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 2;
    this.group.add(this.beams);
    this.meshes.push(this.beams);
    this.noShadow.push(this.beams);
  }

  /** 不透明な本体のインスタンス群。 */
  private makeMesh(
    geom: BufferGeometry,
    capacity: number,
    roughness: number,
    metalness: number,
    envMapIntensity = 1,
  ): InstancedMesh {
    const material = surface({ vertexColors: true, roughness, metalness, envMapIntensity });
    this.materials.push(material);
    const mesh = new InstancedMesh(geom, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  /**
   * 夜の灯り。
   *
   * 光源の影響を受けない材質で、トーンマッピングも通さない。
   * ブルームのしきい値（夜は 0.77 前後）を確実に越えさせて、
   * 前照灯と客室灯が滲むようにするため。
   */
  private makeLamps(geom: BufferGeometry, capacity: number): InstancedMesh {
    const material = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    material.color.setScalar(0);
    this.lampMaterials.push(material);
    this.materials.push(material);
    const mesh = new InstancedMesh(geom, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.noShadow.push(mesh);
    return mesh;
  }

  /** 時刻を受け取り、夜なら灯りを点ける。境目で明滅しないよう連続値で扱う。 */
  setTimeOfDay(dayFraction: number): void {
    this.nightAmount = atmosphereAt(dayFraction).nightAmount;
    // 灯りの明るさそのものを大気に合わせて上げ下げする。
    // 真偽値で切り替えると、日没の 1 分間に街じゅうの灯りが一斉に点いて不自然になる。
    const on = Math.max(0, Math.min(1, (this.nightAmount - LAMP_ON) / (1 - LAMP_ON)));
    for (const m of this.lampMaterials) m.color.setScalar(0.25 + on * 0.75);
    this.beamMaterial.opacity = on * 0.24;
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
    this.animCount = 0;
    this.simpleCount = 0;
    this.beamCount = 0;
    for (const f of this.cars) f.count = 0;
    this.trucks.count = 0;
    this.buses.count = 0;
    for (const f of this.trains) f.count = 0;
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
    // 手足を振らせるのはさらに近いところだけ（LOD）。
    const animDist2 = Math.min(pedRadius, PED_ANIM_DISTANCE_M) ** 2;
    const vehRadius = Math.min(VEHICLE_DRAW_DISTANCE_M, Math.max(500, camDistance * 2.2));
    const vehDist2 = vehRadius * vehRadius;
    const trainDist2 = TRAIN_DRAW_DISTANCE_M * TRAIN_DRAW_DISTANCE_M;

    const c = sim.citizens;
    // 引きの画では 1 人も描かないので、走査自体を丸ごと飛ばす。
    // 以前はここを回り続けて、全員ぶんの citizenPosition（経路のエッジを線形走査）を
    // 毎フレーム計算してから捨てていた。
    for (let id = 0; drawPedestrians && id < c.high; id++) {
      if (this.simpleCount >= MAX_VISIBLE_AGENTS) break;
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
      const d2 = dx * dx + dz * dz;
      if (d2 > pedDist2) continue;

      // 道路の中央ではなく端を歩かせる。全員が真ん中を一列で進むと、
      // 近景で見たときに人の流れではなく点線に見える。
      // 車道の外側になるよう、車線より外に置く。
      const side = LANE_OFFSET_M + 1.2 + ((id >> 1) % 3) * 0.7;
      const wx = this.tmp.x + this.laneOffsetX(this.tmp.heading, side);
      const wz = this.tmp.z + this.laneOffsetZ(this.tmp.heading, side);
      const groundY = this.groundAt(sim, wx, wz) + WALK_SURFACE_M;

      // 服の色を人ごとに散らす。自転車は目立つ色にして見分けられるようにする。
      const h = (id * 2654435761) >>> 0;
      if (mode === Mode.Bike) {
        this.color.setHex(0xe08a3a);
      } else {
        this.color.setHSL(((h >>> 8) % 360) / 360, 0.24, 0.56 + ((h >>> 20) % 24) / 120);
      }

      // 歩き。個体ごとに位相をずらさないと、街じゅうが同じ足で行進する。
      const phase = tick * WALK_RATE + (((h >>> 3) % 1024) / 1024) * Math.PI * 2;
      const swing = Math.sin(phase) * WALK_SWING;
      // 上下の揺れ。踏み込むたびに腰が沈むので、歩調の 2 倍で振る。
      const bob = Math.abs(Math.cos(phase)) * 0.022;
      this.putPerson(d2 <= animDist2, wx, groundY, wz, this.tmp.heading, swing, bob);
    }

    // --- 立ち寄り中の市民 ---
    // 屋外に出すのは買い物中とレジャー中だけ。
    //
    // 以前は在宅・勤務中・通学中まで建物の玄関前に立たせていたが、位置が ID の
    // ハッシュで固定なので、同じ人が同じ場所に一日じゅう立ち尽くす街になっていた。
    // 買い物とレジャーは滞在が 2 時間程度で終わるので、時間とともに入れ替わる。
    //
    // 街に映る人の大半はこちら（移動中の市民は常時 全人口の 0.3% しかいない）。
    // なので、ここを簡易形だけで済ませると寄った絵に手足のある人が 1 人も出ない。
    // 近くなら歩いている人と同じ造形で、立ち姿だけ個体ごとに散らして置く。
    if (drawPedestrians && this.simpleCount < MAX_VISIBLE_AGENTS) {
      const b = sim.buildings;
      for (let id = 0; id < c.high && this.simpleCount < MAX_VISIBLE_AGENTS; id++) {
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

        // タイル内に散らす（毎フレーム同じ位置になるよう ID から決める）。
        // ただし車道の真ん中に立たせない。道路の走っている向きを見て、
        // 進行方向には広く、道を横切る向きには歩道の幅ぶんだけ散らす。
        const h = (id * 2654435761) >>> 0;
        const conn = sim.world.roadConn(standTile);
        const alongZ = (conn & 0b0101) !== 0 || conn === 0;
        const along = (((h >>> 4) % 100) / 100 - 0.5) * TILE_M * 0.85;
        const curb =
          (h & 0x100 ? 1 : -1) * (LANE_OFFSET_M + 1.3 + ((h >>> 16) % 3) * 0.5);
        const ox = alongZ ? curb : along;
        const oz = alongZ ? along : curb;

        this.color.setHSL(((h >>> 8) % 360) / 360, 0.22, 0.54 + ((h >>> 20) % 24) / 120);
        // 立っているので手足は振らないが、片足を少し前に出した姿勢を
        // 個体ごとに変える。全員が気を付けの姿勢だと人形の展示に見える。
        const stance = ((((h >>> 6) % 64) / 64) - 0.5) * 0.24;
        this.putPerson(
          dx * dx + dz * dz <= animDist2,
          wx + ox,
          this.groundAt(sim, wx + ox, wz + oz) + WALK_SURFACE_M,
          wz + oz,
          ((h >>> 24) % 360) * (Math.PI / 180),
          stance,
          0,
        );
      }
    }

    this.drawVehicles(sim, camX, camZ, vehDist2, tick);
    this.drawParkedCars(sim, camX, camZ, camDistance, pedDist2);
    this.drawTrains(sim, camX, camZ, trainDist2, tick);

    const lampsOn = this.nightAmount > LAMP_ON;
    setCount(this.pedSimple, this.simpleCount);
    setCount(this.pedBody, this.animCount);
    setCount(this.pedLimbs[0]!, this.animCount);
    setCount(this.pedLimbs[1]!, this.animCount);
    let vehicles = 0;
    for (const f of [...this.cars, this.trucks, this.buses, ...this.trains]) {
      setCount(f.body, f.count);
      if (f.lamps) setCount(f.lamps, lampsOn ? f.count : 0);
      vehicles += f.count;
    }
    setCount(this.beams, lampsOn ? this.beamCount : 0);

    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    // 灯りと路面の光は影を落とさない。とくに路面の光は地面すれすれの板なので、
    // 影を落とすと夜の道路に真っ黒な長方形が貼り付く。
    // renderer が毎フレーム castShadow を立て直すが、その後にここが走るので上書きできる。
    for (const m of this.noShadow) m.castShadow = false;

    this.visiblePedestrians = this.simpleCount + this.animCount;
    this.visibleVehicles = vehicles;
  }


  /**
   * 人を 1 人置く。
   *
   * 近ければ胴と手足を別インスタンスで置いて手足を振らせ、遠ければ
   * 1 インスタンスの簡易形に落とす。歩いていない人も近くなら手足を持つ
   * （立ち止まっている人のほうが街には圧倒的に多いので、そこを簡易形のまま
   * にすると、寄った絵で見えるのは「腕の無い塊」ばかりになる）。
   *
   * @param swing 手足の振り角 (rad)。0 で直立。
   * @returns 手足付きで置けたら true。
   */
  private putPerson(
    near: boolean,
    x: number,
    y: number,
    z: number,
    heading: number,
    swing: number,
    bob: number,
  ): boolean {
    if (near && this.animCount < MAX_ANIMATED_PEDS) {
      const n = this.animCount;
      this.quat.setFromAxisAngle(this.axisY, heading);
      this.pos.set(x, y + bob, z);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.pedBody.setMatrixAt(n, this.mat);
      this.pedBody.setColorAt(n, this.color);
      // 手足は腰と肩の中間を軸に前後へ振る。左右で符号を逆にすると対角で揃う。
      this.pos.y = y + bob + LIMB_PIVOT_Y;
      for (let k = 0; k < 2; k++) {
        this.quat.setFromAxisAngle(this.axisY, heading);
        this.quat2.setFromAxisAngle(this.axisX, k === 0 ? swing : -swing);
        this.quat.multiply(this.quat2);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.pedLimbs[k]!.setMatrixAt(n, this.mat);
        this.pedLimbs[k]!.setColorAt(n, this.color);
      }
      this.animCount++;
      return true;
    }
    if (this.simpleCount >= MAX_VISIBLE_AGENTS) return false;
    this.quat.setFromAxisAngle(this.axisY, heading);
    this.pos.set(x, y, z);
    this.mat.compose(this.pos, this.quat, this.scl);
    this.pedSimple.setMatrixAt(this.simpleCount, this.mat);
    this.pedSimple.setColorAt(this.simpleCount, this.color);
    this.simpleCount++;
    return false;
  }

  /** 車の前に光の板を 1 枚置く。 */
  private addBeam(local: Matrix4): void {
    if (this.nightAmount <= LAMP_ON || this.beamCount >= MAX_VISIBLE_VEHICLES) return;
    this.mat2.multiplyMatrices(this.mat, local);
    this.beams.setMatrixAt(this.beamCount, this.mat2);
    this.beamCount++;
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
   */
  private drawParkedCars(
    sim: Simulation,
    camX: number,
    camZ: number,
    camDistance: number,
    maxDist2: number,
  ): void {
    if (camDistance >= PARKED_CAR_LOD_DISTANCE_M) return;
    const c = sim.citizens;
    const b = sim.buildings;
    this.parkSlots.clear();

    for (let id = 0; id < c.high; id++) {
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

      const hash = (id * 2654435761) >>> 0;
      const fleet = this.cars[carKind(hash)]!;
      if (fleet.count >= MAX_VISIBLE_VEHICLES) continue;
      this.parkSlots.set(access, used + 1);

      // 道路の走っている向きに沿って縦列駐車させる。
      // 向きを見ずに置くと、車が道路を跨いで横向きに刺さる。
      const conn = sim.world.roadConn(access);
      const alongZ = (conn & 0b0101) !== 0 || conn === 0;
      const heading = alongZ ? 0 : Math.PI / 2;
      // 2 台ずつ、道路の左右の路肩に分ける。
      // 路肩は車道の内側（縁石の手前）。外に出しすぎると歩道に乗り上げるうえ、
      // 歩道を歩く人と重なって「人が屋根に立っている」絵になる。
      const along = ((used >> 1) - 0.5) * 5.2;
      const curb = (used & 1 ? 1 : -1) * (LANE_OFFSET_M + 0.15);
      const ox = alongZ ? curb : along;
      const oz = alongZ ? along : curb;

      // 前向きと後ろ向きを混ぜる。全部が同じ向きだと整列した模型に見える。
      this.quat.setFromAxisAngle(this.axisY, heading + (hash & 0x40 ? Math.PI : 0));
      this.pos.set(wx + ox, this.groundAt(sim, wx + ox, wz + oz) + ROAD_SURFACE_M, wz + oz);
      this.mat.compose(this.pos, this.quat, this.scl);
      fleet.body.setMatrixAt(fleet.count, this.mat);
      this.color.setHex(carColor(hash));
      fleet.body.setColorAt(fleet.count, this.color);
      fleet.count++;
    }
  }

  /**
   * 電車。線路の折れ線を端から端へ往復させる。
   *
   * 鉄道利用者を電車として描く（以前の実装）と、鉄道経路の両端の徒歩区間まで
   * 電車の姿で歩道を歩くことになる。運行そのものを描く方が正しく、かつ
   * 「線路を敷いたのに駅が無い」がひと目で分かるようになる。
   *
   * 先頭・中間・最後尾でメッシュを分ける。顔（前面ガラスと前照灯）と
   * 幌が付くだけで、3 両が「連なった箱」から「1 本の編成」になる。
   */
  private drawTrains(sim: Simulation, camX: number, camZ: number, maxDist2: number, tick: number): void {
    if (this.railLinesVersion !== sim.graph.version) {
      this.railLines = traceRailLines(sim.graph);
      this.railLinesVersion = sim.graph.version;
    }
    let total = 0;
    for (const line of this.railLines) {
      if (total >= MAX_VISIBLE_TRAIN_CARS) break;
      const heads = trainHeads(line, tick, this.heads);
      for (let k = 0; k < heads && total < MAX_VISIBLE_TRAIN_CARS; k++) {
        const head = this.heads[k]!;
        const dir = head.forward ? 1 : -1;
        for (let carIdx = 0; carIdx < TRAIN_CARS && total < MAX_VISIBLE_TRAIN_CARS; carIdx++) {
          // 後続車は先頭から編成長ぶん後ろに付く
          const d = head.distM - dir * carIdx * TRAIN_CAR_PITCH_M;
          if (d < 0 || d > line.lengthM) continue;
          if (!railPoseAt(sim.graph, line, d, head.forward, this.railPose)) continue;
          const dx = this.railPose.x - camX;
          const dz = this.railPose.z - camZ;
          if (dx * dx + dz * dz > maxDist2) continue;
          // 0 = 先頭車、TRAIN_CARS-1 = 最後尾、それ以外は中間車。
          const slot = carIdx === 0 ? 0 : carIdx === TRAIN_CARS - 1 ? 2 : 1;
          const fleet = this.trains[slot]!;
          if (fleet.count >= MAX_VISIBLE_TRAIN_CARS) continue;
          this.quat.setFromAxisAngle(this.axisY, this.railPose.heading);
          // 車両の原点は台車の上端（＝レール面）。線路レイヤのバラストと枕木の上に
          // 台車が載るよう、その厚みぶんだけ持ち上げる。
          this.pos.set(
            this.railPose.x,
            this.groundAt(sim, this.railPose.x, this.railPose.z) + RAIL_TOP_M,
            this.railPose.z,
          );
          this.mat.compose(this.pos, this.quat, this.scl);
          fleet.body.setMatrixAt(fleet.count, this.mat);
          this.color.setHex(TRAIN_BODY_COLOR);
          fleet.body.setColorAt(fleet.count, this.color);
          if (fleet.lamps) fleet.lamps.setMatrixAt(fleet.count, this.mat);
          if (slot === 0) this.addBeam(this.trainBeamLocal);
          fleet.count++;
          total++;
        }
      }
    }
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

  private drawVehicles(sim: Simulation, camX: number, camZ: number, maxDist2: number, tick: number): void {
    const tr = sim.traffic;
    const nowSec = tick * 60;
    const t = sim.freight.trucks;
    tr.forEachVehicle((v) => {
      const kind = tr.kind[v]!;
      const isTruck = kind === VehicleKind.Truck;
      const isBus = kind === VehicleKind.Bus;
      if (isTruck && this.trucks.count >= MAX_VISIBLE_TRUCKS) return;
      if (isBus && this.buses.count >= MAX_VISIBLE_BUSES) return;
      if (!tr.pose(sim.graph, v, nowSec, this.tmp)) return;
      const dx = this.tmp.x - camX;
      const dz = this.tmp.z - camZ;
      if (dx * dx + dz * dz > maxDist2) return;

      const heading = this.smoothHeading(v, tr.departTick[v]!, this.tmp.heading);
      this.quat.setFromAxisAngle(this.axisY, heading);
      // 左側通行。対向車が別の車線を流れる
      const ox = this.laneOffsetX(heading, LANE_OFFSET_M);
      const oz = this.laneOffsetZ(heading, LANE_OFFSET_M);
      this.pos.set(
        this.tmp.x + ox,
        this.groundAt(sim, this.tmp.x + ox, this.tmp.z + oz) + ROAD_SURFACE_M,
        this.tmp.z + oz,
      );
      this.mat.compose(this.pos, this.quat, this.scl);

      const owner = tr.owner[v]!;
      if (isTruck) {
        const f = this.trucks;
        f.body.setMatrixAt(f.count, this.mat);
        // 帰路は空車なので無地。往路は積荷の色。
        const returning = t.alive[owner] === 1 && t.state[owner] === TruckState.Returning;
        this.color.setHex(CARGO_COLORS[returning ? 0 : t.good[owner]!] ?? CARGO_COLORS[0]!);
        f.body.setColorAt(f.count, this.color);
        if (f.lamps) f.lamps.setMatrixAt(f.count, this.mat);
        this.addBeam(this.truckBeamLocal);
        f.count++;
      } else if (isBus) {
        // 車体は路線の色。路線一覧の色と揃えてあるので、
        // 「いま目の前を通ったのがどの系統か」が地図の上で分かる。
        const f = this.buses;
        f.body.setMatrixAt(f.count, this.mat);
        this.color.setHex(lineColor(sim.transit.lineOfBus(owner)));
        f.body.setColorAt(f.count, this.color);
        if (f.lamps) f.lamps.setMatrixAt(f.count, this.mat);
        this.addBeam(this.busBeamLocal);
        f.count++;
      } else {
        const hash = (owner * 2654435761) >>> 0;
        const kindIdx = carKind(hash);
        const f = this.cars[kindIdx]!;
        if (f.count >= MAX_VISIBLE_VEHICLES) return;
        f.body.setMatrixAt(f.count, this.mat);
        this.color.setHex(carColor(hash));
        f.body.setColorAt(f.count, this.color);
        if (f.lamps) f.lamps.setMatrixAt(f.count, this.mat);
        this.addBeam(this.carBeamLocal[kindIdx]!);
        f.count++;
      }
    });
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

/** 空のインスタンス群はシーンから外す。count=0 のままでもドローコールを 1 つ使うため。 */
function setCount(mesh: InstancedMesh, n: number): void {
  mesh.count = n;
  mesh.visible = n > 0;
}

/** 光の板の相対行列（単位ジオメトリは 幅 1・長さ 0..1）。 */
function beamLocal(spec: { z: number; width: number; length: number; y: number }): Matrix4 {
  const m = new Matrix4();
  m.makeScale(spec.width, 1, spec.length);
  m.setPosition(0, spec.y, spec.z);
  return m;
}
