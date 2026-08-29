import { BufferAttribute, BufferGeometry, Color } from 'three';
import { TRAIN_CAR_LENGTH_M } from '@shared/constants';
import { applyVerticalAO, mergeParts, type Part } from './materials';
import { GLASS_ATTRIBUTE } from './agentMaterial';
import { boxes, prism, strut, wheel, type BoxSpec } from './parts';

/**
 * 車両の造形。
 *
 * これまで車もバスもトラックも電車も「箱を数個並べたもの」だった。実寸なので
 * 縮尺は正しいのだが、路上に降りると「色の付いた直方体が流れている」だけで、
 * 軽自動車もセダンもトラックも形からは区別が付かなかった。
 *
 * ここでやることは 3 つ。
 *
 * 1. **シルエットを作る。** 車が車に見えるかどうかは、まずボンネット・キャビン・
 *    トランクの 3 段の段差と、前後に絞られた腰から決まる。面取りした箱を
 *    台形に変形できるようにして（`parts.ts`）、少ない面数で「絞り」を出す。
 * 2. **輪を付ける。** 箱のタイヤは近景でいちばん嘘に見える部品だった。
 *    8 角柱にするだけで 1 台 96 三角形（4 輪）増えるが、払う価値がある。
 * 3. **1 台 1 ドローコールを崩さない。** 部品はすべて `mergeParts` で
 *    1 ジオメトリに焼き固め、インスタンスは今までどおり 1 台 1 つのままにする。
 *
 * 部品ごとの塗り分けは頂点色で行うが、頂点色は**絶対色ではなく変調係数**として
 * 持たせる。three.js は `vColor = color * instanceColor` と掛け算するので、
 * 車体を白（1,1,1）、窓を暗い灰、タイヤをほぼ黒にしておけば、
 * `instanceColor` に車体色を入れるだけで
 * 「白い車の窓は明るい灰、黒い車の窓は真っ黒」と自然に付いてくる。
 */

// ---- 共通の変調色 ----------------------------------------------------------

/** 窓ガラス。白い車体なら明るい灰、黒い車体ならほぼ黒になる。 */
const GLASS = 0x474f58;
/**
 * タイヤ。
 *
 * 変調色なので、暗い車体では自動的にさらに暗くなる。0x21 まで落とすと
 * 白い車でも真っ黒な塊になり、円柱に彫った角が 1 つも読めない
 *（＝「黒い短い柱」に見える正体）。日向のタイヤは写真では中間の灰色まで
 * 明るく写るので、そこまで上げて、暗さは下端の AO と接地影に任せる。
 */
const TYRE = 0x35383d;
/** ホイール（金属）。 */
const HUB = 0xa9aeb4;
/** 下回り・シャシー・幌。 */
const UNDER = 0x44484c;
/** バンパー・モール。車体色より少しだけ沈ませる。 */
const TRIM = 0xdcdee0;
/** ドアの分割線・パネルの目地。 */
const SEAM = 0x5d6266;
/** 前照灯のレンズ（消灯時）。金属寄りの明るい灰。 */
const LENS = 0xeef1f3;
/** 尾灯のレンズ（消灯時）。暗い車体では暗い赤になる。 */
const TAIL_LENS = 0xff5f4a;
/** 方向指示器・車幅灯のレンズ。 */
const AMBER_LENS = 0xffb457;

// ---- 夜の灯り --------------------------------------------------------------

/** 前照灯。狭く強い光にするとブルームが乗って夜の絵が締まる。 */
const HEAD_LAMP = 0xfff6dc;
const TAIL_LAMP = 0xff2a1e;
const CABIN_LAMP = 0xffeec0;
/** 路面に落ちる光。加算合成なので、白に寄せすぎると路面が飛ぶ。 */
const BEAM = 0xffe9b4;

// ---- 車種 ------------------------------------------------------------------

/**
 * 自家用車の車種。日本の街なので軽自動車を主役に置く。
 *
 * 3 車種では足りなかった。路上に並ぶ台数は 1 タイル 2 台 × 数十タイルなので、
 * 3 種類だと消失点まで見通したときに同じシルエットが 10 台以上並び、
 * 「インスタンスを並べただけ」だと一目で分かってしまう。
 * **5 車種**あると、隣り合う 3 台が同じ形になる確率が 4% まで落ちる。
 * 増えるのは 1 車種あたり 2 ドローコール（本体・夜の灯り）だけで、
 * 台数がいくら増えても call は増えない。
 */
export const CarKind = {
  /** 軽自動車。背が高く四角い。 */
  Kei: 0,
  /** セダン／ハッチバック。低く前後に絞られている。 */
  Sedan: 1,
  /** ワンボックス。鼻が短くて背が高い。 */
  Van: 2,
  /** ステーションワゴン／SUV。腰高でルーフが後端まで伸びる。 */
  Wagon: 3,
  /** 軽トラック。日本の郊外・農村でいちばん目に入る車。 */
  KeiTruck: 4,
} as const;
export type CarKind = (typeof CarKind)[keyof typeof CarKind];
export const CAR_KIND_COUNT = 5;

/**
 * ハッシュから車種を選ぶ。同じ車は毎フレーム同じ形になる。
 * 比率は日本の保有台数に寄せた 軽 30 : 乗用 26 : 箱型 14 : ワゴン 20 : 軽トラ 10。
 */
export function carKind(hash: number): CarKind {
  const h = (hash >>> 7) % 100;
  if (h < 30) return CarKind.Kei;
  if (h < 56) return CarKind.Sedan;
  if (h < 70) return CarKind.Van;
  if (h < 90) return CarKind.Wagon;
  return CarKind.KeiTruck;
}

/**
 * 車体色。
 *
 * `theme.ts` の 5 色では、路上に降りたときに「白と紺の 2 色」にしか見えなかった。
 * 白・銀・黒で 8 割という実際の分布は守りつつ、**同じ「白」の中に階調を作る**
 * ことで単調さを消す。パール白・アイボリー・シャンパンは離れて見れば同じ白系だが、
 * 隣り合うと確かに違う車に見える。
 *
 * ただし、正午の直射に環境マップ（空）の映り込みが乗ると、明度 0.9 を超える
 * 塗装は 1.0 に張り付いて **どれも同じ真っ白**になる。せっかく 3 種類置いた
 * 白の差が全部飛ぶうえ、シルバーまで白に合流して「街じゅうが白い車」になる。
 * そこで明るい側の 4 色は 1 段落として、色の差がトーンマッピング後にも
 * 残る範囲に収めてある。合わせて有彩色の比率を 26% → 42% に上げた
 * （日本の保有比率としてはやや多いが、絵として車列が読めることを優先する）。
 */
const CAR_PAINTS: { upTo: number; color: number }[] = [
  { upTo: 14, color: 0xdedcd6 }, // ソリッド白
  { upTo: 22, color: 0xd5cfc3 }, // パール白（わずかに温かい）
  { upTo: 27, color: 0xc6cac7 }, // アイボリー寄りの白
  { upTo: 38, color: 0x9fa4aa }, // シルバー
  { upTo: 45, color: 0x74797f }, // ガンメタ
  { upTo: 58, color: 0x2a2d32 }, // 黒
  { upTo: 66, color: 0x33496a }, // 紺
  { upTo: 72, color: 0x6d8faa }, // 水色
  { upTo: 79, color: 0x8c3a35 }, // 赤
  { upTo: 85, color: 0x3d5a44 }, // 深緑
  { upTo: 91, color: 0xb3a184 }, // ベージュ／シャンパン
  { upTo: 96, color: 0x486b74 }, // 青緑
  { upTo: 100, color: 0x6f4f3c }, // 焦茶
];

/** ハッシュから車体色を引く。 */
export function carPaint(hash: number): number {
  const h = hash % 100;
  for (const c of CAR_PAINTS) {
    if (h < c.upTo) return c.color;
  }
  return CAR_PAINTS[CAR_PAINTS.length - 1]!.color;
}

/**
 * 事業者ごとのトラックの塗色。
 *
 * 帰りの空車をすべて同じ灰色にしていたので、走っているトラックの過半数が
 * 「同じ形・同じ色」で並び、そこがいちばん機械的に見えていた。
 * 日本の運送会社の車体でよく見る色から、隣り合っても見分けの付く順に並べてある。
 */
