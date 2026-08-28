import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { chamferedUnitBox, mergeParts, place, tintGeometry, type Part } from './materials';

/**
 * 建物の部品キットと、立面（ファサード）を描くための材質。
 *
 * ここの設計は「造形を増やしてもドローコールを増やさない」ことに全部を賭けている。
 *
 * 1. **部品は十数種類の"キット"だけに絞り、全建物で共有する。**
 *    面取り箱・切妻・寄棟・円柱・受水槽・鳥居に加え、屋上の室外機の列・
 *    円筒排気筒・手すり、そして看板 2 種。1 キット = 1 InstancedMesh なので、
 *    街に何棟建とうとドローコールはキットの数のまま。
 *    以前の「形状キーごとに本体メッシュ＋屋根メッシュ」は 50 近いメッシュを作っていたので、
 *    造形を増やしたのにドローコールはむしろ減っている。
 *    複数の箱からなる部品（水槽・室外機・看板）は `mergeParts` で 1 つに焼き固めて
 *    置くので、造形が細かくなってもインスタンスの数は増えない。
 *
 * 2. **窓・バルコニー・シャッターはジオメトリではなくシェーダで描く。**
 *    窓を実際の箱で作ると、1 棟で数百インスタンス・数千三角形になり、
 *    数千棟の街では到底成立しない。壁のローカル座標をメートルで受け取り、
 *    階高とスパンで格子に割って窓を描けば、三角形 0 個で階数の読める立面になる。
 *    しかも**インスタンスのスケールが変わっても窓は伸び縮みしない** —
 *    焼き固めたジオメトリを縦に引き伸ばす作りでは、これが原理的にできない。
 *
 * 3. **夜の灯りも同じシェーダの中で部屋単位に散らす。**
 *    「窓の帯を丸ごと点ける／消す」をやめ、(階, スパン, 棟ハッシュ) から
 *    部屋ごとに乱数を引く。点灯率だけを時刻で動かせば、
 *    インスタンスを 1 つも書き換えずに夕方から夜へ灯りが増えていく。
 */

/** 立面の様式。シェーダが窓の割り付けと材質を変える。 */
export const Facade = {
  /** 単純な塗り面。p1=粗さ, p2=金属度。庇・手すり・タンクなど。 */
  Plain: 0,
  /** 住宅。長辺はバルコニー、短辺は小窓。 */
  Residential: 1,
  /** カーテンウォール。オフィス・タワーマンション。 */
  Curtain: 2,
  /** 店舗。1 階が全面ガラス、上階は小窓。 */
  Shop: 3,
  /** 工場・倉庫。縦リブの金属サイディングと高窓・シャッター。 */
  Industrial: 4,
  /** 自発光の看板（板の法線が Z 向き）。p1=昼の輝度, p2=夜の追加輝度, p3=種（負で文字なし）。 */
  Sign: 5,
  /** 学校・庁舎の連窓。 */
  Institution: 6,
  /** 瓦・折板の屋根。流れ方向に葺き足の線が入る。 */
  Roof: 7,
  /**
   * 袖看板（板の法線が X 向き）。`Sign` と同じ描き方だが、
   * 板の面がどの軸を向いているかをシェーダが知っている必要がある。
   * 法線から推測すると、板の「小口」（厚み 0.12m の側面）にまで
   * 文字が回り込んで、縁が色付いて見えてしまう。
   */
  SignBlade: 8,
} as const;

/** これより小さい部品は、上下の面取りを省いた軽い箱で描く (m)。 */
const SMALL_PART_M = 3.2;

/** 面取りの実寸 (m)。単位ボックスを拡大しても角の丸みが一定になるようにする。 */
const CHAMFER_M = 0.11;
/** 単位ボックスを作るときの面取り比。頂点の判別に使うのでシェーダと共有する。 */
const CHAMFER_U = 0.06;

/** 材質共有のためのユニフォーム。時刻で動くのは夜の量だけ。 */
const uniforms = {
  uNight: { value: 0 },
};

const materials: MeshStandardMaterial[] = [];

const VERT_PARS = /* glsl */ `
attribute vec4 aFacade;
varying vec3 vLocalM;
varying vec3 vObjN;
varying vec3 vScaleM;
varying vec4 vFacadeV;
varying float vViewDepth;
varying vec3 vPartTint;
`;

