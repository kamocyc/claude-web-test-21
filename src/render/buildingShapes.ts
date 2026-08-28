import { Color } from 'three';
import { jitterColor } from './materials';
import { Facade, FrontKind, type BuildingParts } from './buildingParts';
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

/**
 * 看板を置くときの Y 回転。
 * 看板キットは「板の裏（+Z）に取付アームが伸びている」向きで焼いてあるので、
 * 面の向きから半回転ずらして、アームが壁の側を向くようにする。
 */
function signRot(f: Facing): number {
  return (f * Math.PI) / 2 + Math.PI;
}

/** 看板のアクセント色。原色のべた塗りをやめ、白地に載る色として選んである。 */
const SIGN_ACCENTS = [0xc4463a, 0xcf8a2a, 0x2f6fa8, 0x4a7a4a, 0x6a4f8f, 0x2f8f6a, 0xb03a6a];

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
  /** 屋根の質感。金属葺き（トタン）だけ粗さを落として鈍く光らせる。 */
  roofRough: number;
  roofMetal: number;
}

const tmpA = new Color();
const tmpB = new Color();
const tmpC = new Color();

/**
 * 「1 階に店構えのキットが載っている面」を、階高の符号と小数第 1 位に埋め込む。
 *
 * こうしておくと、壁のシェーダはその面の 1 階だけ窓帯を描くのをやめて
 * 腰壁にする。埋め込まずにキットを重ねると、庇と柱の隙間から
 * 上階と同じ窓帯が覗いて、せっかく作り分けた 1 階が台無しになる。
 */
function frontFlag(floorH: number, front: Facing): number {
  return -(floorH * 10 + front + 1);
}

/** 用途ごとの 1 階の出（張り出し）(m)。 */
const FRONT_DEPTH: Record<number, number> = {
  [FrontKind.Shop]: 1.5,
  [FrontKind.Office]: 2.4,
  [FrontKind.Porch]: 1.15,
  [FrontKind.Shutter]: 0.9,
  [FrontKind.Tenant]: 1.15,
};

/**
 * 1 階の店構えを正面に 1 つ置く。
 *
 * レビューで「07 の左右の建物は 1 階が全部ただの壁か上階と同じ窓帯」と
 * 指摘された箇所の本体。ここが目線の高さのカットをいちばん動かす。
 * 置くのは焼き固めたキット 1 インスタンスだけで、
 * ガラス／自動ドア／玄関扉／シャッター／テナント板の描き分けは
 * シェーダが `kind` から行う。
 *
 * @param gh    1 階の階高 (m)。壁のシェーダの割付と必ず揃えること。
 * @param scale 間口に対する店構えの幅の比。1 未満なら残りは素の壁になる。
 */
function frontage(
  ctx: BuildCtx,
  kind: number,
  gh: number,
  scale = 0.96,
  opts: { w?: number; d?: number; cx?: number; cz?: number; bay?: number; f?: Facing; off?: number } = {},
): void {
  const { e, hash, gy } = ctx;
  const f = opts.f ?? ctx.front;
  const w = opts.w ?? ctx.w;
  const d = opts.d ?? ctx.d;
  const cx = opts.cx ?? ctx.cx;
  const cz = opts.cz ?? ctx.cz;
  const len = Math.max(1.6, faceLen(f, w, d) * scale);
  const dist = faceDist(f, w, d);
  // テナントの割付。1 区画 5.5m を目安に、間口に収まる整数で割る。
  // 割り切れない刻みにすると、端の区画だけ極端に狭くなって嘘に見える。
  const bay = opts.bay ?? len / Math.max(1, Math.round(len / 5.5));
  // 面に沿ったずらし（正面を全部使わない用途：玄関ポーチ・昇降口）
  const off = opts.off ?? 0;
  tmpA.copy(ctx.wall);
  e.frontage(
    cx + FX[f]! * dist + (f % 2 === 0 ? off : 0),
    gy,
    cz + FZ[f]! * dist + (f % 2 === 0 ? 0 : off),
    len,
    gh,
    FRONT_DEPTH[kind] ?? 1.4,
    kind,
    Math.max(2.2, bay),
    (hash % 991) / 991,
    tmpA,
    faceRot(f),
  );
}

