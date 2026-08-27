import { HalfFloatType, Vector2, type Scene, type Camera, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/**
 * ポストエフェクト。
 *
 * 街の絵が「ゲームの画面」に見えるか「レンダリングされた風景」に見えるかは、
 * 最後のこの一段で決まるところが大きい。ここでやるのは 3 つ。
 *
 * - **ブルーム**: 夜の窓・街灯・ヘッドライトが滲む。夜景の説得力がこれで変わる。
 *   しきい値を高めに置き、昼間の白い壁が光らないようにしてある。
 * - **色調整（グレード）**: 露出・コントラスト・彩度・周辺減光を 1 パスで掛ける。
 *   時刻ごとに少しだけ色を寄せる（朝は青、夕は橙）と、時間帯の印象が強くなる。
 * - **SMAA**: composer を通すと MSAA が効かなくなるので、代わりに掛ける。
 *
 * 重い環境では自動的に切る。ポストエフェクトが原因で 30fps を割るくらいなら、
 * 素のままヌルヌル動くほうがゲームとしては良い。
 */

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.08 },
    uVignette: { value: 0.28 },
    uLift: { value: 0.0 },
    uTint: { value: new Vector2(0, 0) }, // x: 寒暖, y: 緑〜マゼンタ
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform float uLift;
    uniform vec2 uTint;
    varying vec2 vUv;

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;

      // 色かぶり（朝は青、夕は橙）
      c.r *= 1.0 + uTint.x * 0.06;
      c.b *= 1.0 - uTint.x * 0.06;
      c.g *= 1.0 + uTint.y * 0.03;

      // コントラスト（0.5 を中心に）
      c = (c - 0.5) * uContrast + 0.5;
      // 彩度
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      // 黒の持ち上げ（フィルムっぽい沈み方にする）
      c += uLift * (1.0 - c);

      // 周辺減光
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * uVignette * 2.2;
      c *= clamp(v, 0.0, 1.0);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }
  `,
};

export type FxLevel = 'off' | 'auto' | 'high';

export class PostFx {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private smaa: SMAAPass | null = null;
  /** 実際に composer を通しているか。 */
  enabled = false;
  private level: FxLevel;
  private slowFrames = 0;
  private readonly renderer: WebGLRenderer;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera, level: FxLevel = 'auto') {
    this.renderer = renderer;
    this.level = level;
    if (level === 'off') return;

    const size = renderer.getSize(new Vector2());
    size.multiplyScalar(renderer.getPixelRatio());
    const composer = new EffectComposer(renderer);
    // HDR で溜めないと、明るい部分がブルームに渡る前に 1.0 で頭打ちになる
    composer.renderTarget1.texture.type = HalfFloatType;
    composer.renderTarget2.texture.type = HalfFloatType;
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(new Vector2(size.x, size.y), 0.42, 0.7, 0.92);
    composer.addPass(this.bloom);

    this.grade = new ShaderPass(GRADE_SHADER as never);
    composer.addPass(this.grade);

    // OutputPass がトーンマッピングと色空間変換を担当する
    composer.addPass(new OutputPass());

    this.smaa = new SMAAPass(size.x, size.y);
    composer.addPass(this.smaa);

    this.composer = composer;
    this.enabled = true;
  }

  /**
   * 時刻に応じてブルームと色を動かす。
   * @param nightAmount 0（昼）..1（夜）
   * @param warmth      -1（寒色）..1（暖色）
   */
  setMood(nightAmount: number, warmth: number): void {
    if (this.bloom) {
      // 昼は光源が太陽だけなので弱く、夜は窓と街灯が主役なので強く
      this.bloom.strength = 0.16 + nightAmount * 0.3;
      this.bloom.threshold = 0.95 - nightAmount * 0.18;
      this.bloom.radius = 0.5 + nightAmount * 0.25;
    }
    if (this.grade) {
      const u = this.grade.uniforms;
      (u.uTint!.value as Vector2).set(warmth, 0);
      u.uContrast!.value = 1.05 + nightAmount * 0.06;
      u.uSaturation!.value = 1.1 - nightAmount * 0.12;
      u.uLift!.value = nightAmount * 0.012;
    }
  }

  setSize(w: number, h: number): void {
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w, h);
  }

  /**
   * 描画する。ポストエフェクトが有効なら composer 経由、無効なら素で描く。
   * @returns composer を通したか
   */
  render(scene: Scene, camera: Camera, frameMs: number): boolean {
    if (!this.composer || !this.enabled) {
      this.renderer.render(scene, camera);
      return false;
    }
    // auto のときだけ、重い環境で自動的に降りる
    if (this.level === 'auto') {
      if (frameMs > 40) this.slowFrames++;
      else this.slowFrames = Math.max(0, this.slowFrames - 1);
      if (this.slowFrames > 90) {
        this.enabled = false;
        console.info('[render] 描画が重いのでポストエフェクトを切りました');
        this.renderer.render(scene, camera);
        return false;
      }
    }
    this.composer.render();
    return true;
  }

  dispose(): void {
    this.composer?.dispose();
    this.bloom?.dispose();
    this.smaa?.dispose();
    this.grade?.dispose();
  }
}
