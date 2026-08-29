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
 *   - 夜は露出を上げるのではなく、回り込み（半球ライト）を上げて稼ぐ。
 *     露出で持ち上げると、窓の灯りが先に 255 に張り付いて白い矩形になり、
 *     そのくせ壁は黒いままで、階調が 2 値になる
 *   - 日中は回り込み（半球ライト）を控えめにし、直射との差を開ける。
 *     環境光を上げると陰が消えて全部が平らな板になる。明るさは日射で稼ぐ。
 *   - 直射は暖色、回り込みは青。同じ白で照らすと日向と日陰が明度差だけの
 *     関係になり、画面全体が 1 つの灰色に沈む。色相を割ると情報量が倍になる。
 *   - 夜も半球の上下を割る。上＝冷たい微光、下＝街灯の橙の跳ね返り。
 *     無指向の 1 色で照らすと、夜が「昼を暗くしただけ」に見える。
 * の 3 点が絵の印象を決める。
 */
const KEYFRAMES: Keyframe[] = [
  //   h   zenith    horizon   sun       int   skyLt     grndLt    amb   exp   star  night
  key(0, 0x080d1c, 0x141d33, 0x8ea2d8, 0.5, 0x46608f, 0x4a3520, 0.95, 1.06, 1, 1),
  key(4.4, 0x0a1020, 0x18223a, 0x8ea2d8, 0.52, 0x486293, 0x4b3721, 0.97, 1.05, 0.95, 1),
  key(5.3, 0x1b2748, 0x53415a, 0xc08a84, 0.62, 0x6a82c8, 0x3a3742, 1.0, 1.08, 0.35, 0.85),
  key(6.2, 0x39527f, 0xc07a58, 0xff9e64, 1.4, 0x6079cc, 0x473e36, 0.5, 1.12, 0, 0.35),
  key(7.4, 0x3f6ea6, 0xbfc9cd, 0xffe3bc, 1.7, 0x86aae2, 0x6f6450, 0.46, 1.0, 0, 0.05),
  key(9.5, 0x2f6fb4, 0xc2d3e0, 0xfff1dc, 2.45, 0x93bcf0, 0x7a715a, 0.5, 0.95, 0, 0),
  key(12, 0x2a68b8, 0xcadbe8, 0xfff1dc, 2.8, 0x9fc4ff, 0x6b6250, 0.54, 0.92, 0, 0),
  key(15, 0x2f6fb4, 0xc6d6e4, 0xfff0d6, 2.5, 0x95bdf4, 0x78705c, 0.5, 0.95, 0, 0),
  key(17.2, 0x3a68a2, 0xd7b489, 0xffcf98, 1.75, 0x7799e4, 0x6b6050, 0.46, 1.0, 0, 0.05),
  key(18.3, 0x39406f, 0xd98a52, 0xff8e50, 1.35, 0x5f76c8, 0x463c34, 0.5, 1.1, 0, 0.45),
  key(19.2, 0x1d2445, 0x6a4358, 0xb87280, 0.62, 0x536fb4, 0x503a24, 0.95, 1.08, 0.3, 0.85),
  key(20.2, 0x0b1120, 0x1b2540, 0x8ea2d8, 0.52, 0x476190, 0x4a3621, 0.96, 1.06, 0.85, 1),
  key(24, 0x080d1c, 0x141d33, 0x8ea2d8, 0.5, 0x46608f, 0x4a3520, 0.95, 1.06, 1, 1),
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
  // 仰角の頂点は 38 度に抑える。真上から照らすと影が建物の真下に隠れ、
  // 街全体が「陰影の無い塗り絵」になる。46 度でも俯瞰では影が建物に隠れて
  // 街区に落ちなかったので、実際の南中高度より低く倒してある。
  // 物理的な正しさより、「高さが影として読める」ほうを取る。
  const maxEl = night ? MathUtils.degToRad(32) : MathUtils.degToRad(38);
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
  uniform float uTime;
  uniform float uCloud;

  // 星用の安いハッシュノイズ
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  // 雲用の 2 次元ノイズ（値ノイズ + 3 オクターブ）
  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * vnoise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return v;
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

    // 雲。無地のグラデーションだけの空は、それだけで書き割りに見える。
    // ライティングは要らない。天球を平面に投影して薄い層を 2 枚重ね、
    // 太陽側だけ縁を明るくすれば、高層雲としては十分に通る。
    if (uCloud > 0.001 && up > -0.02) {
      vec2 uv = dir.xz / max(up + 0.14, 0.14);
      float n = fbm(uv * 0.55 + vec2(uTime * 0.004, uTime * 0.0016));
      float n2 = fbm(uv * 1.7 - vec2(uTime * 0.009, 0.0));
      // fbm は 4 オクターブを平均するので、値は 0.47 付近に集まり、
      // 分布の幅は ±0.12 ほどしかない。前は窓を 0.46〜0.82 に置いていたので
      // 分布の裾しか拾えず、被覆率が数 % ＝ 実質 1 枚も出ていなかった。
      // 窓は必ず分布の中心にまたがるように置く。
      float v = n * 0.72 + n2 * 0.48;
      float density = smoothstep(0.50, 0.70, v);
      // 地平線近くは雲が重なって見えるので厚く、天頂は薄く
      density *= mix(1.0, 0.55, clamp(up, 0.0, 1.0));
      density *= uCloud;
      // 太陽側の縁を明るく（銀縁）
      float rim = pow(max(cosA, 0.0), 3.0);
      // 雲は「空より明るい白」でなければ雲に見えない。地平線側の空は
      // すでに白く霞んでいるので、そこに空の色を混ぜた灰色を置いても
      // 完全に埋もれる（実際それで 1 枚も見えていなかった）。
      // 日向側は白、日陰側は青灰に振って、塊としての厚みを出す。
      float shade = 1.0 - density * 0.45;
      vec3 lit = mix(vec3(0.92, 0.94, 0.97), uSunColor, 0.22) * clamp(uSunIntensity * 0.55, 0.18, 1.15);
      vec3 dark = mix(uZenith, vec3(0.35, 0.39, 0.46), 0.5);
      vec3 cloudCol = mix(dark, lit, shade);
      cloudCol += uSunColor * rim * 0.5 * clamp(uSunIntensity, 0.1, 2.0);
      col = mix(col, cloudCol, clamp(density, 0.0, 0.94));
    }

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
        uTime: { value: 0 },
        uCloud: { value: 0.55 },
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

  update(
    atmo: Atmosphere,
    sunDir: Vector3,
    cameraPos: { x: number; y: number; z: number },
    elapsed = 0,
  ): void {
    const u = this.material.uniforms;
    (u.uZenith!.value as Color).copy(atmo.zenith);
    (u.uHorizon!.value as Color).copy(atmo.horizon);
    (u.uSunColor!.value as Color).copy(atmo.sunColor);
    (u.uSunDir!.value as Vector3).copy(sunDir);
    u.uSunIntensity!.value = atmo.sunIntensity;
    u.uStars!.value = atmo.starAmount;
    u.uTime!.value = elapsed;
    // 夜は雲を薄くする。暗い空に灰色の雲を敷くと、星が消えて濁るだけになる。
    // 夜も雲は残す。星だけの無地の空は、かえって書き割りに見える。
    u.uCloud!.value = 0.78 - atmo.nightAmount * 0.16;
    this.mesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
