import { Color } from 'three';
import { jitterColor } from './materials';
import { Facade, type BuildingParts } from './buildingParts';
import { RoofKind, type MeshStyle } from './theme';

/**
 * 用途ごとの造形（レシピ）。
 *
 * 1 棟 = 1 箱をやめて、基壇＋セットバック・L 字・塔屋・屋上設備・庇・看板を
 * 積み上げる。ここで作るのは**部品の並べ方**だけで、実際の描画は
 * `BuildingParts` が数個の InstancedMesh にまとめて引き受ける。
 *
 * 形はすべて `hash`（棟ごとの固定値）から決める。乱数を毎フレーム引くと
 * 建物が明滅するし、街を作り直すたびに形が変わってしまう。
 *
 * 遠景のシルエットだけで用途が読めることを最優先にした。
 * 駅はホーム上屋、神社は鳥居、工場は煙突とサイロ、学校は体育館、
 * 商店街はアーケードの庇 — 街を俯瞰したときに「何の街か」が分かるかどうかは、
 * 個々の窓の出来より、この輪郭で決まる。
 */

/** 面の向き。0=+Z, 1=+X, 2=-Z, 3=-X。道路のある側を「正面」とする。 */
export type Facing = 0 | 1 | 2 | 3;

const FX = [0, 1, 0, -1];
const FZ = [1, 0, -1, 0];

/** その面の幅（壁に沿った長さ）。 */
function faceLen(f: Facing, w: number, d: number): number {
  return f % 2 === 0 ? w : d;
}
/** 中心からその面までの距離。 */
function faceDist(f: Facing, w: number, d: number): number {
  return f % 2 === 0 ? d / 2 : w / 2;
}
/** その面に平行な部品を置くときの Y 回転。 */
function faceRot(f: Facing): number {
  return (f * Math.PI) / 2;
}

