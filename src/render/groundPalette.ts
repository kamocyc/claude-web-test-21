import { Color } from 'three';
import { Season, Terrain } from '@shared/enums';

/**
 * 地面まわり（地形・水面・道路・植生）の配色。
 *
 * `theme.ts` は建物・車両・UI と共有していて、しかも「1 タイル 1 色」の
 * 平板な塗り分けを前提にしている。ここで作りたいのは
 * 「傾斜と標高で混ざる地面」「季節で変わる樹冠」「時刻で変わる水」なので、
 * 単色の表ではなく **混色のための素材** が要る。混ぜる相手を theme 側に
 * 足していくと建物レイヤの配色まで巻き込むので、地面用は独立させた。
 *
 * 全体の狙いは「彩度を上げないこと」。日本の平野の緑は、写真で見ると
 * かなり黄色〜灰色寄りで、鮮やかな緑にすると一気に嘘になる。
 * 代わりに **明度と色相をわずかにばらす** ことで情報量を稼ぐ。
 */

// ---------------------------------------------------------------------------
// 連続ノイズ（タイル格子を消すための土台）
// ---------------------------------------------------------------------------

/** 整数格子の擬似乱数 0..1。同じ (x,y) には必ず同じ値を返す。 */
export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 値ノイズ。格子点のハッシュを双三次に近い補間で滑らかにつなぐ。
 *
 * タイルごとに色をばらすと、そのままでは市松模様になる。
 * 「タイルの中心」ではなく「タイルの角の座標」でノイズを引き、
 * 隣り合うタイルが同じ角の値を共有するようにすれば、
 * 色のばらつきは連続したまだら模様になって格子が消える。
 */
export function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  // smoothstep。線形補間のままだと格子の稜線が見える。
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/**
 * 2 オクターブの値ノイズ（およそ -1..1）。
 *
 * 一番低い周波数（1 周期 30 タイル ≒ 300m）が効いているのが肝で、
 * これが無いと「細かいざらつき」にしかならず、引きの画では
 * 結局のっぺりした一色に見える。地面の情報量は、細かさではなく
 * 大きなむらの有無で決まる。
 *
 * 以前は 3 オクターブ目に `x * 0.5`（1 周期 2 タイル ＝ 20m）を混ぜていたが、
 * この帯域は俯瞰では 1px 以下になり、色ムラではなく**圧縮ノイズか
 * 汚れたテクスチャ**にしか見えなかった（草地一面が暗くまだらになる）。
 * 1px を割る周波数は情報を持たずちらつきだけを増やすので、band ごと落とし、
 * そのぶん低周波を強めて「大きな色ムラ」で情報量を稼ぐ。
 */
export function terrainNoise(x: number, y: number): number {
  return (
    (valueNoise(x * 0.032, y * 0.032) - 0.5) * 1.35 +
    (valueNoise(x * 0.11, y * 0.11) - 0.5) * 0.5
  );
}

/**
 * 2 本目のノイズ（およそ -1..1）。`terrainNoise` とは無関係な模様にする。
 *
 * 明度を揺らすだけでは「同じ色の濃淡」にしかならず、引きの画では
 * 結局のっぺりした一色に見える（前回の指摘の「起伏も色の差も無い単一のオリーブ」）。
 * 地面の情報量は **素材の比率が場所で変わること** から出るので、
 * 「どのくらい乾いているか」を決める独立した場を 1 本持つ。
 * 周期をわざと `terrainNoise` とずらしてあるのは、2 本が同位相だと
 * 明度と素材が一緒に動いてしまい、結局 1 本ぶんの情報しか出ないため。
 */
