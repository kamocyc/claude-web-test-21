import {
  BackSide,
  Color,
  MathUtils,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

/**
 * 空と大気。
 *
 * 以前は「時刻を 5 区分して単色を切り替える」だけだった。空が一枚の平らな色だと、
 * どれだけ建物を作り込んでも書き割りの前に立っているようにしか見えない。
 * 実際の空は天頂が濃く、地平線に向かって白く霞み、太陽の周りだけ明るい。
 * その 3 つを入れるだけで奥行きが出る。
 *
 * ここでは
 *   - 時刻ごとの大気パラメータ（天頂色・地平色・日射色・強さ・露出）を連続補間し、
 *   - それをドーム状のシェーダで描き、
 *   - 同じ値をフォグ・環境光・トーンマッピング露出にも配る。
 * 「空・光・霞が食い違わない」ことが、絵をまとまって見せる一番の近道になる。
 */

/** 1 日のうちのある時刻における大気の状態。 */
export interface Atmosphere {
  /** 天頂の色。 */
  zenith: Color;
  /** 地平線の色（フォグの色でもある）。 */
  horizon: Color;
  /** 太陽（夜は月）の光の色。 */
  sunColor: Color;
  /** 太陽光の強さ。 */
  sunIntensity: number;
  /** 空からの回り込み（半球ライトの上側）。 */
  skyLight: Color;
  /** 地面からの照り返し（半球ライトの下側）。 */
  groundLight: Color;
  /** 半球ライトの強さ。 */
  ambientIntensity: number;
  /** トーンマッピングの露出。 */
  exposure: number;
  /** 星の見え具合 0..1。 */
  starAmount: number;
  /** 窓の灯りなどの「夜らしさ」0..1。建物レイヤの点灯判定にも使う。 */
  nightAmount: number;
}

/** 時刻キーフレーム。h は 0..24。間は線形補間する。 */
interface Keyframe extends Atmosphere {
  h: number;
}

const key = (
  h: number,
  zenith: number,
  horizon: number,
  sunColor: number,
  sunIntensity: number,
  skyLight: number,
  groundLight: number,
  ambientIntensity: number,
  exposure: number,
  starAmount: number,
  nightAmount: number,
): Keyframe => ({
  h,
  zenith: new Color(zenith),
  horizon: new Color(horizon),
  sunColor: new Color(sunColor),
  sunIntensity,
  skyLight: new Color(skyLight),
  groundLight: new Color(groundLight),
  ambientIntensity,
  exposure,
  starAmount,
  nightAmount,
});

/**
 * 1 日の大気。深夜 → 薄明 → 朝焼け → 午前 → 正午 → 午後 → 夕焼け → 薄暮 → 深夜。
 *
 * 数字は「写真で見た日本の空」に寄せてある。とくに
 *   - 朝夕は日射が橙〜赤に寄り、強さが落ちるぶん露出を上げる
 *   - 夜は月光（青）を弱く残す。真っ暗にすると街の造形が全部消える
 *   - 日中は回り込み（半球ライト）を控えめにし、直射との差を開ける。
 *     環境光を上げると陰が消えて全部が平らな板になる。明るさは日射で稼ぐ。
 * の 3 点が絵の印象を決める。
 */
const KEYFRAMES: Keyframe[] = [
  //   h   zenith    horizon   sun       int   skyLt     grndLt    amb   exp   star  night
  key(0, 0x080d1c, 0x141d33, 0x8ea2d8, 0.42, 0x33436e, 0x1a1f2c, 0.62, 1.3, 1, 1),
  key(4.4, 0x0a1020, 0x18223a, 0x8ea2d8, 0.44, 0x36476f, 0x1c2130, 0.64, 1.28, 0.95, 1),
  key(5.3, 0x1b2748, 0x53415a, 0xc08a84, 0.55, 0x4a5a84, 0x2c262e, 0.7, 1.2, 0.35, 0.85),
  key(6.2, 0x39527f, 0xc07a58, 0xff9a5e, 0.72, 0x6c7fa8, 0x4a3a2e, 0.6, 1.12, 0, 0.35),
  key(7.4, 0x3f6ea6, 0xbfc9cd, 0xffd9b0, 1.55, 0x8fb0d4, 0x6a6152, 0.5, 1.0, 0, 0.05),
  key(9.5, 0x2f6fb4, 0xc2d3e0, 0xfff0da, 2.25, 0x9dc0e4, 0x77705d, 0.54, 0.95, 0, 0),
  key(12, 0x2a68b8, 0xcadbe8, 0xfff6e8, 2.6, 0xa6c8ea, 0x7d7663, 0.58, 0.92, 0, 0),
  key(15, 0x2f6fb4, 0xc6d6e4, 0xfff0d6, 2.3, 0x9dc0e4, 0x7a7360, 0.55, 0.95, 0, 0),
  key(17.2, 0x3a68a2, 0xd7b489, 0xffd3a0, 1.5, 0x8ea8cc, 0x6d6050, 0.5, 1.0, 0, 0.05),
  key(18.3, 0x39406f, 0xd98a52, 0xff8a4a, 0.65, 0x6a6f96, 0x4a382c, 0.58, 1.1, 0, 0.45),
  key(19.2, 0x1d2445, 0x6a4358, 0xb87280, 0.55, 0x47507e, 0x2b232c, 0.7, 1.2, 0.3, 0.85),
  key(20.2, 0x0b1120, 0x1b2540, 0x8ea2d8, 0.44, 0x35456c, 0x1b202d, 0.63, 1.3, 0.85, 1),
  key(24, 0x080d1c, 0x141d33, 0x8ea2d8, 0.42, 0x33436e, 0x1a1f2c, 0.62, 1.3, 1, 1),
];

const current: Atmosphere = {
  zenith: new Color(),
  horizon: new Color(),
  sunColor: new Color(),
  sunIntensity: 1,
  skyLight: new Color(),
  groundLight: new Color(),
  ambientIntensity: 1,
  exposure: 1,
  starAmount: 0,
  nightAmount: 0,
};

/** 滑らかな補間。線形のままだと正午前後で日射の変化が折れ線に見える。 */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * その時刻の大気を返す。返り値は使い回しの 1 個なので、跨いで保持しないこと。
 * @param dayFraction 0..1（0 = 深夜 0 時）
 */
export function atmosphereAt(dayFraction: number, out: Atmosphere = current): Atmosphere {
  const h = ((dayFraction % 1) + 1) % 1 * 24;
  let i = 0;
  while (i < KEYFRAMES.length - 2 && KEYFRAMES[i + 1]!.h <= h) i++;
  const a = KEYFRAMES[i]!;
  const b = KEYFRAMES[i + 1]!;
  const span = Math.max(1e-6, b.h - a.h);
  const t = smooth(Math.max(0, Math.min(1, (h - a.h) / span)));
  out.zenith.copy(a.zenith).lerp(b.zenith, t);
  out.horizon.copy(a.horizon).lerp(b.horizon, t);
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.skyLight.copy(a.skyLight).lerp(b.skyLight, t);
  out.groundLight.copy(a.groundLight).lerp(b.groundLight, t);
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
  out.ambientIntensity = a.ambientIntensity + (b.ambientIntensity - a.ambientIntensity) * t;
  out.exposure = a.exposure + (b.exposure - a.exposure) * t;
  out.starAmount = a.starAmount + (b.starAmount - a.starAmount) * t;
  out.nightAmount = a.nightAmount + (b.nightAmount - a.nightAmount) * t;
  return out;
}

/**
 * 太陽（夜は月）の方向ベクトル（地面から光源へ向かう単位ベクトル）。
 *
 * 東（+X 側）から昇って西へ沈む。真南に寄せた軌道にしてあるので、
 * 影が真上から落ちる時間が無く、1 日を通してどこかしらに影が伸びる。
 * 夜は同じ軌道の 12 時間ずらし（＝月）を使い、地平線下には潜らせない。
 */
export function sunDirection(dayFraction: number, out = new Vector3()): Vector3 {
  const h = ((dayFraction % 1) + 1) % 1 * 24;
  // 5 時に昇り 19 時に沈む想定。0..1 が日中の進行度。
  let progress = (h - 5) / 14;
  let night = false;
  if (progress < 0 || progress > 1) {
    // 夜は月。19 時 → 翌 5 時を 0..1 に写す。
    night = true;
    const nh = h < 5 ? h + 5 : h - 19;
    progress = nh / 10;
  }
  // 方位: 0 = 東、π/2 = 南、π = 西
  const az = progress * Math.PI;
  // 仰角の頂点は 46 度に抑える。真上から照らすと影が建物の真下に隠れ、
  // 街全体が「陰影の無い塗り絵」になる。斜めから当てて初めて、
  // 建物の高さ・軒の出・道路の谷が影として読めるようになる。
  const maxEl = night ? MathUtils.degToRad(38) : MathUtils.degToRad(46);
  // 地平線ぎりぎりまで下げると影が画面の端まで伸びて破綻するので、下限を置く
  const el = Math.max(MathUtils.degToRad(9), Math.sin(az) * maxEl);
  const cosEl = Math.cos(el);
  return out.set(Math.cos(az) * cosEl, Math.sin(el), -Math.sin(az) * cosEl).normalize();
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // ドームはカメラに追従させるので、位置は view 行列の回転成分だけを使う
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // 常に最遠面
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunIntensity;
  uniform float uStars;

  // 星用の安いハッシュノイズ
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, -1.0, 1.0);

    // 天頂 → 地平のグラデーション。地平近くを厚くするため指数を掛ける。
    float t = pow(clamp(up, 0.0, 1.0), 0.42);
    vec3 col = mix(uHorizon, uZenith, t);
    // 地平線のすぐ上を少しだけ明るく霞ませる（空気遠近）
    float haze = exp(-max(up, 0.0) * 9.0);
    col = mix(col, uHorizon * 1.06, haze * 0.55);
    // 地平線より下（地面が途切れた先）は霞の色で埋める
    col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.12, up));

    // 太陽の周りの輝き。ディスク本体 + 広いグロー。
    float cosA = dot(dir, normalize(uSunDir));
    float glow = pow(max(cosA, 0.0), 34.0) * 0.55 + pow(max(cosA, 0.0), 6.0) * 0.16;
    float disc = smoothstep(0.9986, 0.9995, cosA);
    col += uSunColor * (glow + disc * 6.0) * clamp(uSunIntensity, 0.15, 2.4);

    // 星。天頂ほど濃く、地平では霞に負ける。
    if (uStars > 0.001) {
      vec3 cell = floor(dir * 260.0);
      float n = hash(cell);
      float star = smoothstep(0.9972, 0.9995, n) * smoothstep(0.02, 0.35, up);
      col += vec3(0.85, 0.9, 1.0) * star * uStars * 1.4;
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/**
 * 空のドーム。カメラに追従する（＝常に無限遠にある）ので、
 * どれだけ引いても空の見え方が変わらない。
 */
export class SkyDome {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor(radius = 4000) {
    this.material = new ShaderMaterial({
      uniforms: {
        uZenith: { value: new Color(0x2a68b8) },
        uHorizon: { value: new Color(0xcadbe8) },
        uSunColor: { value: new Color(0xfff6e8) },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunIntensity: { value: 1 },
        uStars: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new Mesh(new SphereGeometry(radius, 32, 20), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }

  /** 同じマテリアルを共有する 2 枚目（環境マップ生成用のシーンに置く）。 */
  clone(radius = 10): Mesh {
    const m = new Mesh(new SphereGeometry(radius, 24, 16), this.material);
    m.frustumCulled = false;
    return m;
  }

  update(atmo: Atmosphere, sunDir: Vector3, cameraPos: { x: number; y: number; z: number }): void {
    const u = this.material.uniforms;
    (u.uZenith!.value as Color).copy(atmo.zenith);
    (u.uHorizon!.value as Color).copy(atmo.horizon);
    (u.uSunColor!.value as Color).copy(atmo.sunColor);
    (u.uSunDir!.value as Vector3).copy(sunDir);
    u.uSunIntensity!.value = atmo.sunIntensity;
    u.uStars!.value = atmo.starAmount;
    this.mesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