/** ハッシュから 0..1 を引く。salt を変えれば独立した値になる。 */
export function rnd(hash: number, salt: number): number {
  let x = (hash ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** 配列からハッシュで 1 つ選ぶ。 */
function pick<T>(arr: readonly T[], hash: number, salt: number): T {
  return arr[Math.floor(rnd(hash, salt) * arr.length) % arr.length]!;
}

export interface BuildCtx {
  e: BuildingParts;
  /** 敷地中心のワールド座標 (m)。 */
  cx: number;
  cz: number;
  /** 地面の高さ (m)。 */
  gy: number;
  /** 建物の平面寸法 (m)。 */
  w: number;
  d: number;
  /** 目標の高さ (m)。 */
  height: number;
  level: number;
  hash: number;
  /** 道路のある向き。 */
  front: Facing;
  style: MeshStyle;
  /** 個体ごとの壁色。 */
  wall: Color;
  roof: Color;
}

const tmpA = new Color();
const tmpB = new Color();
const tmpC = new Color();

/** 1 階の割増し（シェーダの groundMul と揃えること）。 */
function groundMul(facade: number): number {
  if (facade === Facade.Shop) return 1.45;
  if (facade === Facade.Curtain) return 1.3;
  return 1.0;
}

/**
 * 高さを階高の整数倍に丸める。
 * 窓をシェーダの格子で描くので、半端な高さだと最上階の窓が切れる。
 */
export function snapHeight(height: number, floorH: number, facade: number): number {
  const g = floorH * groundMul(facade);
  const upper = Math.max(0, Math.round((height - g) / floorH));
  return g + upper * floorH;
}

/** 階数（1 階を含む）。 */
function floorsOf(height: number, floorH: number, facade: number): number {
  return 1 + Math.max(0, Math.round((height - floorH * groundMul(facade)) / floorH));
}

// ------------------------------------------------------------------ 共通の部品

/**
 * 陸屋根の上に載せるもの。俯瞰で街を見たときの情報量はここで決まる。
 * パラペット（立ち上がり）は必ず回し、そこに塔屋・受水槽・室外機・
 * 手すり・アンテナをハッシュで散らして載せる。
 */
function rooftop(
  ctx: BuildCtx,
  x: number,
  z: number,
  topY: number,
  w: number,
  d: number,
  salt: number,
  opts: { parapet?: number; clutter?: number } = {},
): void {
  const { e, hash } = ctx;
  const ph = opts.parapet ?? 0.85;
  const t = Math.min(0.3, Math.min(w, d) * 0.06);
  tmpA.copy(ctx.wall).multiplyScalar(0.94);
  // パラペット。屋上の縁に線が 1 本出るだけで、平らな箱が建物になる。
  e.box(x, topY, z - d / 2 + t / 2, w, ph, t, tmpA, 0.9, 0.03);
  e.box(x, topY, z + d / 2 - t / 2, w, ph, t, tmpA, 0.9, 0.03);
  e.box(x - w / 2 + t / 2, topY, z, t, ph, d - t * 2, tmpA, 0.9, 0.03);
  e.box(x + w / 2 - t / 2, topY, z, t, ph, d - t * 2, tmpA, 0.9, 0.03);

  const clutter = opts.clutter ?? 1;
  if (clutter <= 0 || Math.min(w, d) < 4) return;

  const r0 = rnd(hash, salt);
  const r1 = rnd(hash, salt + 1);
  const r2 = rnd(hash, salt + 2);
  const inner = 0.5 - Math.min(0.18, 2.2 / Math.max(w, d));

  // 塔屋（階段室）。高さのある建物ほど確実に載る。
  if (r0 < 0.82) {
    const sw = Math.min(w * 0.34, 5.2);
    const sd = Math.min(d * 0.34, 4.4);
    const sx = x + (r1 - 0.5) * (w - sw) * 0.7;
    const sz = z + (r2 - 0.5) * (d - sd) * 0.7;
    tmpB.copy(ctx.wall).multiplyScalar(0.9);
    e.box(sx, topY, sz, sw, 2.7, sd, tmpB, 0.88, 0.04);
    // 塔屋の屋根の縁
    e.box(sx, topY + 2.7, sz, sw + 0.3, 0.16, sd + 0.3, tmpA, 0.9, 0.03);
  }
  // 受水槽
  if (r1 < 0.55) {
    const tw = Math.min(w * 0.26, 3.4);
    e.tank(
      x + (r2 - 0.5) * w * inner * 1.6,
      topY,
      z - (r0 - 0.5) * d * inner * 1.6,
      tw,
      Math.max(2.0, tw * 0.9),
      tw * 0.8,
      0xa8aca6,
    );
  }
  // 空調室外機。小さいものを何台か並べると、それらしい雑然さが出る。
  const units = 2 + Math.floor(r2 * 2);
  for (let i = 0; i < units; i++) {
    const rx = rnd(hash, salt + 10 + i);
    const rz = rnd(hash, salt + 20 + i);
    e.box(
      x + (rx - 0.5) * w * inner * 1.7,
      topY,
      z + (rz - 0.5) * d * inner * 1.7,
      1.5,
      1.2,
      0.9,
      0x9aa0a2,
      0.5,
      0.55,
      rx > 0.5 ? Math.PI / 2 : 0,
    );
  }
  // アンテナ・避雷針。細くて高いものが 1 本あると輪郭が締まる。
  if (r0 > 0.55) {
    const ax = x + (r1 - 0.5) * w * inner;
    const az = z + (r2 - 0.5) * d * inner;
    e.box(ax, topY + ph, az, 0.14, 2.6 + r0 * 3.5, 0.14, 0x9c9c9c, 0.7, 0.2);
    e.box(ax, topY + ph + 1.2, az, 1.1, 0.1, 0.1, 0x9c9c9c, 0.7, 0.2);
  }
}

/** 勾配屋根。棟は長辺に沿わせる。 */
function pitched(
  ctx: BuildCtx,
  kind: RoofKind,
  x: number,
  z: number,
  topY: number,
  w: number,
  d: number,
  scale = 1,
): void {
  const { e } = ctx;
  const h = Math.min(4.6, Math.max(1.5, Math.min(w, d) * 0.3)) * scale;
  if (kind === RoofKind.Hip) {
    e.hip(x, topY, z, w, h, d, ctx.roof);
    return;
  }
  const alongX = w >= d;
  e.gable(x, topY, z, alongX ? w : d, h, alongX ? d : w, ctx.roof, alongX ? 0 : Math.PI / 2);
}

/** 正面の庇（店舗・玄関）。奥行きのある水平の板は、影が落ちて立体感を作る。 */
function awning(
  ctx: BuildCtx,
  y: number,
  depth: number,
  color: number | Color,
  widthScale = 1,
  f: Facing = ctx.front,
): void {
  const { e, cx, cz, w, d } = ctx;
  const len = faceLen(f, w, d) * widthScale;
  const dist = faceDist(f, w, d);
  const px = cx + FX[f]! * (dist + depth / 2 - 0.1);
  const pz = cz + FZ[f]! * (dist + depth / 2 - 0.1);
  e.box(px, y, pz, f % 2 === 0 ? len : depth, 0.22, f % 2 === 0 ? depth : len, color, 0.6, 0.25);
}

/** 低い塀（ブロック塀・玉垣）。路上に降りたときの「敷地感」がこれで出る。 */
function fence(ctx: BuildCtx, siteW: number, siteD: number, h: number, color: number | Color): void {
  const { e, cx, cz, gy } = ctx;
  const t = 0.22;
  const gap = Math.min(3.0, siteW * 0.3);
  // 正面は門のぶんだけ空ける
  const f = ctx.front;
  for (let s = 0 as Facing; s < 4; s = (s + 1) as Facing) {
    const len = faceLen(s, siteW, siteD);
    const dist = faceDist(s, siteW, siteD);
    const px = cx + FX[s]! * dist;
    const pz = cz + FZ[s]! * dist;
    if (s === f) {
      const side = (len - gap) / 2;
      if (side < 0.6) continue;
      const off = (gap + side) / 2;
      const dx = s % 2 === 0 ? 1 : 0;
      const dz = s % 2 === 0 ? 0 : 1;
      e.box(px - dx * off, gy, pz - dz * off, dx ? side : t, h, dz ? side : t, color, 0.92, 0.02);
      e.box(px + dx * off, gy, pz + dz * off, dx ? side : t, h, dz ? side : t, color, 0.92, 0.02);
    } else {
      e.box(px, gy, pz, s % 2 === 0 ? len : t, h, s % 2 === 0 ? t : len, color, 0.92, 0.02);
    }
  }
}

/**
 * バルコニーの床スラブと手すり。
 *
 * シェーダで描く「絵のバルコニー」は俯瞰では効くが、路上に降りると
 * 壁が一枚の板のままで奥行きが出ない。日本の集合住宅の顔は
 * 1.4m 前に出た床スラブが作る水平の影の連なりなので、ここだけは実体で持つ。
 * 長辺の面だけ・階ごとに 2 部品なので、1 棟あたり十数インスタンスで済む。
 */
function balconies(
  ctx: BuildCtx,
  x: number,
  z: number,
  w: number,
  d: number,
  baseY: number,
  h: number,
  floorH: number,
  sides: readonly number[] = [-1, 1],
): void {
  const { e } = ctx;
  const floors = Math.max(1, Math.round(h / floorH));
  if (floors < 2 || Math.min(w, d) < 5.5) return;
  const alongX = w >= d;
  const len = (alongX ? w : d) * 0.96;
  const dist = (alongX ? d : w) / 2;
  const depth = Math.min(1.5, Math.max(w, d) * 0.12);
  tmpA.copy(ctx.wall).multiplyScalar(0.96);
  for (let i = 1; i < floors; i++) {
    const y = baseY + floorH * i;
    for (const s of sides) {
      const off = s * (dist + depth / 2 - 0.05);
      const px = x + (alongX ? 0 : off);
      const pz = z + (alongX ? off : 0);
      // 床スラブ。小口の線と、その下に落ちる影が「階」を読ませる。
      e.box(px, y - 0.17, pz, alongX ? len : depth, 0.17, alongX ? depth : len, tmpA, 0.9, 0.03);
      // 手すり壁（外側の立ち上がり）
      const rx = x + (alongX ? 0 : s * (dist + depth - 0.06));
      const rz = z + (alongX ? s * (dist + depth - 0.06) : 0);
      e.box(rx, y, rz, alongX ? len : 0.12, 1.05, alongX ? 0.12 : len, 0xb6bcbe, 0.78, 0.10);
    }
  }
}

// ------------------------------------------------------------------ 量塊の構成

interface Block {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

/**
 * 中高層の量塊。1 棟 = 1 箱をやめ、基壇＋セットバック・L 字・段違いの
 * 3 系統をハッシュで選ぶ。同じ形状キーの反復が消えるのはここの効果が一番大きい。
 */
function massing(ctx: BuildCtx, variant: number): Block[] {
  const { w, d, height, hash, style } = ctx;
  const f = style.floorH;
  const fac = style.facade;
  const H = snapHeight(height, f, fac);
  const floors = floorsOf(H, f, fac);
  const out: Block[] = [];

  if (variant === 1 && floors >= 4) {
    // 基壇＋セットバック
    const baseFloors = Math.min(floors - 2, 2 + Math.floor(rnd(hash, 5) * 2));
    const baseH = snapHeight(f * groundMul(fac) + (baseFloors - 1) * f, f, fac);
    out.push({ x: 0, z: 0, w, d, h: baseH });
    const k = 0.82 + rnd(hash, 6) * 0.08;
    out.push({ x: 0, z: (d - d * k) * (rnd(hash, 7) - 0.5) * 0.4, w: w * k, d: d * k, h: H });
    return out;
  }
  if (variant === 2 && Math.min(w, d) > 9) {
    // L 字。長辺を主棟、短い翼を直角に付ける。
    const alongX = w >= d;
    const mainD = alongX ? d * 0.6 : d;
    const mainW = alongX ? w : w * 0.6;
    const off = alongX ? (d - mainD) / 2 : (w - mainW) / 2;
    out.push({ x: alongX ? 0 : -off, z: alongX ? -off : 0, w: mainW, d: mainD, h: H });
    // 翼は主棟に少しめり込ませる。面がぴったり重なると Z ファイトで縞が出る。
    const bite = 0.3;
    const wingH = snapHeight(Math.max(f * 2, H * (0.55 + rnd(hash, 8) * 0.2)), f, fac);
    const ww = alongX ? w * 0.42 : w - mainW;
    const wd = alongX ? d - mainD : d * 0.42;
    out.push({
      x: alongX ? -(w - ww) / 2 + (rnd(hash, 9) > 0.5 ? w - ww : 0) : (w - ww) / 2,
      z: alongX ? (d - wd) / 2 : -(d - wd) / 2 + (rnd(hash, 9) > 0.5 ? d - wd : 0),
      w: ww + (alongX ? 0 : bite),
      d: wd + (alongX ? bite : 0),
      h: wingH,
    });
    return out;
  }
  if (variant === 3 && Math.max(w, d) > 11) {
    // 段違いの 2 棟
    const alongX = w >= d;
    const a = 0.52 + rnd(hash, 10) * 0.1;
    const w1 = alongX ? w * a : w;
    const d1 = alongX ? d : d * a;
    const h2 = snapHeight(Math.max(f * 2, H - f * (1 + Math.floor(rnd(hash, 11) * 2))), f, fac);
    out.push({ x: alongX ? -(w - w1) / 2 : 0, z: alongX ? 0 : -(d - d1) / 2, w: w1, d: d1, h: H });
    // 継ぎ目を 0.3m 重ねる（面が一致すると Z ファイトで縞になる）
    out.push({
      x: alongX ? w1 / 2 - 0.15 : 0,
      z: alongX ? 0 : d1 / 2 - 0.15,
      w: alongX ? w - w1 + 0.3 : w,
      d: alongX ? d : d - d1 + 0.3,
      h: h2,
    });
    return out;
  }
  out.push({ x: 0, z: 0, w, d, h: H });
  return out;
}

/** 量塊を実際に置き、陸屋根なら屋上を仕上げる。 */
function placeBlocks(ctx: BuildCtx, blocks: Block[], facade: number): void {
  const { e, cx, cz, gy, style, hash } = ctx;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    e.mass(
      cx + b.x,
      gy,
      cz + b.z,
      b.w,
      b.h,
      b.d,
      ctx.wall,
      facade,
      style.floorH,
      style.bay,
      (hash % 997) / 997 + i * 0.31,
    );
    if (facade === Facade.Residential) {
      balconies(ctx, cx + b.x, cz + b.z, b.w, b.d, gy, b.h, style.floorH);
    }
    if (style.roofKind === RoofKind.Flat) {
      rooftop(ctx, cx + b.x, cz + b.z, gy + b.h, b.w, b.d, 30 + i * 5, {
        clutter: i === 0 || blocks.length < 3 ? 1 : 0,
      });
    } else if (style.roofKind !== RoofKind.None) {
      pitched(ctx, style.roofKind, cx + b.x, cz + b.z, gy + b.h, b.w, b.d);
    }
  }
}

// ------------------------------------------------------------------ 用途ごと

/** 一戸建て。切妻＋下屋＋玄関ポーチ＋カーポート＋ブロック塀。 */
function house(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const v = Math.floor(rnd(hash, 1) * 4);
  const H = snapHeight(ctx.height, style.floorH, Facade.Residential);
  const alongX = w >= d;
  const seed = (hash % 997) / 997;

  if (v === 0) {
    e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Residential, style.floorH, style.bay, seed);
    pitched(ctx, RoofKind.Gable, cx, cz, gy + H, w, d);
  } else if (v === 1) {
    // L 字（主屋＋下屋）
    const mw = alongX ? w * 0.66 : w;
    const md = alongX ? d : d * 0.66;
    const ox = alongX ? -(w - mw) / 2 : 0;
    const oz = alongX ? 0 : -(d - md) / 2;
    e.mass(cx + ox, gy, cz + oz, mw, H, md, ctx.wall, Facade.Residential, style.floorH, style.bay, seed);
    pitched(ctx, RoofKind.Gable, cx + ox, cz + oz, gy + H, mw, md);
    const sw = alongX ? w - mw : w * 0.62;
    const sd = alongX ? d * 0.62 : d - md;
    const sx = alongX ? mw / 2 : (w - sw) / 2;
    const sz = alongX ? (d - sd) / 2 : md / 2;
    const sh = style.floorH;
    e.mass(cx + sx, gy, cz + sz, sw + 0.2, sh, sd + 0.2, ctx.wall, Facade.Residential, style.floorH, style.bay, seed + 0.4);
    pitched(ctx, RoofKind.Gable, cx + sx, cz + sz, gy + sh, sw, sd, 0.8);
  } else {
    // 総 2 階＋玄関ポーチ
    e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Residential, style.floorH, style.bay, seed);
    pitched(ctx, RoofKind.Gable, cx, cz, gy + H, w, d);
    tmpA.copy(ctx.wall).multiplyScalar(0.96);
    awning(ctx, gy + style.floorH * 0.78, Math.min(1.4, d * 0.2), tmpA, 0.42);
  }

  // カーポート（薄い屋根＋柱 2 本）。日本の宅地はほぼ必ず駐車スペースがある。
  if (v !== 1 && rnd(hash, 2) > 0.35) {
    const f = ctx.front;
    const len = Math.min(4.6, faceLen(f, w, d) * 0.62);
    const dist = faceDist(f, w, d) + 1.9;
    const px = cx + FX[f]! * dist;
    const pz = cz + FZ[f]! * dist;
    const cw = f % 2 === 0 ? len : 3.6;
    const cd = f % 2 === 0 ? 3.6 : len;
    e.box(px, gy + 2.3, pz, cw, 0.12, cd, 0xb8c4c8, 0.35, 0.25);
    e.box(px - cw / 2 + 0.2, gy, pz - cd / 2 + 0.2, 0.16, 2.3, 0.16, 0xa8adb0, 0.72, 0.18);
    e.box(px + cw / 2 - 0.2, gy, pz + cd / 2 - 0.2, 0.16, 2.3, 0.16, 0xa8adb0, 0.72, 0.18);
  }
  // ブロック塀
  if (rnd(hash, 3) > 0.45) {
    const site = { ...ctx, w: w * 1.34, d: d * 1.34 };
    fence(site as BuildCtx, w * 1.34, d * 1.34, 1.15, 0xc8c6bc);
  }
}