const TRUCK_LIVERIES: number[] = [
  0xe9e9e6, // 白（いちばん多い）
  0xdedfe2, // 銀白
  0x2f6f4f, // 緑
  0x2d5590, // 青
  0xa8402f, // 赤
  0xd8b24a, // 黄
  0x4a4f57, // 濃灰
];

export function truckLivery(hash: number): number {
  return TRUCK_LIVERIES[(hash >>> 0) % TRUCK_LIVERIES.length]!;
}

/** 車種ごとの寸法（全長・全幅・全高、m）。灯りの位置もここから引く。 */
interface CarSpec {
  length: number;
  width: number;
  height: number;
  /** 前輪・後輪の中心 z。 */
  frontZ: number;
  rearZ: number;
  wheelR: number;
  /** 前照灯・尾灯の高さ。 */
  headY: number;
  tailY: number;
  /** 前照灯の左右間隔（中心からの距離）。 */
  headX: number;
  /** 室内灯を灯す位置と長さ。軽トラは荷台があるのでキャブの上に寄せる。 */
  cabinZ?: number;
  cabinD?: number;
}

const CAR_SPECS: Record<CarKind, CarSpec> = {
  [CarKind.Kei]: {
    length: 3.4, width: 1.48, height: 1.66,
    frontZ: 1.14, rearZ: -1.1, wheelR: 0.28, headY: 0.92, tailY: 1.08, headX: 0.52,
  },
  [CarKind.Sedan]: {
    length: 4.3, width: 1.72, height: 1.44,
    frontZ: 1.4, rearZ: -1.36, wheelR: 0.31, headY: 0.78, tailY: 0.88, headX: 0.6,
  },
  [CarKind.Van]: {
    length: 4.4, width: 1.7, height: 1.95,
    frontZ: 1.5, rearZ: -1.36, wheelR: 0.3, headY: 0.86, tailY: 1.24, headX: 0.6,
  },
  [CarKind.Wagon]: {
    length: 4.62, width: 1.78, height: 1.66,
    frontZ: 1.5, rearZ: -1.44, wheelR: 0.33, headY: 0.84, tailY: 1.16, headX: 0.62,
  },
  [CarKind.KeiTruck]: {
    length: 3.4, width: 1.47, height: 1.78,
    frontZ: 1.06, rearZ: -1.02, wheelR: 0.26, headY: 0.7, tailY: 0.72, headX: 0.48,
    cabinZ: 0.86, cabinD: 1.1,
  },
};

/**
 * 車輪の角数。
 *
 * 目線の高さのカットでは車輪が画面上 20〜40px あり、8 角柱だと下端が
 * 「短い柱を斜めに切った面」に見えて接地点が読めなかった。12 角にすると
 * 底に必ず平らな面が来て、そこが路面に接する。1 台あたり 4 輪 × 12 三角形
 * 増えるだけ（96 → 144）なので、近景の説得力に対して十分安い。
 */
const WHEEL_SEG = 12;

/** 4 輪をまとめて。 */
function fourWheels(s: CarSpec, width: number): Part[] {
  const x = s.width / 2 - width * 0.42;
  const out: Part[] = [];
  for (const z of [s.frontZ, s.rearZ]) {
    for (const side of [1, -1] as const) {
      out.push(
        ...wheel({ x: side * x, y: s.wheelR, z, r: s.wheelR, width, side, seg: WHEEL_SEG, tyre: TYRE, hub: HUB }),
      );
    }
  }
  return out;
}

/** ホイールアーチの陰。車体色の変調を受けるので、暗い車ではさらに沈む。 */
const ARCH = 0x3f4348;

/**
 * ホイールアーチ（タイヤ上の凹み）。
 *
 * 車を「石鹸箱」から救うのは、実のところ窓とこれの 2 つしかない。
 * 実車の側面は、腰から下がタイヤの上で半円に切り欠かれていて、その中が
 * 必ず暗い。切り欠きが無いと、どんなに面取りしても側面が 1 枚の板に見える。
 *
 * 本当に穴を開けると三角形が跳ね上がるので、**タイヤより一回り大きい
 * 暗いレンズ形の板をタイヤの外側へ差し込む**。板は車体を貫いて左右へ
 * 同時に出るので（`doorSeams` と同じ手口）、1 軸につき箱 1 つ、
 * 1 台 24 三角形で 4 輪ぶんのアーチが付く。
 * 前後端の高さを絞る（`hf`/`hb`）とレンズ形になり、タイヤの周りに
 * 暗い縁が残って、真横から見た輪郭が弧として読める。
 */
function wheelArches(s: CarSpec): BoxSpec[] {
  return [s.frontZ, s.rearZ].map((z) => ({
    // タイヤの外側へ確実に出す。車輪はもともと車体幅より 1.5cm ほど外にある。
    w: s.width + 0.09,
    h: s.wheelR * 1.9,
    d: s.wheelR * 2 + 0.22,
    y: s.wheelR + 0.12,
    z,
    hf: 0.18,
    hb: 0.18,
    tint: ARCH,
  }));
}

/**
 * ドアの分割線。
 *
 * 車体より 1cm だけ幅の広い薄い板を車体を貫くように差し込むと、
 * 左右の側面に同時に 1 本の筋が出る。板 1 枚（12 三角形）で
 * 両側のドア分割線が引けるので、近景の情報量あたりの費用がとても安い。
 */
function doorSeams(width: number, y: number, h: number, zs: readonly number[]): BoxSpec[] {
  return zs.map((z) => ({ w: width + 0.02, h, d: 0.025, y, z, tint: SEAM }));
}

/**
 * ピラー（窓と窓の間の柱）。
 *
 * 側面のガラスは 1 本の長い帯で焼いてあるので、そのままだと窓が
 * 「側面に貼った黒い帯」にしかならない。実車の側面が窓に見えるのは、
 * B ピラー・C ピラーで帯が 2〜3 枚に割れているからである。
 * 車体色の薄い板をガラスより 1.5mm だけ外へ差し込むと、
 * 左右同時に柱が立つ（`doorSeams` と同じ手口。箱 1 つ = 12 三角形）。
 *
 * @param w ガラスの帯の幅。これに少し足した幅で差し込む。
 */
function pillars(w: number, y: number, h: number, zs: readonly number[]): BoxSpec[] {
  return zs.map((z) => ({ w: w + 0.03, h, d: 0.075, y, z }));
}

/** サイドミラー。車体から直に生やして支柱を省く（12 三角形 × 2）。 */
function mirrors(x: number, y: number, z: number): BoxSpec[] {
  return [
    { w: 0.34, h: 0.11, d: 0.09, x, y, z, tint: TRIM },
    { w: 0.34, h: 0.11, d: 0.09, x: -x, y, z, tint: TRIM },
  ];
}

/**
 * 車体を組んで焼き固める。接地部を落として影を足元に溜める。
 *
 * このとき **ガラスの部品だけを後ろにまとめて焼き、頂点属性 `aGlass` で
 * 印を付ける**。窓は頂点カラー（＝車体色との掛け算）で塗ると、黒い車で
 * RGB がほぼ 0 に潰れて「黒い天蓋」になってしまう。ガラスは空を映すものなので
 * 車体色から切り離す必要があるが、別メッシュに割るとドローコールが車種ぶん増える。
 * 印さえ付いていればシェーダ側で塗り分けられる（`agentMaterial.ts`）。
 */