const VERT_BEGIN = /* glsl */ `
#ifdef USE_INSTANCING
  vec3 iScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
  vec3 iScale = vec3(1.0);
#endif
vec3 pLocal = position;
#ifdef CHAMFER_FIX
  // 面取り量をメートル固定に引き直す。単位ボックスをそのまま拡大すると、
  // 大きい建物ほど角が丸くなって石鹸のように見え、逆に薄い板では面取りが消える。
  vec3 q = pLocal - vec3(0.0, 0.5, 0.0);
  vec3 tgt = clamp(vec3(0.5) - vec3(${CHAMFER_M.toFixed(3)}) / max(iScale, vec3(0.05)), vec3(0.30), vec3(0.492));
  vec3 aq = abs(q);
  vec3 isFace = step(vec3(${(0.5 - CHAMFER_U * 0.5).toFixed(4)}), aq);
  q = sign(q) * mix(tgt, vec3(0.5), isFace);
  pLocal = q + vec3(0.0, 0.5, 0.0);
#endif
vec3 transformed = pLocal;
vLocalM = pLocal * iScale;
vObjN = normal;
vScaleM = iScale;
vFacadeV = aFacade;
// 焼き固めた部品を区別するための「素の頂点カラー」。
// vColor はインスタンス色が掛かった後の値なので、
// 「この画素は看板の板か、それとも取付アームか」を判定できない。
// 部品ごとの色だけを別の varying で持てば、1 つの材質のまま
// 看板だけを光らせる／アームは光らせない、が書ける。
#ifdef USE_COLOR
  vPartTint = color;
#else
  vPartTint = vec3(1.0);
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform float uNight;
varying vec3 vLocalM;
varying vec3 vObjN;
varying vec3 vScaleM;
varying vec4 vFacadeV;
varying float vViewDepth;
varying vec3 vPartTint;

vec3 gTint; float gRough; float gMetal; vec3 gEmis;
/** 環境マップの映り込みの倍率。窓だけ強くして「空を映すガラス」にする。 */
float gEnv;
/** その画素が窓かどうか 0..1。法線を少し上に倒して映り込みを壁と分ける。 */
float gWin;

float h21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/**
 * なめらかな値ノイズ。
 * h21(floor(p)) をそのまま使うと、汚れが正方形のタイルに見えてしまう。
 * 4 隅を補間するだけで、同じコストの範囲で「斑」になる。
 */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i);
  float b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0));
  float d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * 区間 [a,b] に入っているかを、画面上の変化率 w で鈍らせて返す。
 * 遠景で 1 セルが 1 画素より小さくなると被覆率に収束するので、
 * 窓の格子がちらつかずに「平均的な壁の色」へ溶けていく。
 */
float bandAA(float t, float a, float b, float w) {
  float e = max(w, 1e-5);
  float m = clamp(min(t - a, b - t) / e + 0.5, 0.0, 1.0);
  return mix(m, clamp(b - a, 0.0, 1.0), clamp(e * 1.7 - 0.15, 0.0, 1.0));
}

/**
 * 看板の文字。
 *
 * 単色に塗った板は、どれだけ光らせても「付箋紙」にしか見えない。
 * 文字が入って初めて看板になる。テクスチャを貼らずに、セルごとに
 * 横画 2〜3 本＋縦画 1〜2 本をハッシュで組み合わせて漢字らしい塊を描く。
 * 遠目には文字の並びに、近づいても「何か書いてある板」に見える。
 *
 * @param p  板の面上の座標（0..1）。長手方向が y。
 * @param n  文字数
 * @param sd 看板ごとの種
 */
float signGlyphs(vec2 p, float n, float sd, float aa) {
  float t = (p.y - 0.06) / 0.88 * n;
  float ci = floor(t);
  vec2 q = vec2((p.x - 0.16) / 0.68, (fract(t) - 0.14) / 0.72);
  float h = h21(vec2(ci, 0.0) + sd * 37.0);
  float h2 = h21(vec2(ci, 9.0) + sd * 37.0);
  float h3 = h21(vec2(ci, 23.0) + sd * 37.0);
  float w = 0.085;
  float ink = 0.0;
  // 横画（1〜4 本）。本数と位置を 3 つのハッシュで組むので、
  // 同じ看板の中で同じ字が並ぶことがほとんど無くなる。
  ink = max(ink, 1.0 - smoothstep(w - aa, w + aa, abs(q.y - 0.5 - (h - 0.5) * 0.12)));
  ink = max(ink, (1.0 - smoothstep(w - aa, w + aa, abs(q.y - 0.06))) * step(0.35, h));
  ink = max(ink, (1.0 - smoothstep(w - aa, w + aa, abs(q.y - 0.94))) * step(0.3, h2));
  ink = max(ink, (1.0 - smoothstep(w * 0.7 - aa, w * 0.7 + aa, abs(q.y - 0.28))) * step(0.62, h3));
  // 縦画（1〜3 本）
  ink = max(ink, (1.0 - smoothstep(w - aa, w + aa, abs(q.x - 0.5))) * step(0.18, h3));
  ink = max(ink, (1.0 - smoothstep(w * 0.8 - aa, w * 0.8 + aa, abs(q.x - 0.5 - (h2 - 0.5) * 0.62))) * step(0.55, h2));
  ink = max(ink, (1.0 - smoothstep(w * 0.7 - aa, w * 0.7 + aa, abs(q.x - 0.16))) * step(0.72, h3) * step(q.y, 0.72));
  // 囲み（口・国のような字）
  float boxEdge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
  ink = max(ink, (1.0 - smoothstep(w * 0.9 - aa, w * 0.9 + aa, abs(boxEdge - 0.12))) * step(0.86, h));
  // 字面の外・余白の外は塗らない
  ink *= step(0.0, q.y) * step(q.y, 1.0);
  ink *= step(0.16, p.x) * step(p.x, 0.84) * step(0.06, p.y) * step(p.y, 0.94);
  return ink;
}

void facadeShade(vec3 base) {
  gTint = vec3(1.0); gRough = 0.9; gMetal = 0.03; gEmis = vec3(0.0);
  gEnv = 1.0; gWin = 0.0;
  float style = vFacadeV.x;
  vec3 n = vObjN;
  float ax = abs(n.x), ay = abs(n.y), az = abs(n.z);

  // ---- 単純な部品 ----
  if (style < 0.5) {
    gRough = vFacadeV.y;
    gMetal = vFacadeV.z;
    // 小物は相対高さで軽く陰影を付ける（下が暗い）。実寸で掛けると小物が全部黒くなる。
    float t = clamp(vLocalM.y / max(vScaleM.y, 0.001), 0.0, 1.0);
    gTint = vec3(mix(0.78, 1.06, t));
    return;
  }

  // ---- 看板 ----
  if ((style > 4.5 && style < 5.5) || style > 7.5) {
    gRough = 0.44; gMetal = 0.0;
    // 上下面まで光らせると板が発光する塊になるので、立面だけ光らせる。
    float face = 1.0 - step(0.6, ay);
    // 種が負の看板は「文字の入らない灯り」（航空障害灯・灯籠・ポールの丸看板）。
    if (vFacadeV.w < 0.0) {
      gEmis = base * face * (vFacadeV.y + vFacadeV.z * uNight);
      return;
    }
    // 袖看板は板の法線が X、正面看板は Z。どちらかは様式で分かる。
    // 法線から推測すると、厚み 0.12m の小口にまで文字が回り込んでしまう。
    bool blade = style > 7.5;
    // 取付アーム・枠は素の頂点カラーで暗く焼いてある。そこは光らせない。
    float board = smoothstep(0.55, 0.9, max(vPartTint.r, max(vPartTint.g, vPartTint.b)));
    // 板の「おもて」だけに文字を描く（小口は枠の色にする）。
    float front = step(0.85, blade ? ax : az);
    float panel = board * front;
    float px = blade ? vLocalM.z / max(vScaleM.z, 0.001) : vLocalM.x / max(vScaleM.x, 0.001);
    float lenH = blade ? vScaleM.z : vScaleM.x;
    vec2 p = vec2(px + 0.5, clamp(vLocalM.y / max(vScaleM.y, 0.001), 0.0, 1.0));
    // 縦長なら縦書き。横長なら 90 度倒して同じコードで横書きにする。
    if (lenH > vScaleM.y) p = vec2(1.0 - p.y, p.x);
    float sd = vFacadeV.w;
    // 文字数は板の縦横比から決める。固定にすると、横長の袖看板では
    // 字が横に間延びし、縦長の看板では詰まって見える。
    float lo = max(min(lenH, vScaleM.y), 0.05);
    float aspect = max(lenH, vScaleM.y) / lo;
    float chars = clamp(floor(aspect * 0.9 + fract(sd * 7.7) * 0.8), 2.0, 8.0);
    // 遠景では文字が 1 画素を割るので、平均的な濃さへ寄せる（ちらつき防止）
    float fade = smoothstep(45.0, 110.0, vViewDepth);
    float aa = max(fwidth(p.x), fwidth(p.y)) * 0.9 + 0.006;
    float ink = mix(signGlyphs(p, chars, sd, aa), 0.30, fade) * panel;
    // 縁の枠（アルミのフチ）。厚みのある板であることが近景で読める。
    float edge = (1.0 - step(0.055, min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y)))) * panel;
    // 白地＋アクセント 1 色。原色べた塗りをやめると夜も昼も色が濁らない。
    vec3 plate = vec3(0.90, 0.89, 0.85);
    vec3 col = mix(plate, base, ink);
    // 小口と枠はアルミの灰。アームはさらに暗い鉄。
    col = mix(col, vec3(0.30, 0.31, 0.33), max(edge, board * (1.0 - front)));
    col = mix(vec3(0.17, 0.18, 0.19), col, board);
    gTint = col / max(base, vec3(0.02));
    gMetal = max(edge, 1.0 - board) * 0.7;
    gRough = mix(0.44, 0.32, max(edge, 1.0 - board));
    // 夜は文字が地より強く光る（内照式の看板の見え方）。
    float glow = vFacadeV.y + vFacadeV.z * uNight;
    gEmis = col * face * panel * glow * (1.0 - edge * 0.85) * mix(0.75, 1.35, ink);
    return;
  }

  // ---- 屋根（瓦・折板）----
  if (style > 6.5) {
    gRough = vFacadeV.y; gMetal = vFacadeV.z;
    float p = (az >= ax) ? vLocalM.z : vLocalM.x;
    float pitchStep = max(vFacadeV.w, 0.15);
    float s = p / pitchStep;
    // 葺き足の線。遠景では 1 本が 1 画素に満たなくなるので、距離で平均へ寄せる。
    // 寄せずに置くと、建物の隙間から覗く遠くの屋根が細かい縞のノイズになる。
    float rFar = smoothstep(110.0, 300.0, vViewDepth);
    float line = mix(bandAA(fract(s), 0.0, 0.16, fwidth(s)), 0.16, rFar);
    gTint = vec3(1.0 - line * 0.34);
    // 棟と軒先の稜線。屋根が 1 枚の板ではなく葺かれた面に見える。
    float ridge = mix(bandAA(abs(p) / pitchStep, 0.0, 0.25, fwidth(p) / pitchStep), 0.0, rFar);
    gTint *= 1.0 + ridge * 0.10;
    // 棟に近いほど明るく。平らな面に流れの向きが出る。
    gTint *= mix(0.92, 1.06, clamp(vLocalM.y / max(vScaleM.y, 0.001), 0.0, 1.0));
    return;
  }

  // ---- 屋上・床面 ----
  if (ay > max(ax, az)) {
    gRough = 0.96; gMetal = 0.02;
    if (n.y > 0.0) {
      // 陸屋根の面は、壁の色に関係なく防水の色に固定する。
      // 壁色をそのまま薄くすると、俯瞰したときに街が「白い板の集合」に見える。
      //
      // 防水は 3 種類を棟ごとに引く。シート防水の灰緑・アスファルトの黒・
      // 保護モルタルの灰。俯瞰では屋上が画面の 4 割を占めるので、
      // ここが 1 色だと街全体が 1 枚のテクスチャに見えてしまう。
      float dk = fract(vFacadeV.w * 5.7);
      vec3 deck = dk < 0.42 ? vec3(0.180, 0.188, 0.170)
                : (dk < 0.72 ? vec3(0.125, 0.121, 0.116) : vec3(0.240, 0.235, 0.220));
      deck *= 0.86 + 0.28 * h21(floor(vLocalM.xz * 0.35) + 3.0);
      // 防水シートの継ぎ目。屋上は俯瞰でいちばん長く見える面なので、
      // 薄い格子が 1 枚入るだけで「塗りつぶした板」から抜けられる。
      vec2 gp = vLocalM.xz / 1.35;
      float joint = max(bandAA(fract(gp.x), 0.0, 0.05, fwidth(gp.x)), bandAA(fract(gp.y), 0.0, 0.05, fwidth(gp.y)));
      // 雨水の流れ跡。屋上は必ずどこか 1 点に向かって水勾配が付いていて、
      // その筋に沿って汚れが溜まる。うっすらした斑が入るだけで、
      // 「新品の板」ではなく「使われている屋上」になる。
      vec2 dp = vLocalM.xz * 0.16 + vFacadeV.w * 13.0;
      float stain = vnoise(dp) * 0.6 + vnoise(dp * 2.7) * 0.4;
      gTint = deck * (1.0 - joint * 0.30) * (1.0 - smoothstep(0.45, 1.0, stain) * 0.26) / max(base, vec3(0.05));
      gRough = 0.93 - smoothstep(0.5, 1.0, stain) * 0.12;
    } else {
      gTint = vec3(0.38);
    }
    return;
  }

  // ---- 立面 ----
  bool alongZ = ax > az;                       // 法線が X 向き ⇒ 壁は Z 方向に伸びる
  float u = alongZ ? vLocalM.z : vLocalM.x;
  float wallLen = alongZ ? vScaleM.z : vScaleM.x;
  float otherLen = alongZ ? vScaleM.x : vScaleM.z;
  float y = vLocalM.y;
  float floorH = max(vFacadeV.y, 1.2);
  float seed = vFacadeV.w;
  // スパンは棟ごとに ±12% 散らす。窓割りの周期が街区で完全に揃うと、
  // 同じ立面が横に並んでコピーに見える。
  float bay = max(vFacadeV.z, 0.8) * (0.88 + 0.24 * fract(seed * 17.3));
  float faceSign = alongZ ? step(0.0, n.x) : step(0.0, n.z);
  float sideSeed = seed * 13.0 + (alongZ ? 3.0 : 41.0) + faceSign * 7.0;
  bool longSide = wallLen >= otherLen - 0.05;

  // 1 階は少し高く取る。店舗・オフィスは特にここが効く。
  float groundMul = (style > 2.5 && style < 3.5) ? 1.45 : ((style > 1.5 && style < 2.5) ? 1.3 : 1.0);
  float gH = floorH * groundMul;
  bool ground = y < gH;

  float ty, wy, fyi;
  if (ground) {
    ty = y / gH; wy = fwidth(y / gH); fyi = -1.0;
  } else {
    float fy = (y - gH) / floorH;
    fyi = floor(fy); ty = fract(fy); wy = fwidth(fy);
  }
  // 壁の端を基準に割り付ける。中心基準だと左右で窓の切れ方が食い違う。
  float fx = (u + wallLen * 0.5) / bay;
  float fxi = floor(fx);
  float tx = fract(fx);
  float wx = fwidth(fx);

  float cell = h21(vec2(fxi, fyi) + sideSeed);
  float cell2 = h21(vec2(fxi, fyi) + sideSeed + 57.0);
  // 1 セルが 1 画素より小さくなったら、部屋ごとのばらつきは平均に寄せる。
  // 寄せずに step のまま描くと、隣り合う画素が別の部屋を引いて画面が砂嵐になる。
  float cellFade = clamp(max(wx, wy) * 1.6 - 0.2, 0.0, 1.0);

  float x0 = 0.18, x1 = 0.82, y0 = 0.26, y1 = 0.78;
  // 灯りの範囲。窓と別に持つ（バルコニーの手すりの裏は光らない）。
  float lx0 = -9.0, lx1 = -9.0, ly0 = -9.0, ly1 = -9.0;
  float litRate = 0.28;
  vec3 litCol = vec3(1.0, 0.74, 0.42);
  float litI = 0.95;                      // 部屋・店ごとの発光の強さの倍率
  // ガラスの地色は「暗い青」ではなく「中庸の灰青」にする。
  // 金属度を上げて空を映させるとき、地色が暗いとフレネルの基準反射率まで
  // 暗くなり、どの向きの壁でも同じ鈍い青にしかならない。日向の面と日陰の面で
  // 窓の色が変わらない — レビューで指摘されたのはまさにこれ。
  vec3 glassCol = vec3(0.20, 0.24, 0.29);
  // 粗さを 0.1 まで落とすと、空の環境マップの低いミップを引いてしまい、
  // 太陽まわりの高周波が窓の中で砂粒状にちらつく。0.14 前後が、
  // 「よく磨いた板ガラス」の見えとその破綻の境目。
  float glassRough = 0.16, glassMetal = 0.80;
  float wallRough = 0.88, wallMetal = 0.03;
  float extra = 0.0;      // 壁面に足す明暗（庇・スラブ・リブ）
  float glow = 1.0;       // 灯りの強さ
  float pier = 0.0;       // テナントの境の柱（ここで窓と灯りを切る）
  float band = 0.0;       // 店舗の看板帯

  if (style < 1.5) {
    // ---- 住宅（マンション・アパート）----
    litRate = 0.44;
    if (longSide) {
      // バルコニー。掃き出し窓は手すり壁の上にしか出ない。
      // ここを「1 階ぶんの大ガラス」にすると、マンションがガラスのオフィスに見える。
      x0 = 0.10; x1 = 0.90; y0 = 0.50; y1 = 0.88;
      // 灯りは手すりの上だけ。バルコニー全面を光らせると板が発光する。
      lx0 = 0.14; lx1 = 0.86; ly0 = 0.54; ly1 = 0.84;
      float slab = bandAA(ty, -0.03, 0.06, wy);                       // 床スラブの小口
      float rail = bandAA(ty, 0.08, 0.45, wy) * bandAA(tx, 0.03, 0.97, wx); // 手すり壁
      float divider = 1.0 - bandAA(tx, 0.04, 0.96, wx);               // 隔て板
      extra = slab * 0.26 + rail * 0.07 - divider * 0.10;
      // 手すりと窓の間はバルコニーの奥。影が溜まる。
      extra -= bandAA(ty, 0.45, 0.50, wy) * 0.24;
      glassCol = vec3(0.17, 0.20, 0.24);
      glassRough = 0.18; glassMetal = 0.74;
    } else {
      x0 = 0.36; x1 = 0.64; y0 = 0.32; y1 = 0.70;
      litRate = 0.20;
    }
    if (ground) { y0 = 0.20; y1 = 0.62; }
  } else if (style < 2.5) {
    // ---- カーテンウォール ----
    x0 = 0.04; x1 = 0.96; y0 = 0.14; y1 = 0.92;
    lx0 = 0.10; lx1 = 0.90; ly0 = 0.22; ly1 = 0.86;
    litRate = 0.26;
    litCol = vec3(0.86, 0.88, 0.84);
    glassCol = vec3(0.24, 0.30, 0.37);
    glassRough = 0.12; glassMetal = 0.90;
    wallRough = 0.42; wallMetal = 0.55;      // 腰の金属パネル
    // 縦のマリオン（方立）。細く明るい線が入るだけで高層らしくなる。
    float mullion = bandAA(fract(fx * 2.0), 0.0, 0.10, fwidth(fx * 2.0));
    extra = mullion * 0.10;
    if (ground) { x0 = 0.03; x1 = 0.97; y0 = 0.08; y1 = 0.88; litRate = 0.6; glow = 1.4; }
  } else if (style < 3.5) {
    // ---- 店舗 ----
    litRate = 0.34;
    if (ground) {
      // 1 階は全面ガラスの売り場。夜はここが一番強く光る。
      x0 = 0.04; x1 = 0.96; y0 = 0.10; y1 = 0.74;
      lx0 = 0.08; lx1 = 0.92; ly0 = 0.16; ly1 = 0.70;
      litRate = 0.9;
      glassCol = vec3(0.24, 0.26, 0.28);
      glassRough = 0.18; glassMetal = 0.62;

      // 業種を 2 スパンごとに引く。夜の日本の商店街は、コンビニの昼白色・
      // 居酒屋の橙・看板の赤や水色が混ざって初めてそれらしくなる。
      // 純白を一様に並べると、店の連なりが 1 枚の発光板に潰れる。
      float ti = floor(fx / 2.0);
      float bh = h21(vec2(ti, 5.0) + seed * 29.0);
      litCol = bh < 0.44 ? vec3(1.00, 0.95, 0.82)     // 昼白（コンビニ・ドラッグストア）
             : (bh < 0.76 ? vec3(1.00, 0.69, 0.38)    // 暖色（居酒屋・定食屋）
             : (bh < 0.90 ? vec3(1.00, 0.40, 0.47)    // 赤い看板
                          : vec3(0.38, 0.78, 1.00))); // 水色の看板
      // 強さも店ごとに散らす。全部が同じ輝度なのが「板」に見える最大の理由。
      // 赤・水色の看板だけは少し抑える。彩度の高い色を同じ強さで出すと、
      // 街区がネオン街に寄りすぎて、住宅と商店の区別が付かなくなる。
      litI = (1.4 + 1.2 * h21(vec2(ti, 6.0) + seed * 29.0)) * (bh > 0.76 ? 0.78 : 1.0);
      glow = 1.0;
      // テナントの境の柱。ここで帯が切れることで「光る板」ではなく
      // 「並んだ店」に見える。切れ目の数がそのまま店の数として読める。
      float tf = fract(fx / 2.0);
      pier = bandAA(tf, 0.0, 0.17, fwidth(fx / 2.0));
      extra -= pier * 0.22;
      // 2 割ほどの店はもう閉まっている。全部の店が同じだけ光っていると、
      // どれだけ色を散らしても「連続した光の帯」に戻ってしまう。
      // 消えている区画が混ざることで、初めて店の切れ目が数えられる。
      float closed = step(0.80, h21(vec2(ti, 12.0) + seed * 29.0));
      litRate = mix(0.9, 0.10, closed);
      litI *= mix(1.0, 0.45, closed);
      // ガラスの上の看板帯（店名のサイン）。夜はここが一番強い。
      band = bandAA(ty, 0.80, 0.96, wy) * bandAA(tx, 0.02, 0.98, wx) * (1.0 - pier);
      extra += band * 0.12;
      band *= mix(1.0, 0.15, closed);   // 閉まっている店は看板も消えている
    } else {
      x0 = 0.16; x1 = 0.84; y0 = 0.24; y1 = 0.74;
      litI = 1.0 + 0.7 * h21(vec2(floor(fx * 0.5), 8.0) + seed * 29.0);
    }
  } else if (style < 4.5) {
    // ---- 工場・倉庫 ----
    wallRough = 0.55; wallMetal = 0.45;
    litRate = 0.12; glow = 0.6;
    // 縦リブの金属サイディング
    float rib = fract(u / 0.42);
    extra = (bandAA(rib, 0.0, 0.10, fwidth(u / 0.42)) - 0.05) * 0.16;
    if (ground && longSide) {
      // 大きなシャッター。壁の中央寄りに 1 つ。
      float doorW = min(wallLen * 0.30, 6.0);
      float dm = bandAA(abs(u), -10.0, doorW * 0.5, fwidth(u)) * bandAA(y, 0.2, gH * 0.82, fwidth(y));
      extra += dm * -0.18;
      // シャッターの横スジ
      float sh = fract(y / 0.28);
      extra += dm * bandAA(sh, 0.0, 0.35, fwidth(y / 0.28)) * -0.10;
      x0 = 2.0; x1 = 2.0;                     // 1 階に窓は置かない
    } else if (ground) {
      x0 = 0.30; x1 = 0.70; y0 = 0.35; y1 = 0.62;
    } else {
      // 高窓（連窓）
      x0 = 0.08; x1 = 0.92; y0 = 0.52; y1 = 0.82;
      glassCol = vec3(0.26, 0.30, 0.33);
      glassRough = 0.20; glassMetal = 0.50;
    }
  } else {
    // ---- 学校・庁舎 ----
    x0 = 0.06; x1 = 0.94; y0 = 0.30; y1 = 0.82;
    litRate = 0.10; glow = 0.7;
    litCol = vec3(0.92, 0.94, 0.88);
    glassCol = vec3(0.22, 0.26, 0.31);
    glassRough = 0.14; glassMetal = 0.66;
    // 教室の窓を割る細い方立
    float mul = bandAA(fract(fx * 3.0), 0.0, 0.08, fwidth(fx * 3.0));
    extra = mul * 0.08;
    // 階の境の水平帯
    extra += bandAA(ty, -0.02, 0.10, wy) * 0.10;
    if (ground) { y0 = 0.24; y1 = 0.70; }
  }

  // 遠景の「平均的な壁」。窓 1 つが 1 画素に満たなくなったら、
  // 格子を描いても被覆率に潰れるだけなので、この平均へ寄せていく。
  //
  // 単に見た目の問題ではない。建物の隙間に見える 1〜2 画素幅の壁では
  // fwidth が隣の面をまたいで壊れた値を返し、格子が砂嵐になる。
  // 距離で確実に平均へ寄せておけば、その破綻がそもそも起きない。
  float aoFar = clamp(vScaleM.y * 0.45, 1.2, 4.5);
  float cov = clamp((x1 - x0) * (y1 - y0), 0.0, 1.0);
  float aoDist = mix(0.55, 1.0, clamp(y / aoFar, 0.0, 1.0));
  vec3 avgTint = mix(vec3(1.0), glassCol / max(base, vec3(0.02)), cov) * aoDist;
  float avgRough = mix(wallRough, glassRough, cov);
  float avgMetal = mix(wallMetal, glassMetal, cov);
  vec3 avgEmis = litCol * cov * litRate * uNight * glow * litI;
  float farMix = smoothstep(150.0, 380.0, vViewDepth);
  if (farMix > 0.999) {
    gTint = avgTint; gRough = avgRough; gMetal = avgMetal; gEmis = avgEmis;
    gEnv = mix(1.0, 1.8, cov); gWin = cov;
    return;
  }

  float win = bandAA(tx, x0, x1, wx) * bandAA(ty, y0, y1, wy);
  win *= 1.0 - pier;                       // テナントの境の柱では窓を切る
  // 窓枠（アルミサッシ）。窓のすぐ外側を明るくする。
  float frame = bandAA(tx, x0 - 0.05, x1 + 0.05, wx) * bandAA(ty, y0 - 0.04, y1 + 0.04, wy) - win;

  // ---- 見込み（開口の奥行き）----
  //
  // 実際の窓は壁面から 80〜150mm 引っ込んでいる。だから上端には必ず濃い
  // 落ち影が、下端には水切り（サッシ下の見切り）のハイライトが出る。
  // この 2 本が無い窓は、脳が「壁に描かれた絵」と判定する。
  // ジオメトリを 1 三角形も増やさずに、この 2 本だけを窓マスクの中に入れる。
  float ww = max(x1 - x0, 1e-3);
  float wh = max(y1 - y0, 1e-3);
  // 上端 16%：まぐさの落ち影。左端 8%：方立の影。
  float revealTop = bandAA(ty, y1 - wh * 0.16, y1, wy) * bandAA(tx, x0, x1, wx);
  float revealSide = bandAA(tx, x0, x0 + ww * 0.08, wx) * bandAA(ty, y0, y1, wy);
  float reveal = max(revealTop, revealSide * 0.8);
  // 下端 6%：水切りの金物。ここだけ明るい線が入ると窓が「面から浮く」。
  float drip = bandAA(ty, y0, y0 + wh * 0.06, wy) * bandAA(tx, x0, x1, wx);
  // 開口の下、壁側に出る水切りの天端。庇の影とセットで奥行きが決まる。
  float sill = bandAA(ty, y0 - 0.06, y0, wy) * bandAA(tx, x0 - 0.04, x1 + 0.04, wx);
  // 階の境の目地。水平線が入ると階数が読めて、壁の高さの見当が付く。
  float slabLine = ground ? 0.0 : bandAA(ty, -0.015, 0.03, wy);

  // 部屋ごとにカーテンの有無を散らす。全部が同じ暗いガラスだと
  // 「黒い板がびっしり貼られた壁」に見えて、人の住んでいる気配が出ない。
  vec3 curtain = mix(vec3(0.46, 0.44, 0.40), vec3(0.30, 0.31, 0.33), step(0.5, cell2));
  float hasCurtain = mix(step(cell2, 0.38), 0.38, cellFade);
  glassCol = mix(glassCol, curtain, hasCurtain);
  // 窓の中の縦のグラデーション。ガラスの上半分は空を、下半分は向かいの建物と
  // 路面を映すので、1 枚の中で必ず明るさが変わる。この 1 本の勾配が入るかどうかで、
  // 「窓」に見えるか「壁に貼った青い紙」に見えるかが決まる。
  // カーテンの下りた窓は拡散面なので、この勾配は掛けない。
  float tw = clamp((ty - y0) / wh, 0.0, 1.0);
  glassCol *= mix(mix(0.62, 1.32, tw), 0.72, hasCurtain);
  // 材質（粗さ・金属度）は窓の内外で切り替えるだけにして、fwidth 由来の
  // 中間値を持ち込まない。導関数はブロック単位で量子化されるので、
  // その段差がそのまま粗さに乗ると、光沢の強い窓面で細かい格子状のノイズになる。
  float winMat = step(0.5, win);
  gRough = mix(wallRough, glassRough, winMat);
  gMetal = mix(wallMetal, mix(glassMetal, glassMetal * 0.4, hasCurtain), winMat);
  // 窓の画素だけ環境マップを強く引く。空が焼いてあるので、南面と東面で
  // 映り込む空の明るさが変わり、同じ「青いガラス」が向きごとに別の色になる。
  gEnv = mix(1.0, mix(1.8, 1.2, hasCurtain), winMat);
  gWin = winMat;
  gTint = mix(vec3(1.0 + extra), glassCol / max(base, vec3(0.02)), win);
  gTint *= 1.0 + max(frame, 0.0) * 0.08 + sill * 0.22 - slabLine * 0.10;
  // 落ち影 ×0.55、水切り ×1.25。この 2 本が窓を壁から引っ込ませる。
  gTint *= mix(1.0, 0.46, reveal);
  gTint *= mix(1.0, 1.25, drip);

  // 接地の擬似 AO。実寸で効かせる（相対にすると高層ほど足元が広く暗くなる）。
  gTint *= mix(0.55, 1.0, clamp(y / aoFar, 0.0, 1.0));
  // パラペットの下も少し落とす
  gTint *= mix(0.86, 1.0, clamp((vScaleM.y - y) / 1.2, 0.0, 1.0));
  // 雨だれの汚れ筋。パラペットの水切りから下へ、縦に薄い筋が伸びる。
  // 日本のコンクリート外壁でいちばん目に付く経年の跡で、これが入るだけで
  // 「刷り上がったばかりの板」から「何年か建っている建物」になる。
  float sCell = u * 0.55;
  float streakSeed = h21(vec2(floor(sCell), 21.0) + sideSeed);
  float streakLen = 2.5 + streakSeed * 5.0;
  // 帯の中央が濃く、両端で消える。矩形の帯のままだと塗り分けたように見える。
  float streak = smoothstep(0.62, 1.0, streakSeed)
               * sin(fract(sCell) * 3.14159)
               * clamp(1.0 - (vScaleM.y - y) / streakLen, 0.0, 1.0)
               * (1.0 - winMat);
  gTint *= 1.0 - streak * 0.20;

  // 夜の灯り。部屋ごとにハッシュで点け、時刻で点灯率だけを動かす。
  //
  // 遠景では 1 セルが 1 画素より小さくなる。そこで step のまま描くと
  // 点いた窓・消えた窓がカメラの僅かな動きで入れ替わり、街全体がちらつく。
  float lit = mix(step(cell, litRate), litRate, cellFade) * uNight;
  // 部屋ごとに明るさを散らす。全部同じ輝度だと LED パネルに見える。
  // 上限を 1 の少し上で止める。ここを 1.3 まで振ると、いちばん明るい部屋が
  // トーンマッピングの肩で白へ飽和し、せっかく散らした電球色が消えてしまう。
  lit *= 0.35 + 0.78 * h21(vec2(fxi, fyi) + sideSeed + 91.0);
  float litMask = (lx0 < -1.0) ? win : bandAA(tx, lx0, lx1, wx) * bandAA(ty, ly0, ly1, wy);
  litMask *= 1.0 - pier;
  // 部屋ごとに色温度も散らす。蛍光灯の部屋と白熱灯の部屋が混ざるだけで、
  // 同じ強度でも「全部同じ照明の板」から抜けられる。
  float warm = h21(vec2(fxi, fyi) + sideSeed + 133.0);
  vec3 roomCol = mix(litCol, litCol * vec3(0.90, 0.95, 1.10), smoothstep(0.55, 1.0, warm) * 0.8);
  gEmis = roomCol * litMask * lit * glow * litI;
  // 店舗の看板帯。窓とは別に、業種の色でまとまった面を光らせる。
  gEmis += litCol * band * (0.10 + uNight * litI * 0.7);
  // 店の売り場は昼でも中が明るい。ガラス面が黒く沈むと閉店した街に見える。
  if (style > 2.5 && style < 3.5 && ground) gEmis += litCol * win * 0.10;

  // 距離に応じて平均へ寄せる
  gTint = mix(gTint, avgTint, farMix);
  gRough = mix(gRough, avgRough, farMix);
  gMetal = mix(gMetal, avgMetal, farMix);
  gEmis = mix(gEmis, avgEmis, farMix);
  gEnv = mix(gEnv, mix(1.0, 1.8, cov), farMix);
  gWin = mix(gWin, cov, farMix);
}
`;

