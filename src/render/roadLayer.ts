import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import { OneWay, RoadClass, Terrain, TransitKind, Zone } from '@shared/enums';
import type { Simulation } from '@sim/simulation';
import { neighbor, tileX, tileY } from '@sim/world/tiles';
import { surface } from './materials';
import { applySurfaceNoise } from './surfaceNoise';
import { InstancePool } from './instancePool';
import { atmosphereAt } from './sky';
import {
  CROWN_COLOR,
  LAMP_COOL,
  LAMP_WARM,
  LINE_WHITE,
  LINE_YELLOW,
  MANHOLE_COLOR,
  PAVEMENT,
  PATCH_COLOR,
  RUT_COLOR,
} from './groundPalette';
import {
  ARM_HALF,
  ARM_Y,
  GUARDRAIL_LEN,
  LAMP_ARM_X,
  busStopGeometry,
  curveMirrorGeometry,
  guardrailGeometry,
  lampHeadGeometry,
  lightPoolTexture,
  roadSignGeometry,
  streetLampGeometry,
  utilityPoleGeometry,
  vendingGlowGeometry,
  vendingMachineGeometry,
  walkwayCornerGeometry,
  walkwaySectionGeometry,
} from './streetProps';

/**
 * 道路の造形。
 *
 * 以前の道路は「タイル全面に灰色の板を敷き、白い線を数本置く」だけだった。
 * 幅も歩道の段差も無いので、道路クラスを変えても絵が変わらず、
 * 近景では車がのっぺりした灰色の帯の上を滑っているように見えていた。
 *
 * ここでは 3 つを作り直した。
 *
 * **1. 車道をタイル全面ではなく「実際の幅」で敷く。**
 * 中央の正方形と、繋がっている向きへの腕（最大 4 本）に分ける。
 * こうすると交差点でも隙間ができず、しかも道路クラスごとに
 * 舗装の幅そのものが変わる。生活道路と大通りが遠景でも見分けられる。
 *
 * **2. 歩道を「板」ではなく「断面」にする。**
 * L 型側溝の平部・目地・縁石・平板を 1 つのジオメトリに焼いてある
 * （`walkwaySectionGeometry`）。車道側から 2 段で立ち上がるので、
 * 道と歩道の境界に影の線が 2 本出て、路面がはっきり沈んで見える。
 *
 * **3. 街路の小物を置く。**
 * 街灯・電柱・電線・ガードレール・カーブミラー・標識・自販機・バス停。
 * 日本の街路の見た目を決めているのは、実のところ道路そのものではなく
 * この雑多な立ち物の密度だと思う。
 *
 * さらに 2 つを作り直した。
 *
 * **4. 夜の路面を「街灯の下だけ」明るくする。**
 * 以前は道路タイル 1 枚ごとに加算の板を敷いて路面全体を底上げし、
 * そのうえ街灯 1 本の光溜まりを 24m 角・ほぼ全強度で置いていた。
 * 光溜まりが隣同士で完全に重なった結果、夜の街路が
 * **道路の形をした一様な発光カーペット**になり、路面がファサードの
 * 12 倍明るいという上下関係の逆転を起こしていた。
 * 一律の底上げは廃止し（それは半球ライトの仕事）、光溜まりは
 * 街灯の間隔より小さく・以前の 1/6 の強さにした。
 *
 * **5. 路面に情報を入れる。**
 * 目線の高さでは画面の 3〜4 割が路面なので、そこが継ぎ目も轍も無い
 * 一色のグレーだと、そのカット全体が未完成に見える。
 * 骨材の粗さは世界座標のノイズで材質に焼き（`surfaceNoise.ts`）、
 * 轍・補修跡・マンホールはインスタンスで散らす。どれも近景専用で、
 * 引いたら LOD で丸ごと落とすのでドローコールは返ってくる。
 *
 * 更新は「道路のエポックか季節か路線が変わったとき」だけ。
 * 毎フレームやるのは夜の演出（街灯の点灯）だけで、これは材質の
 * パラメータを数個書き換えるだけなので実質ただ。
 */

/**
 * 車道の半幅（描画単位 m）。
 *
 * 車は中心から ±LANE_OFFSET_M(2.2) を走り、車体幅が 1.7m あるので、
 * 最低でも 3.05m 無いと車が歩道にはみ出す。生活道路をその下限ぎりぎりに置き、
 * 上のクラスほど広げると、舗装の幅がそのまま道路クラスの表示になる。
 */
export const CARRIAGE_HALF: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 3.1,
  [RoadClass.Avenue]: 3.7,
  [RoadClass.Boulevard]: 4.3,
};
/** 歩道の外縁。タイルの端まで使う（隣の道路の歩道と自然につながる）。 */
export const WALK_OUTER = 5.0;
/** 歩道の高さ（縁石の段差）。 */
const CURB_H = 0.22;

/**
 * 重ね順。地面と同じ高さに置くと Z ファイティングで激しくちらつくので、
 * 数 cm ずつ持ち上げる。加えて材質側で polygonOffset も掛けてある
 * （斜面では地形の三角形が路面より上に来ることがあり、高さだけでは足りない）。
 */
const Y_ASPHALT = 0.16;
/** 轍・補修跡・マンホール。標示より下（標示は補修跡の上に引き直される）。 */
const Y_WEAR = 0.172;
const Y_MARKING = 0.2;
const Y_POOL = 0.23;

/** 交差点とみなす接続本数（traffic.ts の SIGNAL_MIN_DEGREE と同じ考え方）。 */
const JUNCTION_DEGREE = 3;

/**
 * 向き d (0=北,1=東,2=南,3=西) の「外向き」単位ベクトル。
 * 歩道・小物の位置はすべてこれと車道半幅の組み合わせで決まる。
 */
const OUT_X = [0, 1, 0, -1] as const;
const OUT_Z = [-1, 0, 1, 0] as const;
/** 部品の +X をその向きの外向きに合わせる Y 回転（歩道・電柱の腕金）。 */
const OUTWARD_ROT = [Math.PI / 2, 0, -Math.PI / 2, Math.PI] as const;
/** 部品の +X を道路の中心へ向ける Y 回転（街灯のアーム）。 */
const INWARD_ROT = [-Math.PI / 2, Math.PI, Math.PI / 2, 0] as const;
/** 部品の +Z を道路の中心へ向ける Y 回転（標識・ミラー・自販機の正面）。 */
const FACE_ROT = [0, -Math.PI / 2, Math.PI, Math.PI / 2] as const;

/** 電線の色。夜空を背景にしたときに黒く沈みすぎない灰色にする。 */
const WIRE_COLOR = 0x3a3d42;
/** 電線 1 本のたわみ（水平距離に対する比）。 */
const WIRE_SAG = 0.055;
/**
 * 電線の断面半径 (m)。
 *
 * 以前は `LineSegments`（1px の線）で描いていた。1px の線は
 * **画面解像度に張り付いていて遠近が効かない**うえ、ライン描画は
 * MSAA も SMAA も素直に効かないので、斜めに走るたびに階段状のジャギーが出る
 * （夕方の空を背景にした電線がいちばん目立っていた）。
 * 実物の低圧配電線の外径は 1cm 前後だが、それだと遠景で消えるので少し太らせる。
 * 円柱にすると太さが距離で縮み、法線があるので光も乗る。
 */
