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
  PARKED_CAR_LOD_DISTANCE_M,
  PEDESTRIAN_LOD_DISTANCE_M,
  TERRAIN_HEIGHT_SCALE,
  TILE_M,
  TRAIN_CARS,
  TRAIN_DRAW_DISTANCE_M,
  VEHICLE_DRAW_DISTANCE_M,
} from '@shared/constants';
import { Activity, Good, Mode, ModeBit, RoadClass, Zone } from '@shared/enums';
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
import { CARGO_COLORS, TRAIN_BODY_COLOR, lineColor } from './theme';
import { jitterColor } from './materials';
import { agentSurface, type AgentSurface } from './agentMaterial';
import { GroundShadows } from './groundShadow';
import {
  LIMB_PIVOT_Y,
  PED_SHOULDER_M,
  bodyGeometry,
  limbGeometry,
  pedColor,
  simpleGeometry,
} from './pedestrianParts';
import {
  CAR_KIND_COUNT,
  CarKind,
  beamConeGeometry,
  beamGeometry,
  busBeamSpec,
  busConeSpec,
  BUS_BODY_M,
  BUS_WIDTH_M,
  TRUCK_BODY_M,
  TRUCK_WIDTH_M,
  busGeometry,
  busLampGeometry,
  carBeamSpec,
  carConeSpec,
  carGeometry,
  carHalfWidth,
  carKind,
  carLampGeometry,
  carLength,
  carPaint,
  truckLivery,
  trainBeamSpec,
  trainConeSpec,
  trainGeometry,
  trainLampGeometry,
  truckBeamSpec,
  truckConeSpec,
  truckGeometry,
  truckLampGeometry,
  type ConeSpec,
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

/**
 * 人の夜の持ち上げは車より弱くする。
 * 布は拡散反射しかしないので、車体ほど「真っ黒に潰れる」わけではない。
 */
const PED_NIGHT_LIFT = 0.55;

/**
 * 車道の半幅 (m)。道路レイヤの `CARRIAGE_HALF` と対の値。
 *
 * 路肩に車を停め、歩道に人を立たせるには、舗装がどこで終わって縁石が
 * どこから始まるかを知っている必要がある。道路レイヤは別のレイヤなので、
 * 値がずれたらここも直すこと（`ROAD_SURFACE_M` と同じ扱い）。
 */
const CARRIAGE_HALF_M: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 3.1,
  [RoadClass.Avenue]: 3.7,
  [RoadClass.Boulevard]: 4.3,
};
/** 歩道の外縁 (m)。タイルの端まで歩道。 */
const WALK_OUTER_M = TILE_M / 2;

/**
 * 飾りの路上（駐車車両・歩道に立つ人）を撒く距離と半径 (m)。
 *
 * 街の絵の「生っぽさ」は建物ではなく動く物の密度で決まるのに、
 * シミュレーション上、移動中の市民は常時 全人口の 0.3% しかいない
 * （人口 4000 人で同時 12 人）。それだけを描くと、人口 4000 人の市街地の
 * 正午が「車 0 台・人 0 人」になる。実際の街で目に入る車と人の大半は
 * 停まっている車と歩道を歩く人なので、**シミュレーションと無関係な純飾り**を
 * 決定的なハッシュで撒く。位置はタイル ID から決まるので、
 * カメラを動かしてもフレームごとにちらつかない。
 */
const STREET_LIFE_DISTANCE_M = 400;
const STREET_LIFE_RADIUS_M = 320;
/**
 * 路肩に飾りの車を足す確率 (%)。**片側 1 タイルにつき**の値。
 *
 * 以前は 1 タイルに縦列 4 枠（5.2m 間隔）を切っていたが、タイルが 10m
 * なのでタイル境界をまたぐ枠の間隔が 4.8m しかなく、全長 4.4m のワンボックスが
 * 並ぶと車間 40cm ―― 実質「隙間なく数珠つなぎ」になっていた。
 * ミラーとバンパーを勘定すれば互いに貫入もする。
 *
 * いまは **1 タイル 1 側につき最大 1 台**に改め、位置をタイル内で
 * ±1.6m 揺らす。こうすると同じ側の前後の間隔は最低でも 6.8m 取れるので、
 * いちばん長いワゴン（4.62m）でも車間が 2.2m 残る（`MIN_HEADWAY_RATIO` の
 * 要求 1.16m を上回る）。台数は減るが、左右 2 側を独立に抽選するので
 * 通り全体の密度は以前とほとんど変わらない。
 */
const PARK_CHANCE_PCT: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 34,
  [RoadClass.Avenue]: 27,
  [RoadClass.Boulevard]: 16,
};

/**
 * 前後の最小車間を、車長の何倍取るか。
 *
 * 渋滞列でも、車は前の車のバンパーに触れる手前で止まる。交通流は
 * 「リンクをどこまで進めたか」しか持っていないので、同じリンクに詰まった
 * 車どうしがめり込むことがある。描画側で最後に間隔を強制する。
 */
const MIN_HEADWAY_RATIO = 0.25;
/**
 * 車間の下限 (m)。比率だけだと、全長 3.4m の軽で 85cm しか空かない。
 * 目線の高さで車列を真後ろから見ると、1m を切った隙間は路面が一切見えず
 * 「1 本の長い塊」に潰れてしまう。停止時の実際の車間もこのくらいある。
 */
const MIN_HEADWAY_M = 1.3;

/**
 * 車間を空けるために 1 台を後ろへ下げてよい最大量 (m)。
 *
 * 車間の強制には落とし穴がある。交通流が同じ地点に 60 台を積み上げていると
 * （貨物の発着地でよく起きる）、後ろの車を順に押し下げる規則がそのまま連鎖して、
 * **本来は 1 か所の団子だったものが数百 m の車列に化ける**。
 * 「消失点まで隙間なく同じ車が一列」は、詰まりそのものではなく
 * この連鎖が作っていた。
 *
 * そこで、押し下げがこの量を超える車は**描かない**。詰まりの実体は
 * 見えているぶんの数台で十分に伝わるし、街路に置ける台数には限りがあるので、
 * 積み上がったぶんを全部並べる意味がそもそも無い。
 */
const MAX_PUSHBACK_M = 12;

/**
 * 1 台ごとの寸法のばらつき。
 *
 * 同じ車種・同じ塗色が隣り合うこと自体は現実にもあるが、**寸法まで
 * 1mm 違わない**のは複製にしか見えない。とくにトラックは 1 種類しか
 * 形が無いので、目線のカットで 60 台が並ぶと定規で引いたような列になる。
 * インスタンス行列の拡大率を数 % 振るだけなら、ジオメトリもドローコールも
 * 増えないまま、シルエットの繰り返しが崩れる。
 */
const SIZE_JITTER_XZ = 0.055;
const SIZE_JITTER_Y = 0.05;

/**
 * 路肩の車の向きの揺らぎ (rad)。±1.5°。
 * 完璧に平行な車列は現実には存在しない。ここが揃っているだけで
 * 「配列に並べた」と読まれる。走行中の車はもっと小さく振る。
 */
const PARK_YAW_JITTER = 0.052;
const DRIVE_YAW_JITTER = 0.02;

/** 路肩の枠のうち、はじめから空けておく割合 (%)。理由は `tryShoulder` の注記に。 */
const EMPTY_SLOT_PCT = 27;

/**
 * 接地影を描く距離 (m) と枚数の上限。
 *
 * 接地影は「足元の数十 cm」を埋めるためのものなので、遠景では 1px 未満に
 * なって効かない。近いところだけに絞って枚数を抑える。
 * 打ち切りの線で影だけが消えると目立つので、手前 6 割から徐々に薄くする。
 */
const SHADOW_DISTANCE_M = 260;
const SHADOW_FADE_FROM = 0.6;
const MAX_SHADOWS = 2600;

/**
 * 接地影と光の円錐を描くカメラ距離 (m)。
 *
 * どちらも「足元の陰」「空中の光」という近景専用の演出で、街区を見下ろす
 * 距離では 1px 未満にしかならない。それでもメッシュは描画リストに載って
 * ドローコールを 2 つ（GTAO の再描画を含めると 4 つ）食うので、
 * 引いたら丸ごと降ろす。
 */
