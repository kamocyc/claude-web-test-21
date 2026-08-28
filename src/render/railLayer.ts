import {
  InstancedMesh,
  Material,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import { archetype } from '@sim/buildings/archetypes';
import type { Simulation } from '@sim/simulation';
import { neighbor, tileX, tileY } from '@sim/world/tiles';
import { applyVerticalAO, mergeParts, surface, type Part } from './materials';
import { boxes, prism, type BoxSpec } from './parts';

/**
 * 線路の造形。
 *
 * 道路レイヤと同じ作りにする。すなわち **線路のエポックが変わったときだけ**
 * 走査し、部品ごとに 1 つの InstancedMesh に詰める。
 * 毎フレーム 10 万タイルを走査するようなことはしない。
 *
 * 以前は「単位の箱を潰して並べる」やり方だったので、バラストは断面が長方形、
 * レールは平べったい板、架線柱はただの棒、架線に至っては存在しなかった。
 * ここでは **1 区間ぶんの軌道（バラスト・枕木・レール）を焼き固めた
 * ジオメトリ**を作り、タイルごとに向きだけ変えて置く。
 * 区間の長さはタイルの半分 + 重ね代で固定なので、拡大縮小すら要らない。
 *
 * 曲がり角・分岐は「隣に線路がある向きごとに半区間を置く」という
 * 元のやり方をそのまま引き継ぐ。特別扱いを書かずに正しい形が出るのが利点で、
 * 架線と踏切だけは直線区間に限って足す（曲線に無理に架線を張ると、
 * 柱と柱の間で線が軌道から外れて破綻するため）。
 */

/** レール面の高さ (m)。電車の台車をここに載せる（agentLayer の RAIL_TOP_M と対）。 */
export const RAIL_TOP_M = 0.55;

const BALLAST_H = 0.28;
/** 斜面でバラストが地面から浮かないよう、下へ埋める深さ (m)。 */
const BALLAST_SINK = 0.3;
const SLEEPER_H = 0.13;
const SLEEPER_TOP = BALLAST_H + SLEEPER_H;
/** レールの高さ（底面から頭頂まで）。 */
const RAIL_H = RAIL_TOP_M - SLEEPER_TOP;

/** バラストの幅 (m)。単線ぶん。道床は台形なので上面はこれより狭い。 */
const BALLAST_W = 5.0;
const BALLAST_TOP_W = 3.5;
/** 軌間の半分 (m)。狭軌 1067mm。 */
const GAUGE_HALF = 0.5335;
/** 枕木の間隔 (m)。実物は 0.6m 間隔だが、それだと 1 タイルに 16 本並んで潰れる。 */
const SLEEPER_PITCH = 1.25;
const SLEEPER_LEN = 2.3;
const SLEEPER_THICK = 0.24;

/** 1 区間の長さ。タイル中心から辺まで + 交差点で隙間が空かないための重ね代。 */
const HALF = TILE_M / 2;
const SEG_BACK = 0.4;
const SEG_LEN = HALF + SEG_BACK;

const BALLAST_COLOR = 0x8f8378;
const SLEEPER_COLOR = 0x4a3d32;
/** レールは頭頂だけ光る。側面は錆色にしておくと金属らしさが出る。 */
const RAIL_HEAD = 0xd8d4cc;
const RAIL_WEB = 0x6b5a4c;
/**
 * 踏切板。舗装に寄せた暗い灰にする。
 * 明るいコンクリート色にすると、線路が道路と重なる区間で
 * 「白い板とバラストが 1 タイルおきに交互に現れる」まだら模様になってしまう。
 */
const DECK_COLOR = 0x6e6a64;
const POLE_COLOR = 0x9aa0a6;
const WIRE_COLOR = 0x5a5347;
const PLATFORM_COLOR = 0xc8c4bc;

/** 架線柱。高さと、線路中心からの張り出し。 */
const POLE_H = 6.2;
const POLE_SIDE = 3.3;
/** 架線柱を立てる間隔（タイル）。この間隔で架線がたわむ。 */
const POLE_PERIOD = 3;
/** 架線（き電吊架線）の高さと、たわみ量 (m)。 */
const WIRE_Y = 5.7;
const CONTACT_Y = 4.9;
const WIRE_SAG = 0.55;

const MAX_TRACK = 30_000;
const MAX_DECK = 4_000;
const MAX_POLES = 8_000;
const MAX_WIRE = 40_000;
const MAX_CROSSING = 4_000;
const MAX_PLATFORM = 2_000;

/** 4 近傍（北・東・南・西）を +Z 向きの部品に写すための Y 回転。 */
const DIR_ROT = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];

