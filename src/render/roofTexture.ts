import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * 屋根に貼る 1 枚のテクスチャ（全屋根で共有）。
 *
 * 俯瞰のカットでは画面の 4 割以上が屋根で、そこがのっぺりした単色の
 * ポリゴンだと街全体が「色紙を折った模型」に見える。屋根の情報量は
 * 俯瞰ゲームの絵の質をほとんど決めてしまう。
 *
 * ただしここで「屋根ごとにテクスチャを持つ」をやると、材質が屋根の数だけ
 * 増えてドローコールが崩壊する。そこで
 *
 * - **形は 1 種類（桟瓦の起伏）だけ**を 512px に手続きで焼く。
 * - 貼り方は屋根のローカル座標（棟方向 × 流れ方向、単位はメートル）なので、
 *   大きさの違う屋根でも瓦の実寸は変わらない。
 * - テクスチャが持つのは「繰り返される瓦の並び」だけ。棟と軒先は
 *   シェーダが屋根の幾何から描く。テクスチャに焼き込むと、
 *   屋根の大きさによって棟の太さが変わってしまう。
 * - 屋根ごとの違いは instanceColor（色相 ±6°・明度 ±8%）だけで出す。
 *
 * これで**ドローコールは 1 つも増えない**（切妻・寄棟はもともと
 * InstancedMesh 1 つずつ）。
 *
 * 外部ファイルは使わず CanvasTexture で手続き的に作る。
 * 文字は一切描かない（ヘッドレス環境に CJK フォントが無い）。
 */

/** テクスチャの一辺 (px)。 */
const SIZE = 512;
/**
 * 1 枚の中に並ぶ桟瓦の枚数（棟方向）と葺き足の段数（流れ方向）。
 * シェーダが UV を作るときに同じ値を使うので、外へ出しておく。
 */
export const ROOF_TILES_X = 8;
export const ROOF_TILES_Y = 6;
const TILES_X = ROOF_TILES_X;
const TILES_Y = ROOF_TILES_Y;

