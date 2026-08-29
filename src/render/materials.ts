import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Material,
  MeshStandardMaterial,
  Matrix4,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 描画で共通に使う材質とジオメトリの部品。
 *
 * 方針は 3 つ。
 *
 * 1. **物理ベース（MeshStandardMaterial）に揃える。**
 *    Lambert は拡散反射しか持たないので、金属・ガラス・濡れたアスファルトが
 *    すべて「同じ質感の紙」になる。粗さと金属度を持たせるだけで、
 *    同じ形のままでも材質の違いが読めるようになる。
 *
 * 2. **角を落とす。** 現実の建物・車に「数学的に鋭い辺」は無い。
 *    1〜2 cm の面取りがあるだけでハイライトが線として乗り、
 *    箱がプラスチックの立方体ではなく「物」に見える。
 *
 * 3. **接地部を暗くする（頂点カラーによる擬似 AO）。**
 *    地面と壁が出会うところに影が溜まるのは、実写でもっとも強い手がかりの 1 つ。
 *    リアルタイム AO を積まなくても、頂点カラーで下方を落とすだけでかなり近づく。
 *    InstancedMesh の setColorAt（instanceColor）と頂点カラーは掛け算で合成されるので、
 *    「建物ごとの色 × 部位ごとの陰影」を 1 つのメッシュで両立できる。
 */

/** 標準的な不透明サーフェス。 */
export function surface(params: {
  color?: number;
  roughness?: number;
  metalness?: number;
  vertexColors?: boolean;
  emissive?: number;
  emissiveIntensity?: number;
  envMapIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  flatShading?: boolean;
  depthWrite?: boolean;
  toneMapped?: boolean;
}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: params.color ?? 0xffffff,
    roughness: params.roughness ?? 0.85,
    metalness: params.metalness ?? 0.04,
    vertexColors: params.vertexColors ?? false,
    emissive: params.emissive ?? 0x000000,
    emissiveIntensity: params.emissiveIntensity ?? 1,
    transparent: params.transparent ?? false,
    opacity: params.opacity ?? 1,
    flatShading: params.flatShading ?? false,
  });
  m.envMapIntensity = params.envMapIntensity ?? 1;
  if (params.depthWrite !== undefined) m.depthWrite = params.depthWrite;
  if (params.toneMapped !== undefined) m.toneMapped = params.toneMapped;
  return m;
}

/** ガラス面（オフィス・タワーの外皮）。反射が強く、粗さが低い。 */
export function glass(color = 0x8fa6b8, opts: { roughness?: number; metalness?: number } = {}): MeshStandardMaterial {
  const m = surface({
    color,
    roughness: opts.roughness ?? 0.12,
    metalness: opts.metalness ?? 0.62,
    vertexColors: true,
  });
  m.envMapIntensity = 1.6;
  return m;
}

/** 金属（車体・線路・設備）。 */
export function metal(color = 0xb8bcc2, roughness = 0.35): MeshStandardMaterial {
  const m = surface({ color, roughness, metalness: 0.85, vertexColors: true });
  m.envMapIntensity = 1.35;
  return m;
}

/**
 * 面取りした直方体。単位サイズ（1×1×1、中心が原点）で作り、
 * 必要なら呼び出し側で translate / scale する。
 *
 * 非 index の三角形スープにして flat な法線を出す。頂点を共有すると
 * 面取り部と平面が滑らかに繋がってしまい、ハイライトの線が消える。
 *
 * @param chamfer 面取り量（単位サイズに対する比）。0.02〜0.06 くらいが自然。
 */