// ---- ジオメトリ ------------------------------------------------------------

/**
 * 道床（バラスト + 枕木）1 区間。
 * 断面を台形にすると、真横から見たときに「土手の上に線路が載っている」ことが分かる。
 */
function bedGeometry(): BufferGeometry {
  const mid = (SEG_LEN - SEG_BACK * 2) / 2 + SEG_BACK / 2;
  const specs: BoxSpec[] = [
    {
      w: BALLAST_W,
      h: BALLAST_H + BALLAST_SINK,
      d: SEG_LEN,
      y: (BALLAST_H - BALLAST_SINK) / 2,
      z: mid,
      wt: BALLAST_TOP_W / BALLAST_W,
      tint: BALLAST_COLOR,
    },
  ];
  // 枕木。区間の内側だけに並べる（隣の区間と重ならないよう中心側から数える）。
  const n = Math.floor(HALF / SLEEPER_PITCH);
  for (let k = 0; k < n; k++) {
    specs.push({
      w: SLEEPER_LEN,
      h: SLEEPER_H,
      d: SLEEPER_THICK,
      y: BALLAST_H + SLEEPER_H / 2,
      z: (k + 0.5) * SLEEPER_PITCH,
      tint: SLEEPER_COLOR,
    });
  }
  const g = mergeParts(boxes(specs));
  applyVerticalAO(g, 0.6, 1.05, 1.5);
  return g;
}

/**
 * レール 2 本 1 区間。
 * 底部（フランジ）と頭部の 2 段にすると、断面が「工」の字に見えて細く締まる。
 */
function railGeometry(): BufferGeometry {
  const mid = (SEG_LEN - SEG_BACK * 2) / 2 + SEG_BACK / 2;
  const specs: BoxSpec[] = [];
  for (const s of [-1, 1]) {
    specs.push(
      { w: 0.14, h: 0.035, d: SEG_LEN, x: s * GAUGE_HALF, y: SLEEPER_TOP + 0.018, z: mid, tint: RAIL_WEB },
      {
        w: 0.075,
        h: RAIL_H - 0.035,
        d: SEG_LEN,
        x: s * GAUGE_HALF,
        y: SLEEPER_TOP + 0.035 + (RAIL_H - 0.035) / 2,
        z: mid,
        wt: 1.35,
        tint: RAIL_HEAD,
      },
    );
  }
  return mergeParts(boxes(specs));
}

/**
 * 踏切板。バラストの代わりに、レールの頭とほぼ同じ高さの舗装板を敷く。
 *
 * 道床をそのまま道路に通すと、道の真ん中に砂利の土手ができる。
 * 実物の踏切は「レール面まで舗装を上げ、車輪のつばが通る溝だけ空けた板」なので、
 * 天端をレール頭のすぐ下に置いて、レールが数 mm だけ顔を出すようにする。
 */
function deckGeometry(): BufferGeometry {
  const mid = (SEG_LEN - SEG_BACK * 2) / 2 + SEG_BACK / 2;
  const top = RAIL_TOP_M - 0.02;
  const specs: BoxSpec[] = [
    { w: BALLAST_W, h: top + BALLAST_SINK, d: SEG_LEN, y: (top - BALLAST_SINK) / 2, z: mid, tint: DECK_COLOR },
    // 車輪のフランジが通る溝。レールの内側に暗い筋を入れるだけで踏切に見える。
    { w: 0.1, h: 0.05, d: SEG_LEN, x: GAUGE_HALF - 0.11, y: top, z: mid, tint: 0x2e2b28 },
    { w: 0.1, h: 0.05, d: SEG_LEN, x: -GAUGE_HALF + 0.11, y: top, z: mid, tint: 0x2e2b28 },
  ];
  const g = mergeParts(boxes(specs));
  applyVerticalAO(g, 0.78, 1.04, 1.4);
  return g;
}

/**
 * 架線柱。ビームを軌道の上へ張り出し、斜めの筋交いで支える。
 * 柱は +X 側に立つ。反対側に立てたいときは Y 回転を π 足す。
 */