/** 1 階の階高 (m)。窓の割付・店構えの高さの両方がこの値で決まる。 */
function groundH(style: MeshStyle, facade: number): number {
  return style.floorH * groundMul(facade);
}

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
  // パラペットの高さを棟ごとに散らす。ここが全棟同じだと、
  // 屋上の縁の線が街区で揃い、輪郭が「同じ高さの箱の集合」に見える。
  const ph = (opts.parapet ?? 0.85) * (0.7 + rnd(hash, salt + 90) * 1.0);
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
  const r3 = rnd(hash, salt + 3);
  const r4 = rnd(hash, salt + 4);
  const inner = 0.5 - Math.min(0.18, 2.2 / Math.max(w, d));
  const px = (r: number): number => x + (r - 0.5) * w * inner * 1.8;
  const pz = (r: number): number => z + (r - 0.5) * d * inner * 1.8;
  /**
   * 設備の大きさのばらつき（0.6〜1.8 倍）。
   * これを入れないと、屋上が「同じ大きさの白い立方体を並べた角砂糖」になる。
   * 実際の屋上は 1 台 40cm のパッケージから 3m の高置水槽まで大きさが揃っていない。
   */
  const vary = (r: number): number => 0.6 + r * 1.2;

  // 笠木（パラペットの天端に載る一回り広い見切り）。
  // 3 棟に 1 棟ほど付けると、屋上の縁に太い線と細い線が混ざる。
  if (rnd(hash, salt + 91) > 0.55) {
    tmpB.copy(ctx.wall).multiplyScalar(1.05);
    e.box(x, topY + ph, z, w + 0.3, 0.14, d + 0.3, tmpB, 0.85, 0.05);
  }

  // 落下防止柵。パラペットの天端に回す。
  // 屋上の縁に「透けた線」が 1 本入るだけで、平らな灰色の面に厚みが出る。
  const railH = 1.0 + r3 * 0.35;
  const bigRoof = Math.min(w, d) > 9;
  if (r3 > 0.28 && Math.min(w, d) > 5.5) {
    for (const s of [-1, 1]) {
      e.railFrame(x, topY + ph, z + s * (d / 2 - t * 1.2), w - t * 2, railH);
      if (bigRoof) {
        e.railFrame(x + s * (w / 2 - t * 1.2), topY + ph, z, d - t * 2, railH, Math.PI / 2);
      }
    }
  }

  // 塔屋（階段室）。高さのある建物ほど確実に載る。
  if (r0 < 0.82) {
    const k = 0.75 + r4 * 0.7;
    const sw = Math.min(w * 0.34 * k, 5.6);
    const sd = Math.min(d * 0.34 * k, 4.8);
    const sh = 2.4 + r4 * 1.4;
    const sx = x + (r1 - 0.5) * (w - sw) * 0.7;
    const sz = z + (r2 - 0.5) * (d - sd) * 0.7;
    tmpB.copy(ctx.wall).multiplyScalar(0.9);
    e.box(sx, topY, sz, sw, sh, sd, tmpB, 0.88, 0.04);
    // 塔屋の屋根の縁
    e.box(sx, topY + sh, sz, sw + 0.3, 0.16, sd + 0.3, tmpA, 0.9, 0.03);
    // 出入口の鉄扉。面のどこかに 1 枚暗い矩形があると、大きさの見当が付く。
    e.box(sx, topY + 0.05, sz + sd / 2, 0.95, 2.0, 0.1, 0x6e7276, 0.55, 0.45);
  }
  // 架台付きの高置水槽。ステンレス・FRP・塗装鋼板で光り方をはっきり分ける。
  // 「全部が同じ淡いグレー」に見えていた原因は形ではなく、材質が 1 種類だったこと。
  if (r1 < 0.6) {
    const tw = Math.min(w * 0.26, 3.4) * vary(r4);
    const mat = rnd(hash, salt + 92);
    const col = mat < 0.4 ? 0xc2c8ca : mat < 0.78 ? 0xd8d3c2 : 0xa8aca6;
    // ステンレス（磨いた面）/ FRP（つや消しの白）/ 塗装鋼板
    const rough = mat < 0.4 ? 0.26 : mat < 0.78 ? 0.86 : 0.6;
    const metal = mat < 0.4 ? 0.88 : mat < 0.78 ? 0.02 : 0.3;
    e.tank(px(r2), topY, pz(1 - r0), tw, Math.max(1.8, tw * 1.05), tw * 0.78, col, rough, metal);
  }
  // 空調室外機の列。列そのものの長さと高さを散らす。
  const rows = 1 + Math.floor(r2 * 2.4);
  for (let i = 0; i < rows; i++) {
    const rx = rnd(hash, salt + 10 + i);
    const rz = rnd(hash, salt + 20 + i);
    const s = vary(rnd(hash, salt + 30 + i));
    // 経年で色が振れる。全部が同じ白だと、大きさを散らしても列が揃って見える。
    const age = 0.82 + rnd(hash, salt + 70 + i) * 0.3;
    const mat = rnd(hash, salt + 93 + i);
    // 塗装鋼板（新しい）／ステンレス／屋外で焼けた古い機。
    if (mat < 0.5) tmpC.setRGB(age, age * 0.99, age * 0.95);
    else if (mat < 0.78) tmpC.setRGB(age * 0.92, age * 0.95, age * 0.98);
    else tmpC.setRGB(age * 0.86, age * 0.82, age * 0.74);
    e.acRow(
      px(rx),
      topY,
      pz(rz),
      2.6 * s,
      0.95 * s,
      0.85 * s,
      rx > 0.5 ? Math.PI / 2 : 0,
      tmpC,
      mat < 0.5 ? 0.62 : mat < 0.78 ? 0.3 : 0.9,
      mat < 0.5 ? 0.28 : mat < 0.78 ? 0.82 : 0.12,
    );
  }
  // 円筒の排気筒。屋上で唯一の丸い形なので、1 本あるだけで面が単調でなくなる。
  const stacks = r0 > 0.45 ? 1 + Math.floor(r1 * 2) : 0;
  for (let i = 0; i < stacks; i++) {
    const s = vary(rnd(hash, salt + 40 + i));
    const age = 0.8 + rnd(hash, salt + 80 + i) * 0.35;
    // 亜鉛メッキか、赤錆の浮いた鉄。錆が 1 本混ざるだけで屋上が「使われている」。
    const rusty = rnd(hash, salt + 96 + i) > 0.72;
    if (rusty) tmpC.setRGB(age * 0.78, age * 0.5, age * 0.34);
    else tmpC.setRGB(age, age * 0.97, age * 0.92);
    e.stack(
      px(rnd(hash, salt + 50 + i)),
      topY,
      pz(rnd(hash, salt + 60 + i)),
      0.3 * s,
      1.7 * s,
      tmpC,
      rusty ? 0.94 : 0.4,
      rusty ? 0.08 : 0.7,
    );
  }
  // 屋上を這う配管・ダクト。水平の線が 1 本走ると、屋上が「面」ではなく「場」になる。
  // ラッキング（ステンレスの保温外装）なので、他の設備よりはっきり光る。
  if (r4 > 0.4 && bigRoof) {
    const alongX = r0 > 0.5;
    e.box(
      px(r1),
      topY + 0.35,
      pz(r2),
      alongX ? w * 0.5 : 0.45,
      0.45,
      alongX ? 0.45 : d * 0.5,
      0xc0c6c8,
      0.3,
      0.8,
    );
    // ダクトを受ける架台。宙に浮いた配管は「貼り付けた」に見える最たるもの。
    for (const sg of [-1, 1]) {
      e.box(
        px(r1) + (alongX ? sg * w * 0.18 : 0),
        topY,
        pz(r2) + (alongX ? 0 : sg * d * 0.18),
        0.12,
        0.35,
        0.12,
        0x8a8e90,
        0.75,
        0.2,
      );
    }
  }

  // 屋上看板のフレーム。
  // 高さだけ違う箱が並ぶスカイラインを割るのに、いちばん効く要素。
  // 脚 2 本＋看板 1 枚の 3 インスタンスなので、5 棟に 1 棟に載せても軽い。
  if (r2 > 0.78 && bigRoof && w > 8) {
    const sw = Math.min(w * 0.82, 12);
    const sh = 2.4 + r1 * 2.2;
    const legY = topY + ph;
    const bx = x + (r0 - 0.5) * (w - sw) * 0.5;
    const bz = z + (r1 - 0.5) * d * 0.3;
    for (const sg of [-1, 1]) {
      e.box(bx + sg * sw * 0.4, legY, bz, 0.2, 1.6 + sh, 0.2, 0x8f9498, 0.7, 0.25);
    }
    e.signFace(
      bx,
      legY + 1.6 + sh,
      bz,
      sw,
      sh,
      pick(SIGN_ACCENTS, hash, salt + 97),
      rnd(hash, salt + 98),
      0.14,
      1.6,
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

/**
 * 屋外の非常階段。
 *
 * 日本の雑居ビル・事務所ビルは、正面をどれだけ整えても裏側に必ずこれが付く。
 * 踊り場・斜めの段板・手すりの 3 つが階ごとに繰り返す縦の要素なので、
 * 平らな裏面に「階数の読める影の階段」ができる。
 * 手すりは焼き固めたキットを 1 スパンぶん置くだけなので、
 * 1 階あたり 3 インスタンスで済む。
 */
function fireStair(ctx: BuildCtx, cx: number, cz: number, w: number, d: number, baseY: number, h: number, floorH: number): void {
  const { e } = ctx;
  const b = ((ctx.front + 2) % 4) as Facing;
  const dist = faceDist(b, w, d);
  const len = faceLen(b, w, d);
  const off = len * 0.28;
  const wide = 1.5;
  const px = cx + FX[b]! * (dist + wide * 0.5) + (b % 2 === 0 ? off : 0);
  const pz = cz + FZ[b]! * (dist + wide * 0.5) + (b % 2 === 0 ? 0 : off);
  const floors = Math.max(2, Math.min(9, Math.round(h / floorH)));
  const rot = faceRot(b);
  // 壁に沿う向き（接線）。段板と踊り場をこの向きに並べる。
  const tanX = FZ[b]!;
  const tanZ = -FX[b]!;
  for (let i = 1; i <= floors; i++) {
    const y = baseY + floorH * i;
    // 踊り場
    e.box(px, y - 0.14, pz, wide, 0.14, wide, 0x8f979c, 0.66, 0.3);
    // 斜めの段板。1 枚の傾いた板でも、影が段に見える。
    // `put` の回転は YXZ なので、傾け（X 軸まわり）が効くのは常にローカル Z。
    // 段板の長手をローカル Z に取り、Y 回転で壁に平行な向きへ倒す。
    const tilt = Math.atan2(floorH, 2.4);
    const sx = px + tanX * wide * 0.55;
    const sz = pz + tanZ * wide * 0.55;
    e.box(sx, y - floorH * 0.5, sz, 1.1, 0.12, 2.7, 0x8f979c, 0.66, 0.3, rot + Math.PI / 2, tilt);
    // 外側の手すり
    e.railFrame(px + FX[b]! * (wide * 0.5), y, pz + FZ[b]! * (wide * 0.5), wide, 1.05, rot);
  }
  // 縦の主柱
  e.box(px + FX[b]! * (wide * 0.45), baseY, pz + FZ[b]! * (wide * 0.45), 0.16, h, 0.16, 0x8f979c, 0.66, 0.3);
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
    e.hip(x, topY, z, w, h, d, ctx.roof, 0, 0.45, ctx.roofRough, ctx.roofMetal);
    return;
  }
  const alongX = w >= d;
  e.gable(
    x,
    topY,
    z,
    alongX ? w : d,
    h,
    alongX ? d : w,
    ctx.roof,
    alongX ? 0 : Math.PI / 2,
    0.4,
    ctx.roofRough,
    ctx.roofMetal,
  );
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
    const near = rnd(hash, 9) > 0.5;
    out.push({
      x: alongX ? -(w - ww) / 2 + (near ? w - ww : 0) : (w - ww) / 2,
      z: alongX ? (d - wd) / 2 : -(d - wd) / 2 + (near ? d - wd : 0),
      w: ww + (alongX ? 0 : bite),
      d: wd + (alongX ? bite : 0),
      h: wingH,
    });
    // コの字。反対の端にもう 1 本翼を出す。
    // L 字だけだと、輪郭の切れ方が「箱の角が欠けた」に見える棟が多くなる。
    // 両端に翼が出ると中庭が生まれ、遠景でも影の落ち方で平面形が読める。
    if (rnd(hash, 14) > 0.45) {
      const wing2H = snapHeight(Math.max(f * 2, H * (0.5 + rnd(hash, 15) * 0.25)), f, fac);
      out.push({
        x: alongX ? -(w - ww) / 2 + (near ? 0 : w - ww) : (w - ww) / 2,
        z: alongX ? (d - wd) / 2 : -(d - wd) / 2 + (near ? 0 : d - wd),
        w: ww + (alongX ? 0 : bite),
        d: wd + (alongX ? bite : 0),
        h: wing2H,
      });
    }
    return out;
  }
  if (variant === 4 && floors >= 3) {
    // 独立した階段室ボックス。
    // 本体より 1.5 層高い細い塔を片側に寄せて立てる。
    // 平らなパラペットが横一直線に並ぶのがスカイラインの鋸歯の正体なので、
    // 縦に突き出るものを混ぜて輪郭を割る。
    const alongX = w >= d;
    const core = Math.min(alongX ? w * 0.24 : w * 0.9, 6.2);
    const coreD = Math.min(alongX ? d * 0.9 : d * 0.24, 6.2);
    const side = rnd(hash, 12) > 0.5 ? 1 : -1;
    out.push({ x: 0, z: 0, w, d, h: H });
    out.push({
      x: alongX ? side * (w - core) * 0.5 * 0.86 : 0,
      z: alongX ? 0 : side * (d - coreD) * 0.5 * 0.86,
      w: core,
      d: coreD,
      h: snapHeight(H + f * (1 + Math.floor(rnd(hash, 13) * 2)), f, fac),
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

/**
 * 量塊を実際に置き、陸屋根なら屋上を仕上げる。
 *
 * @param frontKind 1 階に載せる店構えの種別（負なら置かない）。
 *   置く場合は**基壇（blocks[0]）の正面**に載せ、その面の 1 階には
 *   壁のシェーダが窓帯を描かないよう符号で印を付ける。
 */
function placeBlocks(ctx: BuildCtx, blocks: Block[], facade: number, frontKind = -1): void {
  const { e, cx, cz, gy, style, hash } = ctx;
  const gh = groundH(style, facade);
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
      i === 0 && frontKind >= 0 ? frontFlag(style.floorH, ctx.front) : style.floorH,
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
  if (frontKind >= 0) {
    const b = blocks[0]!;
    frontage(ctx, frontKind, gh, 0.94, { w: b.w, d: b.d, cx: cx + b.x, cz: cz + b.z });
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
    // 総 2 階
    e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Residential, style.floorH, style.bay, seed);
    pitched(ctx, RoofKind.Gable, cx, cz, gy + H, w, d);
  }

  // 玄関ポーチ。庇・両脇の柱・玄関扉・玄関灯が 1 インスタンスで載る。
  // 住宅の 1 階が「無地の壁」なのが、目線の高さでいちばん貧しく見えていた。
  // 駐車スペースと取り合うので、玄関は正面の左寄せ・カーポートは右寄せにする。
  const porchLen = Math.min(3.0, faceLen(ctx.front, w, d) * 0.45);
  frontage(ctx, FrontKind.Porch, style.floorH * 0.98, porchLen / Math.max(faceLen(ctx.front, w, d), 1), {
    off: -(faceLen(ctx.front, w, d) - porchLen) * 0.5 + 0.2,
  });

  // カーポート（薄い屋根＋柱 2 本）。日本の宅地はほぼ必ず駐車スペースがある。
  if (v !== 1 && rnd(hash, 2) > 0.35) {
    const f = ctx.front;
    const len = Math.min(4.0, faceLen(f, w, d) * 0.5);
    const dist = faceDist(f, w, d) + 1.9;
    // 玄関ポーチの反対側へ寄せる。中央に重ねると柱と庇が刺さる。
    const side = (faceLen(f, w, d) - len) * 0.4;
    const px = cx + FX[f]! * dist + (f % 2 === 0 ? side : 0);
    const pz = cz + FZ[f]! * dist + (f % 2 === 0 ? 0 : side);
    const cw = f % 2 === 0 ? len : 3.6;
    const cd = f % 2 === 0 ? 3.6 : len;
    e.box(px, gy + 2.3, pz, cw, 0.12, cd, 0xb8c4c8, 0.35, 0.25);
    e.box(px - cw / 2 + 0.2, gy, pz - cd / 2 + 0.2, 0.16, 2.3, 0.16, 0xa8adb0, 0.72, 0.18);
    e.box(px + cw / 2 - 0.2, gy, pz + cd / 2 - 0.2, 0.16, 2.3, 0.16, 0xa8adb0, 0.72, 0.18);
  }
  // ブロック塀と門柱。門柱が 2 本立つだけで、塀の切れ目が「門」に見える。
  if (rnd(hash, 3) > 0.45) {
    const site = { ...ctx, w: w * 1.34, d: d * 1.34 };
    fence(site as BuildCtx, w * 1.34, d * 1.34, 1.15, 0xc8c6bc);
    const f = ctx.front;
    const gap = Math.min(3.0, w * 1.34 * 0.3);
    const gdist = faceDist(f, w * 1.34, d * 1.34);
    for (const sgn of [-1, 1]) {
      const ox = f % 2 === 0 ? sgn * gap * 0.5 : 0;
      const oz = f % 2 === 0 ? 0 : sgn * gap * 0.5;
      e.box(cx + FX[f]! * gdist + ox, gy, cz + FZ[f]! * gdist + oz, 0.34, 1.5, 0.34, 0xd0cec4, 0.9, 0.02);
      e.box(cx + FX[f]! * gdist + ox, gy + 1.5, cz + FZ[f]! * gdist + oz, 0.44, 0.1, 0.44, 0xb4b2a8, 0.85, 0.04);
    }
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
  // 1 階の玄関。外廊下側に階段があるので、道路側は小さなポーチだけ。
  frontage(ctx, FrontKind.Porch, style.floorH * 0.98, Math.min(0.34, 3.0 / Math.max(faceLen(ctx.front, w, d), 1)));
}

/** マンション。基壇＋セットバック＋塔屋＋受水槽。 */
function mansion(ctx: BuildCtx): void {
  const v = Math.floor(rnd(ctx.hash, 1) * ctx.style.variants);
  placeBlocks(ctx, massing(ctx, v === 0 ? 0 : v === 1 ? 1 : v === 2 ? 3 : 4), Facade.Residential);
  // 1 階のエントランスホール。キャノピーと自動ドアが 1 インスタンスで載る。
  // 幅は間口の 4 割。残りは住戸なので、バルコニーの窓帯のままでよい。
  frontage(ctx, FrontKind.Office, ctx.style.floorH * 1.05, 0.4);
}

/** タワーマンション。基壇・低層部・タワー・冠部の 4 段構成にする。 */
function tower(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Curtain);
  const seed = (hash % 997) / 997;
  const podiumH = style.floorH * 2.3;
  // 低層部（共用部）。周りより一回り広く、街路に対する足元を作る。
  e.mass(cx, gy, cz, w * 1.1, podiumH, d * 1.1, ctx.wall, Facade.Shop, frontFlag(style.floorH, ctx.front), style.bay, seed);
  frontage(ctx, FrontKind.Shop, groundH(style, Facade.Shop), 0.94, { w: w * 1.1, d: d * 1.1 });
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
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Shop, frontFlag(style.floorH, ctx.front), style.bay, seed);
  // 全面ガラスの売り場。コンビニは 1 階しか無いので、ここがそのまま外観になる。
  frontage(ctx, FrontKind.Shop, groundH(style, Facade.Shop), 0.94, { bay: faceLen(ctx.front, w, d) * 0.5 });
  const f = ctx.front;
  const len = faceLen(f, w, d);
  const dist = faceDist(f, w, d);
  // 軒先の看板帯。まわりの建物より一段明るく光らせる。
  e.signFace(
    cx + FX[f]! * (dist + 0.36),
    gy + H - 1.2,
    cz + FZ[f]! * (dist + 0.36),
    len * 0.9,
    1.05,
    0x2f8f4f,
    seed,
    0.18,
    1.9,
    signRot(f),
  );
  // パラペットと庇
  rooftop(ctx, cx, cz, gy + H, w, d, 60, { parapet: 0.75, clutter: 1 });
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
  // ポールサイン。白地に店名が入る（純白のべた塗りをやめる）。
  e.signFace(lx, gy + 6.0, lz, 2.0, 1.3, 0x2f8f4f, seed + 0.5, 0.2, 2.0, signRot(f));
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
    e.mass(px, gy, pz, alongX ? sw : depth, h, alongX ? depth : sw, tmpC, Facade.Shop, frontFlag(style.floorH, f), style.bay, seed + i * 0.17);
    // 店ごとのショップフロント。間口が狭いので 1 店 = 1 区画で割る。
    frontage(ctx, FrontKind.Shop, groundH(style, Facade.Shop), 0.98, {
      w: alongX ? sw : depth,
      d: alongX ? depth : sw,
      cx: px,
      cz: pz,
      bay: sw,
    });
    // 切妻を通りに直交させる（妻面が通りを向く）
    if (style.roofKind === RoofKind.Gable) {
      const rh = Math.min(2.2, sw * 0.34);
      e.gable(px, gy + h, pz, alongX ? depth : sw, rh, alongX ? sw : depth, ctx.roof, alongX ? Math.PI / 2 : 0);
    } else {
      rooftop(ctx, px, pz, gy + h, alongX ? sw : depth, alongX ? depth : sw, 70 + i, { parapet: 0.6, clutter: 0 });
    }
    // 店ごとの袖看板。壁から 0.3m のアームで持ち出した、厚み 0.12m の縦板。
    const dist = faceDist(f, w, d);
    const proj = 1.0;
    const bx = cx + FX[f]! * (dist + proj * 0.86) + (alongX ? off : 0);
    const bz = cz + FZ[f]! * (dist + proj * 0.86) + (alongX ? 0 : off);
    e.signBlade(
      bx,
      gy + style.floorH * 1.05,
      bz,
      proj,
      1.9,
      pick(SIGN_ACCENTS, hash, 30 + i),
      seed + i * 0.23,
      0.16,
      1.9,
      signRot(f),
    );
  }

  // 軒を通して連ねる庇（アーケード）。
  // 店ごとの庇の上に、通りを覆う 1 枚がさらに架かる二重構造にする。
  // 高さを分けないと、店の庇とアーケードが同じ面で重なって縞が出る。
  const dist = faceDist(f, w, d);
  const ax = cx + FX[f]! * (dist + 1.5);
  const az = cz + FZ[f]! * (dist + 1.5);
  const arcadeY = gy + groundH(style, Facade.Shop) + 0.55;
  e.box(ax, arcadeY, az, alongX ? span : 3.0, 0.2, alongX ? 3.0 : span, 0x8a6350, 0.75, 0.06);
  // アーケードを受ける柱。通りに柱が立つと、歩道の奥行きが読める。
  for (let i = 0; i <= shops; i++) {
    const off = -span / 2 + (span / shops) * i;
    e.box(
      cx + FX[f]! * (dist + 2.8) + (alongX ? off : 0),
      gy,
      cz + FZ[f]! * (dist + 2.8) + (alongX ? 0 : off),
      0.16,
      arcadeY - gy,
      0.16,
      0x9a8a7a,
      0.8,
      0.08,
    );
  }
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
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Shop, frontFlag(style.floorH, ctx.front), style.bay, seed);
  rooftop(ctx, cx, cz, gy + H, w, d, 80, { parapet: 1.0 });
  const f = ctx.front;
  const len = faceLen(f, w, d);
  const dist = faceDist(f, w, d);
  // 売り場は 1 区画が広い。5.5m 刻みで割ると柱だらけになるので、間口の 1/3 で割る。
  frontage(ctx, FrontKind.Shop, groundH(style, Facade.Shop), 0.92, { bay: len / 3 });
  e.signFace(
    cx + FX[f]! * (dist + 0.36),
    gy + H - 2.0,
    cz + FZ[f]! * (dist + 0.36),
    len * 0.6,
    1.7,
    0xc4463a,
    seed,
    0.2,
    1.8,
    signRot(f),
  );
}