/** アパート。外廊下と鉄骨階段が付くのが日本の低層集合住宅の顔。 */
function apartment(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Residential);
  const floors = floorsOf(H, style.floorH, Facade.Residential);
  const seed = (hash % 997) / 997;
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Residential, style.floorH, style.bay, seed);

  // 外廊下とバルコニーは必ず長辺に付く。短辺に付けると住戸の並びと食い違う。
  const alongX = w >= d;
  const longA: Facing = alongX ? 0 : 1;
  const longB: Facing = alongX ? 2 : 3;
  // 道路側をバルコニー（洗濯物の干せる南面のつもり）、反対側を外廊下にする。
  const balconySide: Facing = ctx.front === longB ? longB : longA;
  const corridorSide: Facing = balconySide === longA ? longB : longA;

  const len = faceLen(corridorSide, w, d);
  const dist = faceDist(corridorSide, w, d);
  const cwx = FX[corridorSide]!;
  const cwz = FZ[corridorSide]!;
  tmpA.copy(ctx.wall).multiplyScalar(0.9);
  for (let i = 1; i < floors; i++) {
    const y = gy + style.floorH * i;
    const px = cx + cwx * (dist + 0.6);
    const pz = cz + cwz * (dist + 0.6);
    // 床スラブ
    e.box(px, y - 0.16, pz, corridorSide % 2 === 0 ? len : 1.2, 0.16, corridorSide % 2 === 0 ? 1.2 : len, tmpA, 0.9, 0.03);
    // 手すり
    e.box(
      cx + cwx * (dist + 1.15),
      y,
      cz + cwz * (dist + 1.15),
      corridorSide % 2 === 0 ? len : 0.1,
      1.05,
      corridorSide % 2 === 0 ? 0.1 : len,
      0x9fa8ad,
      0.72,
      0.14,
    );
  }
  // 鉄骨階段
  const sx = cx + cwx * (dist + 1.0) + (corridorSide % 2 === 0 ? len * 0.42 : 0);
  const sz = cz + cwz * (dist + 1.0) + (corridorSide % 2 === 0 ? 0 : len * 0.42);
  e.box(sx, gy, sz, 1.3, H, 1.3, 0x8f979c, 0.72, 0.16);

  // 反対側のバルコニー
  balconies(ctx, cx, cz, w, d, gy, H, style.floorH, [balconySide === longA ? 1 : -1]);

  if (style.roofKind === RoofKind.Flat) {
    rooftop(ctx, cx, cz, gy + H, w, d, 40, { parapet: 0.7 });
  } else {
    pitched(ctx, RoofKind.Gable, cx, cz, gy + H, w, d, 0.7);
  }
}

