import { HalfFloatType, Vector2, type Scene, type Camera, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/**
 * ポストエフェクト。
 *
 * 街の絵が「ゲームの画面」に見えるか「レンダリングされた風景」に見えるかは、
 * 最後のこの一段で決まるところが大きい。ここでやるのは 3 つ。
 *
 * - **環境遮蔽（GTAO）**: 壁と地面が出会う角、庇の下、車の下に影が溜まる。
 *   直射日光の影だけでは、物が「置かれている」感じが出ない。曇りの日でも
 *   隅が暗いのは遮蔽のためで、これが無いと何もかもが宙に浮いて見える。
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

      // 色かぶり。画面全体に一律で掛けると、夕方は影の中まで橙になり、
      // 画面が「オレンジのセロファンを貼った 1 色」に潰れる。
      // 明部と暗部で逆向きに振る（split-toning）と、
      // 直射の暖色と空からの回り込みの寒色が対立して、夕景に奥行きが出る。
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c += uTint.x * 0.055 * vec3(lum, lum * 0.15, -lum);
      c += uTint.x * 0.045 * vec3(-(1.0 - lum), 0.0, (1.0 - lum));
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
  private gtao: GTAOPass | null = null;
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

    // 環境遮蔽。半径は実寸（m）。街路の幅が 6〜9m なので、
    // 5m 前後にすると「建物の足元と軒下だけ」が締まり、街全体は暗くならない。
    const gtao = new GTAOPass(scene, camera as never, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.updateGtaoMaterial({
      radius: 3,
      distanceExponent: 1.1,
      thickness: 1.6,
      scale: 1.0,
      samples: 16,
      screenSpaceRadius: false,
    });
    gtao.blendIntensity = 0.75;
    // デノイズを強めに掛ける。サンプル数を増やすより安く粒を潰せる。
    gtao.updatePdMaterial({ lumaPhi: 12, depthPhi: 2.5, normalPhi: 3.5, radius: 6, rings: 3, samples: 16 });
    composer.addPass(gtao);
    this.gtao = gtao;

    this.bloom = new UnrealBloomPass(new Vector2(size.x, size.y), 0.42, 0.7, 0.92);
    composer.addPass(this.bloom);

    // OutputPass がトーンマッピングと色空間変換を担当する。
    //
    // 色調整はこの**後ろ**に置かなければならない。composer のレンダーターゲットへ
    // 描いている間、three はマテリアル側のトーンマッピングを外すので、
    // ここまでの値はリニアの HDR（日向の壁なら 1.5〜4.0）のまま流れてくる。
    // その状態で clamp(0,1) を掛けると、白い塗り壁もクリームのタイルも
    // 打ちっぱなしコンクリートも全部 1.0 に潰れ、ACES の肩（ハイライトの
    // ロールオフ）が一切効かなくなる。日向側が「同じ白」になるあの安さは、
    // ほぼこれが原因だった。0..1 に畳んだ後なら、コントラストの支点 0.5 も
    // 周辺減光も意図どおりに効く。
    composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GRADE_SHADER as never);
    composer.addPass(this.grade);

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
      // しきい値はトーンマッピング前の値に効く。夜に 0.8 まで下げると、
      // 街灯に照らされた壁のような「明るいだけの面」まで滲み、
      // 窓の灯りが白い矩形に潰れる。1.0 より上＝自発光だけを拾わせる。
      this.bloom.strength = 0.16 + nightAmount * 0.34;
      this.bloom.threshold = 1.25 - nightAmount * 0.22;
      this.bloom.radius = 0.5 + nightAmount * 0.25;
    }
    if (this.grade) {
      const u = this.grade.uniforms;
      (u.uTint!.value as Vector2).set(warmth, 0);
      // 夜はコントラストを上げない。上げると暗部が先に 0 に沈み、
      // 「黒い穴と白いシール」の 2 値になる。代わりに黒を持ち上げる。
      u.uContrast!.value = 1.06 - nightAmount * 0.1;
      u.uSaturation!.value = 1.1 - nightAmount * 0.06;
      u.uLift!.value = nightAmount * 0.05;
      // 周辺減光も夜は弱める。四隅が黒く沈むと、暗部の潰れがさらに広がる。
      u.uVignette!.value = 0.28 - nightAmount * 0.15;
    }
  }

  setSize(w: number, h: number): void {
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w, h);
    this.gtao?.setSize(w, h);
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
    this.gtao?.dispose();
    this.grade?.dispose();
  }
}
