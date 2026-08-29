import { BoxGeometry, BufferAttribute, BufferGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { chamferedBox, type Part } from './materials';

/**
 * 車両・人・線路を組み立てるための低ポリ部品。
 *
 * `materials.ts` の `chamferedBox` は「単位立方体を面取りする」ので、
 * 4.3m × 1.7m のような細長い箱に使うと面取りが軸ごとに伸びてしまい、
 * 車のルーフだけ 10cm、全長方向は 30cm という不揃いな角になる。
 * ここでは**実寸の面取り**を持つ箱と、少ない三角形で丸く見えるプリズムを用意する。
 *
 * 三角形数を数えながら作れるようにしてあるのが肝。車は最大 3000 台、
 * 人は 4000 人が同時に出るので、1 体あたり数百三角形を超えると
 * すぐに数百万三角形になる。素の箱 12、面取り箱 44、8 角柱 24 を目安に、
 * 「シルエットを決める部品だけ面取りする」という配分で組む。
 */

/** 箱 1 つ。長辺（進行方向）は +Z に取る決まりにする。 */
export interface BoxSpec {
  w: number;
  h: number;
  d: number;
  x?: number;
  y?: number;
  z?: number;
  /** 回転 (rad)。傾いたフロントガラスやパンタグラフの腕に使う。 */
  rx?: number;
  ry?: number;
  rz?: number;
  /** 前端 (+Z) / 後端 (-Z) の幅の倍率。1 未満で「前が絞られた」形になる。 */
  wf?: number;
  wb?: number;
  /** 前端 / 後端の高さの倍率。 */
  hf?: number;
  hb?: number;
  /** 上面の幅の倍率。キャビンをすぼめるとガラスハウスらしくなる。 */
  wt?: number;
  /** 面取り量 (m)。0 で素の箱。 */
  c?: number;
  /** 変調色（頂点カラー）。 */
  tint?: number;
}

const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpVec = new Vector3();
const tmpMat = new Matrix4();

/**
 * 実寸の面取りを持つ箱。
 *
 * `chamferedBox` は座標が ±0.5 と ±(0.5-c) の 2 種類しか出てこないので、
 * 「外側の座標は半分の寸法へ、内側の座標は半分の寸法 − 面取り量へ」と
 * 読み替えるだけで、軸ごとに面取り量の揃った箱になる。
 */
function chamferedBoxWorld(w: number, h: number, d: number, c: number): BufferGeometry {
  const g = chamferedBox(0.2); // 内側の座標が ±0.3 に出る
  const pos = g.getAttribute('position') as BufferAttribute;
  const size = [w, h, d];
  const cut = [
    Math.min(c, w * 0.45),
    Math.min(c, h * 0.45),
    Math.min(c, d * 0.45),
  ];
  for (let i = 0; i < pos.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = pos.getComponent(i, a);
      const outer = Math.abs(v) > 0.4;
      pos.setComponent(i, a, Math.sign(v) * (size[a]! / 2 - (outer ? 0 : cut[a]!)));
    }
  }
  pos.needsUpdate = true;
  return g;
}

/** 台形化（前後の絞り・上すぼまり）を頂点に焼く。 */
function taper(g: BufferGeometry, s: BoxSpec): void {
  const wf = s.wf ?? 1;
  const wb = s.wb ?? 1;
  const hf = s.hf ?? 1;
  const hb = s.hb ?? 1;
  const wt = s.wt ?? 1;
  if (wf === 1 && wb === 1 && hf === 1 && hb === 1 && wt === 1) return;
  const pos = g.getAttribute('position') as BufferAttribute;
  const hh = s.h / 2;
  const hd = s.d / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = hd > 0 ? Math.max(-1, Math.min(1, z / hd)) : 0;
    const v = hh > 0 ? Math.max(-1, Math.min(1, y / hh)) : 0;
    const fz = t >= 0 ? 1 + (wf - 1) * t : 1 + (wb - 1) * -t;
    const ft = v > 0 ? 1 + (wt - 1) * v : 1;
    const fh = t >= 0 ? 1 + (hf - 1) * t : 1 + (hb - 1) * -t;
    pos.setXYZ(i, x * fz * ft, y * fh, z);
  }
  pos.needsUpdate = true;
}

/** 箱の部品を 1 つ作る。 */
export function box(s: BoxSpec): Part {
  const c = s.c ?? 0;
  const g = c > 0 ? chamferedBoxWorld(s.w, s.h, s.d, c) : new BoxGeometry(s.w, s.h, s.d);
  taper(g, s);
  if (s.rx || s.ry || s.rz) {
    tmpEuler.set(s.rx ?? 0, s.ry ?? 0, s.rz ?? 0, 'ZYX');
    tmpQuat.setFromEuler(tmpEuler);
    tmpMat.makeRotationFromQuaternion(tmpQuat);
    g.applyMatrix4(tmpMat);
  }
  g.translate(s.x ?? 0, s.y ?? 0, s.z ?? 0);
  g.computeVertexNormals();
  return { geom: g, color: s.tint };
}

/** 複数の箱をまとめて。 */
export function boxes(list: readonly BoxSpec[]): Part[] {
  return list.map(box);
}