export function chamferedBox(chamfer = 0.03): BufferGeometry {
  const c = Math.max(0.001, Math.min(0.45, chamfer));
  const h = 0.5;
  const i = h - c; // 面取りで引っ込んだ側の座標

  // 各コーナー (sx,sy,sz) に 3 頂点（X 面側・Y 面側・Z 面側）
  const vert = (sx: number, sy: number, sz: number, axis: 0 | 1 | 2): [number, number, number] => [
    sx * (axis === 0 ? h : i),
    sy * (axis === 1 ? h : i),
    sz * (axis === 2 ? h : i),
  ];

  const tris: [number, number, number][][] = [];
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c2: [number, number, number],
    d: [number, number, number],
  ): void => {
    tris.push([a, b, c2]);
    tris.push([a, c2, d]);
  };

  const signs: (-1 | 1)[] = [-1, 1];

  // 6 つの面（面取りで一回り小さい四角形）
  for (const axis of [0, 1, 2] as const) {
    for (const s of signs) {
      const corners: [number, number, number][] = [];
      for (const u of signs) {
        for (const v of signs) {
          const p: [number, number, number] = [0, 0, 0];
          p[axis] = s * h;
          const other = [0, 1, 2].filter((k) => k !== axis) as [number, number];
          p[other[0]] = u * i;
          p[other[1]] = v * i;
          corners.push(p);
        }
      }
      // corners は (-,-) (-,+) (+,-) (+,+) の順なので、四角形の周回順に並べ替える
      quad(corners[0]!, corners[1]!, corners[3]!, corners[2]!);
    }
  }

  // 12 の辺（面取りの帯）
  for (const axis of [0, 1, 2] as const) {
    const other = [0, 1, 2].filter((k) => k !== axis) as [number, number];
    for (const su of signs) {
      for (const sv of signs) {
        const ends: [number, number, number][][] = [];
        for (const s of signs) {
          const sxyz: [number, number, number] = [0, 0, 0];
          sxyz[axis] = s;
          sxyz[other[0]] = su;
          sxyz[other[1]] = sv;
          ends.push([
            vert(sxyz[0], sxyz[1], sxyz[2], other[0] as 0 | 1 | 2),
            vert(sxyz[0], sxyz[1], sxyz[2], other[1] as 0 | 1 | 2),
          ]);
        }
        quad(ends[0]![0]!, ends[0]![1]!, ends[1]![1]!, ends[1]![0]!);
      }
    }
  }

  // 8 の角（三角形）
  for (const sx of signs) {
    for (const sy of signs) {
      for (const sz of signs) {
        tris.push([vert(sx, sy, sz, 0), vert(sx, sy, sz, 1), vert(sx, sy, sz, 2)]);
      }
    }
  }

  // 巻き方向を外向きに揃える（凸形なので重心から外を向いていれば正しい）
  const pos = new Float32Array(tris.length * 9);
  let w = 0;
  for (const t of tris) {
    const a = t[0]!;
    const b = t[1]!;
    const c2 = t[2]!;
    const ux = b[0]! - a[0]!;
    const uy = b[1]! - a[1]!;
    const uz = b[2]! - a[2]!;
    const vx = c2[0]! - a[0]!;
    const vy = c2[1]! - a[1]!;
    const vz = c2[2]! - a[2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const cx = (a[0]! + b[0]! + c2[0]!) / 3;
    const cy = (a[1]! + b[1]! + c2[1]!) / 3;
    const cz = (a[2]! + b[2]! + c2[2]!) / 3;
    const flip = nx * cx + ny * cy + nz * cz < 0;
    const order = flip ? [a, c2, b] : [a, b, c2];
    for (const p of order) {
      pos[w++] = p[0]!;
      pos[w++] = p[1]!;
      pos[w++] = p[2]!;
    }
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return geom;
}

/** 底面が y=0 の面取り直方体（建物・車体の基本部品）。 */
export function chamferedUnitBox(chamfer = 0.03): BufferGeometry {
  const g = chamferedBox(chamfer);
  g.translate(0, 0.5, 0);
  return g;
}

/**
 * 高さ方向のグラデーションを頂点カラーに焼き込む（擬似 AO）。
 * ジオメトリの bounding box を基準に、下ほど暗くする。
 *
 * @param bottom 最下部の明るさ（1 で無変化）
 * @param top    最上部の明るさ
 * @param power  変化のカーブ。大きいほど「足元だけ」暗くなる
 */
export function applyVerticalAO(geom: BufferGeometry, bottom = 0.62, top = 1.06, power = 1.7): BufferGeometry {
  const pos = geom.getAttribute('position') as BufferAttribute;
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const y0 = bb.min.y;
  const span = Math.max(1e-6, bb.max.y - y0);
  const existing = geom.getAttribute('color') as BufferAttribute | undefined;
  const col = existing ?? new BufferAttribute(new Float32Array(pos.count * 3), 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(Math.max(0, Math.min(1, (pos.getY(i) - y0) / span)), 1 / power);
    const s = bottom + (top - bottom) * t;
    if (existing) {
      col.setXYZ(i, col.getX(i) * s, col.getY(i) * s, col.getZ(i) * s);
    } else {
      col.setXYZ(i, s, s, s);
    }
  }
  geom.setAttribute('color', col);
  return geom;
}

/** 頂点カラーを一律に掛ける（部品ごとの色分けに使う）。 */
export function tintGeometry(geom: BufferGeometry, color: number | Color): BufferGeometry {
  const c = color instanceof Color ? color : new Color(color);
  const pos = geom.getAttribute('position') as BufferAttribute;
  const existing = geom.getAttribute('color') as BufferAttribute | undefined;
  const col = existing ?? new BufferAttribute(new Float32Array(pos.count * 3), 3);
  for (let i = 0; i < pos.count; i++) {
    if (existing) col.setXYZ(i, col.getX(i) * c.r, col.getY(i) * c.g, col.getZ(i) * c.b);
    else col.setXYZ(i, c.r, c.g, c.b);
  }
  geom.setAttribute('color', col);
  return geom;
}

/** すべての部品が color 属性を持つように揃える（merge の前に必要）。 */
function ensureColor(geom: BufferGeometry): BufferGeometry {
  if (!geom.getAttribute('color')) tintGeometry(geom, 0xffffff);
  return geom;
}

export interface Part {
  geom: BufferGeometry;
  /** 部品の色（頂点カラーに焼き込む）。省略で白（＝インスタンス色そのまま）。 */
  color?: number | Color;
  /** 位置・回転・スケール。 */
  matrix?: Matrix4;
}

/**
 * 複数の部品を 1 つのジオメトリに焼き固める。
 *
 * 部品ごとにメッシュを分けるとドローコールが部品数だけ増える。
 * 逆に「1 つの箱」で済ませると造形が痩せる。焼き固めれば、
 * ドローコールを増やさずに何十個の部品からなる形が作れる。
 */
export function mergeParts(parts: Part[]): BufferGeometry {
  const geoms: BufferGeometry[] = [];
  for (const p of parts) {
    const g = ensureColor(p.geom.clone());
    if (p.color !== undefined) tintGeometry(g, p.color);
    if (p.matrix) g.applyMatrix4(p.matrix);
    // merge には属性の顔ぶれが揃っている必要がある
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'color' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.getAttribute('uv')) {
      const n = (g.getAttribute('position') as BufferAttribute).count;
      g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (g.index) geoms.push(g.toNonIndexed());
    else geoms.push(g);
  }
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  if (!merged) throw new Error('mergeParts: ジオメトリを結合できませんでした');
  return merged;
}

/** 位置・スケール（・Y 回転）から行列を作る簡易ヘルパ。 */
export function place(
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = sx,
  sz = sx,
  rotY = 0,
): Matrix4 {
  const m = new Matrix4();
  if (rotY !== 0) m.makeRotationY(rotY);
  m.scale(scaleTmp.set(sx, sy, sz));
  m.setPosition(x, y, z);
  return m;
}

const scaleTmp = new Vector3();

const tmp = new Color();

/**
 * ハッシュから色を少しだけ散らす。
 *
 * 同じ用途の建物が数百棟並ぶと、同じ色の箱が整列して「コピー」に見える。
 * 明度と色相をわずかに散らすだけで、同じ形でも街のざらつきが出る。
 */
export function jitterColor(base: number | Color, hash: number, amount = 0.09, out = tmp): Color {
  if (base instanceof Color) out.copy(base);
  else out.setHex(base);
  const h = (hash >>> 0) % 1024;
  const a = ((h % 32) / 31 - 0.5) * 2; // -1..1
  const b = (((h / 32) | 0) / 31 - 0.5) * 2;
  const hsl = { h: 0, s: 0, l: 0 };
  out.getHSL(hsl);
  out.setHSL(
    (hsl.h + a * amount * 0.06 + 1) % 1,
    Math.max(0, Math.min(1, hsl.s * (1 + b * amount * 0.5))),
    Math.max(0.02, Math.min(0.98, hsl.l * (1 + a * amount))),
  );
  return out;
}

/** 材質の一括破棄。 */
export function disposeMaterial(m: Material | Material[]): void {
  if (Array.isArray(m)) for (const x of m) x.dispose();
  else m.dispose();
}