const CONTACT_DETAIL_M = 300;

/**
 * 接地影だけを描き続けるカメラ距離 (m)。
 *
 * 光の円錐は「空中に伸びる光」なので引いたら要らないが、接地影は違う。
 * 街区を見下ろす画でも、車が路面に**接している**ことは影でしか示せない
 *（影マップは normalBias で足元の数十 cm を必ず外す）。1 台 3px の点でも、
 * 下に 1px の陰があるかどうかで「路面の上の車」と「浮いた点」が分かれる。
 * メッシュは 1 本きりなので、伸ばしても増える call は 2 つだけ。
 */
const SHADOW_DETAIL_M = 430;

/**
 * これより引いたら、自家用車を 1 車種に畳む (m)。
 *
 * 俯瞰では車は 2〜3px にしかならず、軽とワゴンの区別は物理的に付かない。
 * それでも 5 車種ぶんのメッシュが描画リストに載ると、本体 5 + 灯り 5 で
 * 10 ドローコールを使う。1 車種に畳めば 2 で済む。
 * 車種を分ける意味があるのは、路上に降りた画だけ。
 */
const CAR_KIND_LOD_M = 520;

/**
 * これより引いたら、電車を中間車 1 種類に畳む (m)。
 *
 * 先頭車・中間車・最後尾を分けているのは「顔と幌が付くと 3 両が 1 本の編成に
 * 見える」ためだが、それが読めるのは駅の近くまで寄った画だけ。街区を見下ろす
 * 距離では編成そのものが 1 本の棒にしかならないのに、本体 3 + 灯り 3 で
 * 6 ドローコールを使い続けていた。中間車に畳めば 2 で済む。
 */
const TRAIN_FACE_LOD_M = 640;

/**
 * 夜、路肩の飾りの車のうち灯りを点けている割合 (%)。
 *
 * 「夜に無灯火の車列」は物理的にありえない。とはいえ全部を点けると
 * 駐車場が滑走路になるので、一部を「停車中でエンジンをかけている車」
 * として点灯させる。これだけで列の中に光の点が散り、
 * 残りの消灯した車も「暗いだけの車」として読めるようになる。
 *
 * 3 割では足りなかった。夜の目線のカットに映るのはほぼ全部が停まっている車
 *（20 時台に走っている車はシミュレーション上ほとんどいない）なので、
 * 3 割だと 10 台に 3 台、しかも尾灯が見えるのは片側の列だけになり、
 * 画面の中に赤が 1 つも入らないことがある。4 割強まで上げると、
 * どちらの列にも必ず灯りが混ざる。
 */
const PARKED_LIT_PCT = 42;

/** タイプごとのインスタンス群（本体と、夜の灯り）。 */
interface Fleet {
  body: InstancedMesh;
  lamps: InstancedMesh | null;
  count: number;
  /**
   * 灯りメッシュに書き込んだ数。**本体のインスタンス番号とは独立**に数える。
   *
   * 灯すのは「走行中の車」と「夜に停まっている車の一部」で、両者は本体の
   * インスタンス列の中で飛び飛びに現れる。本体と同じ番号に書いていた頃は
   * 「先頭から連続した n 台」しか灯せず、消灯した車の位置に前フレームの
   * 前照灯が取り残された。別の連番にすれば、どの車を灯すかを自由に選べる。
   */
  lit: number;
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
 * 1. **車種でメッシュを分ける。** 軽・セダン・ワンボックス・ワゴン・軽トラは
 *    形が違うのでジオメトリを共有できない。分けるとドローコールが 5 つになるが、
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

  /** 自家用車。車種で形が違うのでメッシュを分ける（`CarKind`）。 */
  private readonly cars: Fleet[] = [];
  private readonly trucks: Fleet;
  private readonly buses: Fleet;
  /** 電車。先頭車・中間車・最後尾で顔と幌が違う。 */
  private readonly trains: Fleet[] = [];

  /** 前照灯が路面に落とす光。全車種で 1 つのメッシュを共有する。 */
  private readonly beams: InstancedMesh;
  private readonly beamMaterial: MeshBasicMaterial;
  private beamCount = 0;
  /**
   * 前照灯が空中に作る光の円錐。路面の楕円と対で置く。
   * こちらも全車種で 1 メッシュ（置き方だけ車種ごとの相対行列で変える）。
   */
  private readonly cones: InstancedMesh;
  private readonly coneMaterial: MeshBasicMaterial;
  private coneCount = 0;
  /** 今フレーム、光の円錐を置くか（引いた画では置かない）。 */
  private conesOn = true;
  /** 今フレーム、車種を 1 つに畳むか（俯瞰の LOD）。 */
  private carLod = false;
  /** 今フレーム、電車を中間車 1 種類に畳むか（俯瞰の LOD）。 */
  private trainLod = false;
  /** 車種ごとの光の板・円錐・尾灯の照り返しの置き方（車体の座標系での相対行列）。 */
  private readonly carBeamLocal: Matrix4[] = [];
  private readonly carConeLocal: Matrix4[] = [];
  private readonly carPoolLocal: Matrix4[] = [];
  private readonly truckBeamLocal: Matrix4;
  private readonly busBeamLocal: Matrix4;
  private readonly trainBeamLocal: Matrix4;
  private readonly truckConeLocal: Matrix4;
  private readonly busConeLocal: Matrix4;
  private readonly trainConeLocal: Matrix4;
  private readonly truckPoolLocal: Matrix4;
  private readonly busPoolLocal: Matrix4;
  private readonly trainPoolLocal: Matrix4;
  /**
   * 光の板の色。前は白（＝焼いてある色そのまま）、後ろは尾灯の赤。
   * 板のジオメトリは 1 つを使い回し、色だけ `instanceColor` で変える。
   */
  private readonly beamWhite = new Color(1, 1, 1);
  private readonly beamRed = new Color(0.8, 0.11, 0.07);

  /** 接地影。車も人もここに 1 枚ずつ置く（1 ドローコール）。 */
  private readonly shadows = new GroundShadows(MAX_SHADOWS);

  /** 灯りの明るさ 0..1。`atmosphereAt().nightAmount` をそのまま使う。 */
  private nightAmount = 0;
  private readonly lampMaterials: MeshBasicMaterial[] = [];
  /** 夜に車体・人を持ち上げる量（`agentMaterial` の uniform と共有している）。 */
  private readonly nightUniforms: { value: number }[] = [];
  /** ガラスが映す空の色など（`agentMaterial` の uniform と共有している）。 */
  private readonly surfaces: AgentSurface[] = [];

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
  /** ガラスの映り込みに配る色（毎フレーム書き換える）。 */
  private readonly glassSky = new Color();
  private readonly glassHorizon = new Color();
  private readonly glassGround = new Color();
  /** 接地影を描く距離のしきい値（2 乗）。 */
  private shadowNear2 = 0;
  private shadowFar2 = 0;

  /** 線路の折れ線。グラフが作り直されたときだけ再計算する。 */
  private railLines: RailLine[] = [];
  private railLinesVersion = -1;
  /** 編成の先頭位置の受け皿（毎フレーム使い回す）。 */
  private readonly heads: TrainHead[] = Array.from({ length: 64 }, () => ({ distM: 0, forward: true }));
  private readonly railPose: RailPose = { x: 0, z: 0, heading: 0 };
  /**
   * タイル → その路肩の使用状況（bit0 = 左側、bit1 = 右側）。
   * 毎フレーム clear して使い回す。
   *
   * シミュレーション由来の駐車車両と飾りの駐車車両が **同じ表**を使うのが肝。
   * 別々に置き場所を決めると、同じ路肩に 2 台が重なって 1 台が 2 台に割れる。
   */
  private readonly parkSlots = new Map<number, number>();
  /**
   * 今フレーム、走行中の車両が乗っている「タイル×車線の側」の集合。
   * キーは `タイル番号 × 2 + (左右)`。
   *
   * 車道は生活道路で全幅 6.2m しかないので、路肩に停めた車は走行車線と
   * ほとんど同じ場所を占める。飾りの駐車車両をそのまま置くと、走ってきた車と
   * 重なって 1 台が 2 台に割れて見える。走行車両が来ている区間には置かない。
   * （消えた駐車車両の場所はちょうど走行車両が覆うので、抜けは目に見えない。）
   */
  private readonly busy = new Set<number>();