/** 立面材質を 1 つ作る。キットごとに面取り補正の有無だけが違う。 */
function facadeMaterial(chamferFix: boolean): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.05,
    vertexColors: true,
  });
  m.envMapIntensity = 0.92;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', VERT_BEGIN)
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vViewDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  facadeShade(diffuseColor.rgb);\n  diffuseColor.rgb *= gTint;',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = gRough;',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  metalnessFactor = gMetal;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gEmis;',
      )
      // 窓の法線を壁面法線と真上の間で 0.15 だけ倒す。
      // 完全に壁と同じ法線だと、窓と壁が同じ方向の空を映してしまい、
      // どれだけ粗さを下げても「壁に貼った青い紙」から抜けられない。
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n' +
          '  normal = normalize(mix(normal, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.12 * gWin));',
      )
      // 環境マップの強さを画素ごとに変える。材質の envMapIntensity は
      // ユニフォームなので上書きできない。IBL の結果に直接掛ける。
      .replace(
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\n  radiance *= gEnv;',
      );
    if (chamferFix) shader.defines = { ...(shader.defines ?? {}), CHAMFER_FIX: '' };
  };
  m.customProgramCacheKey = () => (chamferFix ? 'bldFacadeCF' : 'bldFacade');
  materials.push(m);
  return m;
}