const WIRE_RADIUS = 0.03;
/** カテナリーの分割数。3 で「たるみ」は十分読める。 */
const WIRE_SEGMENTS = 3;
/** これより引いたら電線を描かない。1px を割った電線はちらつきにしかならない。 */
const WIRE_LOD_DISTANCE = 620;

/**
 * 路面標示を 1 本ずつ描くのをやめるカメラ距離 (m)。
 *
 * この距離では横断歩道の縞 1 本が 1〜2px にしかならず、SMAA でも取り切れずに
 * モアレとちらつきの粒になる。しかも塗料は舗装より明るいので、
 * **街区の交点すべてが白いビーズの鎖として画面で最初に目に入る**。
 * ここを超えたら、縞のかわりに「縞と舗装を面積比で平均した淡い矩形」を
 * 交差点の流入 1 本につき 1 枚だけ置く。情報（そこに横断歩道がある）は残り、
 * ちらつきの原因になる高周波だけが消える。
 */
const MARKING_LOD_DISTANCE = 280;
/**
 * 遠景の代替（連続線と横断歩道の平均色）も落とす距離 (m)。
 *
 * ここまで引くと車線 1 本の幅は 1 画素の何分の一かになる。面積比で薄めた
 * 矩形でさえ、隣り合う画素の間で出たり消えたりしてちらつく。俯瞰で
 * 道路の形を伝えているのは舗装そのものなので、標示はいっそ全部落とす。
 */
const MARKING_FAR_CUTOFF = 760;

/**
 * 路面の傷み（轍・補修跡・マンホール）を描くカメラ距離 (m)。
 *
 * これは近景専用のディテール。街区より引くと 1 画素未満になって
 * ちらつくだけなので、まるごと落としてドローコールも返す。
 */
const WEAR_LOD_DISTANCE = 260;

/**
 * 横断歩道の塗料。車線の白線よりさらに一段暗い。
 * 横断歩道は轍が直接乗るので実物でもいちばん早く摩耗する。
 */
const CROSSWALK_COLOR = 0xa5a399;
/**
 * 遠景で縞のかわりに敷く矩形の色。
 * 縞の被覆率（幅 0.55m / 間隔 1.25m ＝ 約 44%）で舗装と塗料を混ぜた値。
 */
const CROSSWALK_FAR_COLOR = 0x62635c;

/**
 * 夜、街灯が路面に落とす光の大きさ (m) と強さ。
 *
 * ここは作り直した。以前は「道路タイル 1 枚ごとに弱い加算の板を敷いて
 * 路面全体を底上げする」ことをしていて、そのうえ街灯 1 本の光溜まりを
 * 24m 角・ほぼ全強度で置いていた。結果として光溜まりが隣同士で完全に
 * 重なり、**道路の形をした一様な発光カーペット**になっていた。
 * 目線の夜景では路面がファサードの 12 倍明るく、明暗の上下関係が
 * 逆転して立体そのものが壊れていた。
 *
 * 直し方は 2 つ。
 *
 * **1. タイルごとの一律加算をやめる。** 光源と明るさの因果が切れていたのは
 * これが原因で、街灯の無い区間まで同じ明るさで光っていた。
 * 路面全体の底上げは加算板ではなく半球ライト（renderer 側）の仕事にする。
 *
 * **2. 光溜まりを小さく弱くする。** 灯具は 6m の高さにあるので、
 * 路面で意味のある明るさになるのはせいぜい半径 7〜8m。
 * 街灯の間隔（3 タイル＝30m）より小さくしておくと、
 * **灯の下だけが明るく、間は落ちる**という夜道本来のリズムが出る。
 */
const LAMP_POOL_SIZE = 15;
const LAMP_POOL_LEVEL = 0.16;

/**
 * 遠景の連続線の幅 (m)。
 * 実寸 15cm の線をこの幅まで太らせ、そのぶん舗装色へ薄める（面積比の保存）。
 */
const LINE_FAR_WIDTH = 0.5;

/** 光の板を白に寄せるための混色先。 */
const WHITE = new Color(1, 1, 1);
/** 混色の作業用（this.color を潰さずに 2 色目を作るため）。 */
const tmpColor = new Color();

export class RoadLayer {
  readonly group = new Object3D();

  private readonly asphalt: InstancePool;
  private readonly walkway: InstancePool;
  private readonly corner: InstancePool;
  private readonly marking: InstancePool;
  /** 俯瞰用。連続線と、横断歩道 1 か所につき淡い矩形 1 枚だけを持つ。 */
  private readonly markingFar: InstancePool;
  /** 轍と補修跡。近景でだけ出す平板。 */
  private readonly wear: InstancePool;
  /** マンホールと集水桝の蓋。近景でだけ出す円板。 */
  private readonly manhole: InstancePool;
  private readonly lamp: InstancePool;
  private readonly lampHead: InstancePool;
  private readonly lightPool: InstancePool;
  private readonly pole: InstancePool;
  private readonly guardrail: InstancePool;
  private readonly mirror: InstancePool;
  private readonly sign: InstancePool;
  private readonly vending: InstancePool;
  private readonly vendingGlow: InstancePool;
  private readonly busStop: InstancePool;
  private readonly pools: InstancePool[] = [];

  /** 電線。細い円柱のインスタンス群（1 ドローコール）。 */
  private readonly wire: InstancePool;

  private readonly materials: Material[] = [];
  private readonly lampHeadMat: MeshBasicMaterial;
  private readonly poolMat: MeshBasicMaterial;
  private readonly vendingGlowMat: MeshBasicMaterial;

  private lastEpoch = -1;
  private lastNetwork = -1;
  private night = -1;
  /** 直近に適用した LOD（毎フレーム visible を触らずに済ませるため）。 */
  private detailFar = false;
  private markingsShown = true;
  private wearShown = true;
  private wiresShown = true;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();
  /** 電線を 1 区間ずつ置くための作業用。 */
  private readonly segA = new Vector3();
  private readonly segB = new Vector3();
  private readonly segDir = new Vector3();
  private readonly axisUp = new Vector3(0, 1, 0);
  /** 電柱の位置を「タイル*4+辺」で引けるようにしておく。電線を張るのに要る。 */
  private readonly poleAt = new Map<number, { x: number; y: number; z: number; d: number }>();