  /**
   * 走行中の車両を一旦ためる場所。
   *
   * 交通流はリンク上の進捗しか持っていないので、そのまま置くと同じ車線で
   * 車体どうしが貫入する。**リンクごとに前から順に並べ直し、前後の車間を
   * 強制してから**置く。そのために 1 フレームぶんを溜める。
   */
  private vehCount = 0;
  private vehSlot = new Int32Array(0);
  /** 車線 ID（軸 × 直交方向のタイル列 × 進行の向き）。 */
  private vehLane = new Int32Array(0);
  private vehAlongZ = new Int32Array(0);
  private vehSign = new Int32Array(0);
  /** 車線に沿った座標 (m)。ここを押し下げて車間を作る。 */
  private vehAlong = new Float32Array(0);
  private vehLength = new Float32Array(0);
  private vehX = new Float32Array(0);
  private vehZ = new Float32Array(0);
  private vehHeading = new Float32Array(0);
  /** 車間を空けきれず、今フレームは描かないことにした車の印（0 = 描かない）。 */
  private vehDrawn = new Int32Array(0);
  private readonly vehOrder: number[] = [];

  /** 今フレームで書き込んだ人の数（putPerson が進める）。 */
  private animCount = 0;
  private simpleCount = 0;

  /** 直近に置いた車体の寸法のばらつき（接地影の大きさに反映する）。 */
  private jitterW = 1;
  private jitterL = 1;

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
    // `skin: true` は「肌・髪・靴は服の色の変調を受けない」印を有効にする指定。
    this.pedSimple = this.makeMesh(simpleGeometry(), MAX_VISIBLE_AGENTS, 0.86, 0.02, 1, false, PED_NIGHT_LIFT, true);
    this.pedBody = this.makeMesh(bodyGeometry(), MAX_ANIMATED_PEDS, 0.86, 0.02, 1, false, PED_NIGHT_LIFT, true);
    this.pedLimbs = [
      this.makeMesh(limbGeometry(1), MAX_ANIMATED_PEDS, 0.86, 0.02, 1, false, PED_NIGHT_LIFT, true),
      this.makeMesh(limbGeometry(-1), MAX_ANIMATED_PEDS, 0.86, 0.02, 1, false, PED_NIGHT_LIFT, true),
    ];

    // 車両は部品（車体・窓・ガラス・車輪）を焼き込んだジオメトリ 1 つ。
    // インスタンスは 1 台 1 つなので、1 車種 1 ドローコールのままでいられる。
    // 長辺は必ず +Z 側（heading をそのまま Y 回転に使うため）。
    //
    // 塗装は「粗さ低め・**金属度は低め**」に置く。
    //
    // 以前は金属度 0.34・環境マップ 1.35 だったが、それだと**上を向いた面が
    // 空をそのまま映して真っ白に飛ぶ**。屋根とボンネットが白く抜けるので、
    // 紺の車も赤の車も上半分は同じ白になり、目線のカットで並ぶと
    // 「白い屋根の箱」の列にしか見えなかった（塗色を 13 色に増やしても、
    // 見えているのは腰から下だけということになる）。
    // 車の塗装はクリア層を持つ**誘電体**で、金属ではない。金属度を下げると
    // 映り込みは色に染まらない白いハイライトとして残り、面の色は塗色のまま出る。
    // ただし下げすぎると拡散反射が増えて、今度は**夜の車が浮くほど明るく**なる
    //（夜の主光源は半球ライトの拡散なので）。0.26 は、屋根が白く飛ばず、
    // かつ夜に明るくなりすぎない折り合いの点。
    for (let k = 0; k < CAR_KIND_COUNT; k++) {
      const kind = k as CarKind;
      this.cars.push({
        body: this.makeMesh(carGeometry(kind), MAX_VISIBLE_VEHICLES, 0.3, 0.26, 0.9, true),
        lamps: this.makeLamps(carLampGeometry(kind), MAX_VISIBLE_VEHICLES),
        count: 0,
        lit: 0,
      });
      this.carBeamLocal.push(beamLocal(carBeamSpec(kind)));
      this.carConeLocal.push(coneLocal(carConeSpec(kind)));
      this.carPoolLocal.push(poolLocal(carConeSpec(kind)));
    }
    this.trucks = {
      body: this.makeMesh(truckGeometry(), MAX_VISIBLE_TRUCKS, 0.42, 0.2, 0.85, true),
      lamps: this.makeLamps(truckLampGeometry(), MAX_VISIBLE_TRUCKS),
      count: 0,
      lit: 0,
    };
    this.buses = {
      body: this.makeMesh(busGeometry(), MAX_VISIBLE_BUSES, 0.36, 0.24, 0.9, true),
      lamps: this.makeLamps(busLampGeometry(), MAX_VISIBLE_BUSES),
      count: 0,
      lit: 0,
    };
    // 先頭車 → 中間車 → 最後尾。最後尾は先頭車の顔を後ろ向きに付けたもの。
    for (const face of [1, 0, -1] as const) {
      this.trains.push({
        body: this.makeMesh(trainGeometry(face), MAX_VISIBLE_TRAIN_CARS, 0.34, 0.26, 1.0, true),
        lamps: this.makeLamps(trainLampGeometry(face), MAX_VISIBLE_TRAIN_CARS),
        count: 0,
        lit: 0,
      });
    }

    this.truckBeamLocal = beamLocal(truckBeamSpec());
    this.busBeamLocal = beamLocal(busBeamSpec());
    this.trainBeamLocal = beamLocal(trainBeamSpec());
    this.truckConeLocal = coneLocal(truckConeSpec());
    this.busConeLocal = coneLocal(busConeSpec());
    this.trainConeLocal = coneLocal(trainConeSpec());
    this.truckPoolLocal = poolLocal(truckConeSpec());
    this.busPoolLocal = poolLocal(busConeSpec());
    this.trainPoolLocal = poolLocal(trainConeSpec());

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

    // 空中に伸びる光の円錐。路面の楕円だけだと、真横から見た夜の車が
    // 「点が 2 つ光る箱」にしかならない。表裏どちらも描いて、
    // 中心軸の近くが二重に足されるようにする。
    this.coneMaterial = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    this.materials.push(this.coneMaterial);
    this.cones = new InstancedMesh(beamConeGeometry(), this.coneMaterial, MAX_VISIBLE_VEHICLES);
    this.cones.count = 0;
    this.cones.frustumCulled = false;
    this.cones.renderOrder = 3;
    this.group.add(this.cones);
    this.meshes.push(this.cones);
    this.noShadow.push(this.cones);