/** 夜の度合いを全材質に配る (0..1)。 */
export function setBuildingNight(night: number): void {
  uniforms.uNight.value = night;
}

// ---------------------------------------------------------------- キットの形

/** 白い頂点カラーを持たせる（vertexColors:true の材質に載せるため）。 */
function white(g: BufferGeometry): BufferGeometry {
  tintGeometry(g, 0xffffff);
  return g;
}

/** 面取り箱。壁の量塊と大きな部品に使う（44 三角形）。 */
function boxGeometry(): BufferGeometry {
  return white(chamferedUnitBox(CHAMFER_U));
}

/**
 * 縦の稜線だけを面取りした箱（28 三角形）。
 *
 * 室外機・手すり・柱・看板のような小物は、上下の角の面取りが
 * 画面上 1 画素にも満たない。全部を 44 三角形の箱で置くと、
 * 街全体では見えない面取りに 25 万三角形を払うことになる。
 * 見える縦の稜線だけ残して、それ以外を落とす。
 */
function boxVGeometry(): BufferGeometry {
  const c = CHAMFER_U;
  const i = 0.5 - c;
  // 平面（x,z）上の 8 角形。CHAMFER_FIX の頂点判別と揃うように、
  // 各成分は必ず 0.5 か 0.5-c のどちらかにする。
  const ring: [number, number][] = [
    [-i, -0.5], [i, -0.5], [0.5, -i], [0.5, i],
    [i, 0.5], [-i, 0.5], [-0.5, i], [-0.5, -i],
  ];
  const tris: number[] = [];
  const push = (x: number, y: number, z: number): void => {
    tris.push(x, y, z);
  };
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    // 側面（下から上へ）
    push(a[0], 0, a[1]); push(b[0], 0, b[1]); push(b[0], 1, b[1]);
    push(a[0], 0, a[1]); push(b[0], 1, b[1]); push(a[0], 1, a[1]);
  }
  for (let k = 1; k < ring.length - 1; k++) {
    const a = ring[0]!;
    const b = ring[k]!;
    const c2 = ring[k + 1]!;
    push(a[0], 1, a[1]); push(b[0], 1, b[1]); push(c2[0], 1, c2[1]);   // 天端
    push(a[0], 0, a[1]); push(c2[0], 0, c2[1]); push(b[0], 0, b[1]);   // 底
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
  g.computeVertexNormals();
  return white(g);
}