export function terrainNoise2(x: number, y: number): number {
  return (
    (valueNoise(x * 0.019 + 71.3, y * 0.019 - 12.7) - 0.5) * 1.0 +
    (valueNoise(x * 0.067 - 5.1, y * 0.067 + 33.9) - 0.5) * 0.7 +
    // 3 オクターブ目（1 周期 6 タイル ＝ 60m）。俯瞰でも 40px 前後あるので
    // ちらつきにはならず、街区の距離では「田の区切りくらいの色ムラ」になる。
    //
    // オクターブの重みを平らにし直してある。最初は低周波 1 本が支配的な
    // 1.5 : 0.62 : 0.34 だったが、それだと**視界に山が 1〜2 個しか入らず**、
    // 郊外一面が端から端まで単調なグラデーション 1 枚に見えていた。
    // 地面の情報量は、いちばん大きなむらの振幅ではなく
    // 「視界に何個のむらが入るか」で決まる。
    (valueNoise(x * 0.17 + 19.7, y * 0.17 + 44.1) - 0.5) * 0.62
  );
}

/**
 * `terrainNoise2` を 0..1 の「乾き具合」に均す。0 = 水の溜まる窪地、1 = 乾いた尾根。
 *
 * 素の値をそのまま `clamp((n - 0.05) * 1.8)` のように使っていたときは、
 * ノイズの実測レンジ（-0.45..0.96）に対して傾きが急すぎて、
 * **見えている範囲のほぼ全域が 1 に張り付いていた**。混色の係数が定数に
 * なるので、2 素材を用意した意味が消えて一様なオリーブに戻る。
 * ノイズの実レンジを 0..1 いっぱいに写す傾きにしておくのが肝。
 */
export function dryness(noise2: number): number {
  return Math.min(1, Math.max(0, 0.5 + noise2 * 0.62));
}

// ---------------------------------------------------------------------------
// 地形の素材色
// ---------------------------------------------------------------------------

/**
 * 地面を「地形分類の色」ではなく **素材の色** で作る。
 *
 * 実際の地面は、標高や傾斜で草・土・岩の比率が変わるだけで、
 * 「森林タイル」と「丘陵タイル」の間に線が引かれているわけではない。
 * 素材を用意して比率で混ぜると、分類の境界線が消えて地形が連続する。
 */
export const GROUND = {
  /** 低地の草。やや黄色寄りの、水気のある緑。 */
  grassLow: 0x6f8c52,
  /** 台地・丘の草。乾いていて灰色寄り。 */
  grassHigh: 0x7e8a5c,
  /** 刈られた・踏まれた乾いた草。畦や空き地、日当たりの強い尾根に出る。 */
  grassDry: 0x8d8760,
  /** 水の溜まる窪地の草。低湿地と川沿いに出る、青みの強い濃い緑。 */
  grassWet: 0x5a7a46,
  /** 森の林床。木の下は暗い。 */
  forestFloor: 0x445e3a,
  /** 露出した土。畦・崖の下・道端。 */
  soil: 0x8a7452,
  /** 岩肌。急斜面に出る。写真の露岩はもっと暗い（反射率 15% 前後）。 */
  rock: 0x6b675d,
  /** 高山の荒れ地。 */
  alpine: 0x74706a,
  /** 砂浜。 */
  sand: 0xc8b894,
  /** 河岸の砂利。 */
  gravel: 0xa39c8d,
  /** 護岸のコンクリート。 */
  revetment: 0x9d9d97,
  /**
   * 造成済み・未建築の宅地。
   *
   * 以前はここに用途地域の色（鮮やかな黄緑など）を 24% 混ぜていた。
   * その結果、街区の中の空き地が「彩度の高い四角」として露出し、
   * **ゲームのデータ構造がそのまま絵になっていた**（前回の指摘）。
   * 実際に更地なのは、草を刈って土を踏み固めた地面か、砕石を敷いた駐車場。
   * 周りの地面と近い明度・低い彩度に置いて、境界が目立たないようにする。
   */
  lotBare: 0x8b8474,
  /**
   * 事業所・工場の構内舗装。
   *
   * 商業・工業の敷地を住宅地と同じ土色にすると、街区が丸ごと 1 枚の
   * 茶色い厚紙に見える（実際そう見えていた）。倉庫や工場の構内は
   * ほぼ全面がコンクリートかアスファルトで、土は残っていない。
   * 用途で素材そのものを変えると、街区と街区の間に色の差が生まれる。
   */
  lotPaved: 0x89898a,
  /** 構内の継ぎ接ぎ舗装・油染み。上の平均から外れる側の色。 */
  lotStain: 0x6f6f6c,
  /** 雪。 */
  snow: 0xdde3e6,
} as const;

