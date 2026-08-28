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
  const key = `sn:${params.x},${params.y},${params.z},${params.w},${fade}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSurfNoise = { value: params };
    shader.uniforms.uSurfFade = { value: fade };

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
        uniform float uSurfFade;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `float surfFade = 1.0 - smoothstep(uSurfFade * 0.5, uSurfFade, distance(cameraPosition, vSurfPos));
        vec2 surfUv = vSurfPos.xz / uSurfNoise.x;
        float surfN = snFbm(surfUv) - 0.5;
        // 勾配は隣を 2 回引いて差分で取る。専用のノイズ微分を書くより安い。
        float surfNx = snFbm(surfUv + vec2(0.16, 0.0)) - 0.5;
        float surfNz = snFbm(surfUv + vec2(0.0, 0.16)) - 0.5;
        #include <map_fragment>
        diffuseColor.rgb *= 1.0 + surfN * uSurfNoise.y * 2.0 * surfFade;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + surfN * uSurfNoise.z * 2.0 * surfFade, 0.04, 1.0);`,
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
        normal = normalize(normal + mat3(viewMatrix) * surfBump * surfFade * surfUp);`,
      );
  };
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}