/**
 * 切妻屋根。単位（幅 1・高さ 1・奥行 1、底面 y=0、棟は X 方向）。
 * 軒の出と鼻隠しの厚みを持たせてある。厚みが無いと、下から見上げたときに
 * 屋根が紙のように見えて安っぽくなる。
 */
function gableGeometry(overX = 0.06, overZ = 0.1, thick = 0.12): BufferGeometry {
  const ex = 0.5 + overX;
  const ez = 0.5 + overZ;
  const tris: number[] = [];
  const tri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): void => {
    tris.push(...a, ...b, ...c);
  };
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ): void => {
    tri(a, b, c);
    tri(a, c, d);
  };
  // 断面（z,y）の 6 点。上面（軒先→棟→軒先）と、そこから真下に thick だけ下ろした面。
  const sec: [number, number][] = [
    [-ez, 0],
    [0, 1],
    [ez, 0],
    [ez, -thick],
    [0, 1 - thick],
    [-ez, -thick],
  ];
  const at = (x: number, i: number): [number, number, number] => [x, sec[i]![1]!, sec[i]![0]!];
  // 側面（6 本の稜線に沿った帯）
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    quad(at(-ex, i), at(ex, i), at(ex, j), at(-ex, j));
  }
  // 妻側の面（六角形を 2 つの四角形に割る）
  quad(at(-ex, 0), at(-ex, 5), at(-ex, 4), at(-ex, 1));
  quad(at(-ex, 1), at(-ex, 4), at(-ex, 3), at(-ex, 2));
  quad(at(ex, 1), at(ex, 4), at(ex, 5), at(ex, 0));
  quad(at(ex, 2), at(ex, 3), at(ex, 4), at(ex, 1));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
  g.computeVertexNormals();
  return white(g);
}