/** 雑居ビル。細長い箱に看板が縦に並ぶ、日本の駅前の顔。 */
function zakkyo(ctx: BuildCtx): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const v = Math.floor(rnd(hash, 1) * ctx.style.variants);
  const blocks = massing(ctx, v === 2 ? 3 : v === 3 ? 4 : v);
  // 1 階はテナント看板の並ぶ入口。奥まった階段と自販機で「入れる建物」に見せる。
  placeBlocks(ctx, blocks, Facade.Shop, FrontKind.Tenant);
  // 裏の非常階段。正面に看板が並ぶぶん、裏は階段で読ませる。
  if (blocks[0]!.h > style.floorH * 3.5 && rnd(hash, 4) > 0.45) {
    fireStair(ctx, cx, cz, w, d, gy, blocks[0]!.h, style.floorH);
  }
  // 正面に縦に並ぶ袖看板。夜はここが街の光になる。
  const f = ctx.front;
  const dist = faceDist(f, w, d);
  const H = blocks[0]!.h;
  const n = Math.max(2, Math.min(5, Math.floor(H / style.floorH) - 1));
  const off = faceLen(f, w, d) * 0.34;
  const seed = (hash % 997) / 997;
  // 袖看板は 1 枚が縦に長い板で、階ごとに積み上がる。
  // 厚みとアームがあることが近景で読めるので、以前の「付箋」からは抜けられる。
  const proj = 1.3;
  for (let i = 0; i < n; i++) {
    const y = gy + style.floorH * (0.95 + i);
    e.signBlade(
      cx + FX[f]! * (dist + proj * 0.86) + (f % 2 === 0 ? off : 0),
      y,
      cz + FZ[f]! * (dist + proj * 0.86) + (f % 2 === 0 ? 0 : off),
      proj,
      style.floorH * 0.72,
      pick(SIGN_ACCENTS, hash, 50 + i),
      seed + i * 0.19,
      0.16,
      2.0,
      signRot(f),
    );
  }
}

