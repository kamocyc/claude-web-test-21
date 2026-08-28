import { Color, MeshStandardMaterial } from 'three';
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
 * かといってガラスを別メッシュに割ると、車種 5 + トラック + バス + 電車 3 で
 * 10 ドローコール増える。そこで **頂点属性 1 本（`aGlass`）で
 * 「ここはガラス」と印を付け、シェーダの側で塗り分ける**。
 * ドローコールは 1 つも増えず、ガラスだけを
 *
 *   - 車体色の変調から外す（暗い地の色にする）
 *   - 反射だけで明るさを作る（空・地平・路面の 3 段 ＋ フレネル）
 *
 * ことができる。**ガラスは反射しか材質の証明を持たない**。地を明るい灰色に
 * 塗ると、黒い天蓋は直っても今度は「白く塗った板」になる。明るさは
 * 必ず反射の側から来なければならない。
 *
 * もう 1 つ、**夜の読めなさ**もここで直す。夜の車体は物理的には正しく真っ黒に
 * なるのだが、絵としては前照灯だけが飛んでいて車が消える。街灯の光を拾って
 * いる想定のごく弱い自発光を足すと、シルエットが戻ってくる。
 * 量は「一律の下駄 + 車体色に比例した分」にしてある。比例分だけだと
 * 黒い車が黒いままで、下駄だけだと白い車も黒い車も同じ明るさになる。
 */

/**
 * ガラス部分に印を付ける頂点属性の名前。
 *
 * 値は **0 = 不透明部・1..2 = ガラス**。1 を足したうえで小数部に
 * 「そのガラスの中での高さ（0 = 下端、1 = 上端）」を載せてある。
 * varying を 1 本増やさずに「ここはガラス」と「窓の上下」を同時に運ぶための
 * 詰め方で、フラグメント側で `step` と `fract` 相当の 2 つに割って使う。
 * 窓 1 枚の中に上下の階調を作るのに、この高さがどうしても要る。
 */
export const GLASS_ATTRIBUTE = 'aGlass';

/**
 * 「インスタンス色（＝服の色）の変調を受けない」部位に 1 を立てる頂点属性。
 *
 * 人は 1 人 1 インスタンス色で服を塗り分けるが、three は
 * `vColor = 頂点色 × instanceColor` と掛け算するので、**肌も髪も靴も
 * 服の色に染まる**。そのため服の色は「暗すぎず明るすぎない中間色」にしか
 * できず、結果として街じゅうの人が同じような薄い色の服を着ることになっていた。
 *
 * 印の付いた頂点だけ頂点シェーダで `vColor` を頂点色そのものへ戻す。
 * これで黒いスーツも白いシャツも置けるようになり、顔は肌色のままでいられる。
 * フラグメント側には一切手を入れないので、費用は属性 1 本ぶんだけ。
 */
export const SKIN_ATTRIBUTE = 'aSkin';

/**
 * ガラスの地の色。
 *
 * 前回はここを明るい青灰（0.40 前後）に置いていたが、それだと
 * **一様に明るいだけの板**になる。「黒い天蓋」を直そうとして、今度は
 * 「白く塗った板」になっていた。ガラスの地は本来かなり暗く、
 * 明るく見えているぶんはすべて**反射**である。地は暗く置き直し、
 * 明るさは下の反射項で作る。
 */
const GLASS_TINT = 'vec3(0.030, 0.034, 0.042)';
/** ガラスの粗さと金属度。反射は自前で足すので、環境マップは補助に留める。 */
const GLASS_ROUGHNESS = '0.18';
const GLASS_METALNESS = '0.65';
/**
 * ガラスだけ環境マップを強く拾わせる倍率。
 *
 * 下の `GLASS_REFLECT` が作るのは「上を向いた面は空、水平は地平、下向きは路面」
 * という滑らかな 3 段で、これだけだと**どの車の窓も同じ絵**になる。
 * 実際の窓に映るのは向かいのビルや電柱で、その不揃いが「映り込み」に見える。
 * 環境マップ（焼いた空）の寄与を 1 より上に取って、
 * 車の向きごとに違う明るさが乗るようにしておく。
 */