/**
 * 寄棟屋根。棟が X 方向に短く通る（真四角なら方形に近い）。
 * 軒先に鼻隠しの帯を回し、下から見ても厚みが出るようにする。
 */
function hipGeometry(over = 0.08, thick = 0.1): BufferGeometry {
  const e = 0.5 + over;
  const rx = 0.22; // 棟の半長
  const tris: number[] = [];
  const tri = (a: number[], b: number[], c: number[]): void => {
    tris.push(...a, ...b, ...c);
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const A = [-e, 0, -e];
  const B = [e, 0, -e];
  const C = [e, 0, e];
  const D = [-e, 0, e];
  const R0 = [-rx, 1, 0];
  const R1 = [rx, 1, 0];
  quad(A, B, R1, R0); // 北の流れ
  quad(D, R0, R1, C); // 南の流れ
  tri(A, R0, D); // 西の隅
  tri(B, C, R1); // 東の隅
  // 鼻隠し（軒先の垂直な帯）と軒天
  const a2 = [-e, -thick, -e];
  const b2 = [e, -thick, -e];
  const c2 = [e, -thick, e];
  const d2 = [-e, -thick, e];
  quad(A, a2, b2, B);
  quad(B, b2, c2, C);
  quad(C, c2, d2, D);
  quad(D, d2, a2, A);
  quad(a2, d2, c2, b2);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
  g.computeVertexNormals();
  return white(g);
}

/** 円柱（煙突・サイロ・タンク・柱）。単位半径 0.5、高さ 1、底面 y=0。 */
function cylGeometry(seg = 10): BufferGeometry {
  const g = new CylinderGeometry(0.5, 0.5, 1, seg, 1);
  g.translate(0, 0.5, 0);
  return white(g.toNonIndexed());
}

/**
 * 屋上の受水槽（脚付き）。箱 5 つを 1 つに焼き固めてある。
 * これを部品ごとにインスタンス化すると、屋上小物だけで instance が 5 倍になる。
 */
function tankGeometry(): BufferGeometry {
  const box = chamferedUnitBox(CHAMFER_U);
  const parts: Part[] = [
    { geom: box, matrix: place(0, 0.42, 0, 1, 0.54, 0.72), color: 0xffffff },
    // 天端のマンホールと通気管
    { geom: box, matrix: place(0.18, 0.96, 0, 0.2, 0.06, 0.2), color: 0xb0b0b0 },
    { geom: box, matrix: place(-0.3, 0.96, 0.2, 0.05, 0.16, 0.05), color: 0x9a9a9a },
  ];
  // 架台。脚 4 本と、その間に渡した水平材・筋交い。
  // 「脚の生えた箱」ではなく「架台に載った水槽」に見えるかどうかは、
  // この筋交いが 1 本入っているかで決まる。
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ geom: box, matrix: place(sx * 0.42, 0, sz * 0.3, 0.09, 0.44, 0.09), color: 0x8e9296 });
    }
    parts.push({ geom: box, matrix: place(sx * 0.42, 0.36, 0, 0.07, 0.06, 0.68), color: 0x8e9296 });
    // 中間の水平材（振れ止め）
    parts.push({ geom: box, matrix: place(sx * 0.42, 0.16, 0, 0.05, 0.05, 0.68), color: 0x8e9296 });
  }
  for (const sz of [-1, 1]) {
    parts.push({ geom: box, matrix: place(0, 0.36, sz * 0.3, 0.9, 0.06, 0.07), color: 0x8e9296 });
  }
  // 昇降用のはしご
  for (let i = 0; i < 4; i++) {
    parts.push({ geom: box, matrix: place(0.52, 0.08 + i * 0.2, 0, 0.02, 0.03, 0.22), color: 0xa4a8ac });
  }
  parts.push({ geom: box, matrix: place(0.52, 0.02, -0.1, 0.03, 0.9, 0.03), color: 0xa4a8ac });
  parts.push({ geom: box, matrix: place(0.52, 0.02, 0.1, 0.03, 0.9, 0.03), color: 0xa4a8ac });
  const g = mergeParts(parts);
  box.dispose();
  return g;
}

/**
 * 屋上の室外機の列（架台付き）。
 *
 * 以前は 1.5×1.2×0.9 の箱を 2〜3 個ばら撒いていただけで、
 * 俯瞰すると「角砂糖を並べた」ようにしか見えなかった。
 * 実物は H 鋼の架台に載った 3 台前後の並びで、正面に大きなファンの
 * ガードが付いている。この「架台 + 並び + ガード」を 1 つに焼き固めれば、
 * インスタンス 1 個で室外機置き場ごと置ける。
 */
function acRowGeometry(): BufferGeometry {
  const box = chamferedUnitBox(CHAMFER_U);
  const parts: Part[] = [
    // 架台（コンクリート基礎 2 本）
    { geom: box, matrix: place(0, 0, -0.3, 1.0, 0.07, 0.12), color: 0x9a9892 },
    { geom: box, matrix: place(0, 0, 0.3, 1.0, 0.07, 0.12), color: 0x9a9892 },
  ];
  for (let i = -1; i <= 1; i++) {
    const x = i * 0.335;
    // 本体
    parts.push({ geom: box, matrix: place(x, 0.07, 0, 0.30, 0.83, 0.68), color: 0xdadcd8 });
    // ファンのガード（正面の凹んだ丸枠のつもり。暗く落として穴に見せる）
    parts.push({ geom: box, matrix: place(x, 0.28, 0.345, 0.22, 0.42, 0.02), color: 0x44484a });
    // 天端のルーバー
    parts.push({ geom: box, matrix: place(x, 0.88, 0, 0.32, 0.04, 0.70), color: 0xb4b8b6 });
  }
  const g = mergeParts(parts);
  box.dispose();
  return g;
}