/** 季節ごとの草の色の掛け率。冬は枯れて彩度が落ち、秋はわずかに黄色く濁る。 */
export const GRASS_SEASON: Record<number, { tint: number; mul: number; amount: number }> = {
  [Season.Spring]: { tint: 0xa8d878, mul: 1.02, amount: 0.3 },
  [Season.Summer]: { tint: 0x8fc46a, mul: 1.0, amount: 0.22 },
  [Season.Autumn]: { tint: 0xc0a355, mul: 0.98, amount: 0.34 },
  // 冬の日本の平野は「緑」ではなく枯草の黄土色。ここを弱くすると
  // 1 月の街が真夏の草原の上に建っているように見える。
  [Season.Winter]: { tint: 0x9d8f6a, mul: 0.9, amount: 0.55 },
};

/** 田んぼの季節色（theme.ts の PADDY_SEASON_COLORS と同じ考え方を畦・水面にも広げる）。 */
export const PADDY_WATER_SEASON: Record<number, number> = {
  [Season.Spring]: 0x93b8c6, // 代掻き（一面の水鏡）
  [Season.Summer]: 0x5f9f4c,
  [Season.Autumn]: 0xcfae4c,
  [Season.Winter]: 0x9c8a6a,
};

// ---------------------------------------------------------------------------
// 植生
// ---------------------------------------------------------------------------

/**
 * 樹冠の季節色。種類ごとに 2 色持ち、個体ごとに補間して散らす。
 *
 * 1 種 1 色だと、同じ木が何万本も並んだときに「塗り絵」になる。
 * 実際の森は、同じ樹種でも日当たりと樹齢で明度が全然違う。
 */
export interface CanopyPalette {
  /** 明るい側（日向・若木）。 */
  light: number;
  /** 暗い側（日陰・老木）。 */
  dark: number;
}

const canopy = (light: number, dark: number): CanopyPalette => ({ light, dark });

/** 針葉樹（杉・檜）。日本の人工林はほぼこれで、季節による変化が小さい。 */
export const CONIFER_SEASON: Record<number, CanopyPalette> = {
  [Season.Spring]: canopy(0x4a7f4a, 0x2e5c38),
  [Season.Summer]: canopy(0x3d7440, 0x275233),
  [Season.Autumn]: canopy(0x3e6c3c, 0x28502f),
  [Season.Winter]: canopy(0x365f3a, 0x21452c),
};

/** 広葉樹（クヌギ・ケヤキ）。秋の紅葉と冬の落葉で一番大きく動く。 */
export const BROADLEAF_SEASON: Record<number, CanopyPalette> = {
  [Season.Spring]: canopy(0x9ecb66, 0x6a9f4a),
  [Season.Summer]: canopy(0x5c9a48, 0x3a7038),
  [Season.Autumn]: canopy(0xd0813a, 0x9c5a2c),
  [Season.Winter]: canopy(0x8a7a63, 0x6a5c4a),
};

/** 桜・街路樹。春だけ花が咲く（日本の街路で一番効く季節表現）。 */
export const STREET_TREE_SEASON: Record<number, CanopyPalette> = {
  [Season.Spring]: canopy(0xf2c8d4, 0xdba7bb),
  [Season.Summer]: canopy(0x5a9445, 0x3d7038),
  [Season.Autumn]: canopy(0xc9903c, 0xa06430),
  [Season.Winter]: canopy(0x7d6e58, 0x60543f),
};

