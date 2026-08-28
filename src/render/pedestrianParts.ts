import { BufferGeometry } from 'three';
import { applyVerticalAO, mergeParts, type Part } from './materials';
import { boxes, prism, type BoxSpec } from './parts';

/**
 * 人の造形。
 *
 * これまで人は「0.55 × 1.75 × 0.35 の箱」1 つだった。街に人がいることは
 * 分かっても、路上に降りると立て看板が滑っていくようにしか見えない。
 *
 * 人は最大 4000 人が同時に出るので、三角形の予算がいちばん厳しい。
 * ここでは 1 人 160 三角形（胴 84 + 手足 2 × 36）に収め、
 * さらに遠景・立ち止まっている人は 48 三角形の簡易形に落とす。
 *
 * 歩きを見せるために、手足を**胴とは別のインスタンスメッシュ**に分ける。
 * InstancedMesh は 1 インスタンス 1 行列なので、1 つのメッシュの中で
 * 部品ごとに違う角度を付けることができないため。
 *
 * 分け方は「左脚 + 右腕」「右脚 + 左腕」の 2 つ。人は歩くとき対角の手足が
 * 同じ向きに出るので、この 2 組がそれぞれ 1 つの剛体として振れればよい。
 * 回転の軸は股関節と肩関節の中間（y = `LIMB_PIVOT_Y`）に置く。
 * 本当は関節ごとに軸が違うが、中間に置けば股も肩も最大でも 10cm ほどしか
 * ずれず、街を歩く人の大きさ（画面上 数十 px）では読み取れない。
 * メッシュを 4 つに割って正確にやるより、ドローコール 2 つで済むほうが得。
 */

/** 手足の回転の中心（足元からの高さ, m）。 */
export const LIMB_PIVOT_Y = 1.06;
/** 身長 (m)。 */
export const PED_HEIGHT = 1.7;

/** 肌。衣服の色（instanceColor）に掛かるので、明るめに置いて顔が沈まないようにする。 */
const SKIN = 0xffd9bc;
/** 髪。 */
const HAIR = 0x2a2724;
/** ズボン・靴。上衣より暗くして上下を分ける。 */
const TROUSERS = 0x585f68;
const SHOE = 0x2e3136;
/** 鞄。 */
const BAG = 0x6b5a48;

/** 胴（頭・首・胸・腰・鞄）。腕と脚は持たない。 */
export function bodyGeometry(): BufferGeometry {
  const specs: BoxSpec[] = [
    // 腰。
    { w: 0.33, h: 0.24, d: 0.21, y: 0.98, tint: TROUSERS },
    // 胸。肩に向かって広がる。
    { w: 0.36, h: 0.46, d: 0.23, y: 1.33, wt: 1.14 },
    // 首。
    { w: 0.11, h: 0.09, d: 0.11, y: 1.6, tint: SKIN },
    // 髪（頭の上半分を覆う）。
    { w: 0.2, h: 0.11, d: 0.21, y: 1.75, tint: HAIR },
    // 肩掛け鞄。全員が持つことになるが、小さいので「街の人」の情報量として効く。
    { w: 0.09, h: 0.22, d: 0.17, x: 0.21, y: 1.16, tint: BAG },
  ];
  const parts: Part[] = boxes(specs);
  // 頭。6 角柱にすると箱より丸く、三角形は 24 枚で済む。
  parts.push(prism({ r: 0.105, len: 0.23, seg: 6, axis: 'y', y: 1.68, caps: 'both', tint: SKIN }));
  const g = mergeParts(parts);
  applyVerticalAO(g, 0.78, 1.06, 1.4);
  return g;
}

/**
 * 手足 1 組（片脚 + 反対側の腕）。原点を `LIMB_PIVOT_Y` に置いてあるので、
 * そのまま X 軸まわりに回せば前後に振れる。
 * @param side +1 で右脚 + 左腕、-1 で左脚 + 右腕。
 */
export function limbGeometry(side: 1 | -1): BufferGeometry {
  const specs: BoxSpec[] = [
    // 脚（腿から脛まで 1 本。下に向かって細くする）。
    { w: 0.14, h: 0.94, d: 0.16, x: side * 0.09, y: 0.5 - LIMB_PIVOT_Y, tint: TROUSERS, hb: 1, wb: 1, wt: 1.06 },
    // 靴。
    { w: 0.12, h: 0.07, d: 0.25, x: side * 0.09, y: 0.035 - LIMB_PIVOT_Y, z: 0.03, tint: SHOE },
    // 反対側の腕。
    { w: 0.1, h: 0.54, d: 0.12, x: -side * 0.235, y: 1.24 - LIMB_PIVOT_Y },
    // 手。
    { w: 0.09, h: 0.1, d: 0.1, x: -side * 0.235, y: 0.94 - LIMB_PIVOT_Y, tint: SKIN },
  ];
  const g = mergeParts(boxes(specs));
  // 足元だけ落とす。原点が腰なので、AO の基準は手足の下端になる。
  applyVerticalAO(g, 0.72, 1.04, 1.3);
  return g;
}

/**
 * 遠景・立ち止まっている人の簡易形。
 * 胴と 2 本の脚を 1 つに焼き固めた 48 三角形。
 * 手足を振る必要が無いので、インスタンスも行列も 1 つで済む。
 */
export function simpleGeometry(): BufferGeometry {
  const specs: BoxSpec[] = [
    { w: 0.3, h: 0.92, d: 0.19, y: 0.46, tint: TROUSERS, wt: 1.06 },
    { w: 0.38, h: 0.52, d: 0.23, y: 1.2, wt: 1.1 },
    { w: 0.2, h: 0.26, d: 0.2, y: 1.6, tint: SKIN },
    { w: 0.21, h: 0.12, d: 0.21, y: 1.76, tint: HAIR },
  ];
  const g = mergeParts(boxes(specs));
  applyVerticalAO(g, 0.7, 1.06, 1.4);
  return g;
}