/** マンション。基壇＋セットバック＋塔屋＋受水槽。 */
function mansion(ctx: BuildCtx): void {
  const v = Math.floor(rnd(ctx.hash, 1) * ctx.style.variants);
  placeBlocks(ctx, massing(ctx, v === 0 ? 0 : v === 1 ? 1 : 3), Facade.Residential);
  // 1 階のエントランス庇
  tmpA.copy(ctx.wall).multiplyScalar(0.88);
  awning(ctx, ctx.gy + ctx.style.floorH * 0.85, 1.8, tmpA, 0.34);
}

/** タワーマンション。基壇・低層部・タワー・冠部の 4 段構成にする。 */
function tower(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Curtain);
  const seed = (hash % 997) / 997;
  const podiumH = style.floorH * 2.3;
  // 低層部（共用部）。周りより一回り広く、街路に対する足元を作る。
  e.mass(cx, gy, cz, w * 1.1, podiumH, d * 1.1, ctx.wall, Facade.Shop, style.floorH, style.bay, seed);
  rooftop(ctx, cx, cz, gy + podiumH, w * 1.1, d * 1.1, 50, { parapet: 0.9, clutter: 0 });
  // 塔体
  const shaftH = H - podiumH - style.floorH * 2;
  e.mass(cx, gy + podiumH, cz, w, shaftH, d, ctx.wall, Facade.Residential, style.floorH, style.bay, seed + 0.2);
  balconies(ctx, cx, cz, w, d, gy + podiumH, shaftH, style.floorH);
  // 冠部（セットバックしたガラスの最上部）。夜に光ると遠くからでも位置が分かる。
  const crownW = w * 0.8;
  const crownD = d * 0.8;
  e.mass(
    cx,
    gy + podiumH + shaftH,
    cz,
    crownW,
    style.floorH * 2,
    crownD,
    ctx.wall,
    Facade.Curtain,
    style.floorH,
    style.bay,
    seed + 0.5,
  );
  const topY = gy + H;
  rooftop(ctx, cx, cz, topY, crownW, crownD, 55, { parapet: 1.1 });
  // 航空障害灯
  e.sign(cx, topY + 1.2, cz, 0.5, 0.5, 0.5, 0xff4436, 0.6, 1.6);
  e.box(cx, topY + 1.7, cz, 0.16, 5.5, 0.16, 0xb0b0b0, 0.4, 0.7);
}

/** コンビニ。ガラス面と大きな看板とパーキング。夜がいちばん目立つ建物。 */
function konbini(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Shop);
  const seed = (hash % 997) / 997;
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Shop, style.floorH, style.bay, seed);
  const f = ctx.front;
  const len = faceLen(f, w, d);
  const dist = faceDist(f, w, d);
  // 軒先の看板帯。まわりの建物より一段明るく光らせる。
  const sx = cx + FX[f]! * (dist + 0.12);
  const sz = cz + FZ[f]! * (dist + 0.12);
  e.sign(sx, gy + H - 1.2, sz, f % 2 === 0 ? len * 0.94 : 0.3, 0.95, f % 2 === 0 ? 0.3 : len * 0.94, 0x2f8f4f, 0.2, 2.3);
  // パラペットと庇
  rooftop(ctx, cx, cz, gy + H, w, d, 60, { parapet: 0.75, clutter: 1 });
  awning(ctx, gy + H - 2.4, 1.5, 0xe8e8e4, 0.98);
  // 駐車場の車止めと照明ポール
  const px = cx + FX[f]! * (dist + 5.0);
  const pz = cz + FZ[f]! * (dist + 5.0);
  for (let i = -1; i <= 1; i++) {
    e.box(
      px + (f % 2 === 0 ? i * 2.6 : 0),
      gy + 0.02,
      pz + (f % 2 === 0 ? 0 : i * 2.6),
      f % 2 === 0 ? 0.16 : 1.9,
      0.14,
      f % 2 === 0 ? 1.9 : 0.16,
      0xd8d8d0,
      0.9,
      0.02,
    );
  }
  const lx = cx + FX[f]! * (dist + 7.2) + (f % 2 === 0 ? len * 0.4 : 0);
  const lz = cz + FZ[f]! * (dist + 7.2) + (f % 2 === 0 ? 0 : len * 0.4);
  e.box(lx, gy, lz, 0.18, 5.4, 0.18, 0xb4b8ba, 0.7, 0.2);
  e.sign(lx, gy + 5.4, lz, 1.9, 1.2, 0.3, 0xffffff, 0.25, 2.4, faceRot(f));
}