function poleGeometry(): BufferGeometry {
  const parts: Part[] = boxes([
    // 柱。上をすぼめると鉄柱らしくなる。
    { w: 0.24, h: POLE_H, d: 0.24, x: POLE_SIDE, y: POLE_H / 2, wt: 0.7, tint: POLE_COLOR },
    // ビーム。
    { w: POLE_SIDE + 0.6, h: 0.16, d: 0.13, x: (POLE_SIDE - 0.6) / 2, y: POLE_H - 0.35, tint: POLE_COLOR },
    // 碍子とハンガー（架線を吊る点）。
    { w: 0.1, h: 0.3, d: 0.1, x: 0, y: POLE_H - 0.6, tint: 0x6a5f52 },
  ]);
  // 筋交い。棒 1 本で「組まれた鉄柱」に見える。
  parts.push(
    ...boxes([
      { w: 1.5, h: 0.1, d: 0.1, x: POLE_SIDE - 0.6, y: POLE_H - 1.3, rz: 0.6, tint: POLE_COLOR },
    ]),
  );
  const g = mergeParts(parts);
  applyVerticalAO(g, 0.72, 1.06, 1.6);
  return g;
}

/** 架線 1 区間。+Z へ長さ 1 の細い棒。両端を指定して伸縮・回転させる。 */
function wireGeometry(): BufferGeometry {
  return mergeParts([
    prism({ r: 0.035, len: 1, seg: 4, axis: 'z', caps: 'none', tint: WIRE_COLOR }),
  ]);
}

/**
 * 踏切の警報機と遮断機。
 * 遮断機の腕は上げた状態（開）にしてある。電車が来ていない時間のほうが長いので、
 * こちらを既定にするほうが街の絵として自然。
 */
function crossingGeometry(): BufferGeometry {
  const specs: BoxSpec[] = [
    // 支柱。
    { w: 0.22, h: 3.0, d: 0.22, y: 1.5, tint: 0xe8e6e0 },
    // 警報灯の台座と赤色灯 2 灯。
    { w: 1.0, h: 0.26, d: 0.16, y: 2.55, tint: 0x38393b },
    { w: 0.3, h: 0.3, d: 0.12, x: 0.34, y: 2.55, z: 0.08, tint: 0xd83a2a },
    { w: 0.3, h: 0.3, d: 0.12, x: -0.34, y: 2.55, z: 0.08, tint: 0xd83a2a },
    // 交差点標識（X 型）。踏切だとひと目で分かる部品。
    { w: 1.2, h: 0.16, d: 0.06, y: 3.05, z: 0.06, rz: 0.72, tint: 0xf0eee8 },
    { w: 1.2, h: 0.16, d: 0.06, y: 3.05, z: 0.06, rz: -0.72, tint: 0xf0eee8 },
    // 遮断機の基部。
    { w: 0.3, h: 0.7, d: 0.3, x: 0.44, y: 0.35, tint: 0xe8e6e0 },
  ];
  // 遮断機の腕。赤白の縞を 4 分割で入れる。斜めに上げてあるので、
  // 根元から先端へ向かって位置と高さを進める。
  const armLen = 4.4;
  const tilt = 1.05; // 上げ角 (rad)
  for (let k = 0; k < 4; k++) {
    const t = (k + 0.5) / 4;
    specs.push({
      w: 0.12,
      h: 0.18,
      d: armLen / 4,
      x: 0.44 + Math.cos(tilt) * 0 ,
      y: 0.75 + Math.sin(tilt) * armLen * t,
      z: Math.cos(tilt) * armLen * t,
      rx: -tilt,
      tint: k % 2 === 0 ? 0xe03a2a : 0xf2f0ea,
    });
  }
  const g = mergeParts(boxes(specs));
  applyVerticalAO(g, 0.74, 1.05, 1.6);
  return g;
}

/**
 * 駅のホーム 1 タイルぶん。上屋（屋根）と柱、ホーム端の白線まで作る。
 * 線路の +X 側に置く前提で、反対側は Y 回転で裏返す。
 */