/** オフィスビル。カーテンウォールと基壇。 */
function office(ctx: BuildCtx): void {
  const v = Math.floor(rnd(ctx.hash, 1) * ctx.style.variants);
  const blocks = massing(ctx, v === 0 ? 1 : v);
  // 1 階はエントランスホール＋キャノピー。
  placeBlocks(ctx, blocks, Facade.Curtain, FrontKind.Office);
  if (rnd(ctx.hash, 4) > 0.55) {
    fireStair(ctx, ctx.cx, ctx.cz, ctx.w, ctx.d, ctx.gy, blocks[0]!.h, ctx.style.floorH);
  }
}

/** 工場・倉庫。折板の切妻／陸屋根、ダクト、煙突、サイロ。 */
function industrial(ctx: BuildCtx, kind: 'small' | 'big' | 'saw' | 'store'): void {
  const { e, cx, cz, gy, w, d, hash, style } = ctx;
  const H = snapHeight(ctx.height, style.floorH, Facade.Industrial);
  const seed = (hash % 997) / 997;
  const alongX = w >= d;
  e.mass(cx, gy, cz, w, H, d, ctx.wall, Facade.Industrial, frontFlag(style.floorH, ctx.front), style.bay, seed);
  // 搬入口。シャッターと通用口とガイドレールを 1 インスタンスで。
  frontage(ctx, FrontKind.Shutter, Math.min(H * 0.9, style.floorH * 1.05), 0.62);

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
  e.mass(cx, gy, cz, bw, H, bd, ctx.wall, Facade.Institution, frontFlag(style.floorH, ctx.front), style.bay, seed);
  pitched(ctx, RoofKind.Hip, cx, cz, gy + H, bw, bd, 0.85);
  // 改札口。奥が明るいガラスの間口があると、駅が「入れる建物」になる。
  frontage(ctx, FrontKind.Office, style.floorH * 1.1, 0.72, { w: bw, d: bd });

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
  e.signFace(
    cx + FX[f]! * (dist + 0.36),
    gy + H * 0.55,
    cz + FZ[f]! * (dist + 0.36),
    (f % 2 === 0 ? bw : bd) * 0.5,
    1.1,
    0x2f6fb5,
    seed,
    0.22,
    1.9,
    signRot(f),
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
  // 昇降口。校舎の中ほどに 1 か所だけ。
  frontage(ctx, FrontKind.Office, style.floorH, 0.26, { w: bw, d: bd, cx: cx + ox, cz: cz + oz });
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
  // 玄関はキャノピー付きのエントランスホール。
  placeBlocks(ctx, blocks, Facade.Institution, FrontKind.Office);
  tmpA.copy(ctx.wall).multiplyScalar(0.9);

  const f = ctx.front;
  const dist = faceDist(f, w, d);
  if (kind === 'hospital') {
    // 赤十字の看板と屋上のヘリポート標識
    e.signFace(cx + FX[f]! * (dist + 0.36), gy + style.floorH * 2.0, cz + FZ[f]! * (dist + 0.36), 1.6, 1.5, 0xc4463a, (hash % 997) / 997, 0.22, 1.5, signRot(f));
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
    e.signFace(cx + FX[f]! * (dist + 0.36), gy + style.baseHeight * 0.8, cz + FZ[f]! * (dist + 0.36), 1.4, 0.6, 0xc4463a, (hash % 997) / 997, 0.25, 1.7, signRot(f));
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

/** 立面の様式から 1 階の店構えを選ぶ（個別のレシピを持たない用途向け）。 */
function defaultFrontKind(facade: number): number {
  if (facade === Facade.Shop) return FrontKind.Shop;
  if (facade === Facade.Curtain || facade === Facade.Institution) return FrontKind.Office;
  if (facade === Facade.Industrial) return FrontKind.Shutter;
  if (facade === Facade.Residential) return FrontKind.Porch;
  return -1;
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
      return placeBlocks(ctx, massing(ctx, v), ctx.style.facade, defaultFrontKind(ctx.style.facade));
    }
  }
}