/** 商店街。間口の狭い店が軒を連ね、通りに面してアーケードの庇と幟が並ぶ。 */
function shotengai(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const f = ctx.front;
  const alongX = f % 2 === 0;
  const span = alongX ? w : d;
  const depth = alongX ? d : w;
  const shops = Math.max(2, Math.min(4, Math.round(span / 5.5)));
  const sw = span / shops;
  const seed = (hash % 997) / 997;

  for (let i = 0; i < shops; i++) {
    const off = -span / 2 + sw * (i + 0.5);
    const px = cx + (alongX ? off : 0);
    const pz = cz + (alongX ? 0 : off);
    const h = snapHeight(ctx.height * (0.85 + rnd(hash, 20 + i) * 0.3), style.floorH, Facade.Shop);
    tmpB.copy(ctx.wall);
    jitterColor(tmpB, hash + i * 7919, 0.16, tmpC);
    e.mass(px, gy, pz, alongX ? sw : depth, h, alongX ? depth : sw, tmpC, Facade.Shop, style.floorH, style.bay, seed + i * 0.17);
    // 切妻を通りに直交させる（妻面が通りを向く）
    if (style.roofKind === RoofKind.Gable) {
      const rh = Math.min(2.2, sw * 0.34);
      e.gable(px, gy + h, pz, alongX ? depth : sw, rh, alongX ? sw : depth, ctx.roof, alongX ? Math.PI / 2 : 0);
    } else {
      rooftop(ctx, px, pz, gy + h, alongX ? sw : depth, alongX ? depth : sw, 70 + i, { parapet: 0.6, clutter: 0 });
    }
    // 店ごとの袖看板
    const dist = faceDist(f, w, d);
    const bx = cx + FX[f]! * (dist + 0.5) + (alongX ? off : 0);
    const bz = cz + FZ[f]! * (dist + 0.5) + (alongX ? 0 : off);
    const sc = pick([0xd94f3a, 0xe0a13a, 0x3f7fbf, 0xe8e2d0, 0x4f9e5a], hash, 30 + i);
    e.sign(bx, gy + style.floorH * 1.55, bz, alongX ? 0.3 : 1.5, 1.1, alongX ? 1.5 : 0.3, sc, 0.2, 2.2);
  }

  // 軒を通して連ねる庇（アーケード）
  const dist = faceDist(f, w, d);
  const ax = cx + FX[f]! * (dist + 0.9);
  const az = cz + FZ[f]! * (dist + 0.9);
  e.box(ax, gy + style.floorH * 1.2, az, alongX ? span : 2.0, 0.2, alongX ? 2.0 : span, 0x8a6350, 0.75, 0.06);
  // 幟（のぼり）。細く色の強い縦の板が数本並ぶだけで、通りの賑わいが出る。
  for (let i = 0; i < shops; i++) {
    const off = -span / 2 + sw * (i + 0.72);
    const bx = cx + FX[f]! * (dist + 2.0) + (alongX ? off : 0);
    const bz = cz + FZ[f]! * (dist + 2.0) + (alongX ? 0 : off);
    e.box(bx, gy, bz, 0.09, 3.0, 0.09, 0xb0b4b6, 0.75, 0.15);
    e.box(bx + 0.3 * FZ[f]!, gy + 0.9, bz + 0.3 * FX[f]!, alongX ? 0.55 : 0.06, 1.9, alongX ? 0.06 : 0.55, pick([0xd94f3a, 0xf0f0e8, 0x3f7fbf], hash, 40 + i), 0.85, 0.02);
  }
}

/** スーパー。大きな平屋＋屋上駐車場の手すり＋大看板。 */
function supermarket(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Shop);
  const seed = (hash % 997) / 997;
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Shop, style.floorH, style.bay, seed);
  rooftop(ctx, cx, cz, gy + H, w, d, 80, { parapet: 1.0 });
  const f = ctx.front;
  const len = faceLen(f, w, d);
  const dist = faceDist(f, w, d);
  awning(ctx, gy + style.floorH * 1.3, 2.6, 0xdedad0, 0.7);
  e.sign(
    cx + FX[f]! * (dist + 0.12),
    gy + H - 2.0,
    cz + FZ[f]! * (dist + 0.12),
    f % 2 === 0 ? len * 0.6 : 0.3,
    1.6,
    f % 2 === 0 ? 0.3 : len * 0.6,
    0xd94f3a,
    0.22,
    2.4,
  );
}

/** 雑居ビル。細長い箱に看板が縦に並ぶ、日本の駅前の顔。 */
function zakkyo(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const v = Math.floor(rnd(hash, 1) * ctx.style.variants);
  const blocks = massing(ctx, v === 2 ? 3 : v);
  placeBlocks(ctx, blocks, Facade.Shop);
  // 正面に縦に並ぶ袖看板。夜はここが街の光になる。
  const f = ctx.front;
  const dist = faceDist(f, w, d);
  const H = blocks[0]!.h;
  const n = Math.max(2, Math.min(5, Math.floor(H / style.floorH) - 1));
  const off = faceLen(f, w, d) * 0.34;
  for (let i = 0; i < n; i++) {
    const y = gy + style.floorH * (1.35 + i);
    const c = pick([0xd94f3a, 0xe0a13a, 0x3f7fbf, 0xf0e8d8, 0x7f5fb0], hash, 50 + i);
    e.sign(
      cx + FX[f]! * (dist + 0.55) + (f % 2 === 0 ? off : 0),
      y,
      cz + FZ[f]! * (dist + 0.55) + (f % 2 === 0 ? 0 : off),
      f % 2 === 0 ? 0.28 : 1.6,
      1.0,
      f % 2 === 0 ? 1.6 : 0.28,
      c,
      0.18,
      2.6,
    );
  }
}

/** オフィスビル。カーテンウォールと基壇。 */
function office(ctx: BuildCtx): void {
  const v = Math.floor(rnd(ctx.hash, 1) * ctx.style.variants);
  placeBlocks(ctx, massing(ctx, v === 0 ? 1 : v), Facade.Curtain);
  tmpA.copy(ctx.wall).multiplyScalar(0.85);
  awning(ctx, ctx.gy + ctx.style.floorH * 1.15, 2.2, tmpA, 0.5);
}

