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
 * 3 オクターブの値ノイズ（およそ -1..1）。
 *
 * 一番低い周波数（1 周期 30 タイル ≒ 300m）が効いているのが肝で、
 * これが無いと「細かいざらつき」にしかならず、引きの画では
 * 結局のっぺりした一色に見える。地面の情報量は、細かさではなく
 * 大きなむらの有無で決まる。
 */
export function terrainNoise(x: number, y: number): number {
  return (
    (valueNoise(x * 0.032, y * 0.032) - 0.5) * 1.0 +
    (valueNoise(x * 0.13, y * 0.13) - 0.5) * 0.7 +
    (valueNoise(x * 0.5, y * 0.5) - 0.5) * 0.35
  );
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

/** 歩道の平板（インターロッキング）。日本の歩道はやや暖色のグレー。 */
export const WALKWAY_COLOR = 0x9a958a;
/** 縁石。歩道より明るいコンクリート。 */
export const CURB_COLOR = 0xb0aca2;
/** 側溝の蓋（グレーチング）と溝の暗がり。 */
export const GUTTER_COLOR = 0x4a4a46;
/**
 * 白線。実際は少し黄ばんでいるので純白にはしない。
 * 引きの画では横断歩道の縞が点の集まりになって強くちらつくので、
 * 純白より一段落として、路面との差を付けすぎないようにしてある。
 */
export const LINE_WHITE = 0xc9c5b6;
/** 中央線・追い越し禁止の黄色。 */
export const LINE_YELLOW = 0xc7a340;

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
): Color {
  const grass = GRASS_SEASON[season] ?? GRASS_SEASON[Season.Summer]!;

  // 標高で草の質を変える。低地は水気のある緑、台地は乾いた緑。
  const alt = Math.min(1, heightDm / 900);
  out.setHex(GROUND.grassLow).lerp(tmp2.setHex(GROUND.grassHigh), alt);

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
  out.lerp(tmp2.setHex(grass.tint), grass.amount * (1 - bare * 0.6));
  out.multiplyScalar(grass.mul);
  return out;
}