function platformGeometry(): BufferGeometry {
  const x0 = BALLAST_W / 2 + 0.2;
  const w = 3.4;
  const cx = x0 + w / 2;
  const h = 1.05;
  const specs: BoxSpec[] = [
    // 床。レール面より 1.05m 高い（実物の低床ホームに合わせる）。
    { w, h: h + 0.5, d: TILE_M, x: cx, y: (h - 0.5) / 2, c: 0.06, tint: PLATFORM_COLOR },
    // ホーム端の白線（線路側）。
    { w: 0.35, h: 0.04, d: TILE_M, x: x0 + 0.2, y: h + 0.01, tint: 0xf4f2ea },
    // 点字ブロック。
    { w: 0.4, h: 0.05, d: TILE_M, x: x0 + 0.62, y: h + 0.01, tint: 0xe0c040 },
    // 上屋。
    { w: w + 0.5, h: 0.16, d: TILE_M, x: cx + 0.1, y: h + 3.0, tint: 0xb4bac0 },
  ];
  // 上屋の柱。
  for (const z of [-3.2, 3.2]) {
    specs.push({ w: 0.18, h: 2.95, d: 0.18, x: cx + 0.6, y: h + 1.5, z, tint: 0x8f959b });
  }
  const g = mergeParts(boxes(specs));
  applyVerticalAO(g, 0.7, 1.06, 1.5);
  return g;
}

// ---- レイヤ ----------------------------------------------------------------

export class RailLayer {
  readonly group = new Object3D();
  private readonly bed: InstancedMesh;
  private readonly rail: InstancedMesh;
  private readonly deck: InstancedMesh;
  private readonly pole: InstancedMesh;
  private readonly wire: InstancedMesh;
  private readonly crossing: InstancedMesh;
  private readonly platform: InstancedMesh;
  private readonly meshes: InstancedMesh[] = [];
  private readonly materials: Material[] = [];

  private lastRailEpoch = -1;
  private lastRoadEpoch = -1;
  private lastNetworkVersion = -1;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3(1, 1, 1);
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly dir = new Vector3();
  private readonly forward = new Vector3(0, 0, 1);

  constructor() {
    this.group.name = 'rails';
    // 砂利と木は粗く、レールだけ磨かれた金属にする。
    // 同じ材質にまとめるとレールの光が死ぬので、ここだけメッシュを分ける価値がある。
    this.bed = this.makeMesh(bedGeometry(), MAX_TRACK, 0.94, 0.02);
    this.rail = this.makeMesh(railGeometry(), MAX_TRACK, 0.24, 0.92, 1.5);
    this.deck = this.makeMesh(deckGeometry(), MAX_DECK, 0.88, 0.04);
    this.pole = this.makeMesh(poleGeometry(), MAX_POLES, 0.55, 0.55);
    this.wire = this.makeMesh(wireGeometry(), MAX_WIRE, 0.5, 0.7);
    this.crossing = this.makeMesh(crossingGeometry(), MAX_CROSSING, 0.7, 0.1);
    this.platform = this.makeMesh(platformGeometry(), MAX_PLATFORM, 0.85, 0.04);
  }