/** 工場・倉庫。折板の切妻／陸屋根、ダクト、煙突、サイロ。 */
function industrial(ctx: BuildCtx, kind: 'small' | 'big' | 'saw' | 'store'): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Industrial);
  const seed = (hash % 997) / 997;
  const alongX = w >= d;
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Industrial, style.floorH, style.bay, seed);

  if (style.roofKind === RoofKind.Gable) {
    // 折板の切妻。勾配を寝かせると工場らしくなる。
    const rh = Math.min(2.6, Math.min(w, d) * 0.16);
    e.gable(cx, gy + H, cz, alongX ? w : d, rh, alongX ? d : w, ctx.roof, alongX ? 0 : Math.PI / 2, 0.55);
    // 換気の越屋根
    if (rnd(hash, 2) > 0.4) {
      e.box(cx, gy + H + rh * 0.55, cz, alongX ? w * 0.5 : 1.4, 0.8, alongX ? 1.4 : d * 0.5, 0x8e9498, 0.5, 0.5);
    }
  } else {
    rooftop(ctx, cx, cz, gy + H, w, d, 90, { parapet: 0.6, clutter: kind === 'store' ? 0 : 1 });
  }

  if (kind === 'big' || kind === 'saw') {
    // 煙突
    const chx = cx + (rnd(hash, 3) - 0.5) * w * 0.5;
    const chz = cz + (rnd(hash, 4) - 0.5) * d * 0.5;
    const ch = H + 6 + rnd(hash, 5) * 8;
    e.cyl(chx, gy, chz, 0.75, ch, 0xd8d4cc, 0.7, 0.15);
    e.cyl(chx, gy + ch * 0.82, chz, 0.82, ch * 0.06, 0xc0392b, 0.7, 0.15);
    e.cyl(chx, gy + ch * 0.62, chz, 0.82, ch * 0.06, 0xc0392b, 0.7, 0.15);
    // サイロ
    const sx = cx + (rnd(hash, 6) - 0.5) * w * 0.6;
    const sz = cz + (rnd(hash, 7) - 0.5) * d * 0.6;
    e.cyl(sx, gy, sz, 1.8, H * 0.9, 0xbfc4c6, 0.45, 0.55);
    e.cyl(sx, gy + H * 0.9, sz, 1.9, 0.5, 0x8f9498, 0.45, 0.6);
    // ダクト
    e.box(cx, gy + H * 0.55, cz + d / 2 + 0.5, w * 0.5, 0.9, 0.9, 0xa8aeb0, 0.5, 0.6);
  }
  if (kind === 'small' || kind === 'store') {
    // 事務所の下屋
    const f = ctx.front;
    const len = faceLen(f, w, d) * 0.4;
    const dist = faceDist(f, w, d);
    tmpA.copy(ctx.wall).multiplyScalar(1.04);
    e.mass(
      cx + FX[f]! * (dist + 1.6),
      gy,
      cz + FZ[f]! * (dist + 1.6),
      f % 2 === 0 ? len : 3.4,
      style.floorH * 1.05,
      f % 2 === 0 ? 3.4 : len,
      tmpA,
      Facade.Institution,
      style.floorH,
      2.4,
      seed + 0.3,
    );
    e.box(
      cx + FX[f]! * (dist + 1.6),
      gy + style.floorH * 1.05,
      cz + FZ[f]! * (dist + 1.6),
      (f % 2 === 0 ? len : 3.4) + 0.3,
      0.18,
      (f % 2 === 0 ? 3.4 : len) + 0.3,
      ctx.roof,
      0.8,
      0.08,
    );
  }
}

/** 駅。ホーム上屋と跨線橋。遠景でもここだけは形で分かるようにする。 */
function station(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Institution);
  const seed = (hash % 997) / 997;
  const alongX = w >= d;
  // 駅舎
  const bw = alongX ? w * 0.55 : w;
  const bd = alongX ? d : d * 0.55;
  e.mass(cx, gy, cz, bw, H, bd, ctx.wall, Facade.Institution, style.floorH, style.bay, seed);
  pitched(ctx, RoofKind.Hip, cx, cz, gy + H, bw, bd, 0.85);

  // ホーム上屋。長く薄い庇を線路方向に伸ばす。
  const pl = alongX ? w * 1.5 : d * 1.5;
  const pw = 5.2;
  const py = gy + 4.2;
  for (const s of [-1, 1]) {
    const ox = alongX ? 0 : s * (w * 0.34);
    const oz = alongX ? s * (d * 0.34) : 0;
    e.box(cx + ox, py, cz + oz, alongX ? pl : pw, 0.28, alongX ? pw : pl, 0xc6ccd0, 0.45, 0.35);
    // 上屋を支える柱
    for (let i = -2; i <= 2; i++) {
      const t = (i / 2) * (pl / 2) * 0.82;
      e.box(
        cx + ox + (alongX ? t : 0),
        gy,
        cz + oz + (alongX ? 0 : t),
        0.22,
        4.2,
        0.22,
        0x9aa2a6,
        0.72,
        0.18,
      );
    }
  }
  // 跨線橋
  e.box(cx, gy + 6.2, cz, alongX ? 3.2 : w * 1.1, 2.6, alongX ? d * 1.1 : 3.2, 0xd2d6d8, 0.5, 0.3);
  e.box(cx, gy + 8.8, cz, alongX ? 3.6 : w * 1.15, 0.22, alongX ? d * 1.15 : 3.6, 0x8f9aa0, 0.5, 0.4);
  // 駅名の看板
  const f = ctx.front;
  const dist = faceDist(f, bw, bd);
  e.sign(
    cx + FX[f]! * (dist + 0.15),
    gy + H * 0.55,
    cz + FZ[f]! * (dist + 0.15),
    f % 2 === 0 ? bw * 0.5 : 0.3,
    1.0,
    f % 2 === 0 ? 0.3 : bd * 0.5,
    0x2f6fb5,
    0.22,
    2.8,
  );
}

/** 学校。校舎（長い連窓）＋体育館（大きな切妻）＋渡り廊下。 */
function school(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Institution);
  const seed = (hash % 997) / 997;
  const alongX = w >= d;
  // 校舎は敷地の奥半分に長く置く
  const bw = alongX ? w * 0.94 : w * 0.46;
  const bd = alongX ? d * 0.4 : d * 0.94;
  const ox = alongX ? 0 : -w * 0.26;
  const oz = alongX ? -d * 0.29 : 0;
  e.mass(cx + ox, gy, cz + oz, bw, H, bd, ctx.wall, Facade.Institution, style.floorH, style.bay, seed);
  rooftop(ctx, cx + ox, cz + oz, gy + H, bw, bd, 100, { parapet: 1.0 });
  // 階段室
  e.mass(
    cx + ox + (alongX ? bw * 0.38 : 0),
    gy,
    cz + oz + (alongX ? 0 : bd * 0.38),
    3.6,
    H + 1.6,
    3.6,
    ctx.wall,
    Facade.Plain,
    style.floorH,
    style.bay,
    seed + 0.2,
  );
  // 体育館。大きな切妻が 1 棟あるだけで学校に見える。
  const gw = alongX ? w * 0.42 : w * 0.44;
  const gd = alongX ? d * 0.4 : d * 0.42;
  const gx = cx + (alongX ? -w * 0.26 : w * 0.26);
  const gz = cz + (alongX ? d * 0.28 : -d * 0.26);
  tmpA.copy(ctx.wall).multiplyScalar(0.97);
  e.mass(gx, gy, gz, gw, 8.2, gd, tmpA, Facade.Industrial, 4.1, 3.4, seed + 0.6);
  const grAlong = gw >= gd;
  e.gable(gx, gy + 8.2, gz, grAlong ? gw : gd, 2.4, grAlong ? gd : gw, ctx.roof, grAlong ? 0 : Math.PI / 2, 0.6);
  // 校庭のフェンス（背の高いネット）
  const f = ctx.front;
  const len = faceLen(f, w, d);
  const dist = faceDist(f, w, d);
  for (let i = -2; i <= 2; i++) {
    const t = (i / 2) * len * 0.42;
    e.box(
      cx + FX[f]! * dist + (f % 2 === 0 ? t : 0),
      gy,
      cz + FZ[f]! * dist + (f % 2 === 0 ? 0 : t),
      0.16,
      4.2,
      0.16,
      0x9aa2a6,
      0.75,
      0.15,
    );
  }
}