/** 竹林。年中この色で、幹の黄緑が特徴。 */
export const BAMBOO_SEASON: Record<number, CanopyPalette> = {
  [Season.Spring]: canopy(0x7fae52, 0x5e8c42),
  [Season.Summer]: canopy(0x6fa348, 0x4f8038),
  [Season.Autumn]: canopy(0x77a04c, 0x557f3c),
  [Season.Winter]: canopy(0x6c9047, 0x4d7238),
};

/** 低木・草むら。刈られていないところの雑草。 */
export const SHRUB_SEASON: Record<number, CanopyPalette> = {
  [Season.Spring]: canopy(0x84ac54, 0x5e8442),
  [Season.Summer]: canopy(0x6f9c46, 0x4f7838),
  [Season.Autumn]: canopy(0xa89347, 0x7d6c36),
  [Season.Winter]: canopy(0x8c7f60, 0x6a5f47),
};

/** 幹の色。針葉樹は赤茶（杉皮）、広葉樹は灰色寄り。 */
export const TRUNK_CONIFER = 0x6a4a35;
export const TRUNK_BROADLEAF = 0x6f6355;
export const TRUNK_BAMBOO = 0x9fae5a;

// ---------------------------------------------------------------------------
// 道路
// ---------------------------------------------------------------------------

/**
 * 舗装の色。theme.ts の ROAD_COLORS より暗い。
 *
 * 物理ベースに切り替わってから、明るい灰色のアスファルトは
 * 環境反射と合わさって真っ白に飛ぶ。実物のアスファルトは
 * 反射率 10% 前後で、写真で見ると「濃い灰色」どころか黒に近い。
 * 道路クラスごとに新しい舗装ほど黒くする。
 */
export const PAVEMENT = {
  street: 0x33342f,
  avenue: 0x2e2f2b,
  boulevard: 0x2a2b28,
  /** 交差点。轍と補修で少し色が抜ける。 */
  junction: 0x383934,
} as const;

/**
 * 轍の色。舗装より「わずかに」暗い。
 *
 * ここを差を付けすぎると、路面に 2 本の黒い帯を描いた絵にしかならない。
 * 実物の轍が読めるのは色よりも**反射の違い**（磨かれて滑らか）なので、
 * 色差は 5% 程度に留め、粗さのほうを材質側で落としてある。
 */
export const RUT_COLOR = 0x2c2d29;
/**
 * 轍と轍のあいだ（クラウン）の色。舗装より「わずかに」明るい。
 *
 * 車輪の通らない帯には砂と細かい砂利が吹き寄せられて溜まるので、
 * 磨かれて黒くなる轍とはちょうど逆に、白っぽく乾いて見える。
 * 轍・クラウン・轍の 3 本が並ぶと、色の差そのものは小さくても
 * 「車が通った跡」として一目で読める。
 */
export const CROWN_COLOR = 0x3d3e37;
/** 補修跡。掘り返して埋め戻した新しいアスファルトなので、周りより黒い。 */
export const PATCH_COLOR = 0x26272a;
/** マンホールの鋳鉄蓋。錆と土埃で茶色く濁っている。 */
export const MANHOLE_COLOR = 0x4c4740;

/** 歩道の平板（インターロッキング）。日本の歩道はやや暖色のグレー。 */
export const WALKWAY_COLOR = 0x9a958a;
/** 縁石。歩道より明るいコンクリート。 */
export const CURB_COLOR = 0xb0aca2;
/** 側溝の目地・グレーチングの暗がり。断面を 2 段に読ませる線。 */
export const GUTTER_COLOR = 0x3f3f3c;
/** L 型側溝の平部。打ち放しのコンクリートで、歩道の平板より白い。 */
export const GUTTER_APRON_COLOR = 0xa9a69c;
/**
 * 白線。実際は少し黄ばんでいるので純白にはしない。
 *
 * ここをさらに一段落としてある。実物の路面標示は施工直後を除けば
 * 砂埃と摩耗で灰色に濁っていて、**アスファルトとの明度差は写真で見るより
 * ずっと小さい**。以前の 0xc9c5b6 は俯瞰で建物の屋根より明るく、
 * 街区の格子が「白いビーズの鎖」になって画面で最初に目に入っていた。
 * 塗料は反射もしないので、材質側も roughness 0.9 / metalness 0 に振ってある。
 */