  private makeMesh(
    geom: BufferGeometry,
    count: number,
    roughness: number,
    metalness: number,
    envMapIntensity = 1,
  ): InstancedMesh {
    const material = surface({ vertexColors: true, roughness, metalness, envMapIntensity });
    this.materials.push(material);
    const mesh = new InstancedMesh(geom, material, count);
    mesh.count = 0;
    // 線路は街から離れた場所に伸びていることが多いので、視錐台カリングを効かせる。
    // 更新のたびに境界球を計算し直している（update の末尾）。
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  /** 情報表示のときは隠す（道路レイヤと同じ理由）。 */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  invalidate(): void {
    this.lastRailEpoch = -1;
  }

  update(sim: Simulation): void {
    const world = sim.world;
    // 踏切は道路の有無で、ホームは駅の有無で変わる。どちらのエポックも見る。
    if (
      world.epochs.rail === this.lastRailEpoch &&
      world.epochs.roads === this.lastRoadEpoch &&
      world.networkVersion === this.lastNetworkVersion
    ) {
      return;
    }
    this.lastRailEpoch = world.epochs.rail;
    this.lastRoadEpoch = world.epochs.roads;
    this.lastNetworkVersion = world.networkVersion;

    let beds = 0;
    let rails = 0;
    let decks = 0;
    let poles = 0;
    let wires = 0;
    let posts = 0;
    let platforms = 0;

    for (let i = 0; i < TILE_COUNT; i++) {
      if (world.rail[i] === 0) continue;
      const tx = tileX(i);
      const ty = tileY(i);
      const cx = (tx + 0.5) * TILE_M;
      const cz = (ty + 0.5) * TILE_M;
      const gy = world.heightDm[i]! * TERRAIN_HEIGHT_SCALE;
      const conn = world.railConn(i);
      const isCrossing = world.isLevelCrossing(i);

      // 隣に線路がある向きごとに、中心から辺までの半区間を敷く。
      // こうすると曲がり角も分岐も、特別扱いを書かずに正しい形が出る。
      // 孤立したタイル（敷きかけ）は南北に 1 本通しておく。
      const dirs = conn === 0 ? 0b0101 : conn;
      for (let d = 0; d < 4; d++) {
        if (!(dirs & (1 << d))) continue;
        const rot = DIR_ROT[d]!;
        if (isCrossing) {
          if (decks < MAX_DECK) this.place(this.deck, decks++, cx, gy, cz, rot);
        } else if (beds < MAX_TRACK) {
          this.place(this.bed, beds++, cx, gy, cz, rot);
        }
        if (rails < MAX_TRACK) this.place(this.rail, rails++, cx, gy, cz, rot);
      }

      // --- 架線柱と架線 ---
      //
      // 線路は斜めに進むとき「東へ 1 タイル・南へ 1 タイル」の階段状になるので、
      // 「直線タイルにだけ架線を張る」と曲がり角だらけの路線ではほとんど架線が
      // 張られない。そこで **tx + ty**（＝経路に沿って 1 タイルごとに 1 増える量）を
      // 弧長の代わりに使い、直線でも曲がり角でも同じ規則で柱を立て、たわみを作る。
      //
      // 架線は「タイル中心 → 各辺」の折れ線として引く。軌道の敷き方と同じ規則なので、
      // 曲線でも分岐でも線がレールから外れない。
      const along = tx + ty;
      const bits = ((dirs >> 0) & 1) + ((dirs >> 1) & 1) + ((dirs >> 2) & 1) + ((dirs >> 3) & 1);
      // 吊架線のたわみ。柱と柱（POLE_PERIOD タイル）の間で放物線を描く。
      const sagAt = (t: number): number => {
        const p = ((((t % POLE_PERIOD) + POLE_PERIOD) % POLE_PERIOD)) / POLE_PERIOD;
        return WIRE_SAG * 4 * p * (1 - p);
      };
      if (bits >= 2) {
        for (let d = 0; d < 4; d++) {
          if (!(dirs & (1 << d))) continue;
          if (wires + 2 > MAX_WIRE) break;
          // 中心から辺へ。辺は経路長で ±0.5 タイル先にあたる。
          const ex = cx + (d === 1 ? HALF : d === 3 ? -HALF : 0);
          const ez = cz + (d === 2 ? HALF : d === 0 ? -HALF : 0);
          const step = d === 1 || d === 2 ? 0.5 : -0.5;
          const y0 = gy + WIRE_Y - sagAt(along);
          const y1 = gy + WIRE_Y - sagAt(along + step);
          this.segment(this.wire, wires++, cx, y0, cz, ex, y1, ez);
          // トロリ線（パンタグラフが擦る線）。たわませない。
          this.segment(this.wire, wires++, cx, gy + CONTACT_Y, cz, ex, gy + CONTACT_Y, ez);
        }
      }
      // 架線柱。3 タイルごと、線路の左右に交互に立てる。
      // 道路が線路と並行に走っている区間（線路が道路敷を共用している）だけは、
      // 柱が車道の真ん中に立ってしまうので避ける。
      const railNS0 = (conn & 0b0101) !== 0;
      const railEW0 = (conn & 0b1010) !== 0;
      const roadConn0 = world.roadConn(i);
      const roadParallel =
        (railNS0 && (roadConn0 & 0b0101) !== 0 && !railEW0) ||
        (railEW0 && (roadConn0 & 0b1010) !== 0 && !railNS0);
      if (bits >= 2 && along % POLE_PERIOD === 0 && !roadParallel && poles < MAX_POLES) {
        const side = ((along / POLE_PERIOD) | 0) % 2 === 0 ? 1 : -1;
        // 柱は軌道に直交する向きに張り出す。南北の線路なら東西へ。
        const base = railNS0 && !railEW0 ? 0 : Math.PI / 2;
        this.place(this.pole, poles++, cx, gy, cz, base + (side > 0 ? 0 : Math.PI));
      }

      // --- 踏切の警報機・遮断機 ---
      //
      // 「線路と道路が同じタイルにある」だけで警報機を立てると、線路に沿って
      // 道が走っている区間では 1 タイルごとに遮断機の林ができてしまう。
      // **道路が線路を横切っている**ときだけ立てる。置くのは道路の左右 1 組で、
      // 腕が道路を跨ぐ向きに構える。
      const roadNS = (roadConn0 & 0b0101) !== 0;
      const roadEW = (roadConn0 & 0b1010) !== 0;
      const gated = isCrossing && ((railNS0 && !railEW0 && roadEW) || (railEW0 && !railNS0 && roadNS));
      if (gated && posts + 2 <= MAX_CROSSING) {
        // 道路の進む向きに沿って軌道の手前と奥、道路の左側に 1 基ずつ。
        const alongRoadZ = roadNS;
        for (const s2 of [1, -1] as const) {
          // 車道の外（歩道側）に立てる。中に入れると遮断機が路上に生える。
          const ox = alongRoadZ ? -s2 * 4.3 : s2 * 4.6;
          const oz = alongRoadZ ? s2 * 4.6 : s2 * 4.3;
          // 腕は道路の中心へ向かって伸ばす。
          const rot = alongRoadZ ? (s2 > 0 ? Math.PI / 2 : -Math.PI / 2) : s2 > 0 ? Math.PI : 0;
          this.place(this.crossing, posts++, cx + ox, gy, cz + oz, rot);
        }
      }

      // --- 駅のホーム ---
      // 線路の隣が駅の建物なら、その側にホームを敷く。
      if (platforms < MAX_PLATFORM && !isCrossing) {
        for (let d = 0; d < 4; d++) {
          const nb = neighbor(i, d);
          if (nb < 0 || !isStationTile(sim, nb)) continue;
          // 線路の走る向きに沿ってホームを敷く（線路と直交させない）。
          const alongZ = (conn & 0b0101) !== 0 || conn === 0;
          const toPlusX = d === 1;
          const toMinusX = d === 3;
          const toPlusZ = d === 2;
          if (alongZ && !toPlusX && !toMinusX) continue;
          if (!alongZ && (toPlusX || toMinusX)) continue;
          const rot = alongZ ? (toPlusX ? 0 : Math.PI) : toPlusZ ? -Math.PI / 2 : Math.PI / 2;
          this.place(this.platform, platforms++, cx, gy + RAIL_TOP_M, cz, rot);
          break;
        }
      }
    }

    setCount(this.bed, beds);
    setCount(this.rail, rails);
    setCount(this.deck, decks);
    setCount(this.pole, poles);
    setCount(this.wire, wires);
    setCount(this.crossing, posts);
    setCount(this.platform, platforms);
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** 実寸で焼いた部品を、位置と Y 回転だけで置く。 */
  private place(mesh: InstancedMesh, index: number, x: number, y: number, z: number, rotY: number): void {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(this.axisY, rotY);
    this.scl.set(1, 1, 1);
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  /** 2 点を結ぶ棒（架線）。+Z 長さ 1 のジオメトリを伸ばして向ける。 */
  private segment(
    mesh: InstancedMesh,
    index: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    this.dir.set(bx - ax, by - ay, bz - az);
    const len = this.dir.length();
    if (len < 1e-4) return;
    this.dir.divideScalar(len);
    this.quat.setFromUnitVectors(this.forward, this.dir);
    this.pos.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    this.scl.set(1, 1, len);
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
  }
}

/** そのタイルが駅の建物か。ホームを敷く場所を決めるのに使う。 */
function isStationTile(sim: Simulation, tile: number): boolean {
  const ref = sim.world.buildingRef[tile]!;
  if (ref === 0) return false;
  const slot = ref - 1;
  if (sim.buildings.alive[slot] !== 1) return false;
  return archetype(sim.buildings.archetypeId[slot]!).mesh === 'station';
}

/** 空のインスタンス群はシーンから外す（count=0 でもドローコールを 1 つ使うため）。 */
function setCount(mesh: InstancedMesh, n: number): void {
  mesh.count = n;
  mesh.visible = n > 0;
}
