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
import { applyVerticalAO, chamferedUnitBox, mergeParts, place, tintGeometry, type Part } from './materials';
import {
  ROOF_TILES_X,
  ROOF_TILES_Y,
  disposeRoofTextures,
  roofAlbedoTexture,
  roofNormalTexture,
  roofTexMean,
} from './roofTexture';

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
  /**
   * 1 階の店構え（frontage キット）。
   * p1=種別（0 商業/1 事務所エントランス/2 住宅ポーチ/3 シャッター/4 雑居ビルの入口）,
   * p2=テナント 1 区画の間口 (m), p3=種。
   *
   * 目線の高さで街が「歩ける街」に見えるかどうかは、上階の窓ではなく
   * ここ 1 層で決まる。壁と同じ窓帯を 1 階にも流していたのが、
   * 前回いちばん大きな減点だった。
   */
  Front: 9,
  /**
   * バルコニーの手すり・腰壁。p1=種別（0 コンクリート腰壁 / 1 アルミ手すり /
   * 2 濃色パネル）, p2=パネル 1 枚の幅 (m), p3=種。
   *
   * 3 種に分けたつもりが、絵の上では全部「無地の実壁パネル」に見えていた。
   * 手すりを `Facade.Plain` の箱で描いていたので、天端も目地も無かったのが本体。
   */
  Parapet: 10,
} as const;

/**
 * 店構えキットの部品 ID。焼き込んだ頂点カラーの R をそのまま識別子に使う。
 *
 * `new Color(0xcccccc)` は sRGB → 作業色空間の変換が掛かって 0.8 にならないので、
 * 必ず `setRGB`（既定で作業色空間＝線形）で作る。ここがずれると
 * シェーダの分岐が 1 つ手前にずれ、庇が看板帯として描かれる。
 */
const FRONT_ID = {
  /** 開口面（ガラス・扉・シャッター）。 */
  panel: new Color().setRGB(1.0, 1.0, 1.0),
  /** 庇。 */
  canopy: new Color().setRGB(0.8, 0.8, 0.8),
  /** 端の柱。 */
  pier: new Color().setRGB(0.6, 0.6, 0.6),
  /** 庇の前縁の看板帯。 */
  fascia: new Color().setRGB(0.4, 0.4, 0.4),
  /** 腰の見切り・沓摺。 */
  base: new Color().setRGB(0.2, 0.2, 0.2),
};

/** 1 階の店構えの種別。`frontage()` に渡す。 */
export const FrontKind = {
  /** 商業：全面ガラスのショップフロントと庇。 */
  Shop: 0,
  /** 事務所：エントランスホールとキャノピー。 */
  Office: 1,
  /** 住宅：玄関ポーチ。 */
  Porch: 2,
  /** 工場・倉庫：シャッターと搬入口。 */
  Shutter: 3,
  /** 雑居ビル：テナント看板の並ぶ入口。 */
  Tenant: 4,
} as const;

/**
 * 桟瓦 1 枚の幅は葺き足の 0.78 倍。
 * 実寸だと葺き足 0.40m に対して幅 0.31m で、この比が崩れると
 * 俯瞰で瓦が縦に間延びして「縞模様の布」に見える。
 */
const TILE_W_RATIO = 0.78;

/** これより小さい部品は、上下の面取りを省いた軽い箱で描く (m)。 */
const SMALL_PART_M = 3.2;

/** 面取りの実寸 (m)。単位ボックスを拡大しても角の丸みが一定になるようにする。 */
const CHAMFER_M = 0.11;
/** 単位ボックスを作るときの面取り比。頂点の判別に使うのでシェーダと共有する。 */
const CHAMFER_U = 0.06;

/**
 * 材質共有のためのユニフォーム。
 *
 * 夜の量に加えて、空の色と太陽の向きを配る。
 * ガラスの映り込みを環境マップ任せにしていたが、あれは屋外の平均輝度を
 * 返すだけで、窓を 2 倍に拡大しても「一様なグレーブルーの平板」にしかならない。
 * 空色を直接受け取って `reflect()` で引けば、同じコストで
 * 「上半分に空、下半分に向かいの建物」が映るガラスになる。
 */
const uniforms = {
  uNight: { value: 0 },
  /** 天頂色・地平色・地上（向かいの建物と路面）の色。 */
  uSkyZenith: { value: new Color(0x2a68b8) },
  uSkyHorizon: { value: new Color(0xcadbe8) },
  uSkyGround: { value: new Color(0x2a2a28) },
  /** 太陽の向き（ワールド・正規化済み）と、映り込みに載せる日射色。 */
  uSunDir: { value: new Vector3(0.4, 0.7, 0.55) },
  uSunTint: { value: new Color(0xfff6e8) },
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
varying vec3 vWorldPos;
varying vec3 vWorldN;
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
// フェイク反射のためのワールド座標と法線。
// 法線はインスタンスのスケールで割ってから回す（逆転置行列の対角版）。
// 割らずに回すと、縦に引き伸ばした壁の法線が上を向いて、
// 壁全面が空を映してしまう。
vec4 wPos = vec4(pLocal, 1.0);
vec3 objN = normal / max(iScale, vec3(1e-4));
vec4 wNrm = vec4(objN, 0.0);
#ifdef USE_INSTANCING
  wPos = instanceMatrix * wPos;
  wNrm = instanceMatrix * wNrm;
#endif
vWorldPos = (modelMatrix * wPos).xyz;
vWorldN = normalize((modelMatrix * wNrm).xyz);
`;

const FRAG_PARS = /* glsl */ `
uniform float uNight;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
varying vec3 vLocalM;
varying vec3 vObjN;
varying vec3 vScaleM;
varying vec4 vFacadeV;
varying float vViewDepth;
varying vec3 vPartTint;
varying vec3 vWorldPos;
varying vec3 vWorldN;

vec3 gTint; float gRough; float gMetal; vec3 gEmis;
/** 環境マップの映り込みの倍率。窓だけ強くして「空を映すガラス」にする。 */
float gEnv;
/** その画素が窓かどうか 0..1。法線を少し上に倒して映り込みを壁と分ける。 */
float gWin;
/** フェイク反射で足す色。ガラスの証明はこれ 1 本にかかっている。 */
vec3 gRefl;
/** 屋根の接空間法線。棟の稜線はここで折る。 */
vec3 gRoofN;
/** 屋根テクスチャの UV（屋根のローカル座標から毎画素作る）。 */
vec2 gRoofUV;
#ifdef ROOF_TEX
uniform sampler2D uRoofMap;
uniform sampler2D uRoofNrm;
uniform float uRoofGain;
#endif

/**
 * 手続きの細かい模様を距離で消す係数。
 *
 * 距離でフェードしないプロシージャルノイズは、1 画素より細かくなった瞬間に
 * 圧縮ノイズに読める。カメラが動けば画面の全面でクロールする。
 * 画面上の変化率 w（fwidth）が 1 画素ぶんを超えたら 0 へ収束させる。
 *
 * @param w その模様の座標の fwidth
 * @param n 何周期ぶんで消し切るか
 */
float detailFade(float w, float n) {
  return 1.0 - smoothstep(0.0, 1.0, w * n);
}

/**
 * 反射方向から空の色を引く。
 *
 * 環境マップは「その場の平均的な明るさ」しか返さないので、窓を拡大しても
 * 一様な板にしかならなかった。ここでは反射ベクトルの Y だけを見て
 * 地平 → 天頂を引き、地平より下は向かいの建物と路面の色にする。
 * これだけで、1 枚の窓の中に「上は空、下は街」という縦の勾配が入り、
 * 見上げた窓と見下ろした窓で色が変わる。
 */
vec3 fakeSky(vec3 R) {
  float t = R.y;
  vec3 sky = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.62, t));
  // 地平のすぐ下は「向かいの建物の日の当たった上半分」なので、実際にはかなり明るい。
  // ここを黒に寄せると、見下ろした窓がすべて黒い板になって元に戻ってしまう。
  vec3 grd = mix(uSkyGround, uSkyHorizon, smoothstep(-0.55, -0.01, t));
  // 地平をまたぐところは smoothstep で繋ぐ。
  // 三項演算子で切り替えていたので、反射ベクトルが水平を横切る画素の列で
  // 色が階段状に飛び、窓の中に**直線の境界**が出ていた。
  // レビューの「窓に白い紙を貼ったように見える」はここが出所。
  vec3 c = mix(grd, sky, smoothstep(-0.07, 0.07, t));
  // 地平の上下に映るのは「向かいの建物」。街路でガラスを斜めに見ると
  // 反射ベクトルはほぼ水平になるので、ここを明るい地平色のままにすると
  // グレージング角の窓が一様な白い板になる。
  // 帯の幅を広く取り、縁を smoothstep で抜いて、境界が線に見えないようにする。
  float town = (1.0 - smoothstep(0.0, 0.32, abs(t))) * 0.60;
  c = mix(c, uSkyGround * 1.1, town);
  // 太陽のギラつき。窓が 1 枚だけ白く光る瞬間があると、一気にガラスになる。
  // ただし pow(s, 180) は 1 画素で 0 から 1 まで跳ぶので、そのままだと
  // 縁の立った白い矩形になる。smoothstep で裾を作って角を殺す。
  float s = max(dot(R, uSunDir), 0.0);
  c += uSunTint * smoothstep(0.88, 0.999, s) * 1.9;
  // 向かいの街並みと雲のむら。**反射ベクトルだけの関数**にするのが肝で、
  // 壁のローカル座標から作ると壁に貼り付いた模様になり、カメラが動いても
  // 動かない明るい面として「貼った紙」に見えてしまう。
  float m = sin(R.x * 5.3 + R.z * 3.1) * sin(R.y * 6.1 - R.x * 2.3);
  c *= 1.0 + 0.15 * m;
  return c;
}

/**
 * フレネル項。視線と面がなす角が浅いほど強い。
 * 街路に立って両側のビルを見ると、壁はほとんど真横 ＝ 深いグレージング角なので、
 * この項が効くかどうかで「ガラス張りのビルの並ぶ通り」に見えるかが決まる。
 */
float fresnelAt(vec3 V, vec3 N) {
  // 指数は物理値（5）より寝かせてある。ガラスの反射率は 45 度でまだ 5% しかなく、
  // 物理どおりに落とすと、街を歩く距離で見る窓がほとんど反射しない＝板に戻る。
  // 絵として「ガラスに見える」ことを優先して、立ち上がりを早くしてある。
  return pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 3.0);
}

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


/**
 * 看板・日除け・テナント表示のアクセント色。
 * 原色のべた塗りではなく、白地に載る色として選んである（看板キットと同じ考え方）。
 */
vec3 accentOf(float h) {
  return h < 0.17 ? vec3(0.72, 0.26, 0.22)
       : h < 0.34 ? vec3(0.78, 0.52, 0.16)
       : h < 0.50 ? vec3(0.17, 0.42, 0.64)
       : h < 0.66 ? vec3(0.28, 0.46, 0.28)
       : h < 0.83 ? vec3(0.40, 0.30, 0.54)
                  : vec3(0.16, 0.54, 0.40);
}

/**
 * 1 階の店構え（frontage キット）を描く。
 *
 * 部品の種別は焼き込んだ頂点カラーの R で持つ
 * （1.0 開口面 / 0.8 庇 / 0.6 柱 / 0.4 看板帯 / 0.2 腰見切り）。
 * vColor はインスタンス色が掛かった後の値なので使えない。
 *
 * 用途ごとに 1 階の表情を変えるのが目的なので、分岐は種別ごとに素直に書く。
 * ここは目線の高さで画面のいちばん手前に来る 1 層で、
 * 上階の窓 100 個より 1 階の 1 枚のガラスの方が絵に効く。
 */