function bake(parts: Part[]): BufferGeometry {
  const solidParts = parts.filter((p) => p.color !== GLASS);
  const glassParts = parts.filter((p) => p.color === GLASS);
  let g: BufferGeometry;
  if (glassParts.length === 0) {
    g = mergeParts(solidParts);
    g.setAttribute(
      GLASS_ATTRIBUTE,
      new BufferAttribute(new Float32Array(g.getAttribute('position').count), 1),
    );
  } else {
    // 焼く順番がそのまま頂点の並びになるので、前半＝不透明・後半＝ガラスで印を割れる。
    const solid = mergeParts(solidParts);
    const glass = mergeParts(glassParts);
    const nSolid = solid.getAttribute('position').count;
    const nGlass = glass.getAttribute('position').count;
    // ガラス 1 枚ごとの頂点数。上下の階調は**窓 1 枚ずつ**で取らないと、
    // 車体でいちばん高い窓（フロントガラス）に引きずられて、
    // 低いところにある側面窓が「全部下端」になってしまう。
    // `mergeParts` は渡した順に繋ぐので、この数だけで境目が分かる。
    // 箱は索引付きなので、非索引化したあとの頂点数を数える。
    const spans = glassParts.map((q) =>
      q.geom.index ? q.geom.index.count : q.geom.getAttribute('position').count,
    );
    g = mergeParts([{ geom: solid }, { geom: glass }]);
    solid.dispose();
    glass.dispose();
    const mark = new Float32Array(nSolid + nGlass);
    mark.fill(1, nSolid);
    const attr = new BufferAttribute(mark, 1);
    g.setAttribute(GLASS_ATTRIBUTE, attr);
    // 法線を反らせるついでに、印へ「窓の中の高さ」を書き足す（0..1 を 1 に加算）。
    curveGlass(g, mark, nSolid, spans);
    attr.needsUpdate = true;
  }
  // 下ほど暗くする。車の下は実際に影になるので、これだけで「浮き」が消える。
  applyVerticalAO(g, 0.62, 1.06, 1.5);
  return g;
}

/**
 * ガラスの法線を左右に反らせる。
 *
 * 窓は平らな板で焼いてあるので、面の法線が一定になる。すると反射ベクトルも
 * 面の中で一定になり、どんなに良い環境マップを当てても**1 枚のガラスが
 * 一様な明るい灰色**にしかならない（＝「白く塗った板」に見える正体）。
 *
 * 実車のガラスは必ず左右に湾曲していて、だからこそ 1 枚の中で空・地平・
 * 路面が横に流れる。ここでは面を割らずに **法線だけ**を円筒状に反らせる。
 * 頂点も三角形も 1 つも増えないのに、反射の階調が出る。
 */
function curveGlass(
  g: BufferGeometry,
  mark: Float32Array,
  nSolid: number,
  spans: readonly number[],
): void {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  if (!pos || !nor) return;
  // 車体半幅 0.85m ぶんで法線が 0.42 ぶん傾く＝半径 2m 前後の湾曲。
  // 0.6 では反りが強すぎて、真後ろから見たリアガラスが「磨いた円筒」に見えた。
  const CURVE = 0.42;
  const HALF = 0.85;
  /**
   * 上下の反り。
   *
   * 左右に反らせるだけでは **側面窓**（法線が ±X）がまったく変わらない。
   * 反射ベクトルの向きは面内で一定のままなので、窓の帯が上から下まで
   * 同じ明るさの一色に塗られる ―― これが「白く塗った板」の残り半分だった。
   * 実車の側面窓もドアの外板に沿って上下に膨らんでいて、**上端は空、
   * 下端は路面**を映す。上を向かせ下を向かせるだけで、1 枚の窓に
   * 空 → 地平 → 路面の 3 段が縦に並ぶ。
   */
  const CURVE_V = 0.36;
  // 上下の基準は**窓 1 枚ごと**に取る。車全体で取ると、いちばん高い
  // フロントガラスに正規化が引きずられて、側面窓が一様に「下端」に潰れる。
  let base = nSolid;
  for (const span of spans) {
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = base; i < base + span; i++) {
      const y = pos.getY(i);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    const yMid = (yMin + yMax) / 2;
    const yHalf = Math.max(0.05, (yMax - yMin) / 2);
    for (let i = base; i < base + span; i++) {
      const t = Math.max(-1, Math.min(1, pos.getX(i) / HALF));
      const u = Math.max(-1, Math.min(1, (pos.getY(i) - yMid) / yHalf));
      let nx = nor.getX(i) + CURVE * t;
      let ny = nor.getY(i) + CURVE_V * u;
      let nz = nor.getZ(i);
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      nor.setXYZ(i, nx, ny, nz);
      // **印そのものに窓の高さを載せる。** 反りだけでは側面窓（法線が ±X）の
      // 反射ベクトルが面内で動かず、1 枚が一色の平板のままだった。
      // 1 + (0..1) にしておけば、フラグメント側で「ガラスか否か」と
      // 「窓の上下」を varying 1 本から取り出せる（`agentMaterial`）。
      mark[i] = 1 + (u + 1) / 2;
    }
    base += span;
  }
  nor.needsUpdate = true;
}

// ---- 自家用車 --------------------------------------------------------------

function keiParts(): Part[] {
  const s = CAR_SPECS[CarKind.Kei];
  const specs: BoxSpec[] = [
    // 腰。軽は真上から見ても四角いので絞りは控えめ。
    { w: s.width, h: 0.74, d: s.length, y: 0.6, c: 0.06, wf: 0.93, wb: 0.95 },
    // キャビン（ガラスハウス）。上をすぼめると屋根の稜線が出る。
    { w: s.width - 0.09, h: 0.66, d: 2.1, y: 1.29, z: -0.16, wt: 0.93, wf: 0.96, tint: GLASS },
    // ルーフ。ガラスハウスより一回り大きくして庇の線を作る。
    { w: s.width - 0.05, h: 0.12, d: 2.0, y: 1.6, z: -0.18, c: 0.05 },
    // 傾いたフロントガラス。軽は立っている。
    { w: s.width - 0.14, h: 0.72, d: 0.06, y: 1.3, z: 0.92, rx: -0.2, tint: GLASS },
    // リアガラス。
    { w: s.width - 0.16, h: 0.6, d: 0.06, y: 1.3, z: -1.24, rx: 0.12, tint: GLASS },
    // バンパー。
    { w: s.width - 0.02, h: 0.34, d: 0.3, y: 0.42, z: s.length / 2 - 0.06, c: 0.06, tint: TRIM },
    { w: s.width - 0.02, h: 0.34, d: 0.3, y: 0.44, z: -s.length / 2 + 0.06, c: 0.06, tint: TRIM },
    // 前照灯・尾灯のレンズ（昼でも見える金属／赤の部品）。
    { w: 0.3, h: 0.2, d: 0.12, x: s.headX, y: s.headY, z: s.length / 2 - 0.06, tint: LENS },
    { w: 0.3, h: 0.2, d: 0.12, x: -s.headX, y: s.headY, z: s.length / 2 - 0.06, tint: LENS },
    { w: 0.15, h: 0.4, d: 0.1, x: 0.63, y: s.tailY, z: -s.length / 2 + 0.02, tint: TAIL_LENS },
    { w: 0.15, h: 0.4, d: 0.1, x: -0.63, y: s.tailY, z: -s.length / 2 + 0.02, tint: TAIL_LENS },
    ...mirrors(0.85, 1.22, 0.72),
    ...doorSeams(s.width, 0.62, 0.72, [0.3, -0.78]),
    ...wheelArches(s),
    ...pillars(s.width - 0.09, 1.29, 0.68, [0.06, -0.95]),
  ];
  return [...boxes(specs), ...fourWheels(s, 0.17)];
}