    // 接地影。灯りと同じく影は落とさない（路面すれすれの板なので、
    // 影を落とすと夜の道路に真っ黒な楕円が貼り付く）。
    this.group.add(this.shadows.mesh);
    this.noShadow.push(this.shadows.mesh);
  }

  /**
   * 不透明な本体のインスタンス群。
   *
   * @param glass ジオメトリが `aGlass` 属性（ガラスの印）を持つか。
   *   車両だけ true。人は窓を持たないので不要。
   * @param nightLift 夜に車体を持ち上げる強さ。人は車より弱くする。
   * @param skin ジオメトリが `aSkin` 属性（服の色に染まらない部位の印）を持つか。
   *   人だけ true。
   */
  private makeMesh(
    geom: BufferGeometry,
    capacity: number,
    roughness: number,
    metalness: number,
    envMapIntensity = 1,
    glass = false,
    nightLift = 1,
    skin = false,
  ): InstancedMesh {
    const s = agentSurface({ roughness, metalness, envMapIntensity, glass, nightLift, skin });
    const material = s.material;
    this.nightUniforms.push(s.night);
    this.surfaces.push(s);
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
    const atmo = atmosphereAt(dayFraction);
    this.nightAmount = atmo.nightAmount;
    // 灯りの明るさそのものを大気に合わせて上げ下げする。
    // 真偽値で切り替えると、日没の 1 分間に街じゅうの灯りが一斉に点いて不自然になる。
    const on = Math.max(0, Math.min(1, (this.nightAmount - LAMP_ON) / (1 - LAMP_ON)));
    // **1 を超えさせる**のが肝。ブルームのしきい値は夜でも 1.03 前後にあり、
    // 灯りのジオメトリはいちばん明るい前照灯でも焼いた色が 1.0 で頭打ちなので、
    // これまで滲みを 1 度も越えていなかった（＝夜の車が「小さな白い長方形を
    // 貼った箱」にしかならなかった）。トーンマッピングを通さない材質なので、
    // ここで 1.6 まで持ち上げれば前照灯と尾灯だけが確実にブルームに拾われる。
    // 室内灯は焼いた色が暗い（0x6a5230）ので、持ち上げてもしきい値は越えない。
    for (const m of this.lampMaterials) m.color.setScalar(0.28 + on * 1.32);
    this.beamMaterial.opacity = on * 0.3;
    this.coneMaterial.opacity = on * 0.1;
    // 夜の車体・人が真っ黒なシルエットに潰れるのを、街灯を拾っている想定の
    // 弱い自発光で戻す。灯りの点灯と同じカーブに乗せて、夕方に段が出ないようにする。
    for (const u of this.nightUniforms) u.value = on;

    // ガラスが映す 3 段の色。時刻とともに変わるので毎フレーム配る。
    // 路面の照り返しは地面からの回り込みをさらに落としたもの
    // （アスファルトは空の 1/3 も返さない）。
    // 天頂の色をそのまま映すと、ガラスの上端が**原色の青**になって
    // 「青いグラデーションに塗った板」に見える。実際に窓が映すのは
    // 頭上の空そのものではなく、斜め上の霞んだ空なので、地平の色を 4 割
    // 混ぜて彩度を落とす。階調は残したまま、色が暴れなくなる。
    this.glassSky.copy(atmo.zenith).lerp(atmo.horizon, 0.4).multiplyScalar(1.05);
    this.glassHorizon.copy(atmo.horizon);
    this.glassGround.copy(atmo.groundLight).multiplyScalar(0.35);
    for (const s of this.surfaces) {
      s.glassSky.value.copy(this.glassSky);
      s.glassHorizon.value.copy(this.glassHorizon);
      s.glassGround.value.copy(this.glassGround);
    }

    // 接地影は日向でいちばん濃い。夜は街灯の拡散光しかないので薄くする
    // （ただし 0 にはしない。夜でも足元は必ず暗い）。
    this.shadows.setOpacity(0.5 - on * 0.26);
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
    this.coneCount = 0;
    this.shadows.reset();
    // 接地影の距離しきい値。カメラの引き具合に連動させる。
    // 引いた画では丸ごと切る（1px 未満の影にドローコールは払えない）。
    const closeUp = camDistance < CONTACT_DETAIL_M;
    const shadowRadius =
      camDistance < SHADOW_DETAIL_M ? Math.min(SHADOW_DISTANCE_M, Math.max(90, camDistance * 1.9)) : 0;
    this.shadowFar2 = shadowRadius * shadowRadius;
    this.shadowNear2 = (shadowRadius * SHADOW_FADE_FROM) ** 2;
    this.conesOn = closeUp;
    // 俯瞰では車種を 1 つに畳む（`CAR_KIND_LOD_M` の注記を参照）。
    this.carLod = camDistance >= CAR_KIND_LOD_M;
    this.trainLod = camDistance >= TRAIN_FACE_LOD_M;
    for (const f of this.cars) f.count = f.lit = 0;
    this.trucks.count = this.trucks.lit = 0;
    this.buses.count = this.buses.lit = 0;
    for (const f of this.trains) f.count = f.lit = 0;
    this.busy.clear();
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
        pedColor(h, this.color);
      }

      // 歩き。個体ごとに位相をずらさないと、街じゅうが同じ足で行進する。
      const phase = tick * WALK_RATE + (((h >>> 3) % 1024) / 1024) * Math.PI * 2;
      const swing = Math.sin(phase) * WALK_SWING;
      // 上下の揺れ。踏み込むたびに腰が沈むので、歩調の 2 倍で振る。
      const bob = Math.abs(Math.cos(phase)) * 0.022;
      this.putPerson(d2 <= animDist2, wx, groundY, wz, this.tmp.heading, swing, bob, h, d2);
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

        pedColor(h, this.color);
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
          h,
          dx * dx + dz * dz,
        );
      }
    }

    this.drawVehicles(sim, camX, camZ, vehDist2, tick);
    this.drawParkedCars(sim, camX, camZ, camDistance, pedDist2);
    // 飾りは最後。実在のエージェントに枠を先に取らせてから、余りで街を埋める。
    this.drawStreetLife(sim, camX, camZ, camDistance, animDist2);
    this.drawTrains(sim, camX, camZ, trainDist2, tick);

    const lampsOn = this.nightAmount > LAMP_ON;
    setCount(this.pedSimple, this.simpleCount);
    setCount(this.pedBody, this.animCount);
    setCount(this.pedLimbs[0]!, this.animCount);
    setCount(this.pedLimbs[1]!, this.animCount);
    let vehicles = 0;
    for (const f of [...this.cars, this.trucks, this.buses, ...this.trains]) {
      setCount(f.body, f.count);
      if (f.lamps) setCount(f.lamps, lampsOn ? f.lit : 0);
      vehicles += f.count;
    }
    setCount(this.beams, lampsOn ? this.beamCount : 0);
    setCount(this.cones, lampsOn ? this.coneCount : 0);
    this.shadows.finish();

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
    hash: number,
    d2: number,
  ): boolean {
    // 体格を個体ごとに散らす。「全員が同じ大きさ」は、姿勢や服の色より先に
    // 「同じ人形を並べた」と読まれる。身長 1.55〜1.87m、横幅 ±10% ほど。
    const sy = 0.91 + ((hash >>> 13) % 32) / 160;
    const sxz = 0.9 + ((hash >>> 23) % 26) / 110;
    this.scl.set(sxz, sy, sxz);

    // 足元の接地影。人が浮いて見えるのは、影マップの解像度と normalBias で
    // 必ず抜ける「足元の数十 cm」が空いているせい。
    this.shadows.add(
      x,
      y + 0.02,
      z,
      heading,
      PED_SHOULDER_M * 1.3 * sxz,
      PED_SHOULDER_M * 1.7 * sxz,
      this.shadowStrength(d2) * 0.85,
    );

    if (near && this.animCount < MAX_ANIMATED_PEDS) {
      const n = this.animCount;
      this.quat.setFromAxisAngle(this.axisY, heading);
      this.pos.set(x, y + bob, z);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.pedBody.setMatrixAt(n, this.mat);
      this.pedBody.setColorAt(n, this.color);
      // 手足は腰と肩の中間を軸に前後へ振る。左右で符号を逆にすると対角で揃う。
      // 軸の高さも身長に合わせて伸ばさないと、背の高い人だけ腰から下が伸びる。
      this.pos.y = y + bob + LIMB_PIVOT_Y * sy;
      for (let k = 0; k < 2; k++) {
        this.quat.setFromAxisAngle(this.axisY, heading);
        this.quat2.setFromAxisAngle(this.axisX, k === 0 ? swing : -swing);
        this.quat.multiply(this.quat2);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.pedLimbs[k]!.setMatrixAt(n, this.mat);
        this.pedLimbs[k]!.setColorAt(n, this.color);
      }
      this.animCount++;
      this.scl.set(1, 1, 1);
      return true;
    }
    if (this.simpleCount >= MAX_VISIBLE_AGENTS) {
      this.scl.set(1, 1, 1);
      return false;
    }
    this.quat.setFromAxisAngle(this.axisY, heading);
    this.pos.set(x, y, z);
    this.mat.compose(this.pos, this.quat, this.scl);
    this.pedSimple.setMatrixAt(this.simpleCount, this.mat);
    this.pedSimple.setColorAt(this.simpleCount, this.color);
    this.simpleCount++;
    this.scl.set(1, 1, 1);
    return false;
  }

  /**
   * 接地影の濃さ。手前は 1、遠くへ向かって 0 に落とす。
   * 打ち切りの線で影だけが一斉に消えると、そこに境界線が見えてしまう。
   */
  private shadowStrength(d2: number): number {
    if (d2 >= this.shadowFar2) return 0;
    if (d2 <= this.shadowNear2) return 1;
    return (this.shadowFar2 - d2) / (this.shadowFar2 - this.shadowNear2);
  }

  /**
   * 走っている車の夜の灯りを路面と空中に置く。3 つ 1 組。
   *
   * - **前照灯の楕円プール**（路面）。これが無いと道路が真っ暗なまま
   *   「光る点が流れる」画になる。
   * - **光の円錐**（空中）。真横から見たときに車が光源として立体になる。
   * - **尾灯の照り返し**（路面・赤）。去っていく車の後ろに赤い滲みが残る。
   *   夜の街路の写真でいちばん目に付く赤はこれで、無いと車列が
   *   「白い点の列」にしかならない。
   *
   * 板は前後で同じジオメトリを使い、色だけ `instanceColor` で分ける。
   * `this.mat` に車体の行列が入っている状態で呼ぶこと。
   */
  private addBeam(beam: Matrix4, cone: Matrix4, pool: Matrix4): void {
    if (this.nightAmount <= LAMP_ON) return;
    if (this.beamCount < MAX_VISIBLE_VEHICLES) {
      this.mat2.multiplyMatrices(this.mat, beam);
      this.beams.setMatrixAt(this.beamCount, this.mat2);
      this.beams.setColorAt(this.beamCount, this.beamWhite);
      this.beamCount++;
    }
    if (this.beamCount < MAX_VISIBLE_VEHICLES) {
      this.mat2.multiplyMatrices(this.mat, pool);
      this.beams.setMatrixAt(this.beamCount, this.mat2);
      this.beams.setColorAt(this.beamCount, this.beamRed);
      this.beamCount++;
    }
    if (this.conesOn && this.coneCount < MAX_VISIBLE_VEHICLES) {
      this.mat2.multiplyMatrices(this.mat, cone);
      this.cones.setMatrixAt(this.coneCount, this.mat2);
      this.coneCount++;
    }
  }

  /**
   * 車体 1 台ぶんの接地影。`this.pos` に車体の位置が入っている状態で呼ぶ。
   * 幅は車体幅の 1.1 倍、長さは全長の 1.05 倍。
   */
  private addVehicleShadow(heading: number, width: number, length: number, d2: number): void {
    this.shadows.add(
      this.pos.x,
      this.pos.y + 0.02,
      this.pos.z,
      heading,
      width * 1.1 * this.jitterW,
      length * 1.05 * this.jitterL,
      this.shadowStrength(d2),
    );
  }

  /**
   * 1 台ぶんの寸法のばらつきを `this.scl` に入れる（`SIZE_JITTER_*` の注記を参照）。
   *
   * `this.scl` は人・電車と共有している使い回しのベクタなので、行列を組んだら
   * すぐ 1 に戻す。倍率のほうは接地影の大きさにも要るので、別に覚えておく。
   */
  private setVehicleScale(hash: number): void {
    const a = ((hash >>> 9) % 64) / 64 - 0.5;
    const b = ((hash >>> 15) % 64) / 64 - 0.5;
    const c = ((hash >>> 21) % 64) / 64 - 0.5;
    this.jitterW = 1 + a * SIZE_JITTER_XZ;
    this.jitterL = 1 + c * SIZE_JITTER_XZ * 1.6;
    this.scl.set(this.jitterW, 1 + b * SIZE_JITTER_Y, this.jitterL);
  }

  /** 寸法のばらつきを解いて、共有のベクタを 1 に戻す。 */
  private clearVehicleScale(): void {
    this.jitterW = 1;
    this.jitterL = 1;
    this.scl.set(1, 1, 1);
  }

  /**
   * ハッシュから車種を選ぶ。引いた画では 1 車種に畳む（`CAR_KIND_LOD_M`）。
   * 畳む先はセダン。いちばん平均的な形なので、遠景の点として無難。
   */
  private pickCarKind(hash: number): CarKind {
    return this.carLod ? CarKind.Sedan : carKind(hash);
  }

  /** 灯りメッシュに 1 台ぶん書き込む。本体とは別の連番で数える。 */
  private addLamps(fleet: Fleet, capacity: number): void {
    if (!fleet.lamps || fleet.lit >= capacity) return;
    fleet.lamps.setMatrixAt(fleet.lit, this.mat);
    fleet.lit++;
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

      const wx = (tileX(access) + 0.5) * TILE_M;
      const wz = (tileY(access) + 0.5) * TILE_M;
      const dx = wx - camX;
      const dz = wz - camZ;
      const d2 = dx * dx + dz * dz;
      // 距離の判定を駐車枠の確保より先に置く。逆にすると、視野の外にいて
      // 描かない車が枠を潰し、境界のタイルに本来より少ない台数しか並ばない。
      if (d2 > maxDist2) continue;

      const hash = (id * 2654435761) >>> 0;
      // 停める側は車ごとのハッシュで選び、埋まっていれば反対側へ回る。
      // 走行車両が来ている車線には置かない（重なって 1 台が 2 台に割れて見える）。
      const want = hash & 0x10000 ? 1 : -1;
      let side = 0;
      for (const cand of [want, -want] as const) {
        if (this.busy.has(access * 2 + (cand > 0 ? 1 : 0))) continue;
        if (this.tryShoulder(access, cand)) {
          side = cand;
          break;
        }
      }
      if (side === 0) continue;

      const kind = this.pickCarKind(hash);
      const fleet = this.cars[kind]!;
      if (fleet.count >= MAX_VISIBLE_VEHICLES) continue;

      const conn = sim.world.roadConn(access);
      const alongZ = (conn & 0b0101) !== 0 || conn === 0;
      this.placeParked(sim, access, wx, wz, alongZ, side, sim.world.road[access]!, kind, hash, d2);
    }
  }

  /**
   * 路肩の枠を 1 つ取る。取れたら true。
   *
   * **1 タイル 1 側につき 1 台まで**にするのが要点。タイルは 10m しかないので、
   * 2 台入れると必ず車間が 1m を切り、タイル境界をまたぐ組はさらに詰まる。
   * 「消失点まで隙間なく一列、しかも互いに貫入」の正体はここだった。
   */
  private tryShoulder(tile: number, side: number): boolean {
    const used = this.parkSlots.get(tile) ?? 0;
    const bit = side > 0 ? 2 : 1;
    if (used & bit) return false;
    // **枠のうち一定割合は最初から潰しておく。**
    //
    // 1 タイル 1 側 1 台にしても、市街地では自宅と職場の車で枠がほぼ全部埋まる。
    // タイルは 10m 間隔の格子なので、埋まりきると「10m ごとに 1 台」という
    // 寸分違わぬリズムの列になり、隙間が車 1 台ぶんも空かない。
    // 実際の路肩には車庫の出入口・交差点の隅切り・バス停・消火栓があって、
    // 4 枠に 1 つは必ず空いている。空き枠をタイルのハッシュで決めておけば、
    // 列に不規則な切れ目が入って「並べた」感じが消える（描く台数も 1/4 減る）。
    if (tileHash(tile, side > 0 ? 31 : 32) % 100 < EMPTY_SLOT_PCT) {
      this.parkSlots.set(tile, used | bit);
      return false;
    }
    this.parkSlots.set(tile, used | bit);
    return true;
  }

  /**
   * 路肩に車を 1 台置く。シミュレーション由来の駐車車両と飾りの車で共通。
   *
   * 「インスタンスを並べただけ」に見せないために、ここで 3 つを散らす。
   *
   * - **前後の位置** を ±1.6m。等間隔の列が崩れる。
   * - **向き** を ±1.5°。完璧に平行な列は現実には存在しない。
   * - **色** を 11 色 + 微小なばらつき。同じ「白」でも隣とは違う白になる。
   */
  private placeParked(
    sim: Simulation,
    tile: number,
    wx: number,
    wz: number,
    alongZ: boolean,
    side: number,
    cls: number,
    kind: CarKind,
    hash: number,
    d2: number,
  ): void {
    const fleet = this.cars[kind]!;
    const h = tileHash(tile, side > 0 ? 21 : 22);
    // タイル内での前後の揺らぎ。同じタイル・同じ側なら毎フレーム同じ値になる。
    // 幅は ±1.9m。枠の 27% を空けたぶん前後に余裕ができたので、±1.6m から
    // 広げてある。等間隔の列がそのぶん強く崩れる。
    const along = (((h >>> 6) % 64) / 64 - 0.5) * 3.8;
    const curb = side * (shoulderOffset(cls, kind) + (((h >>> 12) % 16) / 16 - 0.5) * 0.24);
    const ox = alongZ ? curb : along;
    const oz = alongZ ? along : curb;
    // 左側通行なので、路肩の車はその車線の進行方向を向いている。
    // 前後をハッシュで裏返していた頃は、対向車線に頭から突っ込んだ車が並んでいた。
    const yaw = parkHeading(alongZ, side) + (((h >>> 18) % 64) / 64 - 0.5) * PARK_YAW_JITTER;
    this.quat.setFromAxisAngle(this.axisY, yaw);
    this.pos.set(wx + ox, this.groundAt(sim, wx + ox, wz + oz) + ROAD_SURFACE_M, wz + oz);
    this.setVehicleScale(hash);
    this.mat.compose(this.pos, this.quat, this.scl);
    this.scl.set(1, 1, 1);
    fleet.body.setMatrixAt(fleet.count, this.mat);
    jitterColor(carPaint(hash), hash >>> 11, 0.045, this.color);
    fleet.body.setColorAt(fleet.count, this.color);
    fleet.count++;
    this.addVehicleShadow(yaw, carHalfWidth(kind) * 2, carLength(kind), d2);
    // 夜は一部だけ灯りを点ける（`PARKED_LIT_PCT` の理由はそちらの注記に）。
    // 路面への光は付けない。停まっている車の光溜まりが重なると、
    // 路肩が一本の光の帯になってしまう。
    if (this.nightAmount > LAMP_ON && (hash >>> 3) % 100 < PARKED_LIT_PCT) {
      this.addLamps(fleet, MAX_VISIBLE_VEHICLES);
    }
    this.clearVehicleScale();
  }

  /**
   * 飾りの路上。
   *
   * カメラの周りの道路タイルを走査して、路肩に停まっている車と歩道に立つ人を
   * 撒く。シミュレーションには一切触らず、タイル番号のハッシュだけで位置を決める。
   * 同じタイルは毎フレーム同じ結果になるので、カメラを動かしてもちらつかない。
   *
   * 置き場所には守るべき線が 3 本ある。
   *
   * - 車は **車道の内側**（縁石の手前）。外に出すと歩道に乗り上げる。
   * - 人は **車道の外側**（縁石の上）。内に入れると車道の真ん中に立つ。
   * - 交差点と踏切には何も置かない。曲がってくる車と正面衝突して見える。
   */
  private drawStreetLife(
    sim: Simulation,
    camX: number,
    camZ: number,
    camDistance: number,
    animDist2: number,
  ): void {
    if (camDistance >= STREET_LIFE_DISTANCE_M) return;
    const world = sim.world;
    const radius = Math.min(STREET_LIFE_RADIUS_M, Math.max(120, camDistance * 2.1));
    const maxDist2 = radius * radius;
    const rt = Math.ceil(radius / TILE_M);
    const cx0 = Math.floor(camX / TILE_M);
    const cz0 = Math.floor(camZ / TILE_M);
    // 人は寄ったときだけ。引きの画では 1px 未満にしかならない。
    const drawPeds = camDistance < PEDESTRIAN_LOD_DISTANCE_M;
    const z0 = Math.max(0, cz0 - rt);
    const z1 = Math.min(MAP_H - 1, cz0 + rt);
    const x0 = Math.max(0, cx0 - rt);
    const x1 = Math.min(MAP_W - 1, cx0 + rt);

    for (let ty = z0; ty <= z1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const tile = idx(tx, ty);
        const cls = world.road[tile]!;
        if (cls === RoadClass.None) continue;
        const wx = (tx + 0.5) * TILE_M;
        const wz = (ty + 0.5) * TILE_M;
        const dx = wx - camX;
        const dz = wz - camZ;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxDist2) continue;

        const conn = world.roadConn(tile);
        const ns = (conn & 0b0101) !== 0;
        const ew = (conn & 0b1010) !== 0;
        // 直線区間だけ。交差点・曲がり角は空けておく。
        if (ns === ew) continue;
        const half = CARRIAGE_HALF_M[cls] ?? CARRIAGE_HALF_M[RoadClass.Street]!;

        if (!world.isLevelCrossing(tile)) this.parkOnShoulder(sim, tile, wx, wz, ns, cls, d2);
        if (drawPeds) this.standOnWalkway(sim, tile, wx, wz, ns, half, camX, camZ, maxDist2, animDist2);
      }
    }
  }

  /**
   * 路肩に飾りの車を 1 台。既存の車種メッシュに相乗りするのでドローコールは増えない。
   *
   * 抽選は**左右それぞれ独立**に行う。1 タイル 1 側 1 台の上限があるので、
   * 台数を稼ぐには側を増やすしかない（縦列を詰めるのは車間を潰す）。
   */
  private parkOnShoulder(
    sim: Simulation,
    tile: number,
    wx: number,
    wz: number,
    alongZ: boolean,
    cls: number,
    d2: number,
  ): void {
    const chance = PARK_CHANCE_PCT[cls] ?? 0;
    for (const side of [-1, 1] as const) {
      const h = tileHash(tile, side > 0 ? 1 : 2);
      if (h % 100 >= chance) continue;
      // **駐車枠はシミュレーション由来の駐車車両と共有する。**
      // 別々に置き場所を決めると、同じ路肩に 2 台が重なって 1 台が 2 台に割れる。
      if (!this.tryShoulder(tile, side)) continue;
      if (this.busy.has(tile * 2 + (side > 0 ? 1 : 0))) continue;
      const hash = (h >>> 3) ^ Math.imul(tile, 0x27d4eb2d);
      const kind = this.pickCarKind(hash);
      if (this.cars[kind]!.count >= MAX_VISIBLE_VEHICLES) continue;
      this.placeParked(sim, tile, wx, wz, alongZ, side, cls, kind, hash >>> 0, d2);
    }
  }

  /**
   * 歩道に立つ人。
   *
   * 密度は地価から決める。都心の商業地は歩道が人で埋まり、郊外の住宅地は
   * ぽつぽつになる。一律に撒くと、田畑の中の農道にまで人が並ぶ。
   */
  private standOnWalkway(
    sim: Simulation,
    tile: number,
    wx: number,
    wz: number,
    alongZ: boolean,
    half: number,
    camX: number,
    camZ: number,
    maxDist2: number,
    animDist2: number,
  ): void {
    const world = sim.world;
    const lv = world.landValue[tile]!;
    const h = tileHash(tile, 2);
    let n = lv > 150 ? 3 : lv > 96 ? 2 : lv > 48 ? 1 : 0;
    // 地価の低い通りも完全に無人にはしない（1/8 のタイルに 1 人）。
    if (n === 0 && (h & 7) === 0) n = 1;
    // 公園と商業地は通り沿いに人が出る。工業地と農地は逆に減らす。
    const zone = world.zone[tile]!;
    if (zone === Zone.IndustrialHeavy || zone === Zone.AgriPaddy || zone === Zone.AgriField) {
      n = Math.min(n, 1);
    }

    for (let k = 0; k < n; k++) {
      const g = tileHash(tile, 10 + k);
      const side = g & 1 ? 1 : -1;
      // 縁石の内側（車道）と歩道の外縁の**両方**で挟む。外縁で切るだけだと、
      // 車道の広い大通り（半幅 4.3m）で人が舗装の上に立ってしまう。
      const inner = half + 0.35;
      const outer = Math.max(inner, WALK_OUTER_M - 0.35);
      const lateral = side * Math.min(outer, inner + ((g >>> 3) % 3) * 0.4);
      const along = (((g >>> 6) % 100) / 100 - 0.5) * TILE_M * 0.86;
      const px = wx + (alongZ ? lateral : along);
      const pz = wz + (alongZ ? along : lateral);
      const dx = px - camX;
      const dz = pz - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxDist2) continue;

      pedColor(g, this.color);
      // 通りに沿った 2 方向を主に、少しだけ振る。全員が真正面を向くと人形の展示になる。
      const facing = alongZ
        ? ((g >>> 2) & 1 ? 0 : Math.PI)
        : ((g >>> 2) & 1 ? Math.PI / 2 : -Math.PI / 2);
      const heading = facing + (((g >>> 11) % 32) / 32 - 0.5) * 0.9;
      const stance = (((g >>> 17) % 64) / 64 - 0.5) * 0.26;
      const py = this.groundAt(sim, px, pz) + WALK_SURFACE_M;
      if (!this.putPerson(d2 <= animDist2, px, py, pz, heading, stance, 0, g, d2)) {
        // 簡易形の枠も尽きていたら、以降のタイルでも入らないので打ち切る。
        if (this.simpleCount >= MAX_VISIBLE_AGENTS) return;
      }
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
          // 引いた画では顔も幌も読めないので、中間車 1 種類に畳む。
          const slot = this.trainLod ? 1 : carIdx === 0 ? 0 : carIdx === TRAIN_CARS - 1 ? 2 : 1;
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
          this.addLamps(fleet, MAX_VISIBLE_TRAIN_CARS);
          // 前照灯は「編成の先頭かどうか」で決める。畳んだときも点いたままにする。
          if (carIdx === 0) this.addBeam(this.trainBeamLocal, this.trainConeLocal, this.trainPoolLocal);
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
    const graph = sim.graph;
    const nowSec = tick * 60;
    const t = sim.freight.trucks;

    // --- 1 巡目: 位置を集める ---
    //
    // 交通流が持っているのは「リンクをどこまで進めたか」だけで、車体の長さを
    // 知らない。そのまま置くと詰まった車列で前後がめり込む。
    //
    // 並べ直す単位は**リンクではなく車線**にする。リンクはタイル 1 つぶん
    // （10m）しかないので、リンクごとに整えても「隣のリンクの車と重なる」が
    // まったく直らない。道路は必ず軸に平行なので、
    // 「軸 × 直交方向のタイル列 × 進行の向き」で 1 本の車線として束ねられる。
    this.vehCount = 0;
    tr.forEachVehicle((v) => {
      const kind = tr.kind[v]!;
      if (!tr.pose(graph, v, nowSec, this.tmp)) return;
      const dx = this.tmp.x - camX;
      const dz = this.tmp.z - camZ;
      if (dx * dx + dz * dz > maxDist2) return;
      const edge = this.tmp.edge;
      if (edge < 0) return;
      const a = graph.edgeFrom[edge]!;
      const b = graph.edgeTo[edge]!;
      const ex = graph.nodeX[b]! - graph.nodeX[a]!;
      const ez = graph.nodeZ[b]! - graph.nodeZ[a]!;
      const alongZ = Math.abs(ez) >= Math.abs(ex);
      const sign = (alongZ ? ez : ex) >= 0 ? 1 : -1;
      // 車線 ID。直交方向のタイル列で束ねる（同じ通りの同じ向きが 1 本になる）。
      const perp = Math.round((alongZ ? this.tmp.x : this.tmp.z) / TILE_M);
      const lane = perp * 4 + (alongZ ? 2 : 0) + (sign > 0 ? 1 : 0);
      const along = (alongZ ? this.tmp.z : this.tmp.x) * sign;
      this.pushVehicle(
        v,
        lane,
        along,
        kind === VehicleKind.Truck
          ? TRUCK_BODY_M
          : kind === VehicleKind.Bus
            ? BUS_BODY_M
            : carLength(this.pickCarKind((tr.owner[v]! * 2654435761) >>> 0)),
        this.tmp.x,
        this.tmp.z,
        Math.atan2(ex, ez),
        alongZ,
        sign,
      );
    });

    // --- 2 巡目: 同じ車線の前後で最小車間を強制する ---
    //
    // 車線ごとに前（進行方向側）から並べ、後ろの車を必要なだけ下げる。
    // 先頭（停止線に着いている車）は動かさない。動かすと信号待ちの列が
    // 交差点に食い込む。
    const order = this.vehOrder;
    order.length = 0;
    for (let i = 0; i < this.vehCount; i++) order.push(i);
    order.sort((p, q) => this.vehLane[p]! - this.vehLane[q]! || this.vehAlong[q]! - this.vehAlong[p]!);
    let curLane = Number.NaN;
    let prevAlong = 0;
    let prevLen = 0;
    for (const i of order) {
      const lane = this.vehLane[i]!;
      const len = this.vehLength[i]!;
      if (lane !== curLane) {
        curLane = lane;
      } else {
        const gap = Math.max(MIN_HEADWAY_M, MIN_HEADWAY_RATIO * Math.max(len, prevLen));
        const limit = prevAlong - prevLen / 2 - gap - len / 2;
        if (this.vehAlong[i]! > limit) {
          // 押し下げ量が過ぎるものは描かない（`MAX_PUSHBACK_M` の注記を参照）。
          // 基準は前の車のまま据え置く。そうしないと、落とした車の位置から
          // 数えて次の車がさらに後ろへ流れていく。
          if (this.vehAlong[i]! - limit > MAX_PUSHBACK_M) {
            this.vehDrawn[i] = 0;
            continue;
          }
          this.vehAlong[i] = limit;
        }
      }
      this.vehDrawn[i] = 1;
      prevAlong = this.vehAlong[i]!;
      prevLen = len;
    }

    // --- 3 巡目: 実際に置く ---
    for (let i = 0; i < this.vehCount; i++) {
      if (this.vehDrawn[i] === 0) continue;
      const v = this.vehSlot[i]!;
      const kind = tr.kind[v]!;
      const isTruck = kind === VehicleKind.Truck;
      const isBus = kind === VehicleKind.Bus;
      if (isTruck && this.trucks.count >= MAX_VISIBLE_TRUCKS) continue;
      if (isBus && this.buses.count >= MAX_VISIBLE_BUSES) continue;

      // 車線の向きの成分だけを、車間を空けた値に差し替える。
      const alongZ = this.vehAlongZ[i] === 1;
      const sign = this.vehSign[i]!;
      const moved = this.vehAlong[i]! * sign;
      const px = alongZ ? this.vehX[i]! : moved;
      const pz = alongZ ? moved : this.vehZ[i]!;

      const heading = this.smoothHeading(v, tr.departTick[v]!, this.vehHeading[i]!)
        // 走行中もほんの少しだけ向きを散らす。全車が完璧に車線と平行だと、
        // 消失点まで伸びる列が 1 本の定規に見える。
        + (((v * 2654435761) >>> 20) % 32) / 32 * DRIVE_YAW_JITTER - DRIVE_YAW_JITTER / 2;
      this.quat.setFromAxisAngle(this.axisY, heading);
      // 左側通行。対向車が別の車線を流れる
      const ox = this.laneOffsetX(heading, LANE_OFFSET_M);
      const oz = this.laneOffsetZ(heading, LANE_OFFSET_M);
      this.pos.set(px + ox, this.groundAt(sim, px + ox, pz + oz) + ROAD_SURFACE_M, pz + oz);
      const owner = tr.owner[v]!;
      // 寸法を数 % 振る。とくにトラックは形が 1 種類しか無いので、
      // これが無いと目線のカットで同じ箱が定規のように並ぶ。
      this.setVehicleScale(Math.imul(owner + 1, 2654435761) ^ (kind * 0x9e3779b9));
      this.mat.compose(this.pos, this.quat, this.scl);
      this.scl.set(1, 1, 1);
      this.markLane(px + ox, pz + oz, heading, ox, oz, isTruck || isBus);
      const dx = px - camX;
      const dz = pz - camZ;
      const d2 = dx * dx + dz * dz;

      if (isTruck) {
        const f = this.trucks;
        f.body.setMatrixAt(f.count, this.mat);
        // 積荷があれば積荷の色、空車（帰路）なら事業者の塗色。
        // 帰りの車をすべて同じ灰色にしていたので、走っているトラックの
        // 過半数が「同じ形・同じ色」で並び、そこがいちばん機械的に見えていた。
        // 積荷が無い車（帰路、または積んでいない車）は事業者の塗色。
        // `Good.None` を積荷の色として拾うと、同じ灰色が延々と並ぶ。
        const good = t.good[owner]!;
        const empty =
          t.alive[owner] !== 1 || t.state[owner] === TruckState.Returning || good === Good.None;
        const base = empty
          ? truckLivery((owner * 2654435761) >>> 0)
          : (CARGO_COLORS[good] ?? CARGO_COLORS[Good.None]!);
        // ばらつきを 0.05 → 0.13 に広げる。トラックは形が 1 種類しか無く、
        // 積荷の色も 7 通りしか無いので、同じ品目の車が続くとそこだけ
        // 「同じ色の箱の列」になる。同じ品目でも 1 台ずつ濃さが違えば、
        // 何を積んでいるかは読めたまま列がばらける。
        jitterColor(base, (owner * 40503) >>> 0, 0.13, this.color);
        f.body.setColorAt(f.count, this.color);
        this.addLamps(f, MAX_VISIBLE_TRUCKS);
        this.addBeam(this.truckBeamLocal, this.truckConeLocal, this.truckPoolLocal);
        this.addVehicleShadow(heading, TRUCK_WIDTH_M, TRUCK_BODY_M, d2);
        f.count++;
      } else if (isBus) {
        // 車体は路線の色。路線一覧の色と揃えてあるので、
        // 「いま目の前を通ったのがどの系統か」が地図の上で分かる。
        const f = this.buses;
        f.body.setMatrixAt(f.count, this.mat);
        this.color.setHex(lineColor(sim.transit.lineOfBus(owner)));
        f.body.setColorAt(f.count, this.color);
        this.addLamps(f, MAX_VISIBLE_BUSES);
        this.addBeam(this.busBeamLocal, this.busConeLocal, this.busPoolLocal);
        this.addVehicleShadow(heading, BUS_WIDTH_M, BUS_BODY_M, d2);
        f.count++;
      } else {
        const hash = (owner * 2654435761) >>> 0;
        const kindIdx = this.pickCarKind(hash);
        const f = this.cars[kindIdx]!;
        if (f.count >= MAX_VISIBLE_VEHICLES) continue;
        f.body.setMatrixAt(f.count, this.mat);
        jitterColor(carPaint(hash), hash >>> 11, 0.045, this.color);
        f.body.setColorAt(f.count, this.color);
        this.addLamps(f, MAX_VISIBLE_VEHICLES);
        this.addBeam(this.carBeamLocal[kindIdx]!, this.carConeLocal[kindIdx]!, this.carPoolLocal[kindIdx]!);
        this.addVehicleShadow(heading, carHalfWidth(kindIdx) * 2, carLength(kindIdx), d2);
        f.count++;
      }
      this.clearVehicleScale();
    }
  }

  /** 走行中の車両を 1 台ぶん溜める。配列は使い回して伸ばすだけ。 */
  private pushVehicle(
    slot: number,
    lane: number,
    along: number,
    length: number,
    x: number,
    z: number,
    heading: number,
    alongZ: boolean,
    sign: number,
  ): void {
    if (this.vehCount >= this.vehSlot.length) {
      const n = Math.max(512, this.vehSlot.length * 2);
      const grow32 = (src: Int32Array): Int32Array<ArrayBuffer> => {
        const out = new Int32Array(n);
        out.set(src);
        return out;
      };
      const growF = (src: Float32Array): Float32Array<ArrayBuffer> => {
        const out = new Float32Array(n);
        out.set(src);
        return out;
      };
      this.vehSlot = grow32(this.vehSlot);
      this.vehDrawn = grow32(this.vehDrawn);
      this.vehLane = grow32(this.vehLane);
      this.vehAlongZ = grow32(this.vehAlongZ);
      this.vehSign = grow32(this.vehSign);
      this.vehAlong = growF(this.vehAlong);
      this.vehLength = growF(this.vehLength);
      this.vehX = growF(this.vehX);
      this.vehZ = growF(this.vehZ);
      this.vehHeading = growF(this.vehHeading);
    }
    const i = this.vehCount++;
    this.vehSlot[i] = slot;
    this.vehDrawn[i] = 1;
    this.vehLane[i] = lane;
    this.vehAlong[i] = along;
    this.vehLength[i] = length;
    this.vehX[i] = x;
    this.vehZ[i] = z;
    this.vehHeading[i] = heading;
    this.vehAlongZ[i] = alongZ ? 1 : 0;
    this.vehSign[i] = sign;
  }

  /**
   * 走行中の車両が今いる「タイル×車線の側」に印を付ける。
   *
   * 車体は 4m 級なのでタイル境界をまたぐ。前後 1 つずつも一緒に潰しておかないと、
   * 隣のタイルに置いた駐車車両に半分めり込む。
   */
  private markLane(x: number, z: number, heading: number, ox: number, oz: number, wide: boolean): void {
    // 前方は (sin h, cos h)。|cos| が大きいほど道は Z 方向に走っている。
    const alongZ = Math.abs(Math.cos(heading)) >= Math.abs(Math.sin(heading));
    const side = (alongZ ? ox : oz) > 0 ? 1 : 0;
    // タイルは 10m。前後 5m を潰しておけば、車体がまたいだ隣のタイルも必ず入る。
    const fx = Math.sin(heading) * 5;
    const fz = Math.cos(heading) * 5;
    for (let k = -1; k <= 1; k++) {
      const tx = Math.floor((x + fx * k) / TILE_M);
      const tz = Math.floor((z + fz * k) / TILE_M);
      if (tx < 0 || tz < 0 || tx >= MAP_W || tz >= MAP_H) continue;
      const t = idx(tx, tz);
      this.busy.add(t * 2 + side);
      // バス（全幅 2.44m）とトラックは、車線の中央にいても反対側の路肩まで届く。
      if (wide) this.busy.add(t * 2 + (1 - side));
    }
  }

  dispose(): void {
    this.shadows.dispose();
    // InstancedMesh.dispose() はジオメトリを解放しない。明示的に捨てる。
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}

