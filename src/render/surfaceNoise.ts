import { Vector4, type MeshStandardMaterial } from 'three';

/**
 * 「世界座標のノイズで材質を揺らす」シェーダの差し込み。
 *
 * 路面・地面・歩道が単色の板に見える原因は、モデルの粗さではなく
 * **1 つの面の中に情報が 1 つも無いこと** にある。目線の高さでは画面の
 * 3〜4 割が路面なので、そこが一色だとカット全体が未完成に見える。
 *
 * ふつうはテクスチャを貼るところだが、ここでは 2 つの理由でシェーダに焼く。
 *
 * **1. UV が使えない。** 路面は 1×1 の板を交差点・腕・歩道と別々の倍率で
 * 敷いているので、板ごとに UV の密度が違う。テクスチャを貼ると板の継ぎ目に
 * 密度の段差が出て、かえって「タイルを並べた」感じが強まる。
 * 世界座標で引けば、板をどう割ろうと模様は連続する。
 *
 * **2. 画像を持ちたくない。** 外部ファイルを増やさずに済むうえ、
 * 粗さと法線を同じノイズから作れるので「色が濃いところは粗い」という
 * 相関が自動的に付く（実際の骨材の出方もそうなっている）。
 *
 * 距離でディテールを消すのも肝で、遠景では 1 画素を割った揺らぎが
 * ちらつきにしかならない。`fade` を越えたら素の材質に戻す。
 */
export interface SurfaceNoiseOptions {
  /** ノイズ 1 周期のおおよその長さ (m)。 */
  scale?: number;
  /** 色の振れ幅（1 に対する比）。0.06 で「わずかにまだら」。 */
  color?: number;
  /** 粗さの振れ幅（絶対値）。乾いた舗装は 0.6〜0.8 の間で揺れている。 */
  roughness?: number;
  /** 法線の傾き。0.02 前後で「ざらつき」、0.06 で「荒れた舗装」。 */
  bump?: number;
  /** ここまでの距離でディテールが消える (m)。 */
  fade?: number;
  /**
   * 間接反射（空の映り込み）の掛け率。1 で素のまま、0.2 でほぼ消す。
   *
   * **目線の高さで路面が白い板になる原因はここ**だった。環境マップは
   * 「空を丸ごと見渡せる場所」の probe を 1 つだけ焼いたもので、遮蔽を持たない。
   * ところが街路の路面が実際に見ている空は、両側のビルに挟まれた細い帯でしかない。
   * さらに視線が水平に近づくほどフレネル反射が 1 に近づくので、
   * 過大な probe がそのまま乗って、albedo 3% のアスファルトが
   * 27% の明るさで描かれていた（実測）。加算で乗る光は**比を潰す**ので、
   * 白線も轍もマンホールも骨材のムラも、全部その中に沈んで消える。
   * 路面が「一色の板」に見えていた最大の原因はこれ。
   *
   * 正しくは probe に遮蔽を持たせるべきだが、街路 1 本ごとに probe は焼けない。
   * 上を向いた面の間接**鏡面**だけを落とすのが、いちばん安くて外さない近似。
   * 間接拡散（空のフィル光）は残すので、日陰の路面が黒く潰れることはない。
   */
  specular?: number;
  /**
   * 舗装の目地・継ぎ目。世界座標の格子に沿った、わずかに暗く粗い帯。
   *
   * `spacing` が間隔 (m)、`width` が帯の幅 (m)、`darken` が暗くする割合。
   * 道路も歩道も軸に平行なので、世界座標の XZ 格子がそのまま
   * 「舗装の打ち継ぎ」「平板の目地」の向きに一致する。
   * 線を 1px の細さで描くと遠くでちらつくので、実寸の帯として
   * ぼかしたまま置き、距離で早めに消す。
   */
  seam?: { spacing: number; width: number; darken: number };
}

/** 差し込むノイズ関数。値ノイズ 2 オクターブ。安いほうを優先する。 */
const NOISE_GLSL = /* glsl */ `
float snHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float snValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(snHash(i), snHash(i + vec2(1.0, 0.0)), u.x),
    mix(snHash(i + vec2(0.0, 1.0)), snHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float snFbm(vec2 p) {
  return snValue(p) * 0.62 + snValue(p * 2.7 + 11.3) * 0.26 + snValue(p * 6.1 + 3.7) * 0.12;
}
`;

/**
 * 材質にノイズを差し込む。同じ材質に 2 回呼んではいけない。
 *
 * `customProgramCacheKey` を上書きしているのは、three が「同じ種類の材質」を
 * 1 つのプログラムに束ねてしまうため。差し込む定数が違えば別のプログラムに
 * したいので、鍵にパラメータを混ぜる。
 */