function sedanParts(): Part[] {
  const s = CAR_SPECS[CarKind.Sedan];
  const specs: BoxSpec[] = [
    // 腰。前後に絞る（wf/wb）と、真上から見たときに車らしい紡錘形になる。
    { w: s.width, h: 0.62, d: s.length, y: 0.5, c: 0.07, wf: 0.86, wb: 0.9, hf: 0.94 },
    // ボンネット。前へ向かって下がる。
    { w: s.width - 0.1, h: 0.16, d: 1.4, y: 0.87, z: 1.24, c: 0.05, wf: 0.84, hf: 0.7 },
    // トランク。ボンネットより少し高くして、前後の違いを上からも読ませる。
    { w: s.width - 0.08, h: 0.16, d: 1.05, y: 0.9, z: -1.55, c: 0.05, wb: 0.88 },
    // ガラスハウス。
    { w: s.width - 0.1, h: 0.44, d: 2.15, y: 1.13, z: -0.2, wt: 0.9, wf: 0.94, wb: 0.94, tint: GLASS },
    // ルーフ。
    { w: s.width - 0.16, h: 0.1, d: 1.7, y: 1.38, z: -0.36, c: 0.05, wt: 0.94 },
    // 大きく寝たフロントガラス。セダンらしさはここで決まる。
    { w: s.width - 0.16, h: 0.72, d: 0.06, y: 1.12, z: 0.86, rx: -0.6, tint: GLASS },
    { w: s.width - 0.18, h: 0.62, d: 0.06, y: 1.14, z: -1.28, rx: 0.5, tint: GLASS },
    // バンパー。
    { w: s.width - 0.08, h: 0.3, d: 0.32, y: 0.38, z: s.length / 2 - 0.1, c: 0.06, wf: 0.9, tint: TRIM },
    { w: s.width - 0.08, h: 0.3, d: 0.32, y: 0.4, z: -s.length / 2 + 0.1, c: 0.06, wb: 0.92, tint: TRIM },
    // 灯火。
    { w: 0.36, h: 0.18, d: 0.14, x: s.headX, y: s.headY, z: s.length / 2 - 0.14, tint: LENS },
    { w: 0.36, h: 0.18, d: 0.14, x: -s.headX, y: s.headY, z: s.length / 2 - 0.14, tint: LENS },
    { w: 0.34, h: 0.17, d: 0.1, x: 0.62, y: s.tailY, z: -s.length / 2 + 0.1, tint: TAIL_LENS },
    { w: 0.34, h: 0.17, d: 0.1, x: -0.62, y: s.tailY, z: -s.length / 2 + 0.1, tint: TAIL_LENS },
    // フロントグリル。
    { w: 0.86, h: 0.14, d: 0.08, y: 0.68, z: s.length / 2 - 0.08, tint: 0x30343a },
    ...mirrors(0.92, 1.02, 0.66),
    ...doorSeams(s.width, 0.6, 0.62, [0.42, -0.9]),
    ...wheelArches(s),
    ...pillars(s.width - 0.1, 1.13, 0.46, [-0.12, -1.0]),
  ];
  return [...boxes(specs), ...fourWheels(s, 0.19)];
}

function vanParts(): Part[] {
  const s = CAR_SPECS[CarKind.Van];
  const specs: BoxSpec[] = [
    // 腰。ワンボックスは鼻が無いので、前端まで箱が来る。
    { w: s.width, h: 0.92, d: s.length, y: 0.66, c: 0.06, wf: 0.94, wb: 0.95 },
    // 上屋。
    { w: s.width - 0.06, h: 0.82, d: 4.05, y: 1.52, z: -0.14, c: 0.06, wt: 0.95 },
    // 側面の窓の帯。車体より少し広くして面を出す。
    // 後端はリアガラス（z = -2.11）に届かせない。帯の後ろの蓋とリアガラスが
    // 2cm 差で重なると、真後ろから見たときに 1 枚の巨大なガラス板に見える。
    { w: s.width + 0.02, h: 0.5, d: 3.1, y: 1.56, z: -0.26, tint: GLASS },
    // 立ったフロントガラス。
    { w: s.width - 0.1, h: 0.92, d: 0.07, y: 1.5, z: 2.03, rx: -0.16, tint: GLASS },
    { w: s.width - 0.14, h: 0.66, d: 0.07, y: 1.58, z: -2.11, rx: 0.06, tint: GLASS },
    // ルーフ。
    { w: s.width - 0.12, h: 0.12, d: 3.9, y: 1.93, z: -0.14, c: 0.05 },
    // バンパー。
    { w: s.width - 0.02, h: 0.36, d: 0.28, y: 0.4, z: s.length / 2 - 0.04, c: 0.06, tint: TRIM },
    { w: s.width - 0.02, h: 0.36, d: 0.28, y: 0.42, z: -s.length / 2 + 0.04, c: 0.06, tint: TRIM },
    { w: 0.34, h: 0.2, d: 0.12, x: s.headX, y: s.headY, z: s.length / 2 - 0.04, tint: LENS },
    { w: 0.34, h: 0.2, d: 0.12, x: -s.headX, y: s.headY, z: s.length / 2 - 0.04, tint: LENS },
    { w: 0.16, h: 0.5, d: 0.1, x: 0.62, y: s.tailY, z: -s.length / 2 + 0.02, tint: TAIL_LENS },
    { w: 0.16, h: 0.5, d: 0.1, x: -0.62, y: s.tailY, z: -s.length / 2 + 0.02, tint: TAIL_LENS },
    ...mirrors(0.88, 1.3, 1.62),
    // スライドドアの見切り。
    ...doorSeams(s.width, 1.0, 1.5, [0.9, -1.1]),
    ...wheelArches(s),
    ...pillars(s.width + 0.02, 1.56, 0.52, [0.56, -0.9]),
  ];
  return [...boxes(specs), ...fourWheels(s, 0.18)];
}

/**
 * ステーションワゴン／SUV。
 * セダンより腰が高く、ルーフが後端まで水平に伸びて後ろで断ち切られる。
 * ルーフレールを 1 本入れると、真横から見たときにセダンと確実に区別が付く。
 */
function wagonParts(): Part[] {
  const s = CAR_SPECS[CarKind.Wagon];
  const specs: BoxSpec[] = [
    // 腰。セダンより高く、絞りは浅い。
    { w: s.width, h: 0.78, d: s.length, y: 0.62, c: 0.07, wf: 0.9, wb: 0.93 },
    // ボンネット。
    { w: s.width - 0.1, h: 0.16, d: 1.3, y: 1.03, z: 1.42, c: 0.05, wf: 0.86, hf: 0.72 },
    // ガラスハウス。後端まで伸ばす。
    { w: s.width - 0.1, h: 0.5, d: 2.9, y: 1.29, z: -0.55, wt: 0.93, wf: 0.95, tint: GLASS },
    // ルーフ。
    { w: s.width - 0.13, h: 0.11, d: 2.7, y: 1.58, z: -0.6, c: 0.05, wt: 0.95 },
    // ルーフレール（板 1 枚で左右に 2 本出る）。
    { w: s.width - 0.04, h: 0.07, d: 2.1, y: 1.66, z: -0.7, tint: 0x4c5054 },
    // 傾いたフロントガラスと、立ったリアゲートのガラス。
    { w: s.width - 0.16, h: 0.76, d: 0.06, y: 1.28, z: 0.94, rx: -0.5, tint: GLASS },
    { w: s.width - 0.2, h: 0.66, d: 0.06, y: 1.34, z: -2.0, rx: 0.16, tint: GLASS },
    // バンパー。SUV らしく黒い樹脂の下回りを覗かせる。
    { w: s.width - 0.04, h: 0.32, d: 0.3, y: 0.44, z: s.length / 2 - 0.08, c: 0.06, tint: TRIM },
    { w: s.width - 0.04, h: 0.32, d: 0.3, y: 0.46, z: -s.length / 2 + 0.08, c: 0.06, tint: TRIM },
    // 前後の車輪の間だけ。車輪まで覆うと、タイヤの外側に樹脂が突き出す。
    { w: s.width - 0.04, h: 0.2, d: 2.5, y: 0.34, tint: 0x3c4045 },
    // 灯火。テールは縦長でリアゲートの脇に付く。
    { w: 0.36, h: 0.19, d: 0.14, x: s.headX, y: s.headY, z: s.length / 2 - 0.12, tint: LENS },
    { w: 0.36, h: 0.19, d: 0.14, x: -s.headX, y: s.headY, z: s.length / 2 - 0.12, tint: LENS },
    { w: 0.16, h: 0.46, d: 0.1, x: 0.68, y: s.tailY, z: -s.length / 2 + 0.06, tint: TAIL_LENS },
    { w: 0.16, h: 0.46, d: 0.1, x: -0.68, y: s.tailY, z: -s.length / 2 + 0.06, tint: TAIL_LENS },
    { w: 0.9, h: 0.16, d: 0.08, y: 0.74, z: s.length / 2 - 0.06, tint: 0x30343a },
    ...mirrors(0.95, 1.18, 0.78),
    ...doorSeams(s.width, 0.72, 0.78, [0.42, -0.92]),
    ...wheelArches(s),
    ...pillars(s.width - 0.1, 1.29, 0.52, [0.0, -1.15]),
  ];
  return [...boxes(specs), ...fourWheels(s, 0.2)];
}

/**
 * 軽トラック。
 * 運転台が前端まで来て、その後ろが低い荷台。日本の郊外・農村の路上で
 * いちばん目に入る形なので、これが混ざるだけで「日本の街」らしさが増す。
 */