/**
 * 屋上の円筒排気筒（ベンチレータ）。
 * 立ち上がりの基礎・筒・傘を 1 つに焼き固める。
 * 細くて背の高いものが屋上に 1 本立つと、平らな面に縦の目印ができる。
 */
function stackGeometry(): BufferGeometry {
  const box = chamferedUnitBox(CHAMFER_U);
  const cyl = new CylinderGeometry(0.5, 0.5, 1, 10, 1);
  cyl.translate(0, 0.5, 0);
  const c = cyl.toNonIndexed();
  const parts: Part[] = [
    { geom: box, matrix: place(0, 0, 0, 0.85, 0.10, 0.85), color: 0x8e918c }, // 立ち上がり
    { geom: c, matrix: place(0, 0.08, 0, 0.52, 0.72, 0.52), color: 0xc6cacc }, // 筒
    { geom: c, matrix: place(0, 0.78, 0, 0.78, 0.10, 0.78), color: 0xaeb2b4 }, // 傘
    { geom: c, matrix: place(0, 0.88, 0, 0.30, 0.12, 0.30), color: 0xc6cacc }, // 頂部
  ];
  const g = mergeParts(parts);
  box.dispose();
  cyl.dispose();
  c.dispose();
  return g;
}

/**
 * 手すり（落下防止柵）の 1 スパン。X 方向に 1 の長さ、高さ 1。
 *
 * 柵は屋上の縁に必ず回っているものなのに、部品ごとに箱で置くと
 * 1 棟で数十インスタンスになる。1 スパンを焼き固めて横に引き伸ばせば、
 * 1 辺 1 インスタンスで済む。
 */
function railFrameGeometry(): BufferGeometry {
  const box = chamferedUnitBox(CHAMFER_U);
  const parts: Part[] = [
    { geom: box, matrix: place(0, 0.95, 0, 1.0, 0.05, 0.05), color: 0xb0b6b8 }, // 笠木
    { geom: box, matrix: place(0, 0.52, 0, 1.0, 0.035, 0.035), color: 0xa2a8ac }, // 中桟
    { geom: box, matrix: place(0, 0.16, 0, 1.0, 0.03, 0.03), color: 0xa2a8ac }, // 下桟
  ];
  for (let i = 0; i < 4; i++) {
    const x = -0.5 + i / 3;
    parts.push({ geom: box, matrix: place(x, 0, 0, 0.045, 1.0, 0.045), color: 0x9aa0a4 });
  }
  const g = mergeParts(parts);
  box.dispose();
  return g;
}

/**
 * 正面に付く看板（壁と平行な板）。
 *
 * 厚み 0.12m の板を、壁から 0.3m 離した 2 本のアームで持ち出す。
 * 板 1 枚では「壁に貼った付箋」にしかならない。
 * アームと影と厚みの 3 つが揃って、初めて壁から浮いた看板になる。
 *
 * Z 方向は実寸で焼いてあるので、**インスタンスの Z スケールは 1 のまま**にする。
 * 板だけが幅・高さで伸び、厚みとアームの長さは建物の大きさに引きずられない。
 */
function signFaceGeometry(): BufferGeometry {
  const box = chamferedUnitBox(0.03);
  const parts: Part[] = [
    { geom: box, matrix: place(0, 0, 0, 1.0, 1.0, 0.12), color: 0xffffff },
  ];
  for (const s of [-1, 1]) {
    // 持ち出しアーム（壁側へ 0.3m）と壁付けのプレート
    parts.push({ geom: box, matrix: place(s * 0.3, 0.42, 0.24, 0.022, 0.06, 0.32), color: 0x33363a });
    parts.push({ geom: box, matrix: place(s * 0.3, 0.30, 0.39, 0.04, 0.3, 0.03), color: 0x33363a });
  }
  const g = mergeParts(parts);
  box.dispose();
  return g;
}

/**
 * 袖看板（壁から直角に張り出す板）。日本の雑居ビルの顔。
 *
 * 板は YZ 面（法線が X 向き）。Z が張り出し方向で、
 * z=+0.5 より先にアームが伸びて壁に取り付く。
 * X 方向は実寸で焼くので、**インスタンスの X スケールは 1 のまま**にする。
 */
function signBladeGeometry(): BufferGeometry {
  const box = chamferedUnitBox(0.03);
  const parts: Part[] = [
    { geom: box, matrix: place(0, 0, 0, 0.12, 1.0, 1.0), color: 0xffffff },
  ];
  for (const s of [-1, 1]) {
    // 上下 2 本のアームで壁へ。局所 0.34 ぶんが持ち出し長さになる。
    parts.push({ geom: box, matrix: place(0, 0.2 + (s + 1) * 0.28, 0.66, 0.05, 0.05, 0.34), color: 0x33363a });
  }
  parts.push({ geom: box, matrix: place(0, 0.2, 0.84, 0.06, 0.62, 0.04), color: 0x33363a });
  const g = mergeParts(parts);
  box.dispose();
  return g;
}

/**
 * 鳥居。柱 2 本＋笠木＋貫を 1 つに焼き固める。
 * 神社は「赤い小屋」にしか見えないので、これが立つかどうかで用途の読めが決まる。
 */
function toriiGeometry(): BufferGeometry {
  const box = chamferedUnitBox(CHAMFER_U);
  const parts: Part[] = [
    { geom: box, matrix: place(-0.42, 0, 0, 0.1, 0.92, 0.1) },
    { geom: box, matrix: place(0.42, 0, 0, 0.1, 0.92, 0.1) },
    { geom: box, matrix: place(0, 0.92, 0, 1.14, 0.09, 0.17) }, // 笠木
    { geom: box, matrix: place(0, 0.86, 0, 1.0, 0.05, 0.13) }, // 島木
    { geom: box, matrix: place(0, 0.66, 0, 0.98, 0.07, 0.12) }, // 貫
    { geom: box, matrix: place(0, 0.72, 0, 0.07, 0.16, 0.09) }, // 額束
  ];
  const g = mergeParts(parts);
  box.dispose();
  return g;
}

// ---------------------------------------------------------------- インスタンス群

/**
 * 1 種類の部品のインスタンス群。
 * 行列・色・立面パラメータを自前の Float32Array に溜め、足りなくなったら倍に伸ばす。
 * 街が育つたびに全建物を書き直すので、毎回の確保をゼロにしておきたい。
 */
class Kit {
  readonly mesh: InstancedMesh;
  private matrices: Float32Array;
  private colors: Float32Array;
  private facades: Float32Array;
  private capacity: number;
  count = 0;