const GLASS_ENV_GAIN = '1.0';

/**
 * ガラスの反射。
 *
 * 環境マップ（PMREM の空）を当てるだけでは階調が出ない。窓は平らな板で
 * 焼いてあるので、面の中で法線＝反射ベクトルが一定になり、1 枚が
 * 単色に塗り潰されるためである（`vehicleParts.curveGlass` で法線を
 * 反らせてあるのはその対策）。ここではさらに、
 *
 * - **反射ベクトルの上向き成分**から「空 / 地平 / 路面」を引く
 * - **フレネル**で縁を明るくする
 *
 * を明示的に足す。上を向いている面は空の青、水平を向いている面は地平の
 * 明るい帯、下を向いている面は路面の暗さを映すので、1 枚のガラスの中に
 * 必ず階調が生まれる。ガラスが「ガラスに見える」条件はこれだけで足りる。
 *
 * **全体の量は控えめに。** 反射を強く取ると、正午に真後ろから見た
 * リアガラスが「磨いた金属板」になって車体より明るくなる。指摘は逆で、
 * 求められているのは「1 枚の**暗い**ポリゴンとして車体から分離すること」。
 * 明るいのは上端だけでよく、下半分は車内の暗さが勝って当然である。
 */
const GLASS_REFLECT = /* glsl */ `
	{
		vec3 vDir = normalize( vViewPosition );
		vec3 nrm = normalize( normal );
		vec3 upView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
		float up = dot( reflect( -vDir, nrm ), upView );
		vec3 refl = mix( uGlassGround, uGlassHorizon, smoothstep( -0.45, 0.0, up ) );
		refl = mix( refl, uGlassSky, smoothstep( 0.0, 0.6, up ) );
		// **窓の高さそのもの**でもう一段割る。法線から引いた 3 段は、側面窓のように
		// 面が真横を向いていると面内でほとんど変化せず、結局 1 枚が一色になる
		//（前回「反りを足した」のが効かなかったのはここ）。窓の上端は空を、
		// 下端は路面と暗い車内を映すので、上下で 4 倍の明度差を直接与える。
		refl *= 0.16 + 0.80 * gUp;
		// 視線が浅いほど強く映る（フレネル）。縁が光るとガラスの厚みが出る。
		float fres = pow( 1.0 - clamp( dot( vDir, nrm ), 0.0, 1.0 ), 4.0 );
		totalEmissiveRadiance += gMask * refl * ( 0.24 + 0.95 * fres );
	}
`;

/** 夜の持ち上げ量。一律の下駄と、車体色に比例する分。 */
const NIGHT_FLOOR = 0.028;
const NIGHT_TINT = 0.065;

export interface AgentSurfaceOptions {
  roughness: number;
  metalness: number;
  envMapIntensity?: number;
  /** ガラス（`aGlass` 属性）を持つジオメトリに使うか。 */
  glass?: boolean;
  /** 肌・髪など、インスタンス色の変調を外す部位（`aSkin` 属性）を持つか。 */
  skin?: boolean;
  /** 夜の持ち上げの強さ。人は車より弱くする。 */
  nightLift?: number;
}

/** 材質と、毎フレーム書き換える夜の量（uniform と同じオブジェクトを共有する）。 */
export interface AgentSurface {
  material: MeshStandardMaterial;
  /** `atmosphereAt().nightAmount` をそのまま入れる。 */
  night: { value: number };
  /**
   * ガラスが映す空・地平・路面の色。時刻に合わせて書き換える。
   * ガラスを持たない材質でも同じ形で返す（書き換えても無害）。
   */
  glassSky: { value: Color };
  glassHorizon: { value: Color };
  glassGround: { value: Color };
}

