import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  Euler,
  LinearFilter,
  Matrix4,
  Quaternion,
  RGBAFormat,
  Vector3,
} from 'three';
import { applyVerticalAO, mergeParts, type Part } from './materials';
import { CURB_COLOR, GUTTER_APRON_COLOR, GUTTER_COLOR, WALKWAY_COLOR } from './groundPalette';

/**
 * 街路の小物。
 *
 * 日本の街路を日本の街路たらしめているのは、道路の幅でも建物でもなく、
 * **電柱・電線・街灯・カーブミラー・自販機** といった雑多な立ち物の密度だと思う。
 * 建物だけを作り込んでも「どこかの国の街」にしかならない。
 *
 * どれも数千個置くので、部品はすべて `mergeParts` で 1 つのジオメトリに焼き、
 * 種類ごとに InstancedMesh 1 つで描く。実寸（m）で作ってあるので、
 * 置くときの拡大率は 1 のまま（向きだけ Y 回転で変える）。
 */

const q = new Quaternion();
const e = new Euler();
const v = new Vector3();
const s = new Vector3(1, 1, 1);

function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Matrix4 {
  e.set(rx, ry, rz);
  q.setFromEuler(e);
  return new Matrix4().compose(v.set(x, y, z), q, s.set(1, 1, 1));
}

/** 底面 y=0 の直方体。 */
function box(sx: number, sy: number, sz: number): BufferGeometry {
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(0, sy / 2, 0);
  return g;
}

/** 底面 y=0 の円柱（ポール）。 */
function post(rBottom: number, rTop: number, h: number, sides = 6): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBottom, h, sides, 1, false);
  g.translate(0, h / 2, 0);
  return g;
}

// ---------------------------------------------------------------------------
// 街灯
// ---------------------------------------------------------------------------

/** 街灯の灯具の高さ (m)。光の板の広がりを決めるのに roadLayer からも参照する。 */
export const LAMP_HEAD_Y = 5.8;
/** 灯具の道路側への張り出し (m)。+X 方向に出す（置くときに回す）。 */
export const LAMP_ARM_X = 1.5;

const POLE_METAL = 0x8e9298;
const POLE_CONCRETE = 0xa8a49c;
const DARK_METAL = 0x55585c;

/**
 * 街灯（本体）。灯具は別メッシュにするので、ここには含めない。
 *
 * 支柱をまっすぐ立てて、上端からアームを道路側へ伸ばす。
 * アームをわずかに反らせる（2 段に折る）だけで、
 * まっすぐな L 字より「見たことのある街灯」に近づく。
 */