/** 神社。鳥居・入母屋の屋根・玉垣。 */
function shrine(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = style.baseHeight;
  const bw = w * 0.62;
  const bd = d * 0.62;
  // 社殿（高床）
  e.box(cx, gy, cz, bw * 1.1, 0.9, bd * 1.1, 0x7a6a58, 0.9, 0.02);
  e.mass(cx, gy + 0.9, cz, bw, H, bd, ctx.wall, Facade.Plain, 0.85, 0.03, 0);
  // 入母屋：寄棟の上に小さな切妻を載せる
  const alongX = bw >= bd;
  e.hip(cx, gy + 0.9 + H, cz, bw * 1.22, Math.min(3.0, bw * 0.34), bd * 1.22, ctx.roof);
  e.gable(
    cx,
    gy + 0.9 + H + Math.min(3.0, bw * 0.34) * 0.42,
    cz,
    (alongX ? bw : bd) * 0.72,
    Math.min(2.2, bw * 0.26),
    (alongX ? bd : bw) * 0.66,
    ctx.roof,
    alongX ? 0 : Math.PI / 2,
    0.5,
  );
  // 千木・鰹木
  for (let i = -1; i <= 1; i++) {
    e.box(
      cx + (alongX ? i * bw * 0.22 : 0),
      gy + 0.9 + H + Math.min(3.0, bw * 0.34) * 1.28,
      cz + (alongX ? 0 : i * bd * 0.22),
      alongX ? 0.28 : 1.2,
      0.3,
      alongX ? 1.2 : 0.28,
      0xbfa15a,
      0.45,
      0.6,
    );
  }
  // 鳥居
  const f = ctx.front;
  const dist = faceDist(f, w, d);
  e.torii(
    cx + FX[f]! * (dist + 1.4),
    gy,
    cz + FZ[f]! * (dist + 1.4),
    Math.min(6.0, faceLen(f, w, d) * 0.62),
    5.6,
    0xc0392b,
    faceRot(f),
  );
  // 玉垣（石の柵）
  fence(ctx, w * 1.06, d * 1.06, 1.0, 0xbdb9ae);
  // 灯籠
  for (const s of [-1, 1]) {
    const lx = cx + FX[f]! * (dist - 1.2) + (f % 2 === 0 ? s * bw * 0.5 : 0);
    const lz = cz + FZ[f]! * (dist - 1.2) + (f % 2 === 0 ? 0 : s * bd * 0.5);
    e.box(lx, gy, lz, 0.5, 1.5, 0.5, 0xa9a49a, 0.95, 0.02);
    e.sign(lx, gy + 1.5, lz, 0.7, 0.6, 0.7, 0xffd9a0, 0.1, 1.4);
    e.box(lx, gy + 2.1, lz, 0.95, 0.28, 0.95, 0x9a958c, 0.95, 0.02);
  }
  void hash;
}

/** 病院・庁舎・警察・消防など。連窓の箱に用途ごとの目印を足す。 */
function institution(ctx: BuildCtx, kind: 'hospital' | 'cityhall' | 'police' | 'fire'): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const v = kind === 'cityhall' ? 0 : Math.floor(rnd(hash, 1) * 3);
  const blocks = massing(ctx, v === 0 ? 0 : v === 1 ? 2 : 1);
  placeBlocks(ctx, blocks, Facade.Institution);
  tmpA.copy(ctx.wall).multiplyScalar(0.9);
  awning(ctx, gy + style.floorH * 1.1, 2.4, tmpA, 0.45);

  const f = ctx.front;
  const dist = faceDist(f, w, d);
  if (kind === 'hospital') {
    // 赤十字の看板と屋上のヘリポート標識
    e.sign(cx + FX[f]! * (dist + 0.12), gy + style.floorH * 2.0, cz + FZ[f]! * (dist + 0.12), 1.4, 1.4, 0.3, 0xe04b4b, 0.25, 1.8);
  } else if (kind === 'fire') {
    // ホース乾燥塔。細く高い塔が 1 本立つのが消防署の目印。
    e.mass(cx + w * 0.36, gy, cz + d * 0.34, 2.6, style.baseHeight + 7, 2.6, ctx.wall, Facade.Plain, 0.85, 0.04, 0);
    e.box(cx + w * 0.36, gy + style.baseHeight + 7, cz + d * 0.34, 3.0, 0.25, 3.0, ctx.roof, 0.8, 0.06);
    // 車庫のシャッター
    const len = faceLen(f, w, d) * 0.66;
    e.box(
      cx + FX[f]! * (dist + 0.08),
      gy + 0.1,
      cz + FZ[f]! * (dist + 0.08),
      f % 2 === 0 ? len : 0.16,
      3.4,
      f % 2 === 0 ? 0.16 : len,
      0xbcc2c4,
      0.4,
      0.6,
    );
  } else if (kind === 'police') {
    e.sign(cx + FX[f]! * (dist + 0.12), gy + style.baseHeight * 0.8, cz + FZ[f]! * (dist + 0.12), 1.2, 0.5, 0.3, 0xe8443a, 0.3, 2.0);
  } else {
    // 庁舎は正面に柱列を立てて格を出す
    const len = faceLen(f, w, d);
    for (let i = -2; i <= 2; i++) {
      const t = (i / 2) * len * 0.36;
      e.box(
        cx + FX[f]! * (dist + 1.0) + (f % 2 === 0 ? t : 0),
        gy,
        cz + FZ[f]! * (dist + 1.0) + (f % 2 === 0 ? 0 : t),
        0.7,
        style.floorH * 2.1,
        0.7,
        tmpA,
        0.85,
        0.03,
      );
    }
  }
}

/** 発電所。大きな建屋と 2 本の高い煙突。街の端でもすぐ分かる。 */
function powerplant(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Industrial);
  const seed = (hash % 997) / 997;
  e.mass(cx, gy, cz, w * 0.86, H, d * 0.72, ctx.wall, Facade.Industrial, style.floorH, style.bay, seed);
  rooftop(ctx, cx, cz, gy + H, w * 0.86, d * 0.72, 110, { parapet: 0.8 });
  // 煙突 2 本（紅白）
  for (const s of [-1, 1]) {
    const px = cx + s * w * 0.3;
    const pz = cz + d * 0.32;
    const ch = H + 26;
    e.cyl(px, gy, pz, 1.5, ch, 0xe8e4dc, 0.65, 0.2);
    for (let i = 1; i <= 3; i++) {
      e.cyl(px, gy + (ch * i) / 4, pz, 1.6, ch * 0.06, 0xc0392b, 0.65, 0.2);
    }
    e.sign(px, gy + ch, pz, 0.6, 0.6, 0.6, 0xff4436, 0.5, 1.8);
  }
  // 燃料タンク
  e.cyl(cx - w * 0.34, gy, cz - d * 0.32, 3.4, 5.2, 0xc8ccc8, 0.5, 0.4);
  e.cyl(cx + w * 0.06, gy, cz - d * 0.34, 3.0, 4.6, 0xc8ccc8, 0.5, 0.4);
  // 送電鉄塔のような架構
  e.box(cx + w * 0.4, gy, cz - d * 0.1, 0.3, H + 12, 0.3, 0xa8adb0, 0.7, 0.2);
  e.box(cx + w * 0.4, gy + H + 8, cz - d * 0.1, 6.0, 0.25, 0.25, 0xa8adb0, 0.7, 0.2);
}

