import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';

/**
 * 接地影（コンタクトシャドウ）。
 *
 * 車も人も、これまで路面との間に一切の陰が無かった。影マップは 2048px で
 * 110m 以上を覆っていて 1 テクセルが 10cm 前後あり、そのうえアクネ避けの
 * `normalBias` で影が物から押し出されるので、**足元の数十 cm** だけは
 * 構造的に必ず抜ける。人が「浮いている」と感じるのはまさにその数十 cm なので、
 * 影マップをいくら細かくしても、この一枚を敷かない限り直らない。
 *
 * そこで **物 1 つにつき、路面に寝かせた放射グラデーションの板を 1 枚**置く。
 * 板は車・人・トラックで共有する 1 本の InstancedMesh に詰めるので、
 * 何千個置いてもドローコールは 1 つのままで済む。
 *
 * 濃さの持たせ方に工夫がいる。three の `instanceColor` は頂点カラーの **rgb** に
 * しか掛からないので、真っ黒な板に「インスタンスごとの濃さ」を乗せる手が無い。
 * ここでは *頂点カラーの rgb を白・アルファをグラデーション* にしておき、
 * `instanceColor` に濃さを入れてから、フラグメントで **rgb をアルファに移し替えて
 * 板を黒く塗り潰す**。これで 1 メッシュのまま「遠いほど薄い」「人は車より薄い」が
 * 表現できる。
 */

/** 板の分割数。8 角形だと縁の直線が見えるので 10 にしてある。 */
const SEGMENTS = 10;
/** 内側リングの半径と、そこでの濃さ。中心 1.0 → 内側 → 外周 0.0。 */
const INNER_R = 0.56;
const INNER_A = 0.6;

/**
 * 単位の楕円板。半径 0.5 の円なので、インスタンス行列の x/z スケールに
 * 「幅」「長さ」をそのまま入れれば、その大きさの影になる。
 */
function shadowGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const push = (r: number, a: number, k: number): void => {
    const t = (k / SEGMENTS) * Math.PI * 2;
    pos.push(Math.cos(t) * r * 0.5, 0, Math.sin(t) * r * 0.5);
    // rgb は白のまま。ここにインスタンスごとの濃さが掛かる。
    col.push(1, 1, 1, a);
    nor.push(0, 1, 0);
  };
  const center = (): void => {
    pos.push(0, 0, 0);
    col.push(1, 1, 1, 1);
    nor.push(0, 1, 0);
  };
  // 巻き方向は **面ごとに** 検算して積む。
  //
  // 板は XZ 平面に寝ているので、角度の増える向き（cos t, 0, sin t）に
  // 素直に並べると (v1-v0)×(v2-v0) が **-Y** を向く。WebGL の表裏は法線属性
  // ではなく巻き方向で決まるので、裏向きに積んだ面は既定の `FrontSide` では
  // 背面カリングで 1 枚残らず消える（行列は書いているのに画面に出ない）。
  //
  // 前回ここを直したとき、**中心の扇だけ**を直して外周のリングを直し忘れた。
  // その結果、残っていたのは半径 0.28 のハードエッジの円板だけで、
  //
  //   - 車 … 円板が車体幅の半分ほどあるので、車体の外へ出て影として読めた
  //   - 人 … 円板の差し渡しが 15cm しかなく、**靴と胴の真下に完全に隠れた**
  //
  // ということが起きていた。「車には付いたが人には 1 枚も無い」の正体はこれで、
  // 板を大きくするだけでは直らない（ぼかしのリングごと消えているため）。
  // リングは (内 k → 外 k → 外 k+1) と (内 k → 外 k+1 → 内 k+1) が表向き。
  for (let k = 0; k < SEGMENTS; k++) {
    // 中心 → 内側リング
    center();
    push(INNER_R, INNER_A, k + 1);
    push(INNER_R, INNER_A, k);
    // 内側リング → 外周（外周のアルファ 0 でぼかす）
    push(INNER_R, INNER_A, k);
    push(1, 0, k);
    push(1, 0, k + 1);
    push(INNER_R, INNER_A, k);
    push(1, 0, k + 1);
    push(INNER_R, INNER_A, k + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  // itemSize 4 にすると three が USE_COLOR_ALPHA を立て、頂点アルファが効く。
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 4));
  // 法線は使わない（MeshBasicMaterial なので）が、必ず持たせる。
  // ポストエフェクトの GTAO は法線バッファを焼くときシーンを
  // `MeshNormalMaterial` で描き直すので、法線が無いと NaN が混ざる。
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  return g;
}

/** 接地影の一群。車と人で 1 つを共有する。 */
export class GroundShadows {
  readonly mesh: InstancedMesh;
  private readonly material: MeshBasicMaterial;
  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3(1, 1, 1);
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();
  private count = 0;

  constructor(capacity: number) {
    this.material = new MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      // 路面に寝かせる板なので、深度は書かない（後ろの車体が消える）。
      depthWrite: false,
      // 表裏どちらからでも描く。巻き方向を 1 か所間違えるだけで影が全滅する
      // （実際に一度そうなった）事故を、材質の側でも起こらないようにしておく。
      // 坂の上の車を下から見上げる画でも、板が消えずに残る。
      side: DoubleSide,
      toneMapped: false,
      opacity: 0.5,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // rgb にはインスタンスごとの濃さが入っている（頂点カラーの rgb は白）。
        // アルファへ移し替えてから、板そのものは黒く塗る。
        diffuseColor.a *= diffuseColor.r;
        diffuseColor.rgb = vec3(0.0);`,
      );
    };
    this.material.customProgramCacheKey = () => 'groundShadow';
    this.mesh = new InstancedMesh(shadowGeometry(), this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // 路面（不透明）の後、前照灯の光（renderOrder 2）の前。
    this.mesh.renderOrder = 1;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  reset(): void {
    this.count = 0;
  }

  /**
   * 影を 1 枚置く。
   *
   * @param y   置く高さ。路面のすぐ上（数 cm）に置く。
   * @param width  車体幅 × 1.1 くらい。人なら肩幅の 2 倍ほど。
   * @param length 車長 × 1.05 くらい。
   * @param strength 0..1 の濃さ。遠いものほど薄くすると、描画距離の
   *   打ち切り線が「影だけ突然消える」形で見えなくなる。
   */
  add(
    x: number,
    y: number,
    z: number,
    heading: number,
    width: number,
    length: number,
    strength: number,
  ): void {
    if (this.count >= this.capacity || strength <= 0.01) return;
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(this.axisY, heading);
    this.scl.set(width, 1, length);
    this.mat.compose(this.pos, this.quat, this.scl);
    this.mesh.setMatrixAt(this.count, this.mat);
    this.color.setScalar(strength);
    this.mesh.setColorAt(this.count, this.color);
    this.count++;
  }

  /** 今フレームぶんを確定する。空なら丸ごとシーンから外す（ドローコール節約）。 */
  finish(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** 全体の濃さ。日向は濃く、夜は薄くする。 */
  setOpacity(v: number): void {
    this.material.opacity = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }
}