void frontShade(vec3 base) {
  float kind = vFacadeV.y;
  float bayW = max(vFacadeV.z, 1.6);
  float sd = vFacadeV.w;
  float id = vPartTint.r;
  vec3 n = vObjN;
  float ax = abs(n.x), ay = abs(n.y), az = abs(n.z);
  float pw = max(vScaleM.x, 0.1);
  float ph = max(vScaleM.y, 0.1);
  float u = vLocalM.x;
  float py = vLocalM.y;
  float yn = clamp(py / ph, 0.0, 1.0);

  gTint = vec3(1.0); gRough = 0.86; gMetal = 0.05; gEmis = vec3(0.0);
  gEnv = 1.0; gWin = 0.0; gRefl = vec3(0.0);

  // テナントの割付。間口ごとに独立した乱数を引く。
  float t = (u + pw * 0.5) / bayW;
  float ti = floor(t);
  float tf = fract(t);
  float ha = h21(vec2(ti, 3.0) + sd * 41.0);
  float hb = h21(vec2(ti, 17.0) + sd * 41.0);
  float hc = h21(vec2(ti, 29.0) + sd * 41.0);
  vec3 accent = accentOf(ha);
  // 2 割ほどの区画は閉まっている。全部が同じだけ光ると「光る帯」に戻る。
  float closed = step(0.79, hc) * step(kind, 0.5);

  // ---- 庇 ----
  if (id > 0.7 && id < 0.9) {
    float under = step(n.y, -0.5);
    // 下面は必ず暗い。庇は、この落ち影を作るために付けている。
    gTint = vec3(mix(1.04, 0.30, under));
    gRough = 0.80; gMetal = 0.06;
    // 庇の下の帯照明。夜の歩道の足元がここで読める。
    gEmis = vec3(1.0, 0.94, 0.82) * under * uNight * 0.34 * (1.0 - closed * 0.85)
          * step(kind, 0.5);
    return;
  }
  // ---- 看板帯（庇の前縁）----
  if (id > 0.3 && id < 0.5) {
    gRough = 0.5; gMetal = 0.05;
    float faceOut = step(0.55, az);
    // 帯の中の縦位置（キットで y=0.78..0.95 に焼いてある）
    float fv = clamp((yn - 0.78) / 0.17, 0.0, 1.0);
    vec2 p = vec2(fv, tf);
    float aa = max(fwidth(p.x), fwidth(p.y)) * 0.9 + 0.008;
    float fade = smoothstep(40.0, 95.0, vViewDepth);
    float ink = mix(signGlyphs(p, 4.0, sd + ti * 0.37, aa), 0.28, fade) * faceOut;
    vec3 plate = mix(vec3(0.90, 0.89, 0.85), accent, ink);
    // 事務所・住宅の 1 階には店名の看板は出ない。無地のアルミの帯にする。
    plate = mix(vec3(0.62, 0.63, 0.62), plate, step(kind, 0.5) + step(3.5, kind));
    gTint = plate / max(base, vec3(0.02));
    gEmis = plate * faceOut * (0.05 + uNight * 0.95 * (1.0 - closed * 0.9))
          * (step(kind, 0.5) + step(3.5, kind));
    return;
  }
  // ---- 腰の見切り（御影石・タイル）----
  if (id < 0.3) {
    gTint = vec3(0.34) / max(base, vec3(0.02));
    gRough = 0.55; gMetal = 0.12;
    return;
  }
  // ---- 端の柱 ----
  if (id < 0.7) {
    // 目地を 1 本入れて、塗った板ではなくタイル貼りの柱に見せる。
    float joint = bandAA(fract(py / 0.6), 0.0, 0.06, fwidth(py / 0.6));
    gTint = vec3(0.90 - joint * 0.14) * mix(0.72, 1.0, yn);
    gRough = 0.8; gMetal = 0.05;
    return;
  }

  // ---- 開口面（ここが 1 階の表情そのもの）----
  bool faceOut = az > max(ax, ay) && n.z > 0.0;
  if (!faceOut) {
    // 板の小口。枠のアルミ。
    gTint = vec3(0.34) / max(base, vec3(0.02));
    gRough = 0.4; gMetal = 0.6;
    return;
  }

  vec3 col = vec3(0.5);
  float glassMask = 0.0;      // 反射を掛ける範囲
  vec3 emis = vec3(0.0);
  float rough = 0.85, metal = 0.05;

  // 方立（サッシの縦桟）。0.95m ピッチ。
  float mull = bandAA(fract(u / 0.95), 0.0, 0.05, fwidth(u / 0.95));
  // テナントの境の柱
  float pier = bandAA(tf, 0.0, 0.07, fwidth(t));

  if (kind < 0.5) {
    // ---- 商業：全面ガラスのショップフロント ----
    float sill = 0.32;                       // 腰の高さ
    float head = ph * 0.80;                  // ガラスの上端
    float g = step(sill, py) * (1.0 - step(head, py)) * (1.0 - pier);
    // 店内。奥に行くほど暗く、什器の水平線が入る。
    float shelf = bandAA(fract((py - sill) / 0.66), 0.0, 0.12, fwidth(py / 0.66));
    vec3 inside = vec3(0.15, 0.155, 0.16) * (1.0 - shelf * 0.30);
    // 奥の壁。天井近くが明るい（照明が天井にある）。
    inside += vec3(0.13, 0.12, 0.10) * smoothstep(sill, head, py);
    // 客・什器の影。区画ごとに 1 つ入るだけで、ガラスの奥に空間ができる。
    float fx = 0.22 + 0.56 * fract(hb * 11.0);
    float fig = (1.0 - smoothstep(0.045, 0.085, abs(tf - fx)))
              * (1.0 - smoothstep(0.42, 0.62, (py - sill) / max(head - sill, 0.1)));
    inside *= 1.0 - fig * 0.6;
    // 入口の自動ドア。区画の右寄りに 1 か所。
    float door = step(0.60, tf) * (1.0 - step(0.88, tf));
    inside = mix(inside, inside * 0.72, door * step(py, head * 0.92));
    // のれん・タペストリ。ガラスの上 1/5 に色帯が入る。
    float noren = step(head * 0.78, py) * (1.0 - step(head, py)) * step(0.55, hb);
    inside = mix(inside, accent * 0.55, noren * 0.85);
    col = mix(vec3(0.72, 0.71, 0.68), inside, g);          // 枠は明るいアルミ
    col = mix(col, vec3(0.20, 0.20, 0.19), (1.0 - step(sill, py)));   // 腰壁（御影石）
    // テナントの境の柱と方立を強く出す。ここで帯が切れることで、
    // 光る 1 本の帯ではなく「並んだ店」として数えられるようになる。
    col *= 1.0 - mull * g * 0.40 - pier * 0.45;
    glassMask = g * (1.0 - mull * 0.8);
    rough = mix(0.7, 0.14, glassMask);
    metal = mix(0.08, 0.22, glassMask);
    // 夜の売り場。純白ではなく、業種で色を変えた光を「滲ませて」出す。
    vec3 litC = ha < 0.42 ? vec3(1.00, 0.95, 0.84)
              : (ha < 0.74 ? vec3(1.00, 0.72, 0.44) : accent + vec3(0.35));
    // 夜の売り場は街路でいちばん明るいが、上限は 1.4 前後で止める。
    // 隣り合う店が全部 2 を超えると、ブルームで店の切れ目が溶けて
    // 商店街が「1 枚の白い板」に戻ってしまう。
    float glow = (0.14 + uNight * 0.95) * (1.0 - closed * 0.88);
    // 内部の階調をそのまま発光に持ち込む（一様に光らせない）。
    emis = litC * g * glow * (0.45 + 0.85 * smoothstep(sill, head, py)) * (1.0 - fig * 0.7);
    emis += accent * noren * (0.1 + uNight * 0.5);
  } else if (kind < 1.5) {
    // ---- 事務所：エントランスホール ----
    float sill = 0.18;
    float head = ph * 0.88;
    float g = step(sill, py) * (1.0 - step(head, py));
    // ホールの奥。床と天井が見え、中央に受付のカウンター。
    vec3 inside = vec3(0.13, 0.14, 0.155);
    inside += vec3(0.10, 0.10, 0.11) * smoothstep(head * 0.55, head, py);
    inside += vec3(0.07) * (1.0 - smoothstep(sill, sill + 0.9, py));
    // 自動ドアの 2 枚建て。中央に縦の枠が 2 本。
    float cx = abs(u) / max(pw * 0.5, 0.1);
    float doorFrame = (1.0 - smoothstep(0.02, 0.05, abs(cx - 0.20)))
                    + (1.0 - smoothstep(0.02, 0.05, abs(cx - 0.02)));
    inside = mix(inside, vec3(0.30), clamp(doorFrame, 0.0, 1.0) * step(py, 2.3));
    col = mix(vec3(0.40, 0.41, 0.42), inside, g);
    col *= 1.0 - bandAA(fract(u / 1.45), 0.0, 0.05, fwidth(u / 1.45)) * 0.30;
    glassMask = g;
    rough = mix(0.6, 0.10, g);
    metal = mix(0.15, 0.25, g);
    emis = vec3(0.92, 0.94, 0.98) * g * (0.10 + uNight * 0.85)
         * (0.5 + 0.9 * smoothstep(sill, head, py));
  } else if (kind < 2.5) {
    // ---- 住宅：玄関ポーチ ----
    //
    // 寸法は実寸で書く。相対で書くと、間口 3m の家でも 8m の家でも
    // 「間口の半分が扉」になって、玄関の大きさで家の大きさが読めなくなる。
    float ux = abs(u);
    float door = (1.0 - step(0.47, ux)) * (1.0 - step(2.05, py));
    // 木目の縦線が入った玄関扉
    float grain = bandAA(fract(u / 0.11), 0.0, 0.5, fwidth(u / 0.11));
    vec3 doorC = vec3(0.26, 0.19, 0.13) * (0.92 + grain * 0.12);
    // 扉の脇の小窓（型ガラス）
    float side = step(0.58, ux) * (1.0 - step(0.84, ux))
               * step(0.85, py) * (1.0 - step(1.9, py));
    col = mix(vec3(0.88), doorC, door);
    col = mix(col, vec3(0.55, 0.58, 0.56), side);
    // 引き手（縦長のハンドル）
    col *= 1.0 - (1.0 - smoothstep(0.015, 0.03, abs(ux - 0.34)))
                 * step(0.95, py) * (1.0 - step(1.35, py)) * door * 0.55;
    glassMask = side * 0.6;
    rough = 0.72; metal = 0.04;
    emis = vec3(1.0, 0.86, 0.62) * side * uNight * 0.5;
    // 玄関灯。扉の脇の壁に 1 つ。夜の住宅地はこれが点いているかで生活感が変わる。
    float lamp = (1.0 - smoothstep(0.06, 0.10, abs(ux - 1.02)))
               * (1.0 - smoothstep(0.07, 0.11, abs(py - 2.0)));
    emis += vec3(1.0, 0.88, 0.66) * lamp * (0.08 + uNight * 1.5);
    col = mix(col, vec3(0.95, 0.90, 0.80), lamp);
  } else if (kind < 3.5) {
    // ---- 工場・倉庫：シャッターと搬入口 ----
    float rail = (1.0 - smoothstep(0.44, 0.47, abs(u) / max(pw * 0.5, 0.1)));
    // 折板シャッターの横スジ。0.11m ピッチ。
    float rib = fract(py / 0.11);
    float shade = bandAA(rib, 0.0, 0.45, fwidth(py / 0.11));
    col = vec3(0.52, 0.53, 0.53) * (0.86 + shade * 0.26);
    // 下端の水切りと、上部の巻き取りボックス
    col *= 1.0 - (1.0 - step(0.18, py)) * 0.35;
    col = mix(col, vec3(0.40, 0.41, 0.41), step(ph * 0.86, py));
    // 通用口（片側の小さな鉄扉）
    float un = (u + pw * 0.5) / pw;
    float pdoor = step(0.03, un) * (1.0 - step(0.13, un)) * (1.0 - step(2.0, py));
    col = mix(col, vec3(0.30, 0.33, 0.34), pdoor);
    // 錆と汚れ。搬入口の下端は必ず擦れている。
    col *= 1.0 - vnoise(vec2(u * 1.4, py * 1.4)) * 0.10 * detailFade(fwidth(u * 1.4), 1.4);
    col *= 1.0 - rail * 0.18;
    rough = 0.62; metal = 0.42;
    emis = vec3(1.0, 0.93, 0.78) * pdoor * uNight * 0.25;
  } else {
    // ---- 雑居ビル：テナント看板の並ぶ入口 ----
    //
    // 日本の雑居ビルの 1 階は「狭くて暗い階段の入口」「その脇のテナント表示板」
    // 「端の自動販売機」の 3 つで出来ている。全部を実寸で置く。
    float ux = u + pw * 0.5;                 // 左端からの距離 (m)
    float entX = pw * 0.62;                  // 入口の中心（やや右寄り）
    float ent = (1.0 - step(1.25, abs(ux - entX))) * (1.0 - step(ph * 0.78, py));
    vec3 inside = vec3(0.075, 0.075, 0.08);
    // 奥の階段。斜めの明暗が 1 本入ると、奥行きのある穴に見える。
    float stair = bandAA(fract(py * 1.6 + (ux - entX) * 0.8), 0.0, 0.5, 0.3);
    inside *= 0.7 + stair * 0.9;
    // テナント表示板。幅 1.1m の板に、階数ぶんの小さな行が縦に積む。
    float bx0 = max(entX - 2.7, 0.25);
    float bxm = (1.0 - step(1.1, abs(ux - bx0 - 0.55)));
    float rows = 6.0;
    float bTop = min(ph * 0.7, 3.0);
    float bt = clamp((py - 0.85) / max(bTop - 0.85, 0.3), 0.0, 0.999);
    float ri = floor(bt * rows);
    float rowT = fract(bt * rows);
    float hr = h21(vec2(ri, 7.0) + sd * 53.0);
    vec3 plate = mix(vec3(0.86, 0.85, 0.82), accentOf(hr), 0.18);
    float gap = bandAA(rowT, 0.08, 0.92, fwidth(rowT));
    float boardM = bxm * step(0.85, py) * (1.0 - step(bTop, py));
    vec2 gp = vec2(clamp(rowT, 0.0, 1.0), clamp((ux - bx0) / 1.1, 0.0, 1.0));
    float aa2 = max(fwidth(gp.x), fwidth(gp.y)) * 0.9 + 0.01;
    float ink = signGlyphs(gp, 3.0, sd + ri * 0.29, aa2);
    plate = mix(plate, accentOf(hr) * 0.55, ink);
    plate *= mix(0.35, 1.0, gap);
    col = vec3(0.42, 0.42, 0.41);
    // 入口まわりの壁は磨いた石。雑居ビルの足元はたいていこれ。
    // 軒下の粒状ノイズ。距離で消さないと、遠景で壁がざらついて見える。
    col *= 1.0 + 0.2 * (vnoise(vec2(ux * 3.0, py * 3.0)) - 0.5) * detailFade(fwidth(ux * 3.0), 1.2);
    col = mix(col, inside, ent);
    col = mix(col, plate, boardM);
    // 自動販売機（右端）。日本の雑居ビルの足元には必ず 1 台ある。
    float vm = (1.0 - step(0.55, abs(ux - (pw - 0.9)))) * (1.0 - step(1.9, py));
    vec3 vmC = mix(accent, vec3(0.85), 0.25);
    float vmWin = step(0.85, py) * (1.0 - step(1.72, py));
    col = mix(col, mix(vmC, vec3(0.95, 0.93, 0.86), vmWin), vm);
    rough = 0.66; metal = 0.1;
    emis = vec3(0.95, 0.92, 0.86) * boardM * (0.05 + uNight * 0.9) * mix(0.4, 1.0, gap);
    emis += vec3(1.0, 0.95, 0.88) * vm * vmWin * (0.22 + uNight * 1.7);
    emis += vec3(1.0, 0.88, 0.70) * ent * stair * uNight * 0.28;
  }

  gTint = col / max(base, vec3(0.02));
  gRough = rough; gMetal = metal;
  gEmis = emis;
  gWin = glassMask;
  // ガラスに空を映す。1 階は目線の高さなので、ここの映り込みが
  // いちばん近くで見られる。フレネルで縁を明るくすると板から抜ける。
  if (glassMask > 0.001) {
    vec3 V = normalize(vWorldPos - cameraPosition);
    vec3 Nw = normalize(vWorldN);
    // 上限は上階の窓より低く抑える。1 階のガラスは街路を斜めに見ることが多く、
    // 上階と同じだけ映すと反射で真っ白になって、せっかく描いた店内が消える。
    // ショップフロントは「中が見えること」が値打ちなので、映り込みは脇役でよい。
    gRefl = fakeSky(reflect(V, Nw)) * mix(0.10, 0.52, fresnelAt(V, Nw)) * glassMask;
  }
}