export function agentSurface(o: AgentSurfaceOptions): AgentSurface {
  const material = surface({
    vertexColors: true,
    roughness: o.roughness,
    metalness: o.metalness,
    envMapIntensity: o.envMapIntensity ?? 1,
  });
  const night = { value: 0 };
  const glassSky = { value: new Color(0x93b7dc) };
  const glassHorizon = { value: new Color(0xc9d6e0) };
  const glassGround = { value: new Color(0x2e3134) };
  const glass = o.glass === true;
  const skin = o.skin === true;
  const floor = (NIGHT_FLOOR * (o.nightLift ?? 1)).toFixed(4);
  const tint = (NIGHT_TINT * (o.nightLift ?? 1)).toFixed(4);

  material.onBeforeCompile = (shader) => {
    // uniform には同じオブジェクトを差す。以後 night.value を書き換えるだけで届く。
    shader.uniforms.uNight = night;
    shader.uniforms.uGlassSky = glassSky;
    shader.uniforms.uGlassHorizon = glassHorizon;
    shader.uniforms.uGlassGround = glassGround;

    if (glass) {
      shader.vertexShader = `attribute float ${GLASS_ATTRIBUTE};\nvarying float vGlass;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `vGlass = ${GLASS_ATTRIBUTE};\n\t#include <begin_vertex>`,
      );
    }
    if (skin) {
      // `color_vertex` は vColor = 頂点色 × instanceColor を作る。その直後に
      // 頂点色そのものへ戻せば、印の付いた部位だけ服の色から切り離せる。
      shader.vertexShader = `attribute float ${SKIN_ATTRIBUTE};\n${shader.vertexShader}`.replace(
        '#include <color_vertex>',
        `#include <color_vertex>\n\tvColor.xyz = mix(vColor.xyz, color.xyz, ${SKIN_ATTRIBUTE});`,
      );
    }

    let fs = `uniform float uNight;\nuniform vec3 uGlassSky;\nuniform vec3 uGlassHorizon;\nuniform vec3 uGlassGround;\n${glass ? 'varying float vGlass;\n' : ''}${shader.fragmentShader}`;
    if (glass) {
      fs = fs
        // 属性に詰めた 2 つの値をここで割る。以降は gMask（0/1）と
        // gUp（窓の中の高さ 0..1）だけを使う。`color_fragment` は
        // 粗さ・金属度より前に来るので、ここで宣言しておけば全部から見える。
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
	float gMask = step(0.5, vGlass);
	float gUp = clamp(vGlass - 1.0, 0.0, 1.0);
	diffuseColor.rgb = mix(diffuseColor.rgb, ${GLASS_TINT}, gMask);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, ${GLASS_ROUGHNESS}, gMask);`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>\n\tmetalnessFactor = mix(metalnessFactor, ${GLASS_METALNESS}, gMask);`,
        )
        // 空の映り込みそのものを強める。金属度だけだと日陰の車で足りない。
        // ただし窓の下半分には掛けない（下端まで空を映すと平板に戻る）。
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>\n\tradiance *= mix(1.0, ${GLASS_ENV_GAIN} * (0.25 + 0.75 * gUp), gMask);`,
        );
    }
    // 夜の持ち上げと、ガラスの反射。どちらも法線が確定した後でないと書けないので、
    // `emissivemap_fragment`（＝ライティングの直前）にまとめて差し込む。
    fs = fs.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
	totalEmissiveRadiance += uNight * (vec3(${floor}) + diffuseColor.rgb * ${tint});
${glass ? GLASS_REFLECT : ''}`,
    );
    shader.fragmentShader = fs;
  };
  // 同じ差し込みをした材質どうしはプログラムを共有させる（コンパイル 1 回で済む）。
  material.customProgramCacheKey = () => `agent:${glass ? 'g' : '-'}${skin ? 's' : '-'}:${floor}:${tint}`;

  return { material, night, glassSky, glassHorizon, glassGround };
}