  constructor() {
    this.group.name = 'roads';

    // --- 路面 ---
    // 濡れていない乾いたアスファルトは粗いが、完全な拡散面ではない。
    // わずかに反射を残すと、朝夕の低い日射で路面がぬらりと光る。
    // envMapIntensity を大きく下げてある。目線の高さ（仰角 6 度）で路面を
    // 見ると視線はほぼ水平で、そこではフレネル反射が 1 に近づく。
    // 0.3 のままだと **空がそのまま路面に映って、車道が歩道と同じ明るさの
    // 白っぽい板になる**（実際にそうなった）。乾いたアスファルトは
    // ほとんど鏡面反射を持たないので、下げるのが物理的にも正しい。
    // 粗さを 0.74 から上げてある。目線の高さで路面を見ると視線はほぼ水平で、
    // そこでは鏡面ローブが視線方向に伸びて空をまとめて拾う。
    // 粗いほどローブが広く薄くなり、ぬらりとした「濡れた板」感が消える。
    const asphaltMat = surface({ roughness: 0.86, metalness: 0.05, envMapIntensity: 0.14 });
    // 板が地形と同じ高さに来たときの縞を止める。高さのオフセットと二段構えにする。
    asphaltMat.polygonOffset = true;
    asphaltMat.polygonOffsetFactor = -3;
    asphaltMat.polygonOffsetUnits = -3;
    // 骨材の粗さを世界座標のノイズで焼く。目線の高さでは画面の 3〜4 割が路面で、
    // そこが継ぎ目も色ムラも無い一色だとカット全体が未完成に見える。
    // 板ごとに倍率の違う UV は使えないので、シェーダに差し込む（surfaceNoise.ts）。
    applySurfaceNoise(asphaltMat, {
      scale: 3.4,
      // 振れ幅を 0.075 から上げた。空の映り込みを削ったぶん路面が暗くなり、
      // 同じ振れ幅では見えなくなる（暗い面の 7% は 1 階調も動かない）。
      color: 0.14,
      roughness: 0.2,
      bump: 0.05,
      fade: 240,
      // 舗装の打ち継ぎ。4.6m は 1 車線ぶんの敷き幅で、実際の街路も
      // だいたいこの間隔で継ぎ目が走っている。
      seam: { spacing: 4.6, width: 0.17, darken: 0.13 },
      // 路面がファサードより明るいという上下関係の逆転を止める要。
      // 詳しくは surfaceNoise.ts の specular の説明。
      specular: 0.2,
    });
    this.materials.push(asphaltMat);

    const plane = new PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.asphalt = this.pool(plane, asphaltMat, true, 8192);

    // --- 路面の傷み（轍・補修跡・マンホール）---
    // 轍は車輪が通ったところだけ骨材が磨かれて、わずかに暗く・滑らかになる。
    // 舗装と同じ材質にすると「色だけ違う板」になって轍に見えないので、
    // 粗さを一段落とした専用の材質にする（近景でしか出さないので安い）。
    // 「滑らか」といっても路面の話なので、鏡になってはいけない。
    // 舗装より 0.12 だけ粗さを落とし、環境反射は舗装と同じに揃える。
    // ここを 0.5 / 0.42 にしていたときは、轍が車道の大半を覆うぶん
    // 空の映り込みで路面全体が白く飛んだ。
    const wearMat = surface({ roughness: 0.74, metalness: 0.05, envMapIntensity: 0.14 });
    wearMat.polygonOffset = true;
    wearMat.polygonOffsetFactor = -5;
    wearMat.polygonOffsetUnits = -5;
    applySurfaceNoise(wearMat, {
      scale: 2.2,
      color: 0.12,
      roughness: 0.16,
      bump: 0.02,
      fade: 200,
      specular: 0.2,
    });
    this.materials.push(wearMat);
    this.wear = this.pool(plane.clone(), wearMat, true, 4096);
    // 蓋は鋳鉄。粗さを下げて金属度を上げると、朝夕の低い日射で 1 個だけ光る。
    // ただし金属の見えは間接鏡面がほぼすべてなので、遮蔽の無い環境マップだと
    // 視線が寝たとたんに真っ白な円板になる。舗装を暗くしたぶん目立つので、
    // 金属度と映り込みを一段落として「錆びた鋳鉄」の側に寄せる。
    const manholeMat = surface({ roughness: 0.62, metalness: 0.32, envMapIntensity: 0.16 });
    manholeMat.polygonOffset = true;
    manholeMat.polygonOffsetFactor = -7;
    manholeMat.polygonOffsetUnits = -7;
    this.materials.push(manholeMat);
    const disc = new CircleGeometry(0.5, 12);
    disc.rotateX(-Math.PI / 2);
    this.manhole = this.pool(disc, manholeMat, true, 2048);

    // --- 歩道（縁石・側溝を含む断面）---
    const walkMat = surface({ roughness: 0.9, metalness: 0.02, vertexColors: true, envMapIntensity: 0.2 });
    // 歩道も一色の板だった。汚れと退色の大きなむらに加えて、
    // **平板の目地**を入れる。日本の歩道はほぼインターロッキングか
    // 30〜60cm の平板で、目線の高さではその目地が真っ先に目に入る
    // （「歩道も一色」と読まれた最大の理由がこれ）。
    // 目地は世界座標の格子で引くので、歩道をどう分割して敷いても連続する。
    applySurfaceNoise(walkMat, {
      scale: 2.6,
      color: 0.1,
      roughness: 0.1,
      bump: 0.02,
      fade: 200,
      seam: { spacing: 0.6, width: 0.06, darken: 0.22 },
      // 歩道は路面ほど暗くない（コンクリートの反射率は 35% 前後）ので、
      // 映り込みを削る量も控えめでよい。それでも素のままだと
      // 目線の高さでファサードより白く飛ぶ。
      specular: 0.38,
    });
    this.materials.push(walkMat);
    this.walkway = this.pool(walkwaySectionGeometry(), walkMat, false, 8192);
    this.corner = this.pool(walkwayCornerGeometry(), walkMat, false, 4096);

    // --- 路面標示 ---
    // 白線は塗料なので、アスファルトよりずっと粗く、まったく反射しない。
    // ここで反射を残していると、朝夕の低い日射で標示だけが白く輝いて、
    // 俯瞰では建物の屋根より明るい「白いビーズの鎖」になる。
    const markMat = surface({ roughness: 0.9, metalness: 0.0, envMapIntensity: 0.08 });
    markMat.polygonOffset = true;
    markMat.polygonOffsetFactor = -6;
    markMat.polygonOffsetUnits = -6;
    // 塗料の擦れ。真っ白で均一な標示は、施工直後の数週間しか存在しない。
    // 細かいノイズで濃淡を付けると、横断歩道が「印刷した縞」から
    // 「踏まれて減った塗料」になる。振れ幅は舗装より大きく取る。
    applySurfaceNoise(markMat, {
      scale: 1.1,
      color: 0.22,
      roughness: 0.06,
      bump: 0.0,
      fade: 210,
      // 標示も路面と同じだけ映り込みを削る。ここだけ素のままにすると、
      // 舗装を暗くしたぶん白線が相対的に飛んで、擦れの階調が全部潰れる。
      specular: 0.2,
    });
    this.materials.push(markMat);
    this.marking = this.pool(plane.clone(), markMat, true, 16384);
    // 俯瞰用の代替（横断歩道 1 か所 = 1 枚）。同じ材質を共有するので描画は 1 増えるだけ。
    this.markingFar = this.pool(plane.clone(), markMat, true, 4096);

    // --- 街灯・電柱・防護柵 ---
    const propMat = surface({ roughness: 0.6, metalness: 0.3, vertexColors: true, envMapIntensity: 0.7 });
    this.materials.push(propMat);
    this.lamp = this.pool(streetLampGeometry(), propMat, false, 2048);
    this.pole = this.pool(utilityPoleGeometry(), propMat, false, 2048);
    this.guardrail = this.pool(guardrailGeometry(), propMat, false, 1024);
    this.mirror = this.pool(curveMirrorGeometry(), propMat, false, 512);
    this.sign = this.pool(roadSignGeometry(), propMat, false, 512);
    this.busStop = this.pool(busStopGeometry(), propMat, false, 256);
    const vendMat = surface({ roughness: 0.45, metalness: 0.15, vertexColors: true });
    this.materials.push(vendMat);
    this.vending = this.pool(vendingMachineGeometry(), vendMat, false, 512);

    // --- 夜の発光。ライトではなく「光って見える面」で作る ---
    // 本物の PointLight を数百個置くと、影響を受けるメッシュごとに
    // ライト数ぶんのシェーダ分岐が走って描画が止まる。
    this.lampHeadMat = new MeshBasicMaterial({ color: LAMP_WARM, toneMapped: false, transparent: true });
    this.materials.push(this.lampHeadMat);
    this.lampHead = this.pool(lampHeadGeometry(), this.lampHeadMat, true, 2048);

    this.vendingGlowMat = new MeshBasicMaterial({ color: 0xfff0d0, toneMapped: false, transparent: true });
    this.materials.push(this.vendingGlowMat);
    this.vendingGlow = this.pool(vendingGlowGeometry(), this.vendingGlowMat, false, 512);

    // 路面に落ちる光。加算合成なので、暗いほど強く見える。
    const poolTex = lightPoolTexture();
    this.poolMat = new MeshBasicMaterial({
      map: poolTex,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    // 路面に貼り付ける板なので、深度を数テクセルぶん手前に押す。
    // 高さのオフセット（Y_POOL）だけだと、斜面では舗装の三角形が
    // 板より手前に来て光溜まりが虫食いになる。
    this.poolMat.polygonOffset = true;
    this.poolMat.polygonOffsetFactor = -8;
    this.poolMat.polygonOffsetUnits = -8;
    this.materials.push(this.poolMat);
    const poolGeom = new PlaneGeometry(1, 1);
    poolGeom.rotateX(-Math.PI / 2);
    this.lightPool = this.pool(poolGeom, this.poolMat, true, 2048);
    // 加算の板は最後に描く。半透明のもの同士の前後関係を気にしなくて済む。
    this.lightPool.setRenderOrder(4);

    // --- 電線 ---
    // 細い円柱を 1 区間 1 インスタンスで敷く。線ではなく立体なので、
    // 遠近で太さが変わり、SMAA も素直に効いてジャギーが出ない。
    const wireMat = surface({ color: WIRE_COLOR, roughness: 0.55, metalness: 0.35, envMapIntensity: 0.5 });
    this.materials.push(wireMat);
    // 中心が原点・+Y に高さ 1 の円柱。断面は 4 角形で十分（遠景では 1px 前後）。
    const wireGeom = new CylinderGeometry(WIRE_RADIUS, WIRE_RADIUS, 1, 4, 1, true);
    this.wire = this.pool(wireGeom, wireMat, false, 16384);
  }

  private pool(geom: BufferGeometry, material: Material, colored: boolean, cap: number): InstancePool {
    const p = new InstancePool(geom, material, this.group, colored, cap);
    this.pools.push(p);
    return p;
  }

  /** 情報表示に切り替えたときは隠す。地形の色（ヒートマップ）をそのまま見せるため。 */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** セーブデータを読み込んだときのように、エポックが「進まずに変わる」場合に使う。 */
  invalidate(): void {
    this.lastEpoch = -1;
  }

  /**
   * @param camDistance カメラの注視点からの距離 (m)。路面標示と電線の LOD に使う。
   *   既定を 0 にしてあるのは、呼び出し元（renderer.ts）が渡さなくても
   *   「近景 = 全部描く」で従来どおり動くようにするため。
   */
  update(sim: Simulation, camDistance = 0): void {
    // 夜の点灯だけは毎フレーム。材質を数個いじるだけなので、ここに置いても安い。
    this.setNight(atmosphereAt(sim.clock.dayFraction).nightAmount);
    this.setDetail(camDistance);

    const epoch = sim.world.epochs.roads;
    const net = sim.world.networkVersion;
    if (epoch === this.lastEpoch && net === this.lastNetwork) return;
    this.lastEpoch = epoch;
    this.lastNetwork = net;
    this.rebuild(sim);
  }

  /**
   * カメラ距離で描き分ける。
   *
   * `InstancePool.grow()` はメッシュを作り直すので、再構築のたびに
   * visible が既定へ戻る。状態を持っておいて `rebuild` の後にも通す。
   */
  private setDetail(camDistance: number): void {
    this.detailFar = camDistance > MARKING_LOD_DISTANCE;
    // いちばん引いたところでは、面積比で薄めた矩形すらちらつくので全部落とす。
    this.markingsShown = camDistance < MARKING_FAR_CUTOFF;
    this.wearShown = camDistance < WEAR_LOD_DISTANCE;
    this.wiresShown = camDistance < WIRE_LOD_DISTANCE;
    this.applyDetail();
  }

  private applyDetail(): void {
    this.marking.setVisible(!this.detailFar);
    this.markingFar.setVisible(this.detailFar && this.markingsShown);
    this.wear.setVisible(this.wearShown);
    this.manhole.setVisible(this.wearShown);
    this.wire.setVisible(this.wiresShown);
  }

  /**
   * 街灯を点ける。
   *
   * `nightAmount` は空の大気（sky.ts）から来るので、点灯のタイミングが
   * 建物の窓・空の色と自動的に揃う。ここで独自に時刻を判定すると、
   * 「空はまだ明るいのに街灯だけ全開」のような食い違いが出る。
   */
  private setNight(night: number): void {
    if (Math.abs(night - this.night) < 0.01) return;
    this.night = night;
    const lit = night > 0.02;
    this.lampHead.mesh.visible = lit;
    this.lightPool.mesh.visible = lit;
    this.vendingGlow.mesh.visible = lit;
    if (!lit) return;
    this.lampHeadMat.opacity = Math.min(1, night * 1.4);
    // 光の板の強さ。以前はここを 0.92 まで上げていて、24m 角の光溜まりが
    // 隣同士で重なった結果、路面が「発光するベージュの絨毯」になっていた。
    // 加算板が担うのは**街灯の真下のプール光だけ**で、路面全体の明るさは
    // 半球ライト（renderer 側）が持つ。以前の 1/6 まで落とす。
    this.poolMat.opacity = night * LAMP_POOL_LEVEL;
    this.vendingGlowMat.opacity = Math.min(1, night * 1.2);
  }

  private rebuild(sim: Simulation): void {
    const world = sim.world;
    for (const p of this.pools) p.begin();
    this.poleAt.clear();

    for (let i = 0; i < TILE_COUNT; i++) {
      const cls = world.road[i]!;
      if (cls === RoadClass.None) continue;
      const x = tileX(i);
      const y = tileY(i);
      const cx = (x + 0.5) * TILE_M;
      const cz = (y + 0.5) * TILE_M;
      const gy = world.heightDm[i]! * TERRAIN_HEIGHT_SCALE;
      const conn = world.roadConn(i);
      const degree = world.roadDegree(i);
      const half = CARRIAGE_HALF[cls]!;
      const h = (i * 2654435761) >>> 0;

      this.putPavement(cls, conn, cx, cz, gy, half, h);
      this.putWalkways(world, i, conn, cx, cz, gy, half, h, cls);
      this.putMarkings(world, i, cls, conn, degree, cx, cz, gy, half);
      this.putWear(conn, degree, cx, cz, gy, half, h);
    }

    this.putBusStops(sim);
    this.buildWires(world);
    for (const p of this.pools) p.end();
    // grow() でメッシュが作り直されていることがあるので、LOD を掛け直す。
    this.applyDetail();
  }

  /**
   * 路面の傷み。轍・補修跡・マンホール。
   *
   * 目線のカットで路面が「無地の板」に見えていた最大の理由は、
   * 舗装の色ムラが無いことより **人工物の痕跡が 1 つも無いこと** だった。
   * 実際のアスファルトには、必ず轍・掘り返した跡・鉄蓋が乗っている。
   * どれも数が少ないので、近景でしか描かない（LOD で丸ごと落とす）。
   */
  private putWear(
    conn: number,
    degree: number,
    cx: number,
    cz: number,
    gy: number,
    half: number,
    h: number,
  ): void {
    const straightNS = conn === 0b0101;
    const straightEW = conn === 0b1010;
    const y = gy + Y_WEAR;

    // --- 轍 ---
    // 車は中心から ±LANE_OFFSET_M(2.2) を走るので、その帯だけが磨り減る。
    // 交差点では車の軌跡が散るので敷かない（実物も交差点内に轍は出ない）。
    if (straightNS || straightEW) {
      const alongX = straightEW;
      // 帯の幅。以前は最大 2.3m を 2 本敷いていたが、生活道路（半幅 3.1m、
      // 車道の全幅 6.2m）だと**車道の 3/4 が轍**になり、轍ではなく
      // 「舗装より少し明るい別の材質の板」が路面全体を覆っていた。
      // 実物の轍は車輪の当たる 1m 弱の帯なので、そこまで絞る。
      const width = Math.min(1.25, Math.max(0.7, (half - 2.2) * 2));
      this.color.setHex(RUT_COLOR);
      for (let k = -1; k <= 1; k += 2) {
        const off = k * 2.2;
        this.place(
          this.wear,
          alongX ? cx : cx + off,
          y,
          alongX ? cz + off : cz,
          alongX ? TILE_M : width,
          alongX ? width : TILE_M,
          0,
          this.color,
        );
      }

      /**
       * 轍と轍のあいだの「クラウン」。
       *
       * 車輪が通らない中央の帯には、砂と細かい砂利が吹き寄せられて溜まる。
       * 轍とは逆に、周りより**明るく粗い**のが実物の見え方。
       *
       * ここを足したのは絵の都合が半分ある。目線のカットでは、車道の両側は
       * 走っている車と停まっている車で埋まっていて、**画面に映る路面は
       * 中央の帯だけ**になる。轍もマンホールも車輪の位置に置いてあるので、
       * いちばん見える場所にだけ何も無い、という状態になっていた。
       */
      const crown = Math.min(2.0, Math.max(0.6, 4.4 - width * 2));
      this.color.setHex(CROWN_COLOR).multiplyScalar(0.94 + ((h >>> 5) % 13) / 100);
      this.place(
        this.wear,
        cx,
        y,
        cz,
        alongX ? TILE_M : crown,
        alongX ? crown : TILE_M,
        0,
        this.color,
      );
    }

    // --- 補修跡 ---
    // 掘り返して埋め戻したところ。新しいアスファルトなので周りより黒い。
    // タイルの 1/4 くらいの矩形を、8 タイルに 1 枚。
    if ((h >>> 6) % 8 === 3 && half > 0) {
      const px = cx + ((((h >>> 11) % 100) / 100 - 0.5) * half * 1.2);
      const pz = cz + ((((h >>> 17) % 100) / 100 - 0.5) * TILE_M * 0.55);
      const sx = 1.4 + ((h >>> 21) % 22) / 10;
      const sz = 1.1 + ((h >>> 25) % 26) / 10;
      this.color.setHex(PATCH_COLOR);
      this.place(this.wear, px, y, pz, sx, sz, 0, this.color);
    }

    // --- マンホール・集水桝 ---
    // 交差点の隅と、路肩寄りの管路の上。等間隔に並べると点線になるので、
    // タイルのハッシュで位相を散らす。
    if ((h >>> 3) % 3 === 1) {
      const side = (h >>> 9) % 2 === 0 ? 1 : -1;
      // 3 個に 1 個はセンターライン上に置く。日本の生活道路の下水本管は
      // 道路の中心を通っていることが多く、蓋も中央に並ぶ。
      // 絵の都合もあって、目線の高さで見えている路面は中央の帯だけなので、
      // 全部を路肩寄りに置くと蓋が 1 枚も画面に入らない。
      const centred = (h >>> 27) % 3 === 0;
      const lat = centred
        ? ((h >>> 13) % 7) / 20
        : Math.min(half - 0.7, 1.5 + ((h >>> 13) % 14) / 10);
      const alongOff = ((((h >>> 15) % 100) / 100 - 0.5) * TILE_M * 0.7);
      const vertical = straightNS || (!straightEW && degree >= JUNCTION_DEGREE);
      const size = 0.62 + ((h >>> 19) % 10) / 40;
      // 蓋は個体差が大きい（新しい鋳鉄・錆びたもの・アスファルトが被ったもの）。
      const v = 0.8 + ((h >>> 23) % 45) / 100;
      this.color.setHex(MANHOLE_COLOR).multiplyScalar(v);
      this.place(
        this.manhole,
        vertical ? cx + lat * side : cx + alongOff,
        y,
        vertical ? cz + alongOff : cz + lat * side,
        size,
        size,
        0,
        this.color,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 路面
  // ---------------------------------------------------------------------

  /**
   * 舗装。中央の正方形と、繋がっている向きへの腕に分ける。
   *
   * タイル全面に敷いていた頃は、道路クラスを変えても舗装の幅が変わらず、
   * 幅の違いを歩道の位置だけで表すしかなかった。中央 + 腕にすると
   * 舗装そのものが道路の形になり、交差点では自然に十字が出る。
   */
  private putPavement(
    cls: number,
    conn: number,
    cx: number,
    cz: number,
    gy: number,
    half: number,
    h: number,
  ): void {
    // 轍と補修で舗装の色は一様ではない。タイルごとにわずかに散らす。
    const base =
      cls === RoadClass.Boulevard
        ? PAVEMENT.boulevard
        : cls === RoadClass.Avenue
          ? PAVEMENT.avenue
          : PAVEMENT.street;
    const jitter = 0.86 + ((h >>> 9) % 100) / 100 * 0.3;
    const y = gy + Y_ASPHALT;

    // 中央（交差点そのもの）。車が旋回するところは骨材が出て色が抜けるので、
    // 交差点だけ一段明るい舗装色にする。上から見たときに交差点の位置が
    // 標示に頼らず読めるようになる。
    this.color.setHex(conn === 0b1111 ? PAVEMENT.junction : base).multiplyScalar(jitter);
    this.place(this.asphalt, cx, y, cz, half * 2, half * 2, 0, this.color);
    this.color.setHex(base).multiplyScalar(jitter);

    // 各方向への腕
    const armLen = TILE_M / 2 - half;
    if (armLen > 0.01) {
      for (let d = 0; d < 4; d++) {
        if (!(conn & (1 << d))) continue;
        const mid = half + armLen / 2;
        const px = cx + OUT_X[d]! * mid;
        const pz = cz + OUT_Z[d]! * mid;
        const alongX = d === 1 || d === 3;
        this.place(
          this.asphalt,
          px,
          y,
          pz,
          alongX ? armLen : half * 2,
          alongX ? half * 2 : armLen,
          0,
          this.color,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // 歩道と街路の小物
  // ---------------------------------------------------------------------

  private putWalkways(
    world: Simulation['world'],
    i: number,
    conn: number,
    cx: number,
    cz: number,
    gy: number,
    half: number,
    h: number,
    cls: number,
  ): void {
    const width = WALK_OUTER - half;
    const mid = (WALK_OUTER + half) / 2;

    for (let d = 0; d < 4; d++) {
      if (conn & (1 << d)) continue;
      const ox = OUT_X[d]!;
      const oz = OUT_Z[d]!;
      const px = cx + ox * mid;
      const pz = cz + oz * mid;
      // 断面は X = 横断方向・Z = 道路に沿う方向。外向きに合わせて回す。
      this.placeBox(this.walkway, px, gy + Y_ASPHALT, pz, width, CURB_H, TILE_M, OUTWARD_ROT[d]!);

      this.putEdgeProps(world, i, d, cx, cz, gy, h, cls, ox, oz);
    }

    // 交差点の隅。両隣の向きが繋がっている角だけ、車道の外に取り残される。
    // ここを埋めないと、十字路の 4 隅に地面が四角く覗いて目立つ。
    for (let d = 0; d < 4; d++) {
      const e = (d + 1) & 3;
      if (!(conn & (1 << d)) || !(conn & (1 << e))) continue;
      const sx = (OUT_X[d]! + OUT_X[e]!) * mid;
      const sz = (OUT_Z[d]! + OUT_Z[e]!) * mid;
      this.placeBox(this.corner, cx + sx, gy + Y_ASPHALT, cz + sz, width, CURB_H, width, 0);
    }
  }

  /**
   * 歩道 1 辺の上に置く小物。
   *
   * 置く周期はタイルのハッシュで決める。等間隔に並べると軍隊のように整列して
   * かえって不自然になるので、周期そのものは決めつつ位相をハッシュに委ねる。
   */
  private putEdgeProps(
    world: Simulation['world'],
    i: number,
    d: number,
    cx: number,
    cz: number,
    gy: number,
    h: number,
    cls: number,
    ox: number,
    oz: number,
  ): void {
    const facing = neighbor(i, d);
    const zone = facing >= 0 ? world.zone[facing]! : Zone.None;
    const half = CARRIAGE_HALF[cls]!;
    /**
     * 小物を置く「タイル中心からの距離」。大通りは車道が広いぶん歩道が狭いので、
     * 望みの位置をそのまま使うと標識やミラーが車道の上に立つ。
     * 縁石の外に必ず出るよう下限を掛ける。
     */
    const off = (want: number): number => Math.max(half + 0.35, Math.min(WALK_OUTER - 0.15, want));
    const urban =
      zone === Zone.ResidentialMid ||
      zone === Zone.CommercialLocal ||
      zone === Zone.CommercialCentral;
    const built = zone !== Zone.None;
    const key = (h ^ (d * 0x9e3779b9)) >>> 0;

    // --- 街灯 ---
    // 夜の絵はここで決まるが、密にしすぎると昼に「ポールの林」になる。
    // 実際の街路灯の間隔は 25〜40m（＝2〜4 タイル）なので、
    // 市街地でも 3 タイルに 1 本、郊外は 6 タイルに 1 本に抑える。
    const lampPeriod = urban ? 3 : built ? 4 : 6;
    if (key % lampPeriod === 1) {
      const lx = cx + ox * off(WALK_OUTER - 0.6);
      const lz = cz + oz * off(WALK_OUTER - 0.6);
      this.placeProp(this.lamp, lx, gy + Y_ASPHALT + CURB_H, lz, INWARD_ROT[d]!);
      // 灯具は支柱から道路側へ張り出しているので、光の落ちる位置もそこ。
      const gx = lx - ox * LAMP_ARM_X;
      const gz = lz - oz * LAMP_ARM_X;
      // 水銀灯（青白）とナトリウム灯（橙）を混ぜる。日本の街路は
      // どちらか一方に統一されていることのほうが少ない。
      const warm = (key >>> 5) % 3 !== 0;
      this.color.setHex(warm ? LAMP_WARM : LAMP_COOL);
      this.placeProp(this.lampHead, lx, gy + Y_ASPHALT + CURB_H, lz, INWARD_ROT[d]!, this.color);
      // 路面に落ちる光。灯具の色をそのまま使うと路面がオレンジ一色になるので、
      // 白に寄せて薄める（実際の路面も光源色ほどは色が付かない）。
      this.color.lerp(WHITE, 0.26);
      // 光溜まりは街灯の間隔より小さく。以前は 24m 角にしていたが、
      // 街灯は 3 タイル（30m）ごと・道の両側にあるので、それだと
      // 隣の光と完全に重なって「切れ目のない発光する帯」になっていた。
      // 15m 角なら灯の下だけが明るく、間はきちんと落ちる。
      this.place(this.lightPool, gx, gy + Y_POOL, gz, LAMP_POOL_SIZE, LAMP_POOL_SIZE, 0, this.color);
    }

    // --- 電柱 ---
    // 日本の街路の顔。街灯より少しまばらにして、電線が長く渡るようにする。
    if (key % 3 === 2) {
      const px = cx + ox * off(WALK_OUTER - 0.3);
      const pz = cz + oz * off(WALK_OUTER - 0.3);
      const py = gy + Y_ASPHALT + CURB_H;
      this.placeProp(this.pole, px, py, pz, OUTWARD_ROT[d]!);
      this.poleAt.set(i * 4 + d, { x: px, y: py, z: pz, d });
    }

    // --- ガードレール ---
    // 水際と、隣が大きく落ち込んでいるところ。実際の日本の道路も
    // 「落ちると危ないところ」にしか付いていない。
    if (facing >= 0) {
      const drop = Math.abs(world.heightDm[i]! - world.heightDm[facing]!);
      const water = world.terrain[facing] === Terrain.Sea || world.terrain[facing] === Terrain.Freshwater;
      if (water || drop > 22) {
        const rx = cx + ox * off(WALK_OUTER - 0.15);
        const rz = cz + oz * off(WALK_OUTER - 0.15);
        const ax = -oz;
        const az = ox;
        for (let k = -1; k <= 1; k += 2) {
          const s = (k * GUARDRAIL_LEN) / 2;
          this.placeProp(
            this.guardrail,
            rx + ax * s,
            gy + Y_ASPHALT + CURB_H,
            rz + az * s,
            OUTWARD_ROT[d]!,
          );
        }
      }
    }

    // --- カーブミラー ---
    // 見通しの悪い角に立っている。交差点の隅にだけ、まばらに。
    if (world.roadDegree(i) >= 3 && key % 5 === 0) {
      this.placeProp(
        this.mirror,
        cx + ox * off(WALK_OUTER - 0.75),
        gy + Y_ASPHALT + CURB_H,
        cz + oz * off(WALK_OUTER - 0.75),
        FACE_ROT[d]!,
      );
    }

    // --- 標識 ---
    if (cls !== RoadClass.Street && key % 11 === 3) {
      this.placeProp(
        this.sign,
        cx + ox * off(WALK_OUTER - 0.85),
        gy + Y_ASPHALT + CURB_H,
        cz + oz * off(WALK_OUTER - 0.85),
        FACE_ROT[d]!,
      );
    }

    // --- 自動販売機 ---
    // 商業地と中高層住宅地の歩道際に。夜に光るので、暗い街区の中で
    // 「そこに道がある」ことを教える点になる。
    if (urban && key % 9 === 4) {
      const vx = cx + ox * off(WALK_OUTER - 0.6);
      const vz = cz + oz * off(WALK_OUTER - 0.6);
      const vy = gy + Y_ASPHALT + CURB_H;
      this.placeProp(this.vending, vx, vy, vz, FACE_ROT[d]!);
      this.placeProp(this.vendingGlow, vx, vy, vz, FACE_ROT[d]!);
    }
  }

  /**
   * バス停。ハッシュで散らすのではなく、実際に路線の停留所があるタイルに置く。
   * 「路線を引いたらバス停が立つ」ほうが、街を作っている実感につながる。
   */
  private putBusStops(sim: Simulation): void {
    const world = sim.world;
    const seen = new Set<number>();
    for (const line of sim.transit.specs()) {
      if (line.kind !== TransitKind.Bus) continue;
      for (const tile of line.stopTiles) {
        if (seen.has(tile)) continue;
        seen.add(tile);
        if (world.road[tile] === RoadClass.None) continue;
        const conn = world.roadConn(tile);
        // 道路が繋がっていない側（＝歩道のある側）に立てる。
        let d = -1;
        for (let k = 0; k < 4; k++) {
          if (!(conn & (1 << k))) {
            d = k;
            break;
          }
        }
        if (d < 0) continue;
        const cx = (tileX(tile) + 0.5) * TILE_M;
        const cz = (tileY(tile) + 0.5) * TILE_M;
        const gy = world.heightDm[tile]! * TERRAIN_HEIGHT_SCALE;
        const bo = Math.max(CARRIAGE_HALF[world.road[tile]!]! + 0.35, WALK_OUTER - 0.6);
        this.placeProp(
          this.busStop,
          cx + OUT_X[d]! * bo,
          gy + Y_ASPHALT + CURB_H,
          cz + OUT_Z[d]! * bo,
          FACE_ROT[d]!,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // 電線
  // ---------------------------------------------------------------------

  /**
   * 電線。隣り合う電柱を、たわんだ曲線でつなぐ。
   *
   * 日本の街路を写真で見たときにいちばん最初に目に入るのは、実のところ
   * 空を横切る電線だと思う。まっすぐな線分でつなぐと送電線に見えるので、
   * 懸垂曲線（近似としての放物線）でたるませる。
   *
   * 描き方は `LineSegments`（1px の線）から**細い円柱のインスタンス**に変えた。
   * 1px の線は距離によらず同じ太さで描かれるうえ、ライン描画にはアンチエイリアスが
   * 素直に効かないので、空を斜めに横切るところで階段状のジャギーが目立つ。
   * 半径 4cm の円柱にすれば、遠近で細り、法線があるので夕日も乗る。
   * インスタンスは 1 メッシュにまとまるので、ドローコールは線のときと同じ 1 本。
   */
  private buildWires(world: Simulation['world']): void {
    /** 隣の電柱を探しに行く最大距離（タイル）。実際の径間は 30〜40m。 */
    const MAX_SPAN = 4;
    for (const [key, a] of this.poleAt) {
      const tile = (key / 4) | 0;
      const d = a.d;
      // 道路に沿う向き（辺 d の電柱列が並ぶ向き）は d の 90 度回り。
      // 「隣のタイル」だけを見ていたときは、電柱の間隔のほうが広いので
      // ほとんど繋がらず、電線が 1 本も出なかった。数タイル先まで辿る。
      const along = (d + 1) & 3;
      let t = tile;
      let b: { x: number; y: number; z: number; d: number } | undefined;
      for (let step = 0; step < MAX_SPAN; step++) {
        const nb = neighbor(t, along);
        if (nb < 0 || world.road[nb] === RoadClass.None) break;
        t = nb;
        const cand = this.poleAt.get(t * 4 + d);
        if (cand) {
          b = cand;
          break;
        }
      }
      if (!b) continue;

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const span = Math.hypot(dx, dz);
      // 電柱の腕金は外向き（±X ローカル）に伸びているので、
      // 電線もその左右 + 中央の 3 本を張る。
      const px = -dz / (span || 1);
      const pz = dx / (span || 1);
      for (let w = -1; w <= 1; w++) {
        const offX = px * w * ARM_HALF * 0.82;
        const offZ = pz * w * ARM_HALF * 0.82;
        const y0 = a.y + ARM_Y[0]! + 0.1;
        const y1 = b.y + ARM_Y[0]! + 0.1;
        const sag = span * WIRE_SAG;
        this.segA.set(a.x + offX, y0, a.z + offZ);
        for (let seg = 1; seg <= WIRE_SEGMENTS; seg++) {
          const t2 = seg / WIRE_SEGMENTS;
          // 放物線のたるみ。両端で 0、中央で最大。
          this.segB.set(
            a.x + dx * t2 + offX,
            y0 + (y1 - y0) * t2 - sag * 4 * t2 * (1 - t2),
            a.z + dz * t2 + offZ,
          );
          this.placeWire();
          this.segA.copy(this.segB);
        }
      }
    }
  }

  /** `segA` → `segB` の 1 区間を円柱 1 本で埋める。 */
  private placeWire(): void {
    this.segDir.subVectors(this.segB, this.segA);
    const len = this.segDir.length();
    if (len < 1e-4) return;
    this.segDir.divideScalar(len);
    // 単位円柱は +Y に伸びているので、それを区間の向きへ倒す。
    this.quat.setFromUnitVectors(this.axisUp, this.segDir);
    this.pos.addVectors(this.segA, this.segB).multiplyScalar(0.5);
    this.scl.set(1, len, 1);
    this.mat.compose(this.pos, this.quat, this.scl);
    this.wire.push(this.mat);
  }

  // ---------------------------------------------------------------------
  // 路面標示
  // ---------------------------------------------------------------------

  /**
   * 車線と交差点の標示。
   *
   * 標示は「その道が何車線で、どちらが優先で、どこで止まるか」を
   * 絵だけで伝える言語なので、道路クラスごとに書き分ける。
   *   生活道路 : 外側線のみ（中央線を引かない）
   *   二車線   : 外側線 + 黄の中央線 + 車線境界の破線
   *   大通り   : 外側線 + 黄の二重線 + 車線境界の破線 2 本
   *
   * 生活道路に中央線を引かないのは、法規どおりというだけではない。
   * 幅員 6m の道に中央線を入れると、俯瞰で街区のすべての生活道路に
   * 明るい線が 1 本ずつ走り、道路網が「基板の配線パターン」に見える。
   * 実際の日本の生活道路にも中央線はほとんど無い。
   */
  private putMarkings(
    world: Simulation['world'],
    i: number,
    cls: number,
    conn: number,
    degree: number,
    cx: number,
    cz: number,
    gy: number,
    half: number,
  ): void {
    const y = gy + Y_MARKING;
    const straightNS = conn === 0b0101;
    const straightEW = conn === 0b1010;
    // 標示の褪せ具合をタイルごとに散らす。同じ白が街じゅうに続いていると、
    // 塗料ではなく「上から重ねた図形」に見える。
    const th = (i * 1103515245 + 12345) >>> 0;
    const fade = 0.86 + ((th >>> 7) % 24) / 100;

    if (straightNS || straightEW) {
      const alongX = straightEW;
      /**
       * 標示を 1 本置く。`offset` は道路の中心線からの横方向、
       * `shift` は道路に沿った方向のずれ（破線を刻むのに使う）。
       * 縦横の場合分けをここに閉じ込めると、車線の定義そのものが素直に書ける。
       */
      const line = (offset: number, width: number, length: number, hex: number, shift = 0): void => {
        this.color.setHex(hex).multiplyScalar(fade);
        this.place(
          this.marking,
          alongX ? cx + shift : cx + offset,
          y,
          alongX ? cz + offset : cz + shift,
          alongX ? length : width,
          alongX ? width : length,
          0,
          this.color,
        );
      };
      /** 破線。1 タイルに 2 本刻むと、走っていて線が流れて見える。 */
      const dashed = (offset: number, width: number, hex: number): void => {
        for (let k = 0; k < 2; k++) line(offset, width, TILE_M * 0.3, hex, (k - 0.5) * (TILE_M / 2));
      };
      /**
       * 遠景用の連続線。
       *
       * 街区の距離だと車線 1 本は 1 画素を割る。同じ幅・同じ色で描くと、
       * 画素の網にかかったところだけが白く出て、道路が点滅する鎖に見える
       * （前回の指摘の「白いビーズの鎖」がこれ）。そこで**面積比を保ったまま
       * 幅を広げて色を薄める**。線 1 本が受け持つ明るさの総量は変わらないので、
       * 遠くから見た印象は同じまま、高周波だけが消える。
       */
      const farLine = (offset: number, width: number, hex: number): void => {
        this.color
          .setHex(PAVEMENT.avenue)
          .lerp(tmpColor.setHex(hex), Math.min(1, (width / LINE_FAR_WIDTH) * fade));
        this.place(
          this.markingFar,
          alongX ? cx : cx + offset,
          y,
          alongX ? cz + offset : cz,
          alongX ? TILE_M : LINE_FAR_WIDTH,
          alongX ? LINE_FAR_WIDTH : TILE_M,
          0,
          this.color,
        );
      };

      // 外側線。路肩の位置を示す線で、これがあると路面が「道」に見える。
      line(half - 0.3, 0.15, TILE_M, LINE_WHITE);
      line(-(half - 0.3), 0.15, TILE_M, LINE_WHITE);
      farLine(half - 0.3, 0.15, LINE_WHITE);
      farLine(-(half - 0.3), 0.15, LINE_WHITE);

      // 生活道路（RoadClass.Street）はここで何も足さない。外側線だけ。
      if (cls === RoadClass.Avenue) {
        line(0, 0.16, TILE_M, LINE_YELLOW);
        dashed(half * 0.5, 0.12, LINE_WHITE);
        dashed(-half * 0.5, 0.12, LINE_WHITE);
        // 遠景では破線を出さない。切れ目のある線は最悪のちらつき源で、
        // しかも中央線さえあれば「二車線の道」は十分読める。
        farLine(0, 0.16, LINE_YELLOW);
      } else if (cls === RoadClass.Boulevard) {
        // 黄の二重線（追い越し禁止）。大通りだとひと目で分かる記号になる。
        line(0.17, 0.14, TILE_M, LINE_YELLOW);
        line(-0.17, 0.14, TILE_M, LINE_YELLOW);
        dashed(half * 0.55, 0.12, LINE_WHITE);
        dashed(-half * 0.55, 0.12, LINE_WHITE);
        farLine(0, 0.28, LINE_YELLOW);
      }
    }

    // --- 一方通行の矢印 ---
    // 標示が無いと、一方通行にしたことが地図の上で一切分からない
    // （車が来なくなった理由が読めない）。
    const ow = world.oneWay[i]!;
    if (ow !== OneWay.None) {
      const ax = ow === OneWay.East ? 1 : ow === OneWay.West ? -1 : 0;
      const az = ow === OneWay.South ? 1 : ow === OneWay.North ? -1 : 0;
      this.color.setHex(LINE_WHITE).multiplyScalar(fade);
      this.place(this.marking, cx, y, cz, ax !== 0 ? 4.4 : 0.45, az !== 0 ? 4.4 : 0.45, 0, this.color);
      for (let k = 0; k < 2; k++) {
        const back = 0.7 + k * 0.7;
        const wide = 2.0 - k * 0.95;
        this.place(
          this.marking,
          cx + ax * (2.2 - back),
          y,
          cz + az * (2.2 - back),
          ax !== 0 ? 0.55 : wide,
          az !== 0 ? 0.55 : wide,
          0,
          this.color,
        );
      }
    }

    // --- 横断歩道と停止線 ---
    if (degree < JUNCTION_DEGREE) return;
    for (let d = 0; d < 4; d++) {
      if (!(conn & (1 << d))) continue;
      const ox = OUT_X[d]!;
      const oz = OUT_Z[d]!;
      // 流入方向に直交する軸（横断歩道の縞が並ぶ向き）
      const ax = -oz;
      const az = ox;
      const alongZ = ox === 0;

      // 横断歩道。縞は歩行者の進む向きに対して直角＝道路の向きに沿って伸びる。
      const e = TILE_M / 2 - 1.6;
      const stripes = Math.max(3, Math.round((half * 2 - 0.6) / 1.25));
      this.color.setHex(CROSSWALK_COLOR).multiplyScalar(fade);
      for (let k = 0; k < stripes; k++) {
        const t = (k - (stripes - 1) / 2) * 1.25;
        this.place(
          this.marking,
          cx + ox * e + ax * t,
          y,
          cz + oz * e + az * t,
          alongZ ? 0.55 : 2.1,
          alongZ ? 2.1 : 0.55,
          0,
          this.color,
        );
      }
      // 俯瞰用の 1 枚。縞の並ぶ範囲をそのまま覆う矩形を、平均色で敷く。
      const band = stripes * 1.25;
      this.color.setHex(CROSSWALK_FAR_COLOR).multiplyScalar(fade);
      this.place(
        this.markingFar,
        cx + ox * e,
        y,
        cz + oz * e,
        alongZ ? band : 2.1,
        alongZ ? 2.1 : band,
        0,
        this.color,
      );

      // 停止線。日本は左側通行なので、流入してくる車線＝進行方向に向かって左。
      // 交差点の手前に太い白帯が 1 本あるだけで「止まる場所」が読める。
      const se = TILE_M / 2 - 3.4;
      const lat = half * 0.5;
      this.color.setHex(LINE_WHITE).multiplyScalar(fade);
      this.place(
        this.marking,
        cx + ox * se - ax * lat,
        y,
        cz + oz * se - az * lat,
        alongZ ? half : 0.45,
        alongZ ? 0.45 : half,
        0,
        this.color,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 配置ヘルパ
  // ---------------------------------------------------------------------

  /** 平板（XZ 平面の 1×1）を置く。 */
  private place(
    pool: InstancePool,
    x: number,
    y: number,
    z: number,
    sx: number,
    sz: number,
    rotY: number,
    color?: Color,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(sx, 1, sz);
    if (rotY === 0) this.quat.identity();
    else this.quat.setFromAxisAngle(this.axisY, rotY);
    this.mat.compose(this.pos, this.quat, this.scl);
    pool.push(this.mat, color);
  }

  /** 単位立方体（底面 y=0）を置く。 */
  private placeBox(
    pool: InstancePool,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rotY: number,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(sx, sy, sz);
    if (rotY === 0) this.quat.identity();
    else this.quat.setFromAxisAngle(this.axisY, rotY);
    this.mat.compose(this.pos, this.quat, this.scl);
    pool.push(this.mat);
  }

  /** 実寸で作ってある小物を、向きだけ変えて置く。 */
  private placeProp(
    pool: InstancePool,
    x: number,
    y: number,
    z: number,
    rotY: number,
    color?: Color,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(1, 1, 1);
    if (rotY === 0) this.quat.identity();
    else this.quat.setFromAxisAngle(this.axisY, rotY);
    this.mat.compose(this.pos, this.quat, this.scl);
    pool.push(this.mat, color);
  }

  dispose(): void {
    for (const p of this.pools) {
      p.mesh.geometry.dispose();
      p.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}