function keiTruckParts(): Part[] {
  const s = CAR_SPECS[CarKind.KeiTruck];
  const specs: BoxSpec[] = [
    // シャシー。
    { w: s.width - 0.18, h: 0.22, d: s.length - 0.3, y: 0.52, tint: UNDER },
    // キャブ。前端から 1.5m ほど。
    { w: s.width, h: 1.06, d: 1.5, y: 1.14, z: 0.86, c: 0.05, wt: 0.96 },
    // フロントガラス（立っている）と側面窓。
    { w: s.width - 0.12, h: 0.6, d: 0.07, y: 1.42, z: 1.58, rx: -0.1, tint: GLASS },
    { w: s.width + 0.03, h: 0.5, d: 1.2, y: 1.44, z: 0.82, tint: GLASS },
    // 荷台の床とあおり 3 枚。
    { w: s.width, h: 0.12, d: 1.72, y: 0.72, z: -0.78, tint: 0x9c9184 },
    { w: 0.08, h: 0.42, d: 1.72, x: s.width / 2 - 0.04, y: 0.98, z: -0.78 },
    { w: 0.08, h: 0.42, d: 1.72, x: -(s.width / 2 - 0.04), y: 0.98, z: -0.78 },
    { w: s.width, h: 0.42, d: 0.08, y: 0.98, z: -1.6 },
    // 鳥居（キャブ後ろの立ち板）。
    { w: s.width - 0.06, h: 0.5, d: 0.08, y: 1.42, z: 0.1, tint: 0xdfe0e0 },
    // バンパー・灯火。
    { w: s.width - 0.04, h: 0.26, d: 0.24, y: 0.42, z: s.length / 2 - 0.04, c: 0.05, tint: TRIM },
    { w: 0.26, h: 0.18, d: 0.1, x: s.headX, y: s.headY, z: s.length / 2 - 0.03, tint: LENS },
    { w: 0.26, h: 0.18, d: 0.1, x: -s.headX, y: s.headY, z: s.length / 2 - 0.03, tint: LENS },
    { w: 0.16, h: 0.22, d: 0.08, x: 0.56, y: s.tailY, z: -s.length / 2 + 0.02, tint: TAIL_LENS },
    { w: 0.16, h: 0.22, d: 0.08, x: -0.56, y: s.tailY, z: -s.length / 2 + 0.02, tint: TAIL_LENS },
    ...mirrors(0.86, 1.46, 1.44),
    ...wheelArches(s),
  ];
  return [...boxes(specs), ...fourWheels(s, 0.15)];
}

const CAR_BUILDERS: Record<CarKind, () => Part[]> = {
  [CarKind.Kei]: keiParts,
  [CarKind.Sedan]: sedanParts,
  [CarKind.Van]: vanParts,
  [CarKind.Wagon]: wagonParts,
  [CarKind.KeiTruck]: keiTruckParts,
};

/** 車種ごとの全長 (m)。前後の車間を取るのに使う（`agentLayer`）。 */
export function carLength(kind: CarKind): number {
  return CAR_SPECS[kind].length;
}

export function carGeometry(kind: CarKind): BufferGeometry {
  return bake(CAR_BUILDERS[kind]());
}

/**
 * 車種ごとの全幅の半分 (m)。
 * 路肩に寄せて停めるとき、縁石までの距離をこれで決める（`agentLayer`）。
 */
export function carHalfWidth(kind: CarKind): number {
  return CAR_SPECS[kind].width / 2;
}

/**
 * 夜の灯り。
 *
 * こちらは変調ではなく**そのままの色**で描く（`MeshBasicMaterial` ＋
 * `instanceColor` なし、トーンマッピングも切る）。夜の街で光ってほしいので
 * 光源の影響を受けない材質を使い、ブルームのしきい値を確実に越えさせる。
 */
export function carLampGeometry(kind: CarKind): BufferGeometry {
  const s = CAR_SPECS[kind];
  const nose = s.length / 2 + 0.02;
  const tail = -s.length / 2 - 0.02;
  return mergeParts(
    boxes([
      { w: 0.26, h: 0.15, d: 0.08, x: s.headX, y: s.headY, z: nose, tint: HEAD_LAMP },
      { w: 0.26, h: 0.15, d: 0.08, x: -s.headX, y: s.headY, z: nose, tint: HEAD_LAMP },
      { w: 0.13, h: 0.3, d: 0.08, x: 0.62, y: s.tailY, z: tail, tint: TAIL_LAMP },
      { w: 0.13, h: 0.3, d: 0.08, x: -0.62, y: s.tailY, z: tail, tint: TAIL_LAMP },
      // 車内のかすかな灯り。窓越しに見えるだけでよいので弱く小さく。
      {
        w: s.width - 0.34,
        h: 0.06,
        d: s.cabinD ?? 1.2,
        y: s.height - 0.28,
        z: s.cabinZ ?? -0.2,
        tint: 0x6a5230,
      },
    ]),
  );
}

/**
 * 前照灯の光の**円錐**（空中に伸びる光）。
 *
 * 路面に落ちる楕円だけでは、真横や斜め前から見た夜の車が「点が 2 つ光る箱」に
 * しかならない。夜の街の写真で車が車に見えるのは、埃と湿気に散乱した光が
 * 前方に立体として伸びているからで、それが**光っている物と照らされている物の
 * 関係**を作っている。加算合成の円錐 1 つ（180 三角形）でそこまで届く。
 *
 * 単位ジオメトリ: 頂点が原点、+Z へ長さ 1。半径は 1 の位置で 0.5。
 * 使う側で (幅, 高さ, 長さ) にスケールする。表裏どちらも描くので、
 * 中心軸の近くは前面と背面が二重に足されて自然に明るくなる。
 */