/**
 * バルコニーの手すり・腰壁。
 *
 * 3 種類に作り分けたはずのものが、絵の上では全部「無地の実壁パネル」に
 * 見えていた。原因は 2 つで、
 *  (a) 手すりを Facade.Plain の箱で描いていたので、天端も目地も無かった。
 *  (b) アルミ手すりは 1 スパンのキットを横に引き伸ばしていたので、
 *      幅 4.5cm のはずの子柱が、長さ 10m の腰壁では幅 45cm の板になっていた。
 *      引き伸ばす作りである限り、キットの子柱は絶対に細くならない。
 *
 * どちらもシェーダで描けば消える。3 種を材質側で描き分ける。
 *   0 = コンクリートの腰壁（笠木＋縦目地＋雨だれ）
 *   1 = アルミの手すり（細い子柱が並び、その間は奥の影）
 *   2 = 濃色パネル＋アルミ枠（枠が明るく、面が暗く艶がある）
 * どれも同じ箱のキットに載るので、インスタンスもドローコールも増えない。
 */
void parapetShade(vec3 base) {
  gTint = vec3(1.0); gRough = 0.84; gMetal = 0.06; gEmis = vec3(0.0);
  gEnv = 1.0; gWin = 0.0; gRefl = vec3(0.0);
  float kind = vFacadeV.y;
  float panelW = max(vFacadeV.z, 0.6);
  vec3 n = vObjN;
  float ax = abs(n.x), ay = abs(n.y), az = abs(n.z);

  // 天端（笠木）。どの種類でもアルミか石の見切りが載る。
  // 上面がひとつ明るい線として抜けるだけで、帯が「厚みのある壁」になる。
  if (ay > max(ax, az)) {
    gTint = vec3(n.y > 0.0 ? 1.30 : 0.42);
    gRough = 0.40; gMetal = 0.45;
    return;
  }

  bool alongZ = ax > az;
  float u = alongZ ? vLocalM.z : vLocalM.x;
  float len = max(alongZ ? vScaleM.z : vScaleM.x, 0.3);
  float H = max(vScaleM.y, 0.2);
  float y = vLocalM.y;
  float dTop = H - y;                     // 天端からの距離 (m)
  float wy = fwidth(y);
  float ul = u + len * 0.5;               // 端からの距離 (m)

  // ---- 全種共通の 2 本：天端キャップの見付と、その真下に落ちる影 ----
  // 眼高では「4cm の見切り 1 本」が素材の説得力を決める。
  // これがゼロだと、淡い色の腰壁が発泡スチロールの板に見える。
  // 影の帯は面取りより下まで伸ばす。箱のキットは天端 11cm が 45 度の
  // 面取りなので、そこだけに影を置くと丸みの陰影に紛れて線として読めない。
  float capFace = bandAA(dTop, 0.0, 0.05, wy);
  float capShad = bandAA(dTop, 0.05, 0.15, wy);
  // 下端の水切り。床スラブとの取り合いに必ず影が溜まる。
  float dripS = bandAA(y, 0.0, 0.05, wy);

  if (kind > 1.5) {
    // ---- 濃色パネル（ガラス／スチール）＋アルミ枠 ----
    // 面を暗く、枠を明るくする。腰壁とは明暗が逆になるので、
    // 同じ形でも遠目に別の作りとして読める。
    float post = bandAA(fract(ul / 1.2), 0.0, 0.055, fwidth(ul / 1.2));
    float frame = max(post, max(bandAA(dTop, 0.05, 0.13, wy), bandAA(y, 0.0, 0.10, wy)));
    vec3 panel = vec3(0.30, 0.32, 0.35);
    vec3 alum = vec3(0.82, 0.83, 0.84);
    vec3 col = mix(panel, alum, frame);
    gTint = col / max(base, vec3(0.03));
    gRough = mix(0.24, 0.42, frame);
    gMetal = mix(0.35, 0.62, frame);
    // 面はわずかに空を映す。ここが板のままだと「濃い色を塗った腰壁」に戻る。
    vec3 V = normalize(vWorldPos - cameraPosition);
    vec3 Nw = normalize(vWorldN);
    gRefl = fakeSky(reflect(V, Nw)) * mix(0.06, 0.40, fresnelAt(V, Nw)) * (1.0 - frame);
    gTint *= 1.0 + capFace * 0.30 - capShad * 0.30;
    return;
  }

  if (kind > 0.5) {
    // ---- アルミの手すり ----
    //
    // 子柱を実寸（径 1.6cm・ピッチ 11cm）で描く。抜くことはできないので、
    // 子柱の間はバルコニーの奥（＝日の当たらない面）の色にする。
    // 明暗の縞が細かく入るだけで、腰壁とは別物として読める。
    float pp = 0.11;
    float bar = fract(ul / pp);
    float wb = fwidth(ul / pp);
    float baluster = bandAA(bar, 0.0, 0.16, wb);
    // 笠木（上端の太い横桟）と中桟・下桟。
    float rails = max(bandAA(dTop, 0.0, 0.055, wy),
                  max(bandAA(dTop, H * 0.5 - 0.02, H * 0.5 + 0.02, wy),
                      bandAA(y, 0.0, 0.035, wy)));
    float metalM = max(baluster, rails);
    // 遠景では子柱が 1 画素を割る。そこで縞を描き続けると
    // 柵がちらつく点の集合になるので、平均の明るさへ寄せる。
    float near = detailFade(wb, 0.9);
    metalM = mix(0.42, metalM, near);
    // 奥は建物の陰。手すりの向こうが暗いから「抜けている」に見える。
    vec3 col = mix(vec3(0.16, 0.17, 0.18), vec3(0.86, 0.87, 0.88), metalM);
    gTint = col / max(base, vec3(0.03));
    gRough = mix(0.7, 0.30, metalM);
    gMetal = mix(0.05, 0.70, metalM);
    return;
  }

  // ---- コンクリートの腰壁 ----
  float t = 1.0;
  t += capFace * 0.34;                    // 笠木の見付（明るい 5cm）
  t -= capShad * 0.36;                    // その真下の影
  t -= dripS * 0.26;                      // 下端の水切り
  // パネルの縦目地。打ち継ぎか、乾式パネルの継ぎ目が必ず 1 本ある。
  // 見えるのは幅 1cm 前後の線 1 本だが、これが無い帯は必ず板に見える。
  //
  // 溝は「暗い 1 本」ではなく「暗い 1 本＋その脇の明るい 1 本」で描く。
  // 実物の目地は深さ 1cm ほどの彫り込みで、片側の面には必ず光が回る。
  // 暗い線だけだと、彫った溝ではなく「線を引いた板」に見えてしまう。
  float jf = fract(ul / panelW);
  float jw = fwidth(ul / panelW);
  float jointW = 0.013 / panelW;              // 1.3cm を割付の比に直す
  t -= bandAA(jf, 0.0, jointW, jw) * 0.44;
  t += bandAA(jf, jointW, jointW * 2.4, jw) * 0.17;
  // 吹付けタイル／打ち放しの肌。5〜8cm の斑が見えるかどうかで、
  // 眼高では「塗った板」と「打った壁」が分かれる。
  // ここは画面の 3〜4 割を占める面なので、肌が無いと帯全体が発泡スチロールに見える。
  // 1 画素より細かくなったら消す（遠景でビデオノイズにしない）。
  vec2 sp = vec2(ul, y) * 13.0;
  t *= 1.0 + (vnoise(sp) - 0.5) * 0.11 * detailFade(fwidth(sp.x), 1.2);
  // 笠木から垂れる雨だれ。遠景では必ず消す（近くでしか意味を持たない）。
  float sc = ul * 0.7;
  float streak = smoothstep(0.62, 1.0, h21(vec2(floor(sc), 5.0) + vFacadeV.w * 31.0))
               * sin(fract(sc) * 3.14159)
               * clamp(1.0 - dTop / 0.9, 0.0, 1.0);
  t -= streak * 0.20 * detailFade(fwidth(sc), 1.6);
  // 足元がわずかに暗い。板ではなく「立ち上がった壁」に見せる最小の勾配。
  t *= mix(0.86, 1.04, clamp(y / max(H, 0.2), 0.0, 1.0));
  gTint = vec3(t);
  // 天端の 5cm だけはアルミの笠木。粗さと金属度まで切り替えないと、
  // 明るい線を 1 本引いただけになって、載っている別部材には見えない。
  gRough = mix(0.86, 0.40, capFace); gMetal = mix(0.04, 0.42, capFace);
}