/**
 * タイル番号から決定的な 32bit ハッシュを作る（salt で系統を分ける）。
 *
 * 飾りの位置はこれだけで決まる。乱数を引くとフレームごとに車と人が入れ替わって
 * 街全体がちらつくし、シミュレーションの乱数列に触れると再現性が壊れる。
 */
function tileHash(tile: number, salt: number): number {
  let h = (tile ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 路肩に停める車の、道路中心からの横位置 (m)。
 *
 * 車体の外側が縁石の 12cm 手前で止まるように置く。車種で全幅が違うので
 * 一律の値にはできない（軽で寄せ足りず、ワンボックスで乗り上げる）。
 */
function shoulderOffset(cls: number, kind: CarKind): number {
  const half = CARRIAGE_HALF_M[cls] ?? CARRIAGE_HALF_M[RoadClass.Street]!;
  return Math.max(1.3, half - carHalfWidth(kind) - 0.12);
}

/** 路肩の車の向き。左側通行なので、その車線の進行方向を向く。 */
function parkHeading(alongZ: boolean, side: number): number {
  if (alongZ) return side > 0 ? 0 : Math.PI;
  return side > 0 ? -Math.PI / 2 : Math.PI / 2;
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

/** 光の円錐の相対行列（単位ジオメトリは 頂点が原点・+Z 長さ 1・半径 0.5）。 */
function coneLocal(spec: ConeSpec): Matrix4 {
  const m = new Matrix4();
  m.makeScale(spec.width, spec.height, spec.length);
  m.setPosition(0, spec.y, spec.z);
  return m;
}

/**
 * 尾灯が路面に落とす照り返しの相対行列。
 * 光の板は +Z へ伸びるので、Y まわりに 180 度回して後ろへ向ける。
 * 前照灯より弱く短い（尾灯は路面を照らすための灯りではない）。
 */
function poolLocal(spec: ConeSpec): Matrix4 {
  const m = new Matrix4().makeRotationY(Math.PI);
  m.scale(new Vector3(spec.width * 0.5, 1, 3.4));
  m.setPosition(0, 0.03, -spec.z - 0.4);
  return m;
}