/** 太陽光発電所。傾けたパネルの列。 */
function solar(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash } = ctx;
  const rows = Math.max(2, Math.round(d / 5));
  const tilt = -0.42;
  for (let i = 0; i < rows; i++) {
    const z = cz - d / 2 + (d / rows) * (i + 0.5);
    e.box(cx, gy + 0.9, z, w * 0.92, 0.12, 3.0, 0x1f2a3f, 0.16, 0.35, 0, tilt);
    e.box(cx - w * 0.34, gy, z, 0.14, 0.9, 0.14, 0x9aa0a4, 0.5, 0.55);
    e.box(cx + w * 0.34, gy, z, 0.14, 0.9, 0.14, 0x9aa0a4, 0.5, 0.55);
  }
  // パワーコンディショナの小屋
  e.box(cx + w * 0.38, gy, cz - d * 0.4, 2.2, 2.4, 1.6, 0xd6d8d2, 0.85, 0.05);
  void hash;
}

/** 浄水場・下水処理場。円形の池と低い建屋。 */
function waterPlant(ctx: BuildCtx, sewage: boolean): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Institution);
  e.mass(cx - w * 0.28, gy, cz - d * 0.3, w * 0.4, H, d * 0.34, ctx.wall, Facade.Institution, style.floorH, style.bay, (hash % 997) / 997);
  rooftop(ctx, cx - w * 0.28, cz - d * 0.3, gy + H, w * 0.4, d * 0.34, 120, { parapet: 0.6, clutter: 0 });
  // 沈殿池（円形）
  const r = Math.min(w, d) * 0.2;
  for (const [ox, oz] of [
    [0.22, 0.22],
    [-0.24, 0.26],
    [0.26, -0.22],
  ] as const) {
    const px = cx + ox * w;
    const pz = cz + oz * d;
    e.cyl(px, gy, pz, r, 1.6, 0xbfc4c2, 0.85, 0.05);
    e.cyl(px, gy + 1.5, pz, r * 0.92, 0.2, sewage ? 0x5f6f66 : 0x4a6f8a, 0.25, 0.1);
    // 掻き寄せ機の橋
    e.box(px, gy + 1.7, pz, r * 2.1, 0.2, 0.4, 0xa8adb0, 0.45, 0.6, rnd(hash, 130) * 3.0);
  }
}

/** 田んぼ。畦だけを起こす。水面と稲の色は地形が持っているので触らない。 */
function paddy(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d } = ctx;
  const t = 0.5;
  const c = 0x7a6a52;
  e.box(cx, gy, cz - d / 2 + t / 2, w, 0.3, t, c, 0.95, 0.02);
  e.box(cx, gy, cz + d / 2 - t / 2, w, 0.3, t, c, 0.95, 0.02);
  e.box(cx - w / 2 + t / 2, gy, cz, t, 0.3, d - t * 2, c, 0.95, 0.02);
  e.box(cx + w / 2 - t / 2, gy, cz, t, 0.3, d - t * 2, c, 0.95, 0.02);
}

/** 畑。畝を数本立てる。 */
function field(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash } = ctx;
  const rows = 5;
  const alongX = rnd(hash, 1) > 0.5;
  for (let i = 0; i < rows; i++) {
    const t = (-0.5 + (i + 0.5) / rows) * (alongX ? d : w);
    e.box(
      cx + (alongX ? 0 : t),
      gy,
      cz + (alongX ? t : 0),
      alongX ? w * 0.94 : 1.1,
      0.28,
      alongX ? 1.1 : d * 0.94,
      0x8a6f4e,
      0.95,
      0.02,
    );
  }
}

/** 林業地。若い植林の列。 */
function forestry(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash } = ctx;
  for (let i = 0; i < 4; i++) {
    const rx = rnd(hash, 200 + i) - 0.5;
    const rz = rnd(hash, 210 + i) - 0.5;
    const px = cx + rx * w * 0.8;
    const pz = cz + rz * d * 0.8;
    const h = 3.2 + rnd(hash, 220 + i) * 2.4;
    e.cyl(px, gy, pz, 0.16, h * 0.4, 0x6b5540, 0.95, 0.02);
    e.hip(px, gy + h * 0.3, pz, 2.2, h * 0.8, 2.2, 0x36703f);
  }
}

/** 公園。東屋とベンチ。 */
function park(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash } = ctx;
  const px = cx + (rnd(hash, 1) - 0.5) * w * 0.4;
  const pz = cz + (rnd(hash, 2) - 0.5) * d * 0.4;
  for (const [ox, oz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    e.box(px + ox * 1.5, gy, pz + oz * 1.5, 0.18, 2.4, 0.18, 0x8a7a62, 0.9, 0.03);
  }
  e.hip(px, gy + 2.4, pz, 4.4, 1.4, 4.4, 0x7a5f4a);
  for (let i = 0; i < 2; i++) {
    e.box(cx + (rnd(hash, 3 + i) - 0.5) * w * 0.7, gy, cz + (rnd(hash, 5 + i) - 0.5) * d * 0.7, 1.6, 0.45, 0.5, 0x8a7a62, 0.9, 0.03);
  }
}

/**
 * 形状キーごとの造形を選ぶ。
 * ここに無いキーは「量塊＋屋根＋屋上」の一般形にまわす。
 */
export function composeBuilding(key: string, ctx: BuildCtx): void {
  switch (key) {
    case 'house':
      return house(ctx);
    case 'apartment':
      return apartment(ctx);
    case 'mansion':
      return mansion(ctx);
    case 'tower':
      return tower(ctx);
    case 'konbini':
      return konbini(ctx);
    case 'shotengai':
      return shotengai(ctx);
    case 'supermarket':
      return supermarket(ctx);
    case 'zakkyo':
      return zakkyo(ctx);
    case 'office':
      return office(ctx);
    case 'smallfactory':
      return industrial(ctx, 'small');
    case 'factory':
      return industrial(ctx, 'big');
    case 'sawmill':
      return industrial(ctx, 'saw');
    case 'ricemill':
      return industrial(ctx, 'small');
    case 'warehouse':
      return industrial(ctx, 'store');
    case 'station':
      return station(ctx);
    case 'school':
      return school(ctx);
    case 'hospital':
      return institution(ctx, 'hospital');
    case 'police':
      return institution(ctx, 'police');
    case 'fire':
      return institution(ctx, 'fire');
    case 'cityhall':
      return institution(ctx, 'cityhall');
    case 'shrine':
      return shrine(ctx);
    case 'powerplant':
      return powerplant(ctx);
    case 'solar':
      return solar(ctx);
    case 'waterworks':
      return waterPlant(ctx, false);
    case 'sewage':
      return waterPlant(ctx, true);
    case 'paddy':
      return paddy(ctx);
    case 'field':
      return field(ctx);
    case 'forestry':
      return forestry(ctx);
    case 'park':
      return park(ctx);
    default: {
      const v = Math.floor(rnd(ctx.hash, 1) * ctx.style.variants);
      return placeBlocks(ctx, massing(ctx, v), ctx.style.facade);
    }
  }
}