export function streetLampGeometry(): BufferGeometry {
  const parts: Part[] = [
    // 基礎（コンクリートの根巻き）
    { geom: box(0.36, 0.16, 0.36), color: 0x9c9890, matrix: at(0, 0, 0) },
    { geom: post(0.11, 0.075, LAMP_HEAD_Y, 6), color: POLE_METAL, matrix: at(0, 0.12, 0) },
    // アーム 2 段（斜め → 水平）
    { geom: post(0.055, 0.05, 0.7, 5), color: POLE_METAL, matrix: at(0, LAMP_HEAD_Y - 0.35, 0, 0, 0, -0.85) },
    { geom: post(0.05, 0.045, 0.95, 5), color: POLE_METAL, matrix: at(0.52, LAMP_HEAD_Y + 0.12, 0, 0, 0, -1.35) },
    // 灯具のケース（発光部は lampHeadGeometry 側）
    { geom: box(0.5, 0.1, 0.26), color: DARK_METAL, matrix: at(LAMP_ARM_X, LAMP_HEAD_Y + 0.34, 0) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.66, 1.06, 1.5);
}

/**
 * 街灯の発光部。夜だけ表示する（発光材質で描くので昼は浮く）。
 *
 * 実際の灯具の発光面より一回り大きく作ってある。夜景で街灯が
 * 「点の列」として読めるかどうかは、路面の光より灯具そのものの
 * 見え方で決まるのに、実寸だと遠景で 1 画素未満に潰れてしまう。
 */
export function lampHeadGeometry(): BufferGeometry {
  const g = box(0.62, 0.2, 0.34);
  g.translate(LAMP_ARM_X, LAMP_HEAD_Y + 0.2, 0);
  return g;
}

// ---------------------------------------------------------------------------
// 電柱
// ---------------------------------------------------------------------------

/** 電柱の高さ (m) と、腕金の高さ。電線を張るときに roadLayer から使う。 */
export const POLE_HEIGHT = 9.2;
export const ARM_Y = [8.75, 8.15] as const;
/** 腕金の半長 (m)。電線はこの左右に張る。 */
export const ARM_HALF = 0.95;

/**
 * 電柱。コンクリート柱に腕金 2 段、柱上変圧器、そして足元の支線。
 *
 * 日本の電柱がそれらしく見える鍵は「柱上変圧器（灰色の樽）」で、
 * これが付いていないと、ただの棒になる。数本に 1 本だけ付ける
 * ——のが正しいが、ジオメトリを分けると描画が増えるので、
 * ここでは全部に付けたうえで数を絞る。
 */
export function utilityPoleGeometry(): BufferGeometry {
  const parts: Part[] = [
    { geom: post(0.17, 0.1, POLE_HEIGHT, 7), color: POLE_CONCRETE, matrix: at(0, 0, 0) },
    // 腕金（X 方向に伸びる）
    { geom: box(ARM_HALF * 2, 0.07, 0.09), color: DARK_METAL, matrix: at(0, ARM_Y[0], 0) },
    { geom: box(ARM_HALF * 1.6, 0.07, 0.09), color: DARK_METAL, matrix: at(0, ARM_Y[1], 0) },
    // 碍子（白い豆粒。これがあると腕金が「電気の設備」に見える）
    { geom: box(0.09, 0.13, 0.09), color: 0xd8d4cc, matrix: at(-ARM_HALF * 0.82, ARM_Y[0] + 0.07, 0) },
    { geom: box(0.09, 0.13, 0.09), color: 0xd8d4cc, matrix: at(0, ARM_Y[0] + 0.07, 0) },
    { geom: box(0.09, 0.13, 0.09), color: 0xd8d4cc, matrix: at(ARM_HALF * 0.82, ARM_Y[0] + 0.07, 0) },
    // 柱上変圧器
    { geom: post(0.29, 0.29, 0.78, 8), color: 0x9aa0a4, matrix: at(0.34, 6.5, 0) },
    { geom: box(0.14, 0.5, 0.12), color: DARK_METAL, matrix: at(0.18, 6.6, 0) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.62, 1.05, 1.6);
}

// ---------------------------------------------------------------------------
// 防護柵・標識まわり
// ---------------------------------------------------------------------------

/** ガードレール 1 区間の長さ (m)。Z 方向に伸びる。 */
export const GUARDRAIL_LEN = 5;

/** ガードレール。支柱 2 本と、白い波形ビーム。 */
export function guardrailGeometry(): BufferGeometry {
  const parts: Part[] = [];
  for (const z of [-GUARDRAIL_LEN / 2 + 0.4, 0, GUARDRAIL_LEN / 2 - 0.4]) {
    parts.push({ geom: post(0.06, 0.06, 0.72, 5), color: 0x9a9d9f, matrix: at(0, 0, z) });
  }
  // ビームは 2 枚重ねて、断面の折れ（W 型）を暗示する
  parts.push({ geom: box(0.06, 0.16, GUARDRAIL_LEN), color: 0xd2d0c8, matrix: at(0, 0.5, 0) });
  parts.push({ geom: box(0.05, 0.1, GUARDRAIL_LEN), color: 0xb6b4ac, matrix: at(0.01, 0.42, 0) });
  return applyVerticalAO(mergeParts(parts), 0.72, 1.05, 1.4);
}

/** カーブミラー。橙の枠と、空を映す灰色の鏡面。 */
export function curveMirrorGeometry(): BufferGeometry {
  const disc = new CylinderGeometry(0.52, 0.52, 0.07, 12);
  disc.rotateX(Math.PI / 2);
  const face = new CylinderGeometry(0.45, 0.45, 0.09, 12);
  face.rotateX(Math.PI / 2);
  const parts: Part[] = [
    { geom: post(0.07, 0.055, 3.1, 6), color: 0xb0b4b8, matrix: at(0, 0, 0) },
    { geom: disc, color: 0xe07b2a, matrix: at(0, 3.15, 0.06) },
    { geom: face, color: 0xb8c2c8, matrix: at(0, 3.15, 0.01) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.7, 1.06, 1.5);
}

/** 道路標識。青地の案内標識と、赤白の規制標識を 1 本の柱にまとめる。 */
export function roadSignGeometry(): BufferGeometry {
  const round = new CylinderGeometry(0.31, 0.31, 0.06, 12);
  round.rotateX(Math.PI / 2);
  const parts: Part[] = [
    { geom: post(0.055, 0.05, 2.5, 6), color: 0xa8acb0, matrix: at(0, 0, 0) },
    { geom: box(0.9, 0.42, 0.05), color: 0x2f5fa0, matrix: at(0, 2.05, 0) },
    { geom: round, color: 0xc0392b, matrix: at(0, 1.45, 0.02) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.72, 1.06, 1.5);
}

/**
 * 自動販売機。
 *
 * 日本の街路のもう 1 つの記号。夜に光るので、暗い住宅街の中で
 * 「そこに道がある」ことを示す点光源にもなる。
 */
export function vendingMachineGeometry(): BufferGeometry {
  const parts: Part[] = [
    { geom: box(1.1, 1.95, 0.75), color: 0x2f3236, matrix: at(0, 0, 0) },
    // 商品見本のパネル（正面 = +Z）
    { geom: box(0.94, 1.05, 0.06), color: 0xd8452f, matrix: at(0, 0.72, 0.37) },
    { geom: box(0.94, 0.3, 0.06), color: 0x2f3236, matrix: at(0, 0.36, 0.38) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.6, 1.05, 1.7);
}

/** 自販機の発光面（夜だけ表示）。 */
export function vendingGlowGeometry(): BufferGeometry {
  const g = box(0.9, 1.0, 0.04);
  g.translate(0, 0.75, 0.41);
  return g;
}

/** バス停。標柱と時刻表、ベンチ。上屋までは作らない（数が多いので）。 */
export function busStopGeometry(): BufferGeometry {
  const plate = new CylinderGeometry(0.36, 0.36, 0.07, 12);
  plate.rotateX(Math.PI / 2);
  const parts: Part[] = [
    { geom: post(0.06, 0.055, 2.5, 6), color: 0xb4b8bc, matrix: at(0, 0, 0) },
    { geom: plate, color: 0xe8e4d8, matrix: at(0, 2.45, 0.02) },
    { geom: box(0.34, 0.5, 0.05), color: 0x3f4650, matrix: at(0, 1.5, 0.04) },
    // ベンチ
    { geom: box(1.5, 0.08, 0.36), color: 0x8a7358, matrix: at(0.95, 0.42, 0) },
    { geom: box(0.08, 0.42, 0.3), color: 0x9a9ea2, matrix: at(0.32, 0, 0) },
    { geom: box(0.08, 0.42, 0.3), color: 0x9a9ea2, matrix: at(1.58, 0, 0) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.68, 1.05, 1.5);
}

// ---------------------------------------------------------------------------
// 歩道の断面
// ---------------------------------------------------------------------------

/**
 * 歩道 1 区間。**X = 道路に対する横断方向（-X が車道側）、Z = 道路に沿う方向**の
 * 単位ジオメトリ（1×1×1、底面 y=0）。置くときに幅・高さ・長さで拡大する。
 *
 * 縁石・側溝・平板をここに焼き込んでしまうのが要点。別メッシュにすると
 * ドローコールが 3 つ増えるうえ、幅の違う道路ごとに位置を合わせ直すことになる。
 * 1 つの断面にしておけば「歩道を置く」だけで縁石も側溝も付いてくる。
 */
export function walkwaySectionGeometry(): BufferGeometry {
  const parts: Part[] = [
    // --- 車道側から順に ---
    // (1) L 型側溝の平部。車道と同じ高さから 5cm ほど立ち上がるコンクリート。
    //     ここが 1 段目。以前は「暗い帯（グレーチング）」を 1 枚置いただけで、
    //     断面が縁石の 1 段しか無く、遠目には板を置いたのと変わらなかった。
    { geom: box(0.3, 0.26, 1), color: GUTTER_APRON_COLOR, matrix: at(-0.62, 0, 0) },
    // (2) 側溝の目地。1 段目と縁石の間に走る細い暗がり。
    //     この線 1 本があるだけで、断面が「2 段」に読めるようになる。
    { geom: box(0.07, 0.3, 1), color: GUTTER_COLOR, matrix: at(-0.475, 0, 0) },
    // (3) 縁石。2 段目。車道側の面が日陰になり、上端に光の線が乗る。
    { geom: box(0.16, 1.06, 1), color: CURB_COLOR, matrix: at(-0.37, 0, 0) },
    // (4) 歩道の平板。縁石の上端より 4cm 低い。ここに段差があると、
    //     縁石が「歩道と一体の板」ではなく別の部材に見える。
    { geom: box(0.72, 0.96, 1), color: WALKWAY_COLOR, matrix: at(0.14, 0, 0) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.55, 1.05, 1.2);
}

/** 交差点の隅に置く歩道（縁石を 2 辺に回す必要があるので、平板だけの簡易版）。 */
export function walkwayCornerGeometry(): BufferGeometry {
  const parts: Part[] = [
    { geom: box(1, 1, 1), color: WALKWAY_COLOR, matrix: at(0, 0, 0) },
    { geom: box(1.04, 1.04, 0.16), color: CURB_COLOR, matrix: at(0, 0, -0.42) },
    { geom: box(0.16, 1.04, 1.04), color: CURB_COLOR, matrix: at(-0.42, 0, 0) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.55, 1.05, 1.2);
}

// ---------------------------------------------------------------------------
// 路面に落ちる光
// ---------------------------------------------------------------------------

/**
 * 街灯が路面に落とす光の円板に貼るテクスチャ。
 *
 * 本物のライトを数百個置くとフォワードレンダリングでは
 * 1 メッシュあたりのライト数が爆発して描画が止まる。かわりに
 * 「路面に加算合成の板を敷く」。物理的には嘘だが、夜の絵で
 * 効いているのは結局この明るい楕円なので、見た目はほぼ同じになる。
 *
 * 中心が明るく外へ二乗で落ちる円。DOM の canvas に依存しないよう
 * DataTexture で直接作る（テストや Worker でも動く）。
 */
export function lightPoolTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.sqrt(dx * dx + dy * dy);
      // 中心が明るく、外へ急に落ちる。
      //
      // 以前は裾を長く引いていた（`a*a*(0.45+0.55*a)`）。裾が長いと隣の街灯の
      // 光と足し合わさって、街路が「切れ目のない発光する帯」になる。
      // 実際の街灯は灯具の真下がいちばん明るく、10m も離れれば目に見えて暗い。
      // 4 乗に近い落ち方にすると、灯の下だけが明るいプールになる。
      const a = Math.max(0, 1 - r);
      const v2 = a * a * (0.18 + 0.82 * a * a);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, v2) * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