/** 整数格子のハッシュ（瓦 1 枚ごとの色むらに使う）。 */
function h2(x: number, y: number): number {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** smoothstep。a > b を渡せば降下側になる。 */
function ss(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 桟瓦の起伏 (0..1 前後)。
 *
 * 実物の桟瓦は「広い平部」と「片側に寄った丸い山」でできていて、
 * 隣の瓦の端がその山の脇に潜り込む。潜り込むところに落ちる細い影が、
 * 俯瞰で屋根を屋根に見せている縦線の正体なので、そこだけは深く彫る。
 *
 * @param gx テクスチャ全体の横位置 0..1（棟に沿った方向）
 * @param gy テクスチャ全体の縦位置 0..1（流れ方向。1 が軒側）
 */
function heightAt(gx: number, gy: number): number {
  const fx = gx * TILES_X;
  const fy = gy * TILES_Y;
  // 格子番号は枚数で折り返す。折り返さないと、テクスチャの右端と左端で
  // 瓦 1 枚ごとのむらが食い違い、繰り返して貼ったときに継ぎ目の線が出る。
  const ix = Math.floor(fx) % TILES_X;
  const iy = Math.floor(fy) % TILES_Y;
  const u = fx - Math.floor(fx);
  const v = fy - Math.floor(fy);
  // 1 枚ごとのわずかな浮き。全部が同じ高さだと「型で押した板」になる。
  return 0.10 + stepAt(v) + rollAt(u) + (h2(ix, iy) - 0.5) * 0.06;
}

/**
 * 流れ方向の段差（葺き足）。
 * 軒側の端が下の段に重なるので、そこだけ瓦の厚みぶん持ち上がる。
 */
function stepAt(v: number): number {
  return ss(0.74, 0.95, v) * 0.30 - (1 - ss(0.0, 0.11, v)) * 0.07;
}

/**
 * 棟方向の断面（平部と山）。
 * 山の右脇に隣の瓦が潜り込むので、そこに深い溝が 1 本入る。
 * 俯瞰で屋根を屋根に見せている縦線の正体はこの溝。
 */
function rollAt(u: number): number {
  let h = 0;
  if (u < 0.62) {
    h += 0.05 * Math.sin(Math.PI * (u / 0.62));
  } else if (u < 0.93) {
    const t = (u - 0.62) / 0.31;
    h += 0.70 * Math.pow(Math.sin(Math.PI * t), 0.55);
  }
  return h - ss(0.90, 1.0, u) * 0.26;
}

/**
 * その画素が平部（平らな部分）か山かを 0..1 で返す。
 *
 * 山は流れ方向に**通し**で走っていて、葺き足の段では切れない。
 * 段差の影を横一直線に引くと、桟瓦ではなく「目地の通った正方形タイル」に
 * 見えてしまう（実際そうなっていた）。段の影は平部にだけ落とす。
 */
function panAt(u: number): number {
  return 1 - ss(0.55, 0.70, u);
}

/** 生成したアルベドの線形平均。シェーダはこれで割って「素の屋根色」に戻す。 */
let texMean = 0.72;

/** アルベドの線形平均。屋根の材質はこの逆数を掛けて基準の明るさに合わせる。 */
export function roofTexMean(): number {
  build();
  return texMean;
}

let albedo: CanvasTexture | null = null;
let normal: CanvasTexture | null = null;

/** sRGB バイト値へ（three が sRGB として読むので、ここでエンコードしておく）。 */
function toSrgbByte(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function build(): void {
  if (albedo || typeof document === 'undefined') return;

  const N = SIZE;
  const hs = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      hs[y * N + x] = heightAt((x + 0.5) / N, (y + 0.5) / N);
    }
  }

  const cA = document.createElement('canvas');
  cA.width = cA.height = N;
  const ctxA = cA.getContext('2d')!;
  const imgA = ctxA.createImageData(N, N);
  const cN = document.createElement('canvas');
  cN.width = cN.height = N;
  const ctxN = cN.getContext('2d')!;
  const imgN = ctxN.createImageData(N, N);

  // 1 テクセルが受け持つ実寸に対する起伏の比。ここが法線の効きになる。
  // 大きくすると瓦がプラスチックの型押しに見えるので、控えめに。
  // Δh 1 テクセルあたりの傾きが実寸の勾配と合う値は 1.0 前後
  // （瓦 1 枚 0.31m・山の高さ 4cm で計算）。少しだけ誇張してある。
  const NK = 1.25;
  let sum = 0;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const fx = ((x + 0.5) / N) * TILES_X;
      const fy = ((y + 0.5) / N) * TILES_Y;
      const ix = Math.floor(fx) % TILES_X;
      const iy = Math.floor(fy) % TILES_Y;
      const u = fx - Math.floor(fx);
      const v = fy - Math.floor(fy);

      // 明るさは主に断面（平部と山）で決める。
      // 葺き足の段差ぶんの持ち上がりまでそのまま明るさにすると、
      // 段の下端が横一直線に白く飛んで、瓦ではなく「格子の布」に見える。
      // 段差は影として下に落とすほうが読みやすい。
      const pan = panAt(u);
      let c = 0.54 + (rollAt(u) * 0.78 + stepAt(v) * 0.35 * pan) * 0.46;
      // 葺き足の段差の影。上の段の鼻が落とす影で、これが横線として読める。
      // **平部にだけ**落とす。山は段で切れないので、ここを一直線に引くと
      // 屋根が「目地の通った正方形タイル」に見えてしまう。
      c *= 1 - (1 - ss(0.0, 0.16, v)) * 0.50 * pan;
      // 継ぎ目の溝。縦線。桟瓦の並びはここでしか読めない。
      c *= 1 - ss(0.86, 1.0, u) * 0.54;
      // 1 枚ごとの焼きむら。瓦は 1 枚ずつ色が違うので、ここを入れないと
      // どれだけ起伏を作っても「同じ模様の反復」に見える。
      c *= 0.86 + h2(ix * 7 + 3, iy * 13 + 1) * 0.28;
      // 肌のざらつき（1 テクセル単位）。ミップで自然に消える。
      c *= 0.955 + h2((x * 3 + 11) % N, (y * 5 + 7) % N) * 0.09;

      // 焼き色のむら。いぶし瓦は青灰、素焼きは赤茶に寄る。
      // 屋根色そのものは instanceColor が決めるので、ここでは
      // ごく薄い色相のずれだけを入れる。
      const tint = h2(ix * 17 + 5, iy * 23 + 9) - 0.5;
      const r = c * (1 + tint * 0.07);
      const g = c;
      const b = c * (1 - tint * 0.07);
      sum += (r + g + b) / 3;

      const o = i * 4;
      imgA.data[o] = toSrgbByte(r);
      imgA.data[o + 1] = toSrgbByte(g);
      imgA.data[o + 2] = toSrgbByte(b);
      imgA.data[o + 3] = 255;

      // 法線。周期境界で折り返す（テクスチャは両方向に繰り返す）。
      const xm = (x + N - 1) % N;
      const xp = (x + 1) % N;
      const ym = (y + N - 1) % N;
      const yp = (y + 1) % N;
      const dhx = (hs[y * N + xp]! - hs[y * N + xm]!) * 0.5 * NK * TILES_X;
      const dhy = (hs[yp * N + x]! - hs[ym * N + x]!) * 0.5 * NK * TILES_Y;
      let nx = -dhx;
      let ny = -dhy;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      imgN.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      imgN.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      imgN.data[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      imgN.data[o + 3] = 255;
    }
  }
  texMean = sum / (N * N);

  ctxA.putImageData(imgA, 0, 0);
  ctxN.putImageData(imgN, 0, 0);

  albedo = new CanvasTexture(cA);
  albedo.wrapS = albedo.wrapT = RepeatWrapping;
  albedo.colorSpace = SRGBColorSpace;
  albedo.minFilter = LinearMipmapLinearFilter;
  albedo.generateMipmaps = true;
  // 屋根は俯瞰でほぼ必ず浅い角度で見えるので、異方性が効くかどうかで
  // 「瓦」と「ざらついた灰色」の差がそのまま出る。
  // ただし上げすぎると、瓦の格子と画素の格子が干渉してモアレが出る。
  albedo.anisotropy = 4;

  normal = new CanvasTexture(cN);
  normal.wrapS = normal.wrapT = RepeatWrapping;
  normal.colorSpace = NoColorSpace;
  normal.minFilter = LinearMipmapLinearFilter;
  normal.generateMipmaps = true;
  normal.anisotropy = 4;
}

/** 屋根のアルベド（無い環境では null）。 */
export function roofAlbedoTexture(): CanvasTexture | null {
  build();
  return albedo;
}

/** 屋根の法線マップ（無い環境では null）。 */
export function roofNormalTexture(): CanvasTexture | null {
  build();
  return normal;
}

/** 破棄（レイヤの dispose から呼ぶ）。 */
export function disposeRoofTextures(): void {
  albedo?.dispose();
  normal?.dispose();
  albedo = null;
  normal = null;
}