export function beamConeGeometry(): BufferGeometry {
  const SEG = 12;
  const NZ = 4;
  const c = new Color(BEAM);
  const pos: number[] = [];
  const col: number[] = [];
  // 根元は絞られていて、遠くへ行くほど広がりながら暗くなる。
  const radius = (t: number): number => (0.06 + t * 0.44) * 1.0;
  const bright = (t: number): number => Math.pow(1 - t, 2.0) * 0.9;
  const push = (t: number, k: number): void => {
    const a = (k / SEG) * Math.PI * 2;
    const r = radius(t);
    pos.push(Math.cos(a) * r, Math.sin(a) * r, t);
    const b = bright(t);
    col.push(c.r * b, c.g * b, c.b * b);
  };
  for (let i = 0; i < NZ; i++) {
    const t0 = i / NZ;
    const t1 = (i + 1) / NZ;
    for (let k = 0; k < SEG; k++) {
      push(t0, k); push(t0, k + 1); push(t1, k + 1);
      push(t0, k); push(t1, k + 1); push(t1, k);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.computeVertexNormals();
  return mergeParts([{ geom: g }]);
}

/** 円錐の置き方（前端の z・幅・高さ・届く距離）。 */
export interface ConeSpec {
  z: number;
  y: number;
  width: number;
  height: number;
  length: number;
}

export function carConeSpec(kind: CarKind): ConeSpec {
  const s = CAR_SPECS[kind];
  return { z: s.length / 2, y: s.headY, width: s.width * 2.4, height: 1.5, length: 11 };
}

export function truckConeSpec(): ConeSpec {
  return { z: TRUCK_LEN / 2, y: 0.92, width: TRUCK_W * 2.2, height: 1.8, length: 13 };
}

export function busConeSpec(): ConeSpec {
  return { z: BUS_LEN / 2, y: 0.98, width: BUS_W * 2.2, height: 1.8, length: 13 };
}

export function trainConeSpec(): ConeSpec {
  return { z: L / 2, y: 1.62, width: 5.5, height: 3.0, length: 26 };
}

/**
 * 前照灯が路面に落とす光。
 *
 * 加算合成の板を車の前に寝かせる。ヘッドライト自体は数十 cm の点でしかないので、
 * これが無いと夜の道路が真っ暗なまま「光る点が流れる」画になる。
 * 手前を明るく、遠くと左右の端を 0 にした頂点カラーで減衰させる。
 */
export function beamGeometry(): BufferGeometry {
  const parts: Part[] = [];
  // 単位ジオメトリ: 幅 1（±0.5）、長さ 1（z = 0..1）。使う側でスケールする。
  // 縦 5 × 横 5 の格子に割り、頂点カラーで四方に減衰させる。
  // 1 枚の板のままだと縁が直線で切れて「白い台形」に見えてしまう。
  const NZ = 5;
  const NX = 5;
  const c = new Color(BEAM);
  // 手前で立ち上がり、遠くへ緩やかに落ちる。実際の配光に近い山形。
  //
  // 立ち上がりを 0.18 → 0.10 に詰めた。前照灯の光は**バンパーのすぐ先**から
  // 路面に乗るもので、そこが暗いままだと車と光溜まりが切り離されて、
  // 「車の前方 3m から急に道が明るくなる」不自然な絵になる。
  const alongFall = (t: number): number =>
    Math.min(1, t / 0.1) * Math.pow(1 - Math.min(1, t), 1.6);
  // 左右は端で 0 に。
  const sideFall = (u: number): number => Math.pow(Math.max(0, 1 - Math.abs(u) * 2), 1.3);
  // 遠いほど広がる。
  //
  // 根元を 0.2 → 0.28 に太らせた。5 分割の格子で左右が 0 まで落ちるので、
  // 実際に光って見える幅は指定の半分ほどしかない。夜のカットで前照灯の光が
  // 「細い一本の帯」にしか見えなかったのはこれが効いていた。
  const halfWidth = (t: number): number => 0.28 + t * 0.32;

  const pos: number[] = [];
  const col: number[] = [];
  const push = (t: number, u: number): void => {
    const hw = halfWidth(t);
    pos.push(u * hw * 2, 0, t);
    const b = alongFall(t) * sideFall(u);
    col.push(c.r * b, c.g * b, c.b * b);
  };
  for (let iz = 0; iz < NZ; iz++) {
    const t0 = iz / NZ;
    const t1 = (iz + 1) / NZ;
    for (let ix = 0; ix < NX; ix++) {
      const u0 = ix / NX - 0.5;
      const u1 = (ix + 1) / NX - 0.5;
      push(t0, u0); push(t0, u1); push(t1, u1);
      push(t0, u0); push(t1, u1); push(t1, u0);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.computeVertexNormals();
  parts.push({ geom: g });
  return mergeParts(parts);
}

/** 車種ごとの光の板の置き方（前端の z・幅・届く距離）。 */
export function carBeamSpec(kind: CarKind): { z: number; width: number; length: number; y: number } {
  const s = CAR_SPECS[kind];
  // 板の始まりを前端の 0.6m 先から 0.15m 先へ寄せる。離すと、車の真ん前だけが
  // 暗いまま残って「車と光が繋がっていない」絵になる。
  return { z: s.length / 2 + 0.15, width: s.width * 4.2, length: 13, y: 0.03 };
}

/**
 * **停まっている車**が路面に落とす光の板。
 *
 * 夜のカットに映る車のほとんどは走行中ではなく路肩に停まった車で、
 * これまでそちらには光の板を一切置いていなかった。結果、灯りの点いた車の
 * 前方だけが真っ暗のままで「白い矩形を 2 つ貼った箱」に見えていた。
 *
 * かといって走行車と同じ 14m の板を全部に置くと、光溜まりが前後で重なって
 * **路肩が一本の光の帯**になる。停車中はロービームで、しかも車間より短ければ
 * 隣とは繋がらない。長さを 1/3 に切り詰め、色（＝instanceColor）でさらに
 * 落として、1 台ずつ独立した光溜まりとして置く。
 */
export function carIdleBeamSpec(kind: CarKind): { z: number; width: number; length: number; y: number } {
  const s = CAR_SPECS[kind];
  return { z: s.length / 2 + 0.4, width: s.width * 2.3, length: 4.8, y: 0.03 };
}

// ---- バス ------------------------------------------------------------------

const BUS_LEN = 8.2;
const BUS_W = 2.44;
/** バスの全長・全幅 (m)。車間と接地影の大きさを決めるのに使う。 */
export const BUS_BODY_M = BUS_LEN;
export const BUS_WIDTH_M = BUS_W;

export function busGeometry(): BufferGeometry {
  const half = BUS_LEN / 2;
  const specs: BoxSpec[] = [
    // スカート（床下）。
    { w: BUS_W - 0.06, h: 0.72, d: BUS_LEN - 0.2, y: 0.5, c: 0.05, tint: 0xdadcde },
    // 車体。
    { w: BUS_W, h: 1.62, d: BUS_LEN, y: 1.6, c: 0.09, wf: 0.97, wb: 0.97 },
    // 側面の窓の帯。車体より少し外に出して、窓が「はまっている」ように見せる。
    { w: BUS_W + 0.03, h: 0.88, d: BUS_LEN - 0.7, y: 1.98, tint: GLASS },
    // 窓柱。帯を 4 枚に割ると、真横のバスが「黒い帯を巻いた箱」から
    // 「窓の並んだバス」になる（`pillars` の注記）。
    ...pillars(BUS_W + 0.03, 1.98, 0.9, [2.2, 0.0, -2.2]),
    // フロントガラス（大きく、わずかに前傾）。
    { w: BUS_W - 0.14, h: 1.26, d: 0.08, y: 1.92, z: half - 0.02, rx: -0.06, tint: GLASS },
    // リアガラス。
    { w: BUS_W - 0.2, h: 0.86, d: 0.08, y: 2.0, z: -half + 0.02, tint: GLASS },
    // 屋根。上をすぼめて丸屋根に見せる。
    { w: BUS_W - 0.04, h: 0.3, d: BUS_LEN - 0.06, y: 2.56, c: 0.1, wt: 0.82 },
    // 屋根上のクーラー。
    { w: 1.5, h: 0.22, d: 2.4, y: 2.78, z: -1.1, c: 0.05, tint: 0xe2e4e6 },
    // 行先表示（前・側面）。夜は灯りの方でも光らせる。
    { w: 1.7, h: 0.34, d: 0.06, y: 2.42, z: half + 0.01, tint: 0x2b2f33 },
    { w: 0.05, h: 0.3, d: 1.2, x: BUS_W / 2 + 0.01, y: 2.42, z: half - 1.6, tint: 0x2b2f33 },
    // バンパー。
    { w: BUS_W - 0.04, h: 0.34, d: 0.24, y: 0.5, z: half + 0.02, tint: TRIM },
    { w: BUS_W - 0.04, h: 0.34, d: 0.24, y: 0.52, z: -half - 0.02, tint: TRIM },
    // 灯火。
    { w: 0.38, h: 0.24, d: 0.1, x: 0.86, y: 0.98, z: half + 0.03, tint: LENS },
    { w: 0.38, h: 0.24, d: 0.1, x: -0.86, y: 0.98, z: half + 0.03, tint: LENS },
    { w: 0.34, h: 0.22, d: 0.1, x: 0.9, y: 1.06, z: -half - 0.03, tint: TAIL_LENS },
    { w: 0.34, h: 0.22, d: 0.1, x: -0.9, y: 1.06, z: -half - 0.03, tint: TAIL_LENS },
    // 乗降ドア。日本のバスは左（進行方向 +Z に対して +X）側に前後 2 枚。
    { w: 0.07, h: 1.96, d: 0.98, x: BUS_W / 2 - 0.01, y: 1.36, z: 2.5, tint: 0x484d52 },
    { w: 0.07, h: 1.96, d: 1.16, x: BUS_W / 2 - 0.01, y: 1.36, z: -0.6, tint: 0x484d52 },
  ];
  // 窓の間の柱。板 1 枚で左右同時に柱が立つ。
  for (let k = 0; k < 5; k++) {
    const z = -3.0 + k * 1.5;
    specs.push({ w: BUS_W + 0.05, h: 0.9, d: 0.12, y: 1.98, z });
  }
  const parts: Part[] = boxes(specs);
  // 車輪は前 2・後 2。実車は後輪 2 軸だが、三角形は輪 1 つ 24 枚なので絞る。
  for (const [z, r] of [[2.6, 0.47], [-2.35, 0.47]] as const) {
    for (const side of [1, -1] as const) {
      parts.push(...wheel({ x: side * (BUS_W / 2 - 0.13), y: r, z, r, width: 0.26, side, tyre: TYRE, hub: HUB }));
    }
  }
  return bake(parts);
}

export function busLampGeometry(): BufferGeometry {
  const half = BUS_LEN / 2;
  const specs: BoxSpec[] = [
    { w: 0.32, h: 0.2, d: 0.08, x: 0.86, y: 0.98, z: half + 0.06, tint: HEAD_LAMP },
    { w: 0.32, h: 0.2, d: 0.08, x: -0.86, y: 0.98, z: half + 0.06, tint: HEAD_LAMP },
    { w: 0.3, h: 0.2, d: 0.08, x: 0.9, y: 1.06, z: -half - 0.06, tint: TAIL_LAMP },
    { w: 0.3, h: 0.2, d: 0.08, x: -0.9, y: 1.06, z: -half - 0.06, tint: TAIL_LAMP },
    // 行先表示。夜の街でバスを見分ける一番の手がかり。
    { w: 1.6, h: 0.26, d: 0.05, y: 2.42, z: half + 0.04, tint: 0xffd489 },
    { w: 0.05, h: 0.24, d: 1.1, x: BUS_W / 2 + 0.03, y: 2.42, z: half - 1.6, tint: 0xffd489 },
  ];
  // 車内灯。窓 1 枚ずつに割る。帯 1 本で光らせると蛍光管が走っているように見える。
  for (let k = 0; k < 5; k++) {
    const z = -2.6 + k * 1.3;
    specs.push({ w: BUS_W + 0.01, h: 0.62, d: 0.95, y: 1.98, z, tint: CABIN_LAMP });
  }
  return mergeParts(boxes(specs));
}

export function busBeamSpec(): { z: number; width: number; length: number; y: number } {
  return { z: BUS_LEN / 2 + 0.2, width: BUS_W * 3.6, length: 14, y: 0.03 };
}

// ---- トラック --------------------------------------------------------------

const TRUCK_LEN = 6.6;
const TRUCK_W = 2.16;
/** トラックの全長・全幅 (m)。 */
export const TRUCK_BODY_M = TRUCK_LEN;
export const TRUCK_WIDTH_M = TRUCK_W;

/**
 * トラック。運転台と荷台を分ける。
 * 車体色は積荷の色なので、荷台とあおりに色が乗って「何を運んでいるか」が読める。
 * 運転台は変調を淡くして、積荷の色に染まりすぎないようにしてある。
 */
export function truckGeometry(): BufferGeometry {
  const half = TRUCK_LEN / 2;
  const specs: BoxSpec[] = [
    // シャシー。
    { w: TRUCK_W - 0.24, h: 0.26, d: TRUCK_LEN - 0.2, y: 0.66, tint: UNDER },
    // キャブ。
    { w: TRUCK_W, h: 1.56, d: 1.96, y: 1.36, z: half - 1.05, c: 0.07, wt: 0.96, tint: 0xf0f0f0 },
    // キャブの窓（前と側面）。
    { w: TRUCK_W - 0.1, h: 0.64, d: 0.08, y: 1.74, z: half - 0.08, rx: -0.1, tint: GLASS },
    { w: TRUCK_W + 0.03, h: 0.56, d: 1.15, y: 1.72, z: half - 1.1, tint: GLASS },
    // 屋根のバイザー。トラックらしさが出る。
    { w: TRUCK_W - 0.04, h: 0.12, d: 0.42, y: 2.16, z: half - 0.3, tint: 0xf0f0f0 },
    // 荷台の床。
    { w: TRUCK_W, h: 0.16, d: 4.1, y: 0.86, z: -1.15, tint: 0x9c9184 },
    // 鳥居（キャブ後ろの立ち板）。
    { w: TRUCK_W, h: 1.3, d: 0.12, y: 1.55, z: 0.94, tint: 0xf2f2f2 },
    // あおり 3 枚。ここに積荷の色が乗る。
    { w: 0.12, h: 0.84, d: 4.1, x: TRUCK_W / 2 - 0.06, y: 1.34, z: -1.15 },
    { w: 0.12, h: 0.84, d: 4.1, x: -(TRUCK_W / 2 - 0.06), y: 1.34, z: -1.15 },
    { w: TRUCK_W, h: 0.84, d: 0.12, y: 1.34, z: -3.14 },
    // 積荷（コンテナ）。あおりから少しだけ頭を出す。
    { w: TRUCK_W - 0.3, h: 0.9, d: 3.8, y: 1.4, z: -1.15, c: 0.05 },
    // バンパー・灯火。
    { w: TRUCK_W - 0.06, h: 0.34, d: 0.24, y: 0.5, z: half + 0.02, tint: TRIM },
    { w: 0.36, h: 0.22, d: 0.1, x: 0.78, y: 0.92, z: half + 0.03, tint: LENS },
    { w: 0.36, h: 0.22, d: 0.1, x: -0.78, y: 0.92, z: half + 0.03, tint: LENS },
    { w: 0.3, h: 0.2, d: 0.1, x: 0.84, y: 0.98, z: -half - 0.02, tint: TAIL_LENS },
    { w: 0.3, h: 0.2, d: 0.1, x: -0.84, y: 0.98, z: -half - 0.02, tint: TAIL_LENS },
    // 車幅灯（キャブ上）。
    { w: 0.14, h: 0.1, d: 0.08, x: 0.7, y: 2.22, z: half - 0.34, tint: AMBER_LENS },
    { w: 0.14, h: 0.1, d: 0.08, x: -0.7, y: 2.22, z: half - 0.34, tint: AMBER_LENS },
    ...mirrors(1.24, 1.86, half - 0.1),
  ];
  const parts: Part[] = boxes(specs);
  // 前 2 輪・後 4 輪（後軸は 2 輪を並べてダブルタイヤに見せる）。
  const r = 0.46;
  for (const z of [half - 1.05, -1.4, -2.55]) {
    for (const side of [1, -1] as const) {
      parts.push(...wheel({ x: side * (TRUCK_W / 2 - 0.16), y: r, z, r, width: 0.26, side, tyre: TYRE, hub: HUB }));
    }
  }
  return bake(parts);
}

export function truckLampGeometry(): BufferGeometry {
  const half = TRUCK_LEN / 2;
  return mergeParts(
    boxes([
      { w: 0.3, h: 0.18, d: 0.08, x: 0.78, y: 0.92, z: half + 0.06, tint: HEAD_LAMP },
      { w: 0.3, h: 0.18, d: 0.08, x: -0.78, y: 0.92, z: half + 0.06, tint: HEAD_LAMP },
      { w: 0.26, h: 0.18, d: 0.08, x: 0.84, y: 0.98, z: -half - 0.05, tint: TAIL_LAMP },
      { w: 0.26, h: 0.18, d: 0.08, x: -0.84, y: 0.98, z: -half - 0.05, tint: TAIL_LAMP },
      { w: 0.12, h: 0.09, d: 0.07, x: 0.7, y: 2.22, z: half - 0.3, tint: 0xffa63c },
      { w: 0.12, h: 0.09, d: 0.07, x: -0.7, y: 2.22, z: half - 0.3, tint: 0xffa63c },
      { w: TRUCK_W - 0.16, h: 0.42, d: 0.06, y: 1.72, z: half - 0.12, tint: 0x5a4526 },
    ]),
  );
}

export function truckBeamSpec(): { z: number; width: number; length: number; y: number } {
  return { z: TRUCK_LEN / 2 + 0.2, width: TRUCK_W * 3.6, length: 14, y: 0.03 };
}

// ---- 電車 ------------------------------------------------------------------

const L = TRAIN_CAR_LENGTH_M;
const TRAIN_W = 2.9;
/** 電車の全幅 (m)。接地影の大きさを決めるのに使う。 */
export const TRAIN_WIDTH_M = TRAIN_W;
/** 車体の帯。`theme.ts` の TRAIN_HEAD_COLOR を車体色で割った変調係数。 */
const TRAIN_STRIPE = 0x4a76a8;
const ROOF = 0xbfc4c9;
const EQUIP = 0x8b9096;

/**
 * 電車 1 両。原点はレール面（車輪の下端）に置く。
 *
 * 台車を y<0 に出しているので、線路のバラストに車体が沈まずに載る。
 * 先頭車と中間車を作り分けると、3 両が並んだときに「編成」に見える。
 * 屋根のクーラーとパンタグラフは、日本の通勤電車を電車らしく見せている
 * 一番の要素なので、車体の造形より先に入れる価値がある。
 */
function trainCommon(): Part[] {
  const specs: BoxSpec[] = [
    // 床下機器。
    { w: TRAIN_W - 0.2, h: 0.6, d: L * 0.9, y: 0.3, tint: UNDER },
    // 車体。
    { w: TRAIN_W, h: 2.72, d: L, y: 2.0, c: 0.1, wt: 0.98 },
    // 側面の窓の帯。
    { w: TRAIN_W + 0.04, h: 0.94, d: L - 2.4, y: 2.62, tint: GLASS },
    // 戸袋と窓柱。20m 級の車体に 1 本の黒い帯だけだと、真横から見た編成が
    // 「黒い線の入った長い箱」にしかならない。4 本立てると扉と窓の割付が読める。
    ...pillars(TRAIN_W + 0.04, 2.62, 0.96, [6.0, 2.0, -2.0, -6.0]),
    // 帯（ラインカラー）。腰の高さに 1 本通す。
    { w: TRAIN_W + 0.05, h: 0.3, d: L, y: 1.3, tint: TRAIN_STRIPE },
    // 屋根。上をすぼめて丸屋根にする。
    { w: TRAIN_W - 0.14, h: 0.42, d: L, y: 3.52, c: 0.12, wt: 0.78, tint: ROOF },
  ];
  // ドア（片側 4 枚 ×2 = 板 4 枚で両側同時）。窓帯を分断して「窓とドアの繰り返し」を作る。
  for (let k = 0; k < 4; k++) {
    const z = (k - 1.5) * 4.3;
    specs.push({ w: TRAIN_W + 0.06, h: 2.0, d: 1.3, y: 2.2, z, tint: 0xd2d6da });
    specs.push({ w: TRAIN_W + 0.07, h: 0.8, d: 1.0, y: 2.72, z, tint: GLASS });
  }
  // 屋根上のクーラー。
  for (let k = 0; k < 3; k++) {
    specs.push({ w: 1.5, h: 0.26, d: 1.9, y: 3.78, z: (k - 1) * 5.6, c: 0.05, tint: EQUIP });
  }
  const parts: Part[] = boxes(specs);
  // パンタグラフ。台枠 → 下枠 → 上枠 → すり板。
  const pz = -L * 0.33;
  parts.push(
    ...boxes([
      { w: 1.9, h: 0.1, d: 0.5, y: 3.78, z: pz, tint: EQUIP },
      { w: 1.5, h: 0.07, d: 0.1, y: 4.62, z: pz + 0.72, tint: EQUIP },
    ]),
    strut(0.55, 3.82, pz - 0.15, 0.32, 4.6, pz + 0.7, 0.045, EQUIP),
    strut(-0.55, 3.82, pz - 0.15, -0.32, 4.6, pz + 0.7, 0.045, EQUIP),
    strut(0.55, 3.82, pz + 0.15, 0.32, 4.6, pz + 0.7, 0.045, EQUIP),
    strut(-0.55, 3.82, pz + 0.15, -0.32, 4.6, pz + 0.7, 0.045, EQUIP),
  );
  // 台車。枠と車軸（左右を貫く 1 本の筒で 2 輪ぶんを兼ねる）。
  for (const bz of [L * 0.29, -L * 0.29]) {
    parts.push(...boxes([{ w: 2.3, h: 0.62, d: 2.9, y: -0.03, z: bz, tint: 0x2b2f33 }]));
    for (const wz of [bz + 0.95, bz - 0.95]) {
      parts.push(
        prism({ r: 0.43, len: 2.1, seg: 8, axis: 'x', y: -0.12, z: wz, caps: 'none', tint: 0x1e2124 }),
      );
    }
  }
  return parts;
}

/** 先頭車の顔。前面ガラス・前照灯・尾灯・スカート。 */
function trainFace(zSign: 1 | -1): Part[] {
  const z = (zSign * L) / 2;
  const specs: BoxSpec[] = [
    // 前面ガラス。わずかに傾ける。
    { w: TRAIN_W - 0.5, h: 1.16, d: 0.1, y: 2.72, z: z - zSign * 0.03, rx: zSign * 0.12, tint: GLASS },
    // 種別・行先表示。
    { w: 1.3, h: 0.3, d: 0.07, y: 3.42, z: z - zSign * 0.02, tint: 0x2b2f33 },
    // 前照灯・尾灯。実車と同じく前照灯は下、尾灯はその外側。
    { w: 0.4, h: 0.26, d: 0.12, x: 1.0, y: 1.62, z: z - zSign * 0.02, tint: LENS },
    { w: 0.4, h: 0.26, d: 0.12, x: -1.0, y: 1.62, z: z - zSign * 0.02, tint: LENS },
    { w: 0.22, h: 0.22, d: 0.1, x: 1.24, y: 2.06, z: z - zSign * 0.02, tint: TAIL_LENS },
    { w: 0.22, h: 0.22, d: 0.1, x: -1.24, y: 2.06, z: z - zSign * 0.02, tint: TAIL_LENS },
    // スカート（排障器）。
    { w: 2.3, h: 0.66, d: 0.4, y: 0.9, z: z - zSign * 0.12, tint: EQUIP },
    // 連結器。
    { w: 0.4, h: 0.28, d: 0.5, y: 0.75, z: z + zSign * 0.16, tint: 0x3a3e42 },
  ];
  return boxes(specs);
}

/** 幌（車両どうしの繋ぎ）。編成に見せるにはここが要る。 */
function trainGangway(zSign: 1 | -1): Part[] {
  const z = (zSign * L) / 2;
  return boxes([
    { w: 1.5, h: 2.1, d: 0.7, y: 2.1, z: z + zSign * 0.3, tint: 0x33373b },
  ]);
}

/**
 * 車両の種別。1 = 先頭車（+Z 側に顔）、0 = 中間車、-1 = 最後尾（-Z 側に顔）。
 *
 * 最後尾を「先頭車を 180 度回したもの」で済ませると、後ろ向きに前照灯が点く。
 * 顔を作る向きを引数にして、幌の付く側だけを入れ替えるほうが安く正しい。
 */
export type TrainFace = 1 | 0 | -1;

export function trainGeometry(face: TrainFace): BufferGeometry {
  const parts = trainCommon();
  if (face === 1) parts.push(...trainFace(1), ...trainGangway(-1));
  else if (face === -1) parts.push(...trainFace(-1), ...trainGangway(1));
  else parts.push(...trainGangway(1), ...trainGangway(-1));
  return bake(parts);
}

/** 客室灯。窓の割りに合わせて灯すと、走っている車内の連なりに見える。 */
export function trainLampGeometry(face: TrainFace): BufferGeometry {
  const specs: BoxSpec[] = [];
  const n = 10;
  for (let k = 0; k < n; k++) {
    const z = (k - (n - 1) / 2) * ((L - 1.6) / n);
    specs.push({ w: TRAIN_W + 0.02, h: 0.72, d: ((L - 1.6) / n) * 0.72, y: 2.62, z, tint: CABIN_LAMP });
  }
  if (face !== 0) {
    const z = (face * (L / 2 + 0.04));
    if (face === 1) {
      // 進行方向の先頭。前照灯・種別表示・運転室の弱い灯り。
      specs.push(
        { w: 0.34, h: 0.2, d: 0.08, x: 1.0, y: 1.62, z, tint: HEAD_LAMP },
        { w: 0.34, h: 0.2, d: 0.08, x: -1.0, y: 1.62, z, tint: HEAD_LAMP },
        { w: 1.2, h: 0.24, d: 0.05, y: 3.42, z, tint: 0xd8e4ff },
        { w: TRAIN_W - 0.6, h: 0.9, d: 0.05, y: 2.72, z: z - 0.02, tint: 0x4a5a3a },
      );
    } else {
      // 最後尾は尾灯。編成の向きが夜でも読める。
      specs.push(
        { w: 0.24, h: 0.22, d: 0.08, x: 1.24, y: 2.06, z, tint: TAIL_LAMP },
        { w: 0.24, h: 0.22, d: 0.08, x: -1.24, y: 2.06, z, tint: TAIL_LAMP },
        { w: 1.2, h: 0.24, d: 0.05, y: 3.42, z, tint: 0xd8e4ff },
      );
    }
  }
  return mergeParts(boxes(specs));
}

export function trainBeamSpec(): { z: number; width: number; length: number; y: number } {
  // 原点はレール面。光の板は枕木のすぐ上（バラストに埋めない）。
  return { z: L / 2 + 2, width: 7.0, length: 30, y: -0.1 };
}
