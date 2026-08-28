import { MeshStandardMaterial } from 'three';
import { surface } from './materials';

/**
 * 動くもの（車両・人）の材質。
 *
 * 車体・窓・タイヤを 1 つのメッシュに焼き固めている都合で、これまで材質は
 * 1 台につき 1 つしか持てなかった。頂点カラーは `vColor = 頂点色 × instanceColor`
 * と掛け算されるので、窓は必ず「車体色 × 暗い灰」になる。
 * 白い車ならそれで正しいが、黒い車・紺の車では窓が RGB ほぼ 0 に潰れ、
 * 昼の路上でも車の上半分が真っ黒な天蓋になってしまっていた。
 * ガラスは空を映すものなので、屋外の昼にこの暗さはあり得ない。
 *
 * かといってガラスを別メッシュに割ると、車種 3 + トラック + バス + 電車 3 で
 * 8 ドローコール増える。そこで **頂点属性 1 本（`aGlass`）で
 * 「ここはガラス」と印を付け、シェーダの側で materials を切り替える**。
 * ドローコールは 1 つも増えず、ガラスだけを
 *
 *   - 車体色の変調から外す（絶対色にする）
 *   - ほぼ鏡（粗さ 0.07・金属度 0.94）にして環境マップ＝空を映す
 *
 * ことができる。角度によって空が映り込んで明るくなるのが正しい見え方で、
 * これは頂点カラーでは絶対に作れない。
 *
 * もう 1 つ、**夜の読めなさ**もここで直す。夜の車体は物理的には正しく真っ黒に
 * なるのだが、絵としては前照灯だけが飛んでいて車が消える。街灯の光を拾って
 * いる想定のごく弱い自発光を足すと、シルエットが戻ってくる。
 * 量は「一律の下駄 + 車体色に比例した分」にしてある。比例分だけだと
 * 黒い車が黒いままで、下駄だけだと白い車も黒い車も同じ明るさになる。
 */

/** ガラス部分に 1 を立てる頂点属性の名前。 */
export const GLASS_ATTRIBUTE = 'aGlass';

/**
 * ガラスの絶対色（＝金属度を上げたときの反射色）。
 * 空色に寄せた明るい青灰。ここが暗いと結局ガラスが黒くなる。
 */
const GLASS_TINT = 'vec3(0.44, 0.49, 0.55)';
/** ガラスの粗さと金属度。ほぼ鏡にして環境マップを拾わせる。 */
const GLASS_ROUGHNESS = '0.07';
const GLASS_METALNESS = '0.94';
/** ガラスだけ環境マップを強く拾わせる倍率。 */
const GLASS_ENV_GAIN = '2.0';

/** 夜の持ち上げ量。一律の下駄と、車体色に比例する分。 */
const NIGHT_FLOOR = 0.05;
const NIGHT_TINT = 0.1;

export interface AgentSurfaceOptions {
  roughness: number;
  metalness: number;
  envMapIntensity?: number;
  /** ガラス（`aGlass` 属性）を持つジオメトリに使うか。 */
  glass?: boolean;
  /** 夜の持ち上げの強さ。人は車より弱くする。 */
  nightLift?: number;
}

/** 材質と、毎フレーム書き換える夜の量（uniform と同じオブジェクトを共有する）。 */
export interface AgentSurface {
  material: MeshStandardMaterial;
  /** `atmosphereAt().nightAmount` をそのまま入れる。 */
  night: { value: number };
}

export function agentSurface(o: AgentSurfaceOptions): AgentSurface {
  const material = surface({
    vertexColors: true,
    roughness: o.roughness,
    metalness: o.metalness,
    envMapIntensity: o.envMapIntensity ?? 1,
  });
  const night = { value: 0 };
  const glass = o.glass === true;
  const floor = (NIGHT_FLOOR * (o.nightLift ?? 1)).toFixed(4);
  const tint = (NIGHT_TINT * (o.nightLift ?? 1)).toFixed(4);

  material.onBeforeCompile = (shader) => {
    // uniform には同じオブジェクトを差す。以後 night.value を書き換えるだけで届く。
    shader.uniforms.uNight = night;

    if (glass) {
      shader.vertexShader = `attribute float ${GLASS_ATTRIBUTE};\nvarying float vGlass;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `vGlass = ${GLASS_ATTRIBUTE};\n\t#include <begin_vertex>`,
      );
    }

    let fs = `uniform float uNight;\n${glass ? 'varying float vGlass;\n' : ''}${shader.fragmentShader}`;
    if (glass) {
      fs = fs
        // 車体色の変調を捨てて絶対色にする。ここがガラスが黒くならない理由。
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, ${GLASS_TINT}, vGlass);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, ${GLASS_ROUGHNESS}, vGlass);`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>\n\tmetalnessFactor = mix(metalnessFactor, ${GLASS_METALNESS}, vGlass);`,
        )
        // 空の映り込みそのものを強める。金属度だけだと日陰の車で足りない。
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>\n\tradiance *= mix(1.0, ${GLASS_ENV_GAIN}, vGlass);`,
        );
    }
    fs = fs.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += uNight * (vec3(${floor}) + diffuseColor.rgb * ${tint});`,
    );
    shader.fragmentShader = fs;
  };
  // 同じ差し込みをした材質どうしはプログラムを共有させる（コンパイル 1 回で済む）。
  material.customProgramCacheKey = () => `agent:${glass ? 'g' : '-'}:${floor}:${tint}`;

  return { material, night };
}