export function applySurfaceNoise(mat: MeshStandardMaterial, opts: SurfaceNoiseOptions = {}): void {
  const params = new Vector4(
    Math.max(0.05, opts.scale ?? 6),
    opts.color ?? 0.06,
    opts.roughness ?? 0.12,
    opts.bump ?? 0.03,
  );
  const fade = opts.fade ?? 260;
  const specular = opts.specular ?? 1;
  // 目地は [間隔, 帯の半幅, 暗くする割合]。無効なら間隔 0 で分岐ごと落とす。
  const seam = new Vector4(
    opts.seam ? Math.max(0.05, opts.seam.spacing) : 0,
    opts.seam ? Math.max(0.005, opts.seam.width) * 0.5 : 0,
    opts.seam ? opts.seam.darken : 0,
    0,
  );
  const key = `sn:${params.x},${params.y},${params.z},${params.w},${fade},${specular},${seam.x},${seam.y},${seam.z}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSurfNoise = { value: params };
    shader.uniforms.uSurfFade = { value: fade };
    shader.uniforms.uSurfSeam = { value: seam };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 surfWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          surfWorld = instanceMatrix * surfWorld;
        #endif
        vSurfPos = (modelMatrix * surfWorld).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vSurfPos;
        uniform vec4 uSurfNoise;
        uniform vec4 uSurfSeam;
        uniform float uSurfFade;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 surfUv = vSurfPos.xz / uSurfNoise.x;
        // 画面上でノイズ 1 周期が何画素あるかを微分で測り、1 画素を割ったら振幅を 0 にする。
        //
        // 距離だけで消していたのでは足りない。目線の高さでは路面も地面も
        // 視線に対してほぼ寝ているので、カメラから 30m の地点でも
        // 画面上では 1 周期が 1 画素を割る。そこに振幅を残すと、
        // 標本化できない周波数がそのまま**フィルタの掛かっていない白い点**として
        // 出る（画面全体に散る「ビデオノイズ」の正体）。
        // fwidth は隣の画素との差なので、傾きでも距離でも同じ尺度で効く。
        vec2 surfDx = vec2(fwidth(surfUv.x), fwidth(surfUv.y));
        float surfPix = max(surfDx.x, surfDx.y);
        float surfSharp = 1.0 - smoothstep(0.22, 0.8, surfPix);
        float surfFade = (1.0 - smoothstep(uSurfFade * 0.5, uSurfFade, distance(cameraPosition, vSurfPos))) * surfSharp;
        float surfN = snFbm(surfUv) - 0.5;
        // 勾配は隣を 2 回引いて差分で取る。専用のノイズ微分を書くより安い。
        float surfNx = snFbm(surfUv + vec2(0.16, 0.0)) - 0.5;
        float surfNz = snFbm(surfUv + vec2(0.0, 0.16)) - 0.5;
        #include <map_fragment>
        diffuseColor.rgb *= 1.0 + surfN * uSurfNoise.y * 2.0 * surfFade;
        // 目地。格子までの距離を実寸で測り、帯の中だけ暗くする。
        // 位相をノイズでわずかに曲げてあるのは、定規で引いた線に見せないため。
        // ここでは値を作るだけで、当てるのは法線が出てから（上向きの面に限る）。
        float surfSeam = 0.0;
        if (uSurfSeam.x > 0.0) {
          vec2 seamP = (vSurfPos.xz + surfN * 0.16) / uSurfSeam.x;
          vec2 seamD = abs(fract(seamP + 0.5) - 0.5) * uSurfSeam.x;
          float seamNear = min(seamD.x, seamD.y);
          // 目地は近景専用。ノイズより早く（半分の距離で）消す。
          float seamFade = (1.0 - smoothstep(uSurfFade * 0.16, uSurfFade * 0.42, distance(cameraPosition, vSurfPos))) * surfSharp;
          surfSeam = (1.0 - smoothstep(uSurfSeam.y * 0.35, uSurfSeam.y, seamNear)) * seamFade;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        // 下限を 0.04 から 0.35 に上げた。ノイズの谷で粗さが 0 に近づくと、
        // 鏡面ローブが 1 画素に収束して**空の輝度がそのまま点として出る**
        // （引きの画で地面に散っていた白い点＝firefly）。
        // 路面も地面もコンクリートも、実物の粗さが 0.35 を下回ることはない。
        roughnessFactor = clamp(roughnessFactor + surfN * uSurfNoise.z * 2.0 * surfFade, 0.35, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        // 揺らすのは「上を向いた面」だけ。normal はビュー空間なので、
        // 視線基準の y を見ると目線の高さで壁まで波打つ。
        // ビュー行列の転置（＝逆回転）を掛けて世界の上下で判定する。
        vec3 surfWorldN = normal * mat3(viewMatrix);
        float surfUp = smoothstep(0.55, 0.9, surfWorldN.y);
        vec3 surfBump = vec3(surfNx - surfN, 0.0, surfNz - surfN) * uSurfNoise.w * 13.0;
        normal = normalize(normal + mat3(viewMatrix) * surfBump * surfFade * surfUp);
        // 目地を当てるのはここ。上向きの面だけに限るのが肝で、世界座標の
        // 格子をそのまま掛けると、縁石の立ち上がり（x が一定の縦面）が
        // 格子の線に当たったときに**面まるごと 1 本の縞**になる。
        // 目地は砂と土が詰まっているので、色だけでなく粗さも上げる。
        // 暗いだけの線は「描いた線」に見えるが、粗さが変わると溝に見える。
        float surfSeamUp = surfSeam * surfUp;
        diffuseColor.rgb *= 1.0 - surfSeamUp * uSurfSeam.z;
        roughnessFactor = clamp(roughnessFactor + surfSeamUp * 0.22, 0.35, 1.0);`,
      );

    if (specular < 1) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // 空の映り込みを上向きの面だけ弱める（SurfaceNoiseOptions.specular を参照）。
        // 壁や縁石の立ち上がりまで落とすと、こんどは陰の面が死ぬので、
        // 法線の上向き成分で重み付けする。
        {
          vec3 specWorldN = normal * mat3(viewMatrix);
          float specUp = smoothstep(0.3, 0.85, specWorldN.y);
          reflectedLight.indirectSpecular *= mix(1.0, ${specular.toFixed(3)}, specUp);
        }`,
      );
    }
  };
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}