export const LINE_WHITE = 0xb8b6ac;
/**
 * 中央線・追い越し禁止の黄色。
 * 白線と同じ理由で彩度・明度を落とす。鮮やかな黄色の中央線が街じゅうに
 * 走っていると、道路網が「配線パターン」に見えてしまう。
 */
export const LINE_YELLOW = 0xa08c4e;

// ---------------------------------------------------------------------------
// 敷地（未建築の宅地に置く小物）
// ---------------------------------------------------------------------------

/**
 * 空き地の小物の色。
 *
 * どれも彩度をほとんど持たせない。街区の空き地は「目立たせる場所」ではなく、
 * **建物と建物の間を埋めて、そこが敷地であることを示す**ためのもの。
 * 色を付けると、以前の用途地域の塗り分けと同じ失敗（区画データが
 * そのまま絵になる）を繰り返すことになる。
 */
export const LOT_PROPS = {
  /** 月極駐車場の砕石。轍で踏み固められた灰茶。 */
  gravel: 0x8a8478,
  /** ブロック塀。日本の宅地の境界はだいたいこれ。 */
  blockWall: 0x9d9a90,
  /** プレハブ物置（亜鉛メッキ）。 */
  shed: 0x9aa2a6,
  /** プレハブ物置（塗装）。2 色あるだけで並んだときの反復が消える。 */
  shedAlt: 0xa4977f,
} as const;

/** 街灯の光の色（水銀灯の白と、ナトリウム灯の橙を混在させる）。 */
export const LAMP_COOL = 0xd8e4f0;
export const LAMP_WARM = 0xffcf8a;

const tmp = new Color();
const tmp2 = new Color();

/** 16 進 2 色を t で補間して返す（使い回しの Color を返すので保持しないこと）。 */
export function mixHex(a: number, b: number, t: number, out = tmp): Color {
  out.setHex(a);
  tmp2.setHex(b);
  return out.lerp(tmp2, Math.max(0, Math.min(1, t)));
}

/**
 * 地形の素材比率から地面の色を作る。
 *
 * @param terrain   地形分類
 * @param heightDm  標高 (dm)
 * @param slope     傾斜（近傍との標高差 dm）
 * @param season    季節
 * @param shore     水辺までの距離（タイル）。3 以内で砂・砂利を混ぜる。255 = 遠い
 */