export type Axis = 'x' | 'y' | 'z';

export interface PrismSpec {
  /** 半径。 */
  r: number;
  /** 反対側の半径（円錐台にしたいとき）。 */
  r2?: number;
  /** 軸方向の長さ。 */
  len: number;
  /** 角数。8 で十分丸く見える。 */
  seg?: number;
  axis?: Axis;
  x?: number;
  y?: number;
  z?: number;
  /** 蓋。'none' | 'pos'（+軸側）| 'neg' | 'both'。見えない側は塞がない。 */
  caps?: 'none' | 'pos' | 'neg' | 'both';
  /** 角の位相 (rad)。タイヤの見え方を車ごとに揃えたくないときに使う。 */
  phase?: number;
  tint?: number;
}

/**
 * n 角柱。タイヤ・柱・クーラー・レールの丸みに使う。
 *
 * `CylinderGeometry` を使わないのは、蓋を片側だけ塞ぐ・角数を切り詰めるといった
 * 「三角形を 1 枚単位で削る」調整ができないため。
 */
export function prism(s: PrismSpec): Part {
  const seg = s.seg ?? 8;
  const r1 = s.r;
  const r2 = s.r2 ?? s.r;
  const half = s.len / 2;
  const caps = s.caps ?? 'both';
  const phase = s.phase ?? 0;
  const tris: number[] = [];
  const axis = s.axis ?? 'y';
  // 軸ごとに (u, v, w) → (x, y, z) の並べ替えを決める。w が軸方向。
  const put = (u: number, v: number, w: number): void => {
    if (axis === 'y') tris.push(u, w, v);
    else if (axis === 'x') tris.push(w, u, v);
    else tris.push(u, v, w);
  };
  const cu = (k: number, r: number): [number, number] => {
    const a = phase + (k / seg) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  for (let k = 0; k < seg; k++) {
    const [x0, y0] = cu(k, r1);
    const [x1, y1] = cu(k + 1, r1);
    const [X0, Y0] = cu(k, r2);
    const [X1, Y1] = cu(k + 1, r2);
    // 側面（-w 側の半径 r1、+w 側の半径 r2）
    put(x0, y0, -half);
    put(x1, y1, -half);
    put(X1, Y1, half);
    put(x0, y0, -half);
    put(X1, Y1, half);
    put(X0, Y0, half);
    if (caps === 'pos' || caps === 'both') {
      put(0, 0, half);
      put(X1, Y1, half);
      put(X0, Y0, half);
    }
    if (caps === 'neg' || caps === 'both') {
      put(0, 0, -half);
      put(x0, y0, -half);
      put(x1, y1, -half);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
  g.translate(s.x ?? 0, s.y ?? 0, s.z ?? 0);
  g.computeVertexNormals();
  return { geom: g, color: s.tint };
}

/**
 * 車輪 1 つ。タイヤ（黒い筒）＋ホイール（外側の蓋）。
 *
 * 内側の蓋は車体に隠れるので張らない。8 角柱で 3 × 8 = 24 三角形。
 * 箱のタイヤと比べて三角形は倍になるが、車が「箱 + 黒い箱」から
 * 「輪の付いた車」に変わるので、ここは払う価値がある。
 */
export function wheel(opts: {
  x: number;
  y: number;
  z: number;
  r: number;
  width: number;
  /** 左右どちら側か（+1 で +X 側）。蓋を外に向ける。 */
  side: 1 | -1;
  seg?: number;
  tyre?: number;
  hub?: number;
}): Part[] {
  const seg = opts.seg ?? 8;
  const outer = opts.side > 0 ? 'pos' : 'neg';
  return [
    prism({
      r: opts.r,
      len: opts.width,
      seg,
      axis: 'x',
      x: opts.x,
      y: opts.y,
      z: opts.z,
      caps: 'none',
      phase: Math.PI / seg,
      tint: opts.tyre ?? 0x24262a,
    }),
    // ホイール面。タイヤより少しだけ外へ出して、光を拾う面を作る。
    prism({
      r: opts.r * 0.66,
      len: opts.width * 0.42,
      seg,
      axis: 'x',
      x: opts.x + opts.side * opts.width * 0.34,
      y: opts.y,
      z: opts.z,
      caps: outer,
      phase: Math.PI / seg,
      tint: opts.hub ?? 0xa8adb4,
    }),
  ];
}

/**
 * 2 点を結ぶ角柱（架線・遮断機の腕・斜めの筋交いなど）。
 * 端点を渡せるので、たわんだ架線を折れ線で近似するのが楽になる。
 */
export function strut(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  tint?: number,
  seg = 4,
): Part {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const p = prism({ r: radius, len: Math.max(len, 1e-4), seg, axis: 'y', caps: 'none', tint });
  tmpVec.set(dx / len, dy / len, dz / len);
  tmpQuat.setFromUnitVectors(UP, tmpVec);
  tmpMat.makeRotationFromQuaternion(tmpQuat);
  p.geom.applyMatrix4(tmpMat);
  p.geom.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  p.geom.computeVertexNormals();
  return p;
}

const UP = new Vector3(0, 1, 0);