void facadeShade(vec3 base) {
  gTint = vec3(1.0); gRough = 0.9; gMetal = 0.03; gEmis = vec3(0.0);
  gEnv = 1.0; gWin = 0.0; gRefl = vec3(0.0);
  gRoofN = vec3(0.0, 0.0, 1.0); gRoofUV = vec2(0.0);
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
    // 下を向く面は必ず暗い。庇・バルコニーの床スラブ・看板の裏の軒天が
    // 明るいままだと、眼高でどれも「厚みの無い板」に見える。
    // 影マップは薄い板の裏側までは届かないので、ここで 1 行入れておく。
    gTint *= mix(1.0, 0.52, clamp(-n.y, 0.0, 1.0));
    // 天端の見切りと下端の水切り。実寸 4cm・3cm の線を 2 本だけ入れる。
    //
    // 眼高では「4cm の見切り 1 本」が素材の説得力を決める。ここは
    // バルコニーの床スラブ・庇・屋上のパラペット・笠木がまとめて通る場所で、
    // どれも小口（＝立ち上がった板の側面）が画面のかなりの面積を占めるのに、
    // 天端も水切りも無い一様な塗り面だった。レビューの「天端キャップも
    // 水切りも目地も無い」はここが出所。
    // 立面にだけ掛ける（上下面に掛けると板の縁が全周光って輪郭が浮く）。
    float side = 1.0 - step(0.5, ay);
    float wyP = fwidth(vLocalM.y);
    gTint *= 1.0 + bandAA(vScaleM.y - vLocalM.y, 0.0, 0.04, wyP) * 0.26 * side;
    gTint *= 1.0 - bandAA(vScaleM.y - vLocalM.y, 0.04, 0.14, wyP) * 0.22 * side;
    gTint *= 1.0 - bandAA(vLocalM.y, 0.0, 0.03, wyP) * 0.30 * side;
    return;
  }

  // ---- 看板 ----
  if ((style > 4.5 && style < 5.5) || (style > 7.5 && style < 8.5)) {
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
    // 遠景で寄せる先を 0.30 から 0.46 に上げた。0.30 だと白地が 7 割残り、
    // 街を少し引いて見ただけで袖看板が「白い紙を貼り付けた板」になっていた
    // （夜と夕方はそこが光るので、白い長方形の列としていちばん目に付く）。
    // 実際の看板は地の色より文字の色のほうが面積が広いことが多いので、
    // 引いたときは地色寄りではなく中間へ寄せるほうが近い。
    float ink = mix(signGlyphs(p, chars, sd, aa), 0.46, fade) * panel;
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
    //
    // 全体の強さは 0.6 倍に落としてある。以前は板が丸ごと 255 に飽和して、
    // 街路の夜が「白い長方形の連なり」になっていた。
    // 内照式の看板は蛍光灯を中に並べたものなので、実際には板の中に
    // 縦方向のむらがあり、縁は暗い。そのむらを入れれば、
    // 強さを落としても「光っている看板」に見える。
    float glow = (vFacadeV.y + vFacadeV.z * uNight) * 0.6;
    // 中の蛍光灯の筋（板の長手に沿った 3 本）と、縁に向かう落ち込み。
    float lamp = 0.82 + 0.28 * abs(sin((lenH > vScaleM.y ? p.x : p.y) * 9.42));
    float vign = smoothstep(0.0, 0.16, min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y)));
    gEmis = col * face * panel * glow * (1.0 - edge * 0.85)
          * mix(0.7, 1.4, ink) * lamp * mix(0.45, 1.0, vign);
    return;
  }

  // ---- バルコニーの手すり・腰壁 ----
  if (style > 9.5) {
    parapetShade(base);
    return;
  }

  // ---- 1 階の店構え ----
  if (style > 8.5) {
    frontShade(base);
    return;
  }

  // ---- 屋根（瓦・折板）----
  //
  // 俯瞰のカットでは画面の 4 割以上が屋根で、ここが単色のクアッドだと
  // 街全体が「色紙を折った模型」に見える。面積のいちばん大きい素材が
  // 情報ゼロなのが、俯瞰の絵で最も大きな減点だった。
  //
  // 直し方は 3 段。
  //  (1) 全屋根で共有する 1 枚の桟瓦テクスチャを、屋根のローカル座標
  //      （棟方向 × 流れ方向、単位はメートル）で貼る。
  //      屋根キットはもともと InstancedMesh 1 つずつなので、
  //      ここだけ材質を分けてもドローコールは増えない。
  //  (2) 棟・軒先は幾何から描く。テクスチャに焼くと屋根の大きさで
  //      棟の太さが変わってしまう。
  //  (3) 棟の稜線は法線で折る。明暗を塗るだけでは、日陰の屋根で棟が消える。
  if (style > 6.5 && style < 7.5) {
    gRough = vFacadeV.y; gMetal = vFacadeV.z;
    gRoofN = vec3(0.0, 0.0, 1.0);
    // 流れ（勾配）方向は、法線の X/Z 成分の大きい方。
    bool downZ = (az >= ax);
    float run = 0.5 * max(downZ ? vScaleM.z : vScaleM.x, 0.2);
    float rise = max(vScaleM.y, 0.05);
    // 勾配ぶんだけ流れ方向は長い。水平距離のまま葺き足を刻むと、
    // 勾配の急な屋根ほど瓦が間延びして見える。
    float slopeLen = run * sqrt(1.0 + (rise * rise) / (run * run));
    // 棟／軒までの距離は高さ比から出す。寄棟の隅（三角形の面）でも
    // 高さ比なら破綻せず、棟と軒が必ず正しい位置に来る。
    float yn = clamp(vLocalM.y / rise, 0.0, 1.0);
    float dRidge = (1.0 - yn) * slopeLen;
    float dEave = yn * slopeLen;
    // 葺き足。寄棟は +10 の下駄を履いて渡ってくる（hip() の注記を参照）。
    float pRaw = vFacadeV.w;
    float isHip = step(5.0, pRaw);
    float pitch = max(abs(pRaw) - isHip * 10.0, 0.15);
    float q = downZ ? vLocalM.x : vLocalM.z;
    // テクスチャ 1 枚に瓦が ROOF_TILES_X 枚 × ROOF_TILES_Y 段ぶん焼いてある。
    // ここで枚数まで割らないと、瓦 1 枚が数センチの砂目になってしまう。
    gRoofUV = vec2(q / (pitch * ${TILE_W_RATIO} * ${ROOF_TILES_X}.0), dRidge / (pitch * ${ROOF_TILES_Y}.0));

    // 屋根の流れではない面（鼻隠し・軒天・妻面の破風）。
    // 流れの面は必ず上を向いているので、法線の Y でまとめて拾える。
    // ここに瓦を貼ると、軒先の木口や破風にまで瓦が回り込んで、
    // 屋根が「全面に模様を巻いた塊」に見えてしまう。
    float board = max(step(vLocalM.y, -0.004 * rise), 1.0 - step(0.12, n.y));
    // 折板葺き（トタン）は瓦ではないので、テクスチャを外して縦の山だけにする。
    float metalRoof = step(0.25, vFacadeV.z);
    // 葺き足に負の値が来たら「屋根ではないもの」（植林の樹冠・東屋）の印。
    // 同じ寄棟のキットを流用しているので、瓦を貼らせないための逃げ道が要る。
    float noTile = step(pRaw, 0.0);
    float plain = max(max(metalRoof, board), noTile);

    vec3 col = vec3(1.0);
#ifdef ROOF_TEX
    // この材質は屋根キット専用なので、style の分岐は材質の全画素で真になる。
    // つまりテクスチャの読み出しは一様な制御フローの中にあり、
    // ミップ選択の導関数が壊れる心配が無い（材質を分けた理由の半分はこれ）。
    // ミップを 1/3 段だけ早く落とす。俯瞰では瓦 1 枚が 1〜2 画素しかなく、
    // 素のミップ選択だと瓦の格子と画素の格子が干渉して、
    // 屋根に規則正しい光る点の並び（モアレ）が出る。
    // 以前は 0.55 だったが、それだと中距離で瓦がほとんど溶けていた。
    // 中距離の目地は下の bandAA（葺き足の横線）が受け持つので、
    // テクスチャ側はもう少し粘らせてよい。
    col = mix(texture2D(uRoofMap, gRoofUV, 0.35).rgb * uRoofGain, vec3(1.0), plain);
    gRoofN = mix(texture2D(uRoofNrm, gRoofUV, 0.35).xyz * 2.0 - 1.0, vec3(0.0, 0.0, 1.0), plain);
#endif

    // 折板葺きの山と谷。流れ方向に通る太い縦線で、瓦とは読みが変わる。
    if (metalRoof > 0.5) {
      float sm = q / (pitch * 1.6);
      float wm = fwidth(sm);
      float rib = bandAA(fract(sm), 0.0, 0.13, wm);
      col *= 1.0 - rib * 0.24 + bandAA(fract(sm), 0.15, 0.24, wm) * 0.14;
      gRoofN.x = mix(gRoofN.x, -0.5, rib * (1.0 - board));
    }

    // 瓦 1 枚ごとの明るさをシェーダ側でも引き直す。
    // テクスチャは 8×6 枚で 1 周するので、大きな屋根ではまったく同じむらが
    // 何度も繰り返して見える（それ自体が「貼ったテクスチャ」の証拠になる）。
    // 屋根のローカル座標から引けば周期が無くなる。
    // 1 枚が 1 画素を割ったら消して、遠景のざらつきにしない。
    vec2 tileId = floor(vec2(gRoofUV.x * ${ROOF_TILES_X}.0, gRoofUV.y * ${ROOF_TILES_Y}.0));
    col *= 1.0 + (h21(tileId + 7.0) - 0.5) * 0.17
         * detailFade(fwidth(gRoofUV.x) * ${ROOF_TILES_X}.0, 1.1) * (1.0 - plain);

    // 遠景では瓦の細かい起伏を法線から抜く。
    // 1 画素より細かい凹凸を法線に残すと、山が拾う光が画素ごとに跳ねて、
    // 屋根に規則正しい光る点の並び（スペキュラのエイリアス）が出る。
    // アルベドはミップが平均してくれるので、暴れるのは法線のほうだけ。
    // 棟と軒の折りはこの後に入れるので、遠景でも残る。
    gRoofN.xy *= detailFade(fwidth(gRoofUV.x) * ${ROOF_TILES_X}.0, 0.8);

    // 棟瓦（熨斗瓦）。棟に沿って 1 本、丸い別部材が載る。
    // 境の幅は画面上の変化率で広げる。固定幅のままだと、遠景で棟が
    // 1 画素を割った瞬間にちらつく細い線になる（俯瞰では棟が街中に出るので
    // それがそのまま画面全体のざらつきになる）。
    float capW = pitch * 1.05;
    float aaR = max(fwidth(dRidge), capW * 0.22);
    float ridge = 1.0 - smoothstep(capW - aaR, capW + aaR, dRidge);
    // 棟瓦の下端に落ちる影。この 1 本があって初めて棟が「線」ではなく
    // 「盛り上がり」になる。
    float ridgeSh = (1.0 - smoothstep(capW * 1.4 - aaR, capW * 1.9 + aaR, dRidge)) * (1.0 - ridge);
    // 軒先。最下段の瓦の鼻（明るい）と、その一段上に溜まる陰（暗い）。
    // 以前は暗い 1 本しか置いていなかったので、屋根の下端がただ暗くなるだけで
    // 「軒」として読めず、俯瞰では隣の屋根との境が消えていた。
    float aaE = max(fwidth(dEave), pitch * 0.2);
    float eaveNose = 1.0 - smoothstep(pitch * 0.34 - aaE, pitch * 0.34 + aaE, dEave);
    float eave = (1.0 - smoothstep(pitch * 0.9 - aaE, pitch * 1.25 + aaE, dEave)) * (1.0 - eaveNose);
    float solid = (1.0 - board) * (1.0 - noTile);

    // ---- 妻側の端（ケラバ）／隅棟 ----
    //
    // 俯瞰で屋根が「色紙を折った模型」に見える最大の理由は、瓦の目地よりも
    // **面の輪郭が無いこと**にある。隣り合う屋根の色が近いと、境が消えて
    // 一枚の色面に溶けてしまう。屋根の 4 辺のうち、棟と軒には線を入れて
    // あったが、流れの左右（切妻ならケラバ、寄棟なら隅棟）が素通しだった。
    //
    // 流れの面がどこで終わるかは、切妻なら一定（矩形）、寄棟なら上へ行くほど
    // 狭まる（台形／三角形）。寄棟かどうかは葺き足の下駄で分かる。
    float qEdge1 = mix(0.56, downZ ? 0.22 : 0.0, isHip);
    float qHalf = mix(mix(0.56, 0.58, isHip), qEdge1, yn)
                * max(downZ ? vScaleM.x : vScaleM.z, 0.2);
    float dVerge = max(qHalf - abs(q), 0.0);
    // 隅棟もケラバも、平部より一段高い別部材が載る。だから
    // 「明るい細い線 ＋ そのすぐ内側の影」の対で描くのは棟とまったく同じ。
    float capV = pitch * 0.6;
    float aaV = max(fwidth(dVerge), capV * 0.3);
    float verge = 1.0 - smoothstep(capV - aaV, capV + aaV, dVerge);
    float vergeSh = (1.0 - smoothstep(capV * 1.5 - aaV, capV * 2.2 + aaV, dVerge)) * (1.0 - verge);

    // ---- 経年のむら（苔・退色・煤）----
    //
    // 瓦 1 枚（0.3m）の目地は、俯瞰では 1〜2 画素しか無くミップで消える。
    // 俯瞰で屋根に情報を残せるのは 1〜3m の粗いむらだけで、実際の屋根も
    // その大きさで苔・退色・雨筋の斑を持っている。ここを入れないと、
    // どれだけ瓦を描き込んでも引いた瞬間に単色へ戻る。
    // 種は寸法から引く。屋根には棟ハッシュが渡っていないが、
    // 幅・高さ・奥行きは棟ごとに散らしてあるので、これで十分ばらける。
    // 粗さの違う 2 段を別々に距離で消す。細かいほうは街区のカット
    //（1 画素 0.2m 前後）で効き、粗いほうは俯瞰（1 画素 1.5m）でも残る。
    // 1 つの周期だけだと、必ずどちらかの距離で情報がゼロに戻る。
    vec2 wseed = vec2(vScaleM.x * 7.31 + vScaleM.y * 2.13, vScaleM.z * 13.7 + vScaleM.y * 5.91);
    vec2 wp = vec2(q, dRidge) * 0.55 + wseed;
    float wRate = fwidth(wp.x);
    float weather = (vnoise(wp) - 0.5) * 0.62 * detailFade(wRate, 1.0)
                  + (vnoise(wp * 0.28) - 0.5) * 0.52 * detailFade(wRate * 0.28, 1.0);
    // 棟の近くは乾き、軒に近いほど水が溜まって苔と汚れが濃くなる。
    // 一様な斑より、流れ方向に偏りがあるほうが「勾配のある面」に見える。
    col *= 1.0 + weather * 0.30 * mix(1.25, 0.75, yn) * solid;

    // 葺き足の横線を、テクスチャとは別にシェーダでも 1 本引く。
    //
    // テクスチャの目地はミップで平均されるので、瓦 1 枚が 1〜2 画素になる
    // 中距離（街区のカット）でちょうど消えてしまう。俯瞰でも眼高でもなく
    // **その間の距離**で屋根が単色に落ちるのは、これが原因だった。
    // bandAA は 1 画素を割ると 0 ではなく「被覆率」へ収束するので、
    // 消えても濁らずに残り、ちらつきもしない。位相はテクスチャと揃えてある
    //（どちらも dRidge / pitch を刻む）ので、線が二重にはならない。
    float cf = dRidge / pitch;
    col *= 1.0 - bandAA(fract(cf), 0.0, 0.09, fwidth(cf)) * 0.13 * solid * (1.0 - metalRoof);

    // 棟瓦は平部と同じ材だが、丸い断面が光を拾うぶん必ず明るく見える。
    // 明るい 1 本と、その真下の暗い 1 本を対で置かないと、
    // 遠景で棟が消えて「二等辺三角形の色板」に戻ってしまう。
    col *= 1.0 + ridge * 0.18 * solid;
    col *= 1.0 - ridgeSh * 0.36 * solid;
    col *= 1.0 + eaveNose * 0.15 * solid;
    col *= 1.0 - eave * 0.24 * solid;
    col *= 1.0 + verge * 0.13 * solid;
    col *= 1.0 - vergeSh * 0.20 * solid;
    // 鼻隠し・破風は少し暗く、軒天（下を向く面）はさらに暗い。
    // ここが明るいと、下から見上げた屋根が紙のように見える。
    col *= mix(1.0, mix(0.70, 0.42, step(n.y, -0.3)), board);
    // 棟に近いほど明るい。平らな面に流れの向きが出る。
    col *= mix(0.93, 1.06, yn);
    gTint = col;
    // 棟と軒の稜線を法線で折る。テクスチャは平部の瓦しか持っていないので、
    // ここだけは幾何から作らないと「線を描いた板」に戻る。
    gRoofN.y = mix(gRoofN.y, -0.72, ridge * solid);
    gRoofN.y = mix(gRoofN.y, 0.42, ridgeSh * solid);
    gRoofN.y = mix(gRoofN.y, 0.38, eave * 0.7 * solid);
    // ケラバ・隅棟も法線で折る。明暗を塗るだけだと、日陰に入った屋根で
    // 線が消えて元の色板に戻ってしまう（棟でまったく同じことが起きていた）。
    // 左右の端で逆向きに倒すので、どちらか一方は必ず日を受ける。
    float qs = q > 0.0 ? 1.0 : -1.0;
    gRoofN.x = mix(gRoofN.x, qs * 0.55, verge * solid);
    gRoofN.x = mix(gRoofN.x, -qs * 0.30, vergeSh * solid);
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
      // 防水の斑。1 画素より細かくなったら消す（遠景で砂嵐にしない）。
      float dFade = detailFade(fwidth(vLocalM.x * 0.35), 1.2);
      deck *= 1.0 + (h21(floor(vLocalM.xz * 0.35) + 3.0) - 0.5) * 0.28 * dFade;
      // 防水シートの継ぎ目。屋上は俯瞰でいちばん長く見える面なので、
      // 薄い格子が 1 枚入るだけで「塗りつぶした板」から抜けられる。
      vec2 gp = vLocalM.xz / 1.35;
      float joint = max(bandAA(fract(gp.x), 0.0, 0.05, fwidth(gp.x)), bandAA(fract(gp.y), 0.0, 0.05, fwidth(gp.y)));
      // 雨水の流れ跡。屋上は必ずどこか 1 点に向かって水勾配が付いていて、
      // その筋に沿って汚れが溜まる。うっすらした斑が入るだけで、
      // 「新品の板」ではなく「使われている屋上」になる。
      vec2 dp = vLocalM.xz * 0.16 + vFacadeV.w * 13.0;
      float stain = mix(0.5, vnoise(dp) * 0.6 + vnoise(dp * 2.7) * 0.4,
                        detailFade(fwidth(dp.x), 1.6));
      // 屋上の縁を回る排水溝と、防水の立ち上がり（巻き上げ）。
      // 陸屋根はどれも「縁から 30〜45cm 内側に溝が 1 本回っている」ので、
      // 俯瞰では屋上ごとに二重の矩形が見える。塗った板と屋上の分かれ目はここ。
      // 面の中心からの距離ではなく縁からの距離で引くので、
      // 大きさの違う屋上でも溝の幅は実寸で揃う。
      float edge = min(vScaleM.x * 0.5 - abs(vLocalM.x), vScaleM.z * 0.5 - abs(vLocalM.z));
      float aaE = max(fwidth(edge), 0.05);
      float gutter = smoothstep(0.28 - aaE, 0.28 + aaE, edge)
                   * (1.0 - smoothstep(0.46 - aaE, 0.46 + aaE, edge));
      float upstand = 1.0 - smoothstep(0.20 - aaE, 0.20 + aaE, edge);
      deck *= (1.0 - gutter * 0.34) * (1.0 + upstand * 0.20);
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
  // 階高が負の棟は「1 階に店構えのキットが載っている」印。
  // 絶対値には「どの面に載っているか」も埋め込んである（floorH*10 + 面 + 1）。
  // 属性を 1 つ増やすとインスタンスの帯域が 1 棟あたり 4 バイト増えるので、
  // 使っていない符号と小数第 1 位に押し込む。
  float p1 = vFacadeV.y;
  float frontFace = -1.0;
  float floorH;
  if (p1 < 0.0) {
    float v = -p1;
    frontFace = mod(v, 10.0) - 1.0;
    floorH = max((v - (frontFace + 1.0)) * 0.1, 1.2);
  } else {
    floorH = max(p1, 1.2);
  }
  // いま描いている面の向き（0=+Z, 1=+X, 2=-Z, 3=-X）。
  float myFace = alongZ ? (n.x > 0.0 ? 1.0 : 3.0) : (n.z > 0.0 ? 0.0 : 2.0);
  bool hasFront = frontFace >= 0.0 && abs(myFace - frontFace) < 0.5;
  float seed = vFacadeV.w;
  // スパンは棟ごとに ±26% 散らす。窓割りの周期が街区で揃っていると、
  // 高さだけ違う同じ立面が横に並んでコピーに見える。
  // ここを広げるのが「同一の押し出し箱が並ぶ」への一番効く手当てになる。
  float bay = max(vFacadeV.z, 0.8) * (0.74 + 0.52 * fract(seed * 17.3));
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

  // 窓の縦横比も棟ごとに振る。割付ピッチだけ変えても、窓の形が同じだと
  // 「同じ立面を横に伸ばしただけ」に見える。細長い窓の棟・横長の棟が
  // 混ざって初めて、街区の情報量が高さの数字より増える。
  float shapeSel = fract(seed * 31.7);
  float wNarrow = (shapeSel - 0.5) * 0.16;   // 窓幅 ∓16%
  float wTall = (fract(seed * 53.1) - 0.5) * 0.14;

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
  // 窓の灯りとは別に足す自発光（1 階の常夜灯など）。
  // gEmis は下で部屋の灯りに一度上書きされるので、ここへ溜めて最後に足す。
  vec3 extraEmis = vec3(0.0);
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
      // 腰壁の天端キャップ（笠木）の見付と、その真下に落ちる影の 2 本。
      // 眼高では「4cm の見切り 1 本」が素材の説得力を決める。
      // ここがゼロだと、画面の 4 割を占める淡い帯が発泡スチロールに見える。
      float mT = 1.0 / floorH;                    // 1m を階内の比に直す
      extra += bandAA(ty, 0.45 - 0.045 * mT, 0.45, wy) * 0.28;
      extra -= bandAA(ty, 0.45 - 0.115 * mT, 0.45 - 0.045 * mT, wy) * 0.26;
      // 腰壁の縦目地（乾式パネルの継ぎ目）。1.5m ごとに 1 本。
      extra -= rail * bandAA(fract(u / 1.5), 0.0, 0.014, fwidth(u / 1.5)) * 0.22;
      // 笠木から垂れる雨だれ。距離で必ず消す（遠景でビデオノイズに読ませない）。
      float bs = u * 0.7;
      extra -= rail
             * smoothstep(0.60, 1.0, h21(vec2(floor(bs), 15.0) + sideSeed))
             * sin(fract(bs) * 3.14159)
             * clamp((ty - 0.10) / 0.30, 0.0, 1.0)
             * 0.13 * detailFade(fwidth(bs), 1.6);
      // バルコニーの奥のガラスは庇と手すりに囲まれていて、
      // オフィスのカーテンウォールほど強くは空を返さない。
      glassCol = vec3(0.17, 0.20, 0.24);
      glassRough = 0.22; glassMetal = 0.56;
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
      litI = (1.05 + 0.85 * h21(vec2(ti, 6.0) + seed * 29.0)) * (bh > 0.76 ? 0.78 : 1.0);
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

  // ---- 各階の見切り（キャップ 1 本・水切り 1 本）----
  //
  // 前回は 1 階と 2 階の境にだけ入れたので、上階が無地のスラブのままだった。
  // 同じ 2 本を全階に流す。テクスチャは要らず、fwidth で 1 画素以下に
  // 潰れる線なので、遠景では勝手に消える。
  if (!ground) {
    float mF = 1.0 / floorH;
    // 床スラブの小口（見付）。明るい 7cm の帯。
    extra += bandAA(ty, 0.0, 0.075 * mF, wy) * 0.09;
    // その下端に回る水切りの影。4cm。庇の下には必ず影が溜まる。
    extra -= bandAA(ty, 1.0 - 0.05 * mF, 1.0, wy) * 0.22;
    // スラブ下に溜まる煤汚れ。18cm ぶんの勾配なので、1 画素がそれを
    // 超えたら消す（遠くでは平均の壁色に戻り、ざらつきにならない）。
    extra -= (1.0 - smoothstep(0.0, 0.18 * mF, ty)) * 0.08 * detailFade(wy, 8.0);
  }

  // 窓の縦横比の散らしを反映する（1 階の特別扱いより後、平均を取る前）。
  if (x0 < 1.5) {
    float mx = (x0 + x1) * 0.5, hx = (x1 - x0) * 0.5 * (1.0 - wNarrow);
    float my = (y0 + y1) * 0.5, hy = (y1 - y0) * 0.5 * (1.0 - wTall);
    x0 = mx - hx; x1 = mx + hx; y0 = my - hy; y1 = my + hy;
  }

  // 1 階に店構えのキットが載っている棟は、壁側の 1 階に窓を描かない。
  // 描いてしまうと、キットの柱や庇の隙間から上階と同じ窓帯が覗いて、
  // せっかく作り分けた 1 階が「上階と同じ壁」に戻ってしまう。
  if (ground && hasFront) {
    x0 = 2.0; x1 = 2.0;
    lx0 = -9.0; ly0 = -9.0;
    litRate = 0.0;
    band = 0.0; pier = 0.0;
    // 腰の御影石だけ残す。ここに横線が 1 本あると、キットとの取り合いが締まる。
    extra = -bandAA(y, 0.0, 0.55, fwidth(y)) * 0.24;
  }

  // ---- 1 階の作り分け（店構えのキットが載らない面）----
  //
  // キットは接道した 1 面にしか載らない。残りの面まで上階と同じ窓帯のままだと、
  // 街路を歩いて横を向いた瞬間に「1 階が無地の壁」へ戻ってしまう。
  // レビューで「1 階が全部ただの壁か、上階と同じ窓帯」と言われたのは、
  // キットの有無ではなく**壁のシェーダに 1 階という概念が無かった**ことが本体。
  // ジオメトリを 1 三角形も増やさずに、足元の石張り・境の水切り・
  // 用途ごとの設備の 3 つで、1 階を上階から切り離す。
  if (ground && !hasFront) {
    // 足元の石張り（腰壁）。日本のビルはほぼ必ず 0.4〜0.9m を磨いた石か
    // タイルで巻いている。ここに境が 1 本できるだけで、壁が地面に「立つ」。
    float plinthH = min(0.66, gH * 0.24);
    float plinth = bandAA(y, -1.0, plinthH, fwidth(y));
    extra -= plinth * 0.34;
    // 石張りの天端の見切り。明るい線を 1 本入れると、腰壁が
    // 「壁の下半分を暗く塗ったもの」ではなく「張った石の帯」になる。
    extra += bandAA(y, plinthH, plinthH + 0.05, fwidth(y)) * 0.20;
    // 石の目地。1 本入るだけで「塗った腰」ではなく「張った石」になる。
    extra -= plinth * bandAA(fract(y / 0.33), 0.0, 0.07, fwidth(y / 0.33)) * 0.14;
    // 1 階と 2 階の境の水切り。見付を明るく、その下を落とす。
    // 目線の高さでいちばん効く 1 本で、これがあると「1 階」が数えられる。
    extra += bandAA(y, gH - 0.28, gH - 0.10, fwidth(y)) * 0.18;
    extra -= bandAA(y, gH - 0.66, gH - 0.28, fwidth(y)) * 0.13;
    // 窓は上階より小さく、位置も上げる（1 階は防犯上どの用途でもこうなる）。
    if (x0 < 1.5) {
      float mx = (x0 + x1) * 0.5;
      float hx = (x1 - x0) * 0.34;
      x0 = mx - hx; x1 = mx + hx;
      y0 = max(y0, plinthH / gH + 0.08);
      y1 = min(max(y1, y0 + 0.14), 0.76);
    }
    // 通用口。どの用途のビルにも「人が出入りする穴」が 1 か所はある。
    // 目線の高さで 1 階が「歩ける」に見えるかは、庇より先にこれで決まる。
    // 割付のどこに開くかは面ごとのハッシュで引く。
    // 3 階以上の棟にだけ開ける。戸建ては正面に玄関ポーチのキットが載るので、
    // ここでもう 1 枚扉を描くと、同じ面に扉が 2 つ並んでしまう。
    float bays = max(floor(wallLen / bay), 1.0);
    float dBay = floor(h21(vec2(3.0, 11.0) + sideSeed) * bays);
    float onBay = (1.0 - step(0.5, abs(fxi - dBay)))
                * step(gH + floorH * 1.5, vScaleM.y);
    float door = onBay * bandAA(tx, 0.32, 0.68, wx) * bandAA(y, -1.0, 2.1, fwidth(y));
    // 枠（左右と上のアルミ）を残して、内側だけを落とす。
    float dInner = onBay * bandAA(tx, 0.36, 0.64, wx) * bandAA(y, -1.0, 1.98, fwidth(y));
    extra += door * 0.10 - dInner * 0.52;
    // 扉の入る割付には窓を描かない。重ねると、暗い入口の真ん中に
    // 明るいガラスが浮いて、扉にも窓にも見えなくなる。
    if (onBay > 0.5) { x0 = 2.0; x1 = 2.0; litRate = 0.0; }
    // 夜は扉の脇の常夜灯だけが点く。街路が真っ暗にならない最小の灯り。
    extraEmis += vec3(1.0, 0.90, 0.70) * onBay
           * bandAA(tx, 0.70, 0.76, wx) * bandAA(y, 1.9, 2.15, fwidth(y))
           * (0.05 + uNight * 1.1);

    if (style < 1.5) {
      // 集合住宅：メーターボックスと通風ガラリの並び。
      // 上階と同じ掃き出し窓を 1 階にも流すと「歩道に面したベランダ」になる。
      // 3 スパンに 1 つほど。全スパンに付けると、足元が縞の帯になってしまう。
      float mb = step(0.64, h21(vec2(fxi, 31.0) + sideSeed))
               * bandAA(tx, 0.70, 0.93, wx) * bandAA(y, 0.72, 1.92, fwidth(y));
      extra -= mb * 0.24;
      extra -= mb * bandAA(fract(y / 0.15), 0.0, 0.5, fwidth(y / 0.15)) * 0.13;
    } else if (style > 1.5 && style < 2.5) {
      // 事務所：上階のカーテンウォールを受ける柱型（ピラスター）。
      extra += bandAA(tx, 0.0, 0.16, wx) * 0.12;
    } else if (style > 4.5) {
      // 学校・庁舎：1 階は腰の高い連窓と、割付ごとの柱型。
      extra += bandAA(tx, 0.0, 0.12, wx) * 0.10;
    }
  }

  // 竪樋（雨樋の縦管）。壁の両端から 0.45m のところに 1 本ずつ通す。
  // 近景で「平らな面」が「建物の外壁」に変わる最も安い手掛かりで、
  // 遠景でも箱の角に縦の線が 1 本出るぶん、稜線が読みやすくなる。
  {
    // 1 画素が 0.25m を超えたら消す。幅 0.1m の線を遠景まで描くと、
    // 建物の角で 1 画素の縦線がちらついて、街全体がざらつく。
    float pw = max(fwidth(u), 1e-4);
    float pipe = (1.0 - smoothstep(0.05, 0.11 + pw, abs(abs(u) - (wallLen * 0.5 - 0.45))))
               * (1.0 - clamp(pw * 4.0, 0.0, 1.0));
    extra -= pipe * 0.20;
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
    gTint = avgTint; gRough = avgRough; gMetal = avgMetal; gEmis = avgEmis * 0.72;
    gEnv = mix(1.0, 1.25, cov); gWin = cov;
    // 遠景でも空は映る。むしろ遠くのビル群が空を返すことで、
    // 街が霞の中でただの灰色の塊に潰れるのを防げる。
    vec3 V = normalize(vWorldPos - cameraPosition);
    vec3 Nw = normalize(vWorldN);
    gRefl = fakeSky(reflect(V, Nw)) * (0.03 + 0.5 * fresnelAt(V, Nw)) * cov;
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
  // 住戸の掃き出し窓はレースのカーテンが下りていることのほうが多い。
  // ここを一律 38% にしていたので、街路を斜めに見たときに
  // バルコニーの奥のガラスが軒並み空の白をそのまま返し、
  // 「白い紙を貼った板」に見えていた。
  float curtainRate = (style < 1.5) ? 0.60 : 0.38;
  float hasCurtain = mix(step(cell2, curtainRate), curtainRate, cellFade);
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
  // 金属度は落とす。映り込みを環境マップ（＝屋外の平均輝度）から取るのをやめ、
  // 下で空を直接引くので、両方を強く出すと二重になって白く飛ぶ。
  gMetal = mix(wallMetal, mix(glassMetal, glassMetal * 0.4, hasCurtain) * 0.5, winMat);
  gEnv = mix(1.0, mix(1.25, 0.8, hasCurtain), winMat);
  gWin = winMat;

  // ---- ガラスに空を映す ----
  //
  // 「窓を 2 倍に拡大すると一様なグレーブルーの平板」がここの直し先。
  // 反射方向の Y から空色を引き、フレネルで縁を明るくする。
  // 見上げる窓（反射が下を向く）は向かいの建物の暗い色、
  // 見下ろす窓（反射が上を向く）は空 — 1 棟の中で縦に階調が付く。
  {
    vec3 V = normalize(vWorldPos - cameraPosition);
    // 窓の法線をわずかに倒す。壁と同じ法線だと、窓と壁がまったく
    // 同じ空を映して、どれだけ磨いても「壁に貼った青い紙」から抜けない。
    //
    // 倒す量を**部屋ごとに散らす**のがここの肝。板ガラスは実際に
    // わずかに反っていて、隣り合う窓で映る空がずれる。全部が同じ角度だと、
    // どれだけ空を映しても「一様な青の格子」に戻ってしまう。
    // 散らしは控えめにする。1 枚ごとに大きく倒すと、窓の矩形ごとに
    // 映り込みが段で変わり、それ自体が「貼った紙」の境界として読める。
    float tiltY = 0.09 + 0.05 * (h21(vec2(fxi, fyi) + sideSeed + 211.0) - 0.5) * 2.0;
    float tiltU = 0.04 * (h21(vec2(fxi, fyi) + sideSeed + 233.0) - 0.5) * 2.0;
    vec3 tangent = alongZ ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 Nw = normalize(vWorldN + (vec3(0.0, tiltY, 0.0) + tangent * tiltU) * winMat);
    float fres = fresnelAt(V, Nw);
    // ガラスは 4% から始まり、グレージング角で 9 割近くまで上がる。
    // カーテンの下りた窓は拡散面なので、反射は控えめにする。
    // 正面から見た窓には、ほとんど空を映さない。
    // ここに一律の下駄を履かせると、街を俯瞰したときに全部の窓が
    // 同じ空色で塗られ、街区が乳白色に霞む（レビューの「一様なグレーブルーの
    // 平板」は、映り込みが足りないのではなく**一様**なのが正体）。
    // 深いグレージング角だけを強く光らせると、同じ 1 枚の中に
    // 暗いガラスと空の映り込みが同居して、初めて板から抜ける。
    // 上限は 0.6 で止める。1.0 近くまで上げると、街路を斜めに見た窓が
    // 空の白をそのまま返して「白い紙を貼った板」に戻る。
    float amt = mix(0.05, 0.62, fres) * mix(1.0, 0.34, hasCurtain);
    // 壁にはほとんど映さない。ここを上げると、グレージング角の壁が
    // 一様に空の色でかぶり、棟ごとに散らしたクリーム色や茶色の外壁が
    // すべて同じ青白い面になってしまう（散らした意味が消える）。
    float wallAmt = fres * 0.035;
    // 映り込みの強さは**視線と法線からだけ**決める。
    // 以前は壁のローカル座標 (u, y) に sin を掛けて
    // 「向かいの建物のむら」を作っていたが、あれは壁に貼り付いた模様なので、
    // カメラが動いても動かない明るい面として窓の一部に居座る。
    // レビューの「窓の左半分だけに直線境界の明るい矩形」はこれが正体。
    // むらは fakeSky の中で反射ベクトルの関数として持たせてある。
    gRefl = fakeSky(reflect(V, Nw)) * mix(wallAmt, amt, winMat);
  }
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
               * (1.0 - winMat)
               // 距離で消す。フェードしない縦の筋は、遠くで
               // 「壁に走る縦スメア」＝圧縮ノイズにしか読めない。
               * detailFade(fwidth(sCell), 1.5);
  gTint *= 1.0 - streak * 0.20;

  // 夜の灯り。部屋ごとにハッシュで点け、時刻で点灯率だけを動かす。
  //
  // 遠景では 1 セルが 1 画素より小さくなる。そこで step のまま描くと
  // 点いた窓・消えた窓がカメラの僅かな動きで入れ替わり、街全体がちらつく。
  float lit = mix(step(cell, litRate), litRate, cellFade) * uNight;
  // 部屋ごとに明るさを散らす。全部同じ輝度だと LED パネルに見える。
  // 上限を 1 の少し上で止める。ここを 1.3 まで振ると、いちばん明るい部屋が
  // トーンマッピングの肩で白へ飽和し、せっかく散らした電球色が消えてしまう。
  lit *= 0.32 + 0.62 * h21(vec2(fxi, fyi) + sideSeed + 91.0);
  float litMask = (lx0 < -1.0) ? win : bandAA(tx, lx0, lx1, wx) * bandAA(ty, ly0, ly1, wy);
  litMask *= 1.0 - pier;

  // ---- 窓の中の階調 ----
  //
  // 夜の窓が 255 のベタ塗りに見えるのは、輝度が高いからではなく
  // 1 枚の中が一様だから。実際の部屋は天井付近が明るく、窓台に近いほど暗く、
  // 家具と人が抜けを作る。その勾配を入れると、同じ輝度でも「飛んだ白」に見えない。
  float rx = clamp((tx - x0) / max(x1 - x0, 1e-3), 0.0, 1.0);
  float ry = clamp((ty - y0) / max(y1 - y0, 1e-3), 0.0, 1.0);
  // 天井が明るく、床側が落ちる。
  float room = mix(0.38, 1.0, ry * ry);
  // 部屋の奥は暗い。中央ほど奥まで見えるので、中央を落とす。
  room *= 1.0 - 0.22 * sin(rx * 3.14159);
  // 3〜4 割の部屋に人影・家具のシルエットを入れる。
  float fh = h21(vec2(fxi, fyi) + sideSeed + 177.0);
  float fx2 = 0.22 + 0.56 * fract(fh * 7.0);
  float fig = (1.0 - smoothstep(0.09, 0.16, abs(rx - fx2)))
            * (1.0 - smoothstep(0.45, 0.72, ry))
            * step(0.58, fh);
  room *= 1.0 - fig * 0.62;
  // カーテンの下りた部屋は面で光る。縦の襞だけ入れて、平板にはしない。
  float fold = 0.82 + 0.18 * sin(rx * 34.0);
  room = mix(room, fold, hasCurtain * 0.75);
  // 窓の縁は必ず暗い（サッシと躯体の影）。ここが 1 になっていると、
  // どれだけ中を作り込んでも輪郭の立った白い矩形にしか見えない。
  float soft = bandAA(rx, 0.06, 0.94, wx / max(x1 - x0, 1e-3))
             * bandAA(ry, 0.05, 0.95, wy / max(y1 - y0, 1e-3));
  room *= mix(0.34, 1.0, soft);
  // 引き違いサッシの召し合わせ（窓の中の縦桟）。
  //
  // 掃き出し窓は 2〜3 枚建てで、真ん中に必ず桟が入る。
  // これが無いと、幅 2.5m の窓が夜に「1 枚の白い矩形」として抜けてしまう。
  // 昼も、桟が 1 本入るだけでガラスの大きさの見当が付く。
  float paneW = max(x1 - x0, 1e-3);
  float panes = max(1.0, floor(paneW * bay / 0.95 + 0.35));
  float sashF = rx * panes;
  float sash = 1.0 - bandAA(fract(sashF), 0.045, 0.955, wx * panes / paneW);
  // 遠景では階調が 1 画素を割るので平均へ寄せる（ちらつき防止）。
  room = mix(room * (1.0 - sash * 0.55), 0.70, cellFade);
  litMask *= room;
  // 昼の窓にも桟を出す。映り込みだけだと、大きなガラスが「板」に戻る。
  gTint *= 1.0 - mix(sash, 0.0, cellFade) * 0.22 * winMat;
  gRefl *= 1.0 - mix(sash, 0.0, cellFade) * 0.5 * winMat;
  // 映り込みは窓の縁まで届かせない。サッシと躯体の影で、実際のガラスは
  // 必ず 2〜3cm ぶん暗い縁を持つ。この縁が無いと、明るい空を映した窓が
  // 「壁に貼った 1 枚の白い紙」として読めてしまう（レビューの指摘そのもの）。
  gRefl *= mix(0.45, 1.0, mix(soft, 1.0, cellFade));
  // 部屋ごとに色温度も散らす。蛍光灯の部屋と白熱灯の部屋が混ざるだけで、
  // 同じ強度でも「全部同じ照明の板」から抜けられる。
  float warm = h21(vec2(fxi, fyi) + sideSeed + 133.0);
  vec3 roomCol = mix(litCol, litCol * vec3(0.90, 0.95, 1.10), smoothstep(0.55, 1.0, warm) * 0.8);
  gEmis = roomCol * litMask * lit * glow * litI;
  // 店舗の看板帯。窓とは別に、業種の色でまとまった面を光らせる。
  gEmis += litCol * band * (0.08 + uNight * litI * 0.5);
  // 店の売り場は昼でも中が明るい。ガラス面が黒く沈むと閉店した街に見える。
  if (style > 2.5 && style < 3.5 && ground) gEmis += litCol * win * 0.10;
  gEmis += extraEmis;

  // 遠景の平均にも階調ぶんの目減りを反映する（近景と遠景で明るさが跳ねない）。
  avgEmis *= 0.72;

  // 距離に応じて平均へ寄せる
  gTint = mix(gTint, avgTint, farMix);
  gRough = mix(gRough, avgRough, farMix);
  gMetal = mix(gMetal, avgMetal, farMix);
  gEmis = mix(gEmis, avgEmis, farMix);
  gEnv = mix(gEnv, mix(1.0, 1.25, cov), farMix);
  gWin = mix(gWin, cov, farMix);
}
`;

/**
 * 屋根の法線マップを接空間から視空間へ戻す。
 *
 * 屋根キットには `uv` 属性が無い（UV は屋根のローカル座標から毎画素作る）ので、
 * three の法線マップの仕組みには載せられない。TBN は画面の微分から組む。
 * 棟の稜線は明暗を塗るだけでは日陰の屋根で消えてしまうので、
 * ここで法線として入れておく必要がある。
 */
const ROOF_NORMAL = /* glsl */ `
  {
    vec3 Nw = normalize(vWorldN);
    vec3 q0 = dFdx(vWorldPos);
    vec3 q1 = dFdy(vWorldPos);
    vec2 s0 = dFdx(gRoofUV);
    vec2 s1 = dFdy(gRoofUV);
    vec3 q1p = cross(q1, Nw);
    vec3 q0p = cross(Nw, q0);
    vec3 T = q1p * s0.x + q0p * s1.x;
    vec3 B = q1p * s0.y + q0p * s1.y;
    float det = max(dot(T, T), dot(B, B));
    if (det > 0.0) {
      float sc = inversesqrt(det);
      vec3 nW = normalize(mat3(T * sc, B * sc, Nw) * normalize(gRoofN));
      normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
    }
  }
`;

/**
 * 立面材質を 1 つ作る。キットごとに面取り補正の有無と、屋根テクスチャの
 * 有無だけが違う。
 *
 * 屋根だけ材質を分けているのは、瓦テクスチャの読み出しを
 * 「材質の全画素で真になる分岐」の中に置くため。壁と同じ材質のまま
 * 屋根の分岐の中で `texture2D` を呼ぶと、非一様な制御フローになって
 * ミップ選択の導関数が保証されない。切妻・寄棟のキットはもともと
 * InstancedMesh 1 つずつなので、材質を分けてもドローコールは増えない。
 */
function facadeMaterial(chamferFix: boolean, roof = false): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.05,
    vertexColors: true,
  });
  m.envMapIntensity = 0.92;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uSkyZenith = uniforms.uSkyZenith;
    shader.uniforms.uSkyHorizon = uniforms.uSkyHorizon;
    shader.uniforms.uSkyGround = uniforms.uSkyGround;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSunTint = uniforms.uSunTint;
    const roofMap = roof ? roofAlbedoTexture() : null;
    const roofNrm = roof ? roofNormalTexture() : null;
    const hasRoofTex = roofMap !== null && roofNrm !== null;
    if (hasRoofTex) {
      shader.uniforms.uRoofMap = { value: roofMap };
      shader.uniforms.uRoofNrm = { value: roofNrm };
      // テクスチャの平均は 1 より暗いので、ここで基準の明るさへ戻す。
      // 戻さないと、瓦を貼った瞬間に街の屋根が一段暗くなる。
      shader.uniforms.uRoofGain = { value: 1 / Math.max(0.05, roofTexMean()) };
    }
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
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gEmis + gRefl;',
      )
      // 窓の法線を壁面法線と真上の間でわずかに倒す。
      // 映り込みそのものは gRefl が受け持つようになったので、ここは
      // 「窓だけ空からの回り込みを少し多く受ける」ぶんだけに抑える。
      // 大きく倒すと、どの向きの壁の窓も同じ明るさになって階調が消える。
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n' +
          '  normal = normalize(mix(normal, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.06 * gWin));' +
          (hasRoofTex ? ROOF_NORMAL : ''),
      )
      // 環境マップの強さを画素ごとに変える。材質の envMapIntensity は
      // ユニフォームなので上書きできない。IBL の結果に直接掛ける。
      .replace(
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\n  radiance *= gEnv;',
      );
    if (chamferFix) shader.defines = { ...(shader.defines ?? {}), CHAMFER_FIX: '' };
    if (hasRoofTex) shader.defines = { ...(shader.defines ?? {}), ROOF_TEX: '' };
  };
  m.customProgramCacheKey = () => (roof ? 'bldRoof' : chamferFix ? 'bldFacadeCF' : 'bldFacade');
  materials.push(m);
  return m;
}

/** 夜の度合いを全材質に配る (0..1)。 */
export function setBuildingNight(night: number): void {
  uniforms.uNight.value = night;
}

/**
 * 空の色と太陽の向きを全材質に配る。
 *
 * ガラスの映り込みを環境マップ任せにしていたのをやめ、
 * シェーダが `reflect()` で直接空を引くようにしたので、
 * 空側の状態をここから渡す必要がある。
 * 渡すのはフレームに 1 回・ユニフォーム 5 個だけなので、コストは無い。
 */
export function setBuildingSky(
  zenith: Color,
  horizon: Color,
  sunDir: Vector3,
  sunColor: Color,
  sunIntensity: number,
): void {
  uniforms.uSkyZenith.value.copy(zenith);
  uniforms.uSkyHorizon.value.copy(horizon);
  // 地平より下に映るのは向かいの建物と路面。
  // 真っ黒にすると、見下ろした窓が全部「黒い板」になって元の木阿弥なので、
  // コンクリートの壁が返すぶんだけ残す（地平色の 1/3 前後）。
  uniforms.uSkyGround.value.copy(horizon).multiplyScalar(0.5);
  uniforms.uSunDir.value.copy(sunDir).normalize();
  // 日射色に強さを載せる。曇天のような弱い光でガラスがギラつくと嘘に見える。
  uniforms.uSunTint.value.copy(sunColor).multiplyScalar(Math.min(1.4, sunIntensity * 0.5));
}

// ---------------------------------------------------------------- キットの形

/** 白い頂点カラーを持たせる（vertexColors:true の材質に載せるため）。 */
function white(g: BufferGeometry): BufferGeometry {
  tintGeometry(g, 0xffffff);
  return g;
}

/**
 * 部品単位の擬似 AO を焼いた面取り箱。
 *
 * `Facade.Plain` のシェーダはインスタンス全体の相対高さで陰影を付けるので、
 * 焼き固めたキット（室外機の列・受水槽）では**組み全体**が下から明るくなるだけで、
 * 1 台ずつの足元は暗くならない。部品ごとに焼いておくと、
 * 並んだ室外機の 1 台 1 台に接地の暗がりが付き、「置いた設備」に見える。
 */
function aoBox(): BufferGeometry {
  return applyVerticalAO(chamferedUnitBox(CHAMFER_U), 0.66, 1.06, 1.7);
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
  // 側面（6 本の稜線に沿った帯）。
  //
  // 断面の 6 点は (z, y) 平面を時計回りに並べてあるので、押し出す向きを
  // -x → +x にすると全部の面が裏返る。これまで屋根として見えていたのは
  // 流れの面ではなく**その裏の軒天**（thick ぶん下、法線がたまたま
  // 上を向いている）で、本物の流れ・鼻隠しはカリングで消えていた。
  // そのせいで軒先に木口の線が出ず、棟の位置も thick ぶんずれていた。
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    quad(at(ex, i), at(-ex, i), at(-ex, j), at(ex, j));
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
  // 三角形の向きを 1 か所で裏返す。
  //
  // 元の並びは全 16 面が内向きで、寄棟は表からだと全面がカリングされていた
  // （＝屋根がまったく描かれず、下の軒天の板だけが見えていた）。
  // 頂点を書き並べた側ではなく、ここで 1 度だけ入れ替える。
  const tri = (a: number[], b: number[], c: number[]): void => {
    tris.push(...a, ...c, ...b);
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
  const ao = aoBox();
  const parts: Part[] = [
    // 架台の下に落ちる影。屋上の設備で一番背が高いので、接地が読めないと浮く。
    { geom: box, matrix: place(0, 0.003, 0, 1.22, 0.005, 0.98), color: 0x1a1a18 },
    { geom: ao, matrix: place(0, 0.42, 0, 1, 0.54, 0.72), color: 0xffffff },
    // 天端のマンホールと通気管
    { geom: box, matrix: place(0.18, 0.96, 0, 0.2, 0.06, 0.2), color: 0xb0b0b0 },
    { geom: box, matrix: place(-0.3, 0.96, 0.2, 0.05, 0.16, 0.05), color: 0x9a9a9a },
  ];
  // 架台。脚 4 本と、その間に渡した水平材・筋交い。
  // 「脚の生えた箱」ではなく「架台に載った水槽」に見えるかどうかは、
  // この筋交いが 1 本入っているかで決まる。
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ geom: ao, matrix: place(sx * 0.42, 0, sz * 0.3, 0.09, 0.44, 0.09), color: 0x8e9296 });
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
  ao.dispose();
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
  const ao = aoBox();
  const parts: Part[] = [
    // 架台（コンクリート基礎 2 本）
    { geom: ao, matrix: place(0, 0, -0.3, 1.0, 0.07, 0.12), color: 0x9a9892 },
    { geom: ao, matrix: place(0, 0, 0.3, 1.0, 0.07, 0.12), color: 0x9a9892 },
  ];
  // 接地の暗がり。屋上に置いた設備が「貼り付いて」見えるのは、
  // 足元に影が無いから。実体の落ち影は距離が出ると影マップの解像度に負けるので、
  // キットの中に一回り大きい暗い板を焼き込んでおく。
  // インスタンスは 1 つも増えない。
  parts.unshift({ geom: box, matrix: place(0, 0.004, 0.02, 1.24, 0.006, 1.12), color: 0x1a1a18 });
  for (let i = -1; i <= 1; i++) {
    const x = i * 0.335;
    // 本体
    // 本体の地色は少し落としてある。ここを純白に近く焼くと、
    // 呼び出し側で色を散らしても全機が明るい灰に張り付いてしまう。
    parts.push({ geom: ao, matrix: place(x, 0.07, 0, 0.30, 0.83, 0.68), color: 0xc3c6c0 });
    // ファンのガード（正面の凹んだ丸枠のつもり。暗く落として穴に見せる）
    parts.push({ geom: box, matrix: place(x, 0.28, 0.345, 0.22, 0.42, 0.02), color: 0x44484a });
    // 天端のルーバー
    parts.push({ geom: box, matrix: place(x, 0.88, 0, 0.32, 0.04, 0.70), color: 0xb4b8b6 });
  }
  const g = mergeParts(parts);
  box.dispose();
  ao.dispose();
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
    { geom: box, matrix: place(0, 0.004, 0, 1.35, 0.006, 1.35), color: 0x1a1a18 }, // 接地の暗がり
    { geom: box, matrix: place(0, 0, 0, 0.85, 0.10, 0.85), color: 0x8e918c }, // 立ち上がり
    { geom: c, matrix: place(0, 0.08, 0, 0.52, 0.72, 0.52), color: 0xc6cacc }, // 筒（下が暗い）
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
 * 1 階の店構え（frontage）。
 *
 * 目線の高さのカットで点が伸びなかった本体がここだった。
 * 上階と同じ窓帯を 1 階にも流していたので、店舗も入口も庇も無く、
 * 「歩ける街」に見えなかった。
 *
 * 作り分けは**キットを増やさず 1 つの形で**やる。
 * 庇・端の柱・腰見切り・看板帯・開口面の 5 部品を焼き固めた 1 インスタンスを
 * 建物の正面に 1 つ置き、開口面の絵（ガラス／自動ドア／玄関扉／シャッター／
 * テナント板）はシェーダが種別で描き分ける。
 * こうすると、用途ごとに 5 通りの 1 階を持ちながら、
 * ドローコールは 1、1 棟あたりのインスタンスも 1 しか増えない。
 *
 * 単位: X = 間口、Y = 1 階の階高、Z = 出（張り出し）。
 * z=0 が壁面で、+Z が街路の側。
 */
function frontGeometry(): BufferGeometry {
  const box = chamferedUnitBox(0.03);
  const parts: Part[] = [
    // 開口面。壁面のすぐ手前に置き、柱と庇が前に出ることで「後退した入口」に見せる。
    { geom: box, matrix: place(0, 0.02, 0.055, 0.88, 0.86, 0.06), color: FRONT_ID.panel },
    // 腰の見切り（御影石）と沓摺。1 階の足元に横線が 1 本入ると、床と壁が分かれる。
    { geom: box, matrix: place(0, 0, 0.105, 0.94, 0.05, 0.2), color: FRONT_ID.base },
    // 庇。出が深いほど下に落ちる影が濃くなる。この影が「軒下」を作る。
    { geom: box, matrix: place(0, 0.86, 0.365, 1.0, 0.045, 0.72), color: FRONT_ID.canopy },
    // 庇の前縁に下がる看板帯（店名のサイン）。夜の街路の光はここが主役になる。
    // 庇の小口より 3cm ほど前に出す。面が揃っていると庇に隠れて文字が出ない。
    { geom: box, matrix: place(0, 0.78, 0.735, 0.99, 0.17, 0.06), color: FRONT_ID.fascia },
  ];
  // 端の柱。左右に 1 本ずつ前へ出すと、開口が奥に引っ込んで見える。
  for (const s of [-1, 1]) {
    parts.push({ geom: box, matrix: place(s * 0.472, 0, 0.27, 0.056, 1.0, 0.52), color: FRONT_ID.pier });
  }
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
  | 'signBlade'
  | 'front';

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
    // 屋根専用。切妻・寄棟はもともと InstancedMesh 1 つずつなので、
    // 材質を分けてもドローコールは 1 つも増えない。
    const roofMat = facadeMaterial(false, true);
    this.mats.push(boxMat, plainMat, roofMat);
    this.kits = {
      box: new Kit(boxGeometry(), boxMat, 4096),
      boxV: new Kit(boxVGeometry(), boxMat, 4096),
      gable: new Kit(gableGeometry(), roofMat, 1024),
      hip: new Kit(hipGeometry(), roofMat, 256),
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
      // 1 階の店構え。1 棟 1 インスタンス・1 ドローコールで
      // 用途ごとに 5 通りの 1 階を描き分ける。
      front: new Kit(frontGeometry(), plainMat, 4096),
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
   * 1 階の店構え。(x,y,z) は壁面・地盤面の間口中心。
   *
   * `rotY` はその面の向き（`faceRot`）。キットは +Z が街路側なので、
   * 面の回転をそのまま渡せばよい。
   *
   * @param kind  `FrontKind.*`
   * @param bayW  テナント 1 区画の間口 (m)。看板とガラスの割付がこの刻みになる。
   */
  frontage(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    depth: number,
    kind: number,
    bayW: number,
    seed: number,
    color: number | Color,
    rotY = 0,
  ): void {
    this.put('front', x, y, z, w, h, depth, rotY, 0, color, Facade.Front, kind, bayW, seed);
  }

  /**
   * 屋上の室外機の列（架台付き）。w は列の長さ。
   * 色は白から少しずらせるようにしてある。新品と古びたものが混ざると、
   * 同じキットを並べても「置かれた設備」に見える。
   *
   * 粗さ・金属度も呼び出し側から渡す。屋上が「同じ淡いグレーの
   * 2〜3 種類のプリミティブ」に見えていたのは形の問題ではなく、
   * 塗装鋼板もステンレスも FRP も同じ材質で描いていたから。
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
    rough = 0.55,
    metal = 0.35,
  ): void {
    this.put('acRow', x, y, z, w, h, d, rotY, 0, color, Facade.Plain, rough, metal, 0);
  }

  /** 屋上の円筒排気筒。 */
  stack(
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    color: number | Color = 0xffffff,
    rough = 0.5,
    metal = 0.55,
  ): void {
    this.put('stack', x, y, z, r * 2, h, r * 2, 0, 0, color, Facade.Plain, rough, metal, 0);
  }

  /**
   * バルコニーの手すり・腰壁。3 種類の作りをシェーダで描き分ける。
   *
   * 箱のキットにそのまま載るので、インスタンスもドローコールも増えない。
   * 「アルミの手すり」を 1 スパンのキットで引き伸ばしていたのをやめたのが肝で、
   * あの作りでは子柱が建物の幅に比例して太くなり、
   * どの種類も同じ「無地の実壁パネル」に見えてしまっていた。
   *
   * @param kind   0=コンクリート腰壁 / 1=アルミ手すり / 2=濃色パネル
   * @param panelW パネル 1 枚の幅 (m)。縦目地の刻みになる。
   */
  parapet(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    kind: number,
    panelW: number,
    seed: number,
    rotY = 0,
  ): void {
    const kit: KitName = Math.max(w, h, d) < SMALL_PART_M ? 'boxV' : 'box';
    this.put(kit, x, y, z, w, h, d, rotY, 0, color, Facade.Parapet, kind, panelW, seed);
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

  /**
   * 寄棟屋根。
   *
   * 葺き足に +10 の下駄を履かせて「これは寄棟だ」を埋めておく。
   * 隅棟（棟の端から四隅へ下りる 4 本の斜めの稜線）は、面がどこで
   * 終わるかを知らないと描けない。切妻の流れは矩形だが、寄棟の流れは
   * 上へ行くほど狭まる台形なので、同じ式では端の位置が出ない。
   * 属性を 1 つ増やすとインスタンスの帯域が 1 棟あたり 4 バイト増えるので、
   * 立面の階高と同じ手口で数値の側に押し込む。
   * 負の値は「屋根ではないもの」（樹冠・東屋）の印なので、下駄は正のときだけ。
   */
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
    const p = pitch > 0 ? pitch + 10 : pitch;
    this.put('hip', x, y, z, w, h, d, rotY, 0, color, Facade.Roof, rough, metal, p);
  }

  /** 屋上の受水槽。ステンレス・FRP・塗装鋼板で光り方が違う。 */
  tank(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number | Color,
    rough = 0.72,
    metal = 0.18,
  ): void {
    this.put('tank', x, y, z, w, h, d, 0, 0, color, Facade.Plain, rough, metal, 0);
  }

  /** 鳥居。 */
  torii(x: number, y: number, z: number, w: number, h: number, color: number | Color, rotY = 0): void {
    this.put('torii', x, y, z, w, h, w * 0.22, rotY, 0, color, Facade.Plain, 0.7, 0.05, 0);
  }

  dispose(): void {
    for (const k of Object.values(this.kits)) k.dispose();
    for (const m of this.mats) m.dispose();
    disposeRoofTextures();
  }
}