export function groundColor(
  terrain: number,
  heightDm: number,
  slope: number,
  season: number,
  shore: number,
  noise: number,
  out = new Color(),
  noise2 = 0,
): Color {
  const grass = GRASS_SEASON[season] ?? GRASS_SEASON[Season.Summer]!;

  // --- 1 層目: 標高で草の質を変える。低地は水気のある緑、台地は乾いた緑。---
  // ノイズを混ぜるのが肝。標高だけで決めると、平野が丸ごと同じ 1 色になる
  // （実際そうなっていて、郊外一面が「単一のオリーブ」に見えていた）。
  const alt = Math.min(1, Math.max(0, heightDm / 900 + noise2 * 0.4));
  out.setHex(GROUND.grassLow).lerp(tmp2.setHex(GROUND.grassHigh), alt);

  // --- 2 層目: 乾湿のまだら ---
  // 同じ標高でも、日当たりと水はけで草の色は大きく違う。
  // 湿 → 素の草 → 乾 の 3 段のランプにしてある。以前は「乾いた側」と
  // 「湿った側」を別々のしきい値で足していたが、ノイズの実レンジに対して
  // 傾きが急すぎて乾側が飽和し、**視界のほぼ全域で係数が定数**になっていた。
  // つまり 2 素材を用意したのに 1 色しか出ていなかった。
  // `dryness()` でレンジを 0..1 に均し、中点からの距離で両側へ振る。
  const dry = dryness(noise2);
  if (dry > 0.5) out.lerp(tmp2.setHex(GROUND.grassDry), (dry - 0.5) * 2 * 0.8);
  else out.lerp(tmp2.setHex(GROUND.grassWet), (0.5 - dry) * 2 * 0.72);

  // --- 3 層目: 乾ききった所は地肌が透ける ---
  // 一面の草地に見えるところも、近くで見れば刈り跡や踏み跡から土が出ている。
  // 明度ではなく **素材** を混ぜるので、引きの画でも「色の違う土地」に読める。
  const scalp = Math.min(1, Math.max(0, (dry - 0.72) * 3.4));
  if (scalp > 0) out.lerp(tmp2.setHex(GROUND.soil), scalp * 0.3);

  // 森は林床が暗い。木の影が落ちている前提の色にすると、
  // 上に木を植えたときに「木の下だけ明るい」矛盾が起きない。
  const forest = terrain === Terrain.Forest;
  if (forest) out.lerp(tmp2.setHex(GROUND.forestFloor), 0.72);

  // 傾斜。急なほど土と岩が出る。地形分類ではなく傾斜で決めるのが肝で、
  // 「山地タイル」ではない急斜面（河岸段丘・丘の縁）にも岩が出る。
  //
  // ノイズを足しているのは、傾斜だけだと「平らな山頂」が
  // 一面の同じ灰色になって、巨大なのっぺりした板に見えるため。
  // 露岩の出方は実際にもまだらなので、これで嘘にはならない。
  let bare = Math.min(1, Math.max(0, (slope - 30) / 80) + noise * 0.22 + (heightDm > 1700 ? 0.25 : 0));
  bare = Math.max(0, Math.min(1, bare));
  // 森の下は落ち葉が積もっていて、傾斜があっても岩は出にくい。
  if (forest) bare *= 0.45;
  if (bare > 0) {
    out.lerp(tmp2.setHex(GROUND.soil), bare * 0.5);
    out.lerp(tmp2.setHex(GROUND.rock), bare * bare * 0.8);
  }

  // 高所は森林限界を超えて荒れる。山地の下限（heightDm 1860）より
  // 少し上から効かせる。低く始めると丘まで灰色になる。
  const high = Math.min(1, Math.max(0, (heightDm - 2000) / 800));
  if (high > 0) out.lerp(tmp2.setHex(GROUND.alpine), high * 0.8);

  // 冬の高山は雪。稜線だけが白くなるように、しきい値は森林限界より上に置く。
  if (season === Season.Winter) {
    const snow = Math.min(1, Math.max(0, (heightDm - 2150 + noise * 220) / 550));
    if (snow > 0) out.lerp(tmp2.setHex(GROUND.snow), snow * 0.85);
  }

  // 水辺。海・川のきわは砂と砂利になる。ここに帯が出ると、
  // 「陸と水が突き当たっている」のではなく「岸がある」ように見える。
  if (shore <= 2) {
    const band = shore <= 0 ? 1 : shore === 1 ? 0.72 : 0.28;
    out.lerp(tmp2.setHex(GROUND.sand), band * 0.75);
  }

  // 季節。草の部分だけに効かせたいが、岩や砂まで一律に染めても
  // 破綻しない程度の弱さにしてある。
  //
  // 掛け率を乾湿で振っているのが肝。冬の枯れ色（amount 0.55）を一律に混ぜると、
  // **手前の層で作ったばらつきの半分がその 1 色に吸われて**、また平野一面が
  // 同じ枯草色に戻ってしまう（実際そうなっていた）。枯れ方は場所で違う ――
  // 水の残る窪地は 1 月でも青いし、乾いた尾根は 11 月にはもう真っ茶色。
  // 素材の分布と枯れ方が同じ場から来るので、両者が同じ向きに強め合う。
  out.lerp(tmp2.setHex(grass.tint), grass.amount * (0.58 + dry * 0.84) * (1 - bare * 0.6));
  out.multiplyScalar(grass.mul * (0.97 + (1 - dry) * 0.06));
  return out;
}