  constructor(geom: BufferGeometry, material: MeshStandardMaterial, capacity = 256) {
    this.capacity = capacity;
    this.matrices = new Float32Array(capacity * 16);
    this.colors = new Float32Array(capacity * 3);
    this.facades = new Float32Array(capacity * 4);
    this.mesh = new InstancedMesh(geom, material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.attach();
  }

  private attach(): void {
    this.mesh.instanceMatrix = new InstancedBufferAttribute(this.matrices, 16);
    this.mesh.instanceColor = new InstancedBufferAttribute(this.colors, 3);
    this.mesh.geometry.setAttribute('aFacade', new InstancedBufferAttribute(this.facades, 4));
  }

  private grow(): void {
    this.capacity *= 2;
    const m = new Float32Array(this.capacity * 16);
    m.set(this.matrices);
    this.matrices = m;
    const c = new Float32Array(this.capacity * 3);
    c.set(this.colors);
    this.colors = c;
    const f = new Float32Array(this.capacity * 4);
    f.set(this.facades);
    this.facades = f;
    this.attach();
  }

  reset(): void {
    this.count = 0;
  }

  push(mat: Matrix4, color: Color, style: number, p1: number, p2: number, p3: number): void {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    mat.toArray(this.matrices, i * 16);
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.facades[i * 4] = style;
    this.facades[i * 4 + 1] = p1;
    this.facades[i * 4 + 2] = p2;
    this.facades[i * 4 + 3] = p3;
  }

  flush(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    const f = this.mesh.geometry.getAttribute('aFacade') as InstancedBufferAttribute;
    f.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/** キットの種類。 */
export type KitName =
  | 'box'
  | 'boxV'
  | 'gable'
  | 'hip'
  | 'cyl'
  | 'tank'
  | 'torii'
  | 'acRow'
  | 'stack'
  | 'railFrame'
  | 'signFace'
  | 'signBlade';

const tmpMat = new Matrix4();
const tmpPos = new Vector3();
const tmpScl = new Vector3();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpColor = new Color();

/**
 * 建物の部品を積むところ。
 * 位置 (x,z) は部品の中心、y は**底面**。recipe 側で床の高さをそのまま渡せる。
 */
export class BuildingParts {
  readonly group = new Object3D();
  private readonly kits: Record<KitName, Kit>;
  private readonly mats: MeshStandardMaterial[] = [];

  constructor() {
    this.group.name = 'buildingParts';
    const boxMat = facadeMaterial(true);
    const plainMat = facadeMaterial(false);
    this.mats.push(boxMat, plainMat);
    this.kits = {
      box: new Kit(boxGeometry(), boxMat, 4096),
      boxV: new Kit(boxVGeometry(), boxMat, 4096),
      gable: new Kit(gableGeometry(), plainMat, 1024),
      hip: new Kit(hipGeometry(), plainMat, 256),
      cyl: new Kit(cylGeometry(), plainMat, 256),
      // 受水槽と鳥居は複数の箱を焼き固めた形。CHAMFER_FIX は
      // 「頂点が単位ボックスの角にある」ことを前提に座標を引き直すので、
      // 焼き固めた形に掛けると全部が 1 つの箱に潰れてしまう。面取り補正なしの材質を使う。
      tank: new Kit(tankGeometry(), plainMat, 256),
      torii: new Kit(toriiGeometry(), plainMat, 32),
      acRow: new Kit(acRowGeometry(), plainMat, 2048),
      stack: new Kit(stackGeometry(), plainMat, 512),
      railFrame: new Kit(railFrameGeometry(), plainMat, 2048),
      signFace: new Kit(signFaceGeometry(), plainMat, 512),
      signBlade: new Kit(signBladeGeometry(), plainMat, 1024),
    };
    for (const k of Object.values(this.kits)) this.group.add(k.mesh);
  }

  reset(): void {
    for (const k of Object.values(this.kits)) k.reset();
  }

  flush(): void {
    for (const k of Object.values(this.kits)) k.flush();
  }

  /** いま積まれている部品の総数（デバッグ用）。 */
  get instanceCount(): number {
    let n = 0;
    for (const k of Object.values(this.kits)) n += k.count;
    return n;
  }

  private put(
    kit: KitName,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    rotY: number,
    tilt: number,
    color: number | Color,
    style: number,
    p1: number,
    p2: number,
    p3: number,
  ): void {
    tmpPos.set(x, y, z);
    tmpScl.set(w, h, d);
    if (rotY === 0 && tilt === 0) tmpQuat.identity();
    else tmpQuat.setFromEuler(tmpEuler.set(tilt, rotY, 0, 'YXZ'));
    tmpMat.compose(tmpPos, tmpQuat, tmpScl);
    if (color instanceof Color) tmpColor.copy(color);
    else tmpColor.setHex(color);
    this.kits[kit].push(tmpMat, tmpColor, style, p1, p2, p3);
  }

  /** 窓の付く壁。floorH / bay で窓の格子が決まる。 */
  mass(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    facade: number,
    floorH: number,
    bay: number,
    seed: number,
    rotY = 0,
  ): void {
    this.put('box', x, y, z, w, h, d, rotY, 0, color, facade, floorH, bay, seed);
  }

  /**
   * 単純な箱の部品（庇・手すり・パラペット・室外機など）。
   * 小さい部品は上下の面取りが見えないので、自動で軽いキットに振り分ける。
   */
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    rough = 0.85,
    metal = 0.04,
    rotY = 0,
    tilt = 0,
  ): void {
    const kit: KitName = Math.max(w, h, d) < SMALL_PART_M ? 'boxV' : 'box';
    this.put(kit, x, y, z, w, h, d, rotY, tilt, color, Facade.Plain, rough, metal, 0);
  }

  /**
   * 文字の入らない小さな灯り（航空障害灯・灯籠・ポールの丸看板）。
   * 種に -1 を渡してシェーダの文字描画を止める。
   */
  sign(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    dayGlow = 0.15,
    nightGlow = 2.4,
    rotY = 0,
  ): void {
    this.put('boxV', x, y, z, w, h, d, rotY, 0, color, Facade.Sign, dayGlow, nightGlow, -1);
  }

  /**
   * 壁と平行に付く看板。厚み 0.12m の板＋壁から 0.3m のアーム。
   * 板の中心を (x,y,z) に置くので、呼び出し側は壁面 + 0.36m に置くこと。
   * 奥行きは実寸で焼いてあるので Z スケールは触らない。
   *
   * @param color 文字と縁取りのアクセント色（地は白）。
   */
  signFace(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    color: number | Color,
    seed: number,
    dayGlow = 0.12,
    nightGlow = 1.5,
    rotY = 0,
  ): void {
    this.put('signFace', x, y - h / 2, z, w, h, 1, rotY, 0, color, Facade.Sign, dayGlow, nightGlow, seed);
  }

  /**
   * 袖看板（壁から直角に張り出す縦長の板）。
   * (x,y,z) は板の下端中心。`proj` は張り出し長さで、
   * その 0.34 倍が壁までのアームになる。
   */
  signBlade(
    x: number,
    y: number,
    z: number,
    proj: number,
    h: number,
    color: number | Color,
    seed: number,
    dayGlow = 0.12,
    nightGlow = 1.8,
    rotY = 0,
  ): void {
    this.put('signBlade', x, y, z, 1, h, proj, rotY, 0, color, Facade.SignBlade, dayGlow, nightGlow, seed);
  }

  /**
   * 屋上の室外機の列（架台付き）。w は列の長さ。
   * 色は白から少しずらせるようにしてある。新品と古びたものが混ざると、
   * 同じキットを並べても「置かれた設備」に見える。
   */
  acRow(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    rotY = 0,
    color: number | Color = 0xffffff,
  ): void {
    this.put('acRow', x, y, z, w, h, d, rotY, 0, color, Facade.Plain, 0.55, 0.35, 0);
  }

  /** 屋上の円筒排気筒。 */
  stack(x: number, y: number, z: number, r: number, h: number, color: number | Color = 0xffffff): void {
    this.put('stack', x, y, z, r * 2, h, r * 2, 0, 0, color, Facade.Plain, 0.5, 0.55, 0);
  }

  /** 手すり（落下防止柵）の 1 スパン。len は X 方向の長さ。 */
  railFrame(x: number, y: number, z: number, len: number, h: number, rotY = 0): void {
    this.put('railFrame', x, y, z, len, h, 1, rotY, 0, 0xffffff, Facade.Plain, 0.55, 0.45, 0);
  }

  /** 円柱（煙突・サイロ・柱）。 */
  cyl(
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    color: number | Color,
    rough = 0.8,
    metal = 0.1,
  ): void {
    this.put('cyl', x, y, z, r * 2, h, r * 2, 0, 0, color, Facade.Plain, rough, metal, 0);
  }

  /**
   * 切妻屋根。棟は既定で X 方向。pitch は葺き足の間隔 (m)。
   * 瓦・スレートと金属葺き（トタン）では光り方が違うので、粗さと金属度を渡せる。
   */
  gable(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    rotY = 0,
    pitch = 0.4,
    rough = 0.72,
    metal = 0.06,
  ): void {
    this.put('gable', x, y, z, w, h, d, rotY, 0, color, Facade.Roof, rough, metal, pitch);
  }

  /** 寄棟屋根。 */
  hip(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    rotY = 0,
    pitch = 0.45,
    rough = 0.72,
    metal = 0.06,
  ): void {
    this.put('hip', x, y, z, w, h, d, rotY, 0, color, Facade.Roof, rough, metal, pitch);
  }

  /** 屋上の受水槽。 */
  tank(x: number, y: number, z: number, w: number, h: number, d: number, color: number | Color): void {
    this.put('tank', x, y, z, w, h, d, 0, 0, color, Facade.Plain, 0.72, 0.18, 0);
  }

  /** 鳥居。 */
  torii(x: number, y: number, z: number, w: number, h: number, color: number | Color, rotY = 0): void {
    this.put('torii', x, y, z, w, h, w * 0.22, rotY, 0, color, Facade.Plain, 0.7, 0.05, 0);
  }

  dispose(): void {
    for (const k of Object.values(this.kits)) k.dispose();
    for (const m of this.mats) m.dispose();
  }
}
