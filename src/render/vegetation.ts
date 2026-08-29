import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { applyVerticalAO, chamferedUnitBox, mergeParts, type Part } from './materials';
import {
  BAMBOO_SEASON,
  BROADLEAF_SEASON,
  CONIFER_SEASON,
  GROUND,
  SHRUB_SEASON,
  STREET_TREE_SEASON,
  TRUNK_BAMBOO,
  TRUNK_BROADLEAF,
  TRUNK_CONIFER,
  hash2,
  mixHex,
  type CanopyPalette,
} from './groundPalette';

/**
 * 樹木・低木・岩のジオメトリ。
 *
 * 以前の木は「箱の幹 + 円錐 1 個」だった。遠景では通用するが、
 * 街路に寄ると木に見えない。木が木に見えるかどうかを決めているのは、
 * 実のところ樹冠のシルエットが **1 個の凸形ではない** ことで、
 * 塊を 3〜4 個ずらして重ねるだけで一気に「葉の茂り」に化ける。
 *
 * ただし森林タイルだけで数万本置くので、頂点数の予算は厳しい。
 * ここでは 1 本 30〜70 三角形に収める。内訳は
 *   - 幹: 5 角柱（テーパー付き、蓋なし）= 10 三角形
 *   - 樹冠: 円錐（蓋なし 5 分割）= 5 三角形 / 八面体 = 8 三角形
 * で、これを組み合わせて種類を作り分ける。
 *
 * 色は頂点カラーに焼き込む。`instanceColor` は「個体ごとのばらつき」に使い、
 * 幹と樹冠の塗り分けは頂点側で持つ（この 2 つは掛け算で合成される）。
 * こうすると幹と樹冠を 1 インスタンスにまとめられて、
 * インスタンス数が半分で済む。
 *
 * すべて **高さ 1・底面 y=0** に正規化してある。実寸はインスタンスの拡大率で決める。
 */

const q = new Quaternion();
const e = new Euler();
const v = new Vector3();
const one = new Vector3(1, 1, 1);

/** 位置・オイラー角・スケールから行列を作る（枝を傾けるのに要る）。 */
function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1): Matrix4 {
  e.set(rx, ry, rz);
  q.setFromEuler(e);
  return new Matrix4().compose(v.set(x, y, z), q, one.clone().multiplyScalar(s));
}

/** テーパーの付いた角柱（幹・枝）。蓋を付けないぶん三角形が半分で済む。 */
function stem(rBottom: number, rTop: number, height: number, sides = 5): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBottom, height, sides, 1, true);
  g.translate(0, height / 2, 0);
  return g;
}

/** 蓋なしの円錐（針葉樹の樹冠 1 段）。 */
function canopyCone(radius: number, height: number, sides = 5): BufferGeometry {
  const g = new ConeGeometry(radius, height, sides, 1, true);
  g.translate(0, height / 2, 0);
  return g;
}

/**
 * いびつな八面体（広葉樹の葉の塊）。
 *
 * 正八面体のままだと「ダイヤ」にしか見えない。頂点をハッシュで
 * ±25% ずらすと輪郭が崩れて、遠目には葉の塊に見える。
 * 崩し方は seed で決まるので、同じ seed なら毎回同じ形になる。
 */
function blob(seed: number, radius = 1): BufferGeometry {
  const g = new OctahedronGeometry(radius, 0);
  const pos = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const jx = hash2(seed, i * 3) - 0.5;
    const jy = hash2(seed + 17, i * 3 + 1) - 0.5;
    const jz = hash2(seed + 31, i * 3 + 2) - 0.5;
    pos.setXYZ(
      i,
      pos.getX(i) * (1 + jx * 0.36),
      pos.getY(i) * (1 + jy * 0.3),
      pos.getZ(i) * (1 + jz * 0.36),
    );
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 冬の落葉樹の「枝の塊」の色。
 *
 * 葉ではなく細枝の集合なので、緑でも茶でもない灰褐色になる。
 * 幹（TRUNK_BROADLEAF / TRUNK_CONIFER）より彩度を落としてあるのが肝で、
 * ここに赤みが残ると遠景で「赤い粒」に戻る。
 *
 * ただし**無彩色にすると朝夕にかえって赤くなる**。橙の日射（0xff9a5e）が
 * そのまま乗るためで、灰色は光の色をいちばん素直に返してしまう。
 * 針葉樹の樹冠が朝でも赤く見えないのは、緑の albedo が橙の R を
 * 押し戻しているから。同じ理屈で、枝の塊にもわずかに緑を残してある。
 *
 * さらに明度を一段上げてある。0x59594a は写真で測った枯枝の色としては
 * 妥当なのだが、**冬の枯草の地面（同じ絵の中で 2 倍明るい）の上に置くと
 * 黒い点にしか見えない**。実際の冬の雑木林が黒く見えないのは、細枝の隙間から
 * 背景の空や地面が透けて、目に届く平均が枝そのものより明るくなるから。
 * 隙間を作らずに塊で描く以上、その平均のほうを albedo にするのが正しい。
 *
 * ただし明るくすると朝夕の橙がよく乗るようになるので、緑を **R より上** に
 * 置き直してある（一度 0x6d6a57＝R>G にしたら、朝の俯瞰で田園一面が
 * サーモンピンクの粒だらけになった）。上の段落のとおり、光の色をそのまま
 * 返さないための保険は albedo の色相しかない。
 */
const TWIG_MASS = 0x64694e;

/**
 * 冬の枝の塊の [x, y, z, 半径]。
 *
 * わざと**左右非対称**に、かつ広げて置いてある。以前は 3 個をほぼ同心に
 * 重ねていたので、輪郭が回転対称の丸になり、インスタンスごとに Y 回転を
 * 振っても**シルエットが 1 ミリも変わらなかった**（前回の指摘の
 * 「同じ大きさの同じ黒い塊が並ぶ」）。重心を中心から外し、高さも段差を
 * 付けておくと、同じジオメトリでも回転と縦横比だけで別の木に見える。
 */
const WINTER_MASS: [number, number, number, number][] = [
  [0.04, 0.7, -0.06, 0.29],
  [0.3, 0.55, 0.12, 0.22],
  [-0.24, 0.61, -0.17, 0.2],
  [0.08, 0.42, 0.27, 0.155],
];

/** 樹冠パレットから t (0..1) の色を取り出す。個体ごとの明暗差になる。 */
function canopyColor(p: CanopyPalette, t: number): number {
  return mixHex(p.dark, p.light, t).getHex();
}

/**
 * 針葉樹（杉）。
 *
 * 段を 4 つ重ねて、上ほど細く短くする。1 個の円錐と決定的に違うのは
 * 輪郭に「節」が出ることで、これがあると遠景でも杉林に見える。
 * 幹は樹冠の上に少しだけ突き出す（杉の梢の特徴）。
 */
export function coniferGeometry(season: number, shade: number, noTrunk = false): BufferGeometry {
  const pal = CONIFER_SEASON[season] ?? CONIFER_SEASON[1]!;
  const parts: Part[] = [];
  // 遠景（LOD）では幹を落とす。杉皮の赤茶 (TRUNK_CONIFER) は樹冠の緑と補色に近く、
  // 1〜2px に潰れると「緑の点に混じった赤い点」としてだけ残る。
  // 幹は樹冠に隠れて見えていないのだから、遠くでは無いほうが正しい。
  if (!noTrunk) parts.push({ geom: stem(0.03, 0.008, 1.0, 5), color: TRUNK_CONIFER, matrix: at(0, 0, 0) });
  // 段ごとの [高さ位置, 半径, 段の高さ]。上に行くほど詰まる。
  const tiers: [number, number, number][] = [
    [0.22, 0.27, 0.34],
    [0.42, 0.225, 0.3],
    [0.6, 0.17, 0.26],
    [0.76, 0.105, 0.2],
  ];
  for (let i = 0; i < tiers.length; i++) {
    const [y, r, h] = tiers[i]!;
    parts.push({
      geom: canopyCone(r, h, 5),
      // 段ごとに明るさを変える。上の段ほど日が当たる。
      color: canopyColor(pal, Math.min(1, shade + i * 0.07)),
      matrix: at(0, y, 0, 0, i * 0.7, 0),
    });
  }
  return finish(parts);
}

/**
 * 広葉樹。
 *
 * 樹冠は塊を 3 個、少しずつずらして重ねる。中心を外すのが要点で、
 * 左右対称にすると途端に「アイスクリーム」になる。
 * `branched` を立てると枝を 2 本出す（街路樹・単木として見せるとき）。
 */
export function broadleafGeometry(
  season: number,
  shade: number,
  branched: boolean,
  bare: boolean,
  noTrunk = false,
): BufferGeometry {
  const pal = BROADLEAF_SEASON[season] ?? BROADLEAF_SEASON[1]!;
  const seed = Math.round(shade * 97) + (branched ? 500 : 0);
  const parts: Part[] = [];
  if (!noTrunk) {
    parts.push({ geom: stem(0.05, 0.028, bare ? 0.5 : 0.44, 5), color: TRUNK_BROADLEAF, matrix: at(0, 0, 0) });
  }

  if (bare) {
    /**
     * 落葉した広葉樹。
     *
     * ここを「小さく平たい樹冠」で済ませると、細い柄の上に傘が乗った
     * キノコにしかならない（実際にそうなった）。葉が落ちた木の輪郭を
     * 決めているのは樹冠ではなく**枝の骨格**なので、太い枝を上向きに
     * 4 本出し、その先に小枝を足す。
     *
     * ただし枝だけにすると、俯瞰で木が 1〜2px に潰れたときに
     * **茶色い幹の色だけが点として残る**。冬の田園一面にそれが並ぶと、
     * 木ではなく「暗赤〜橙の粒が数千個散らばった不具合」に見えていた。
     * 実際の冬の落葉樹も、遠目には枝と小枝が絡んだ**灰茶の塊**として見える
     * （枝の 1 本 1 本が分離して見えるのは近くだけ）。
     * そこで枝の上に、その灰茶色の「枝の塊」を樹冠として重ねる。
     * 近景では枝の骨格が塊を突き抜けて見えるので、キノコにはならない。
     */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + seed * 0.7;
      const tilt = 0.5 + hash2(seed + i, 3) * 0.25;
      const len = 0.34 + hash2(seed + i, 11) * 0.14;
      if (!noTrunk) {
        parts.push({
          geom: stem(0.026, 0.011, len, 4),
          color: TRUNK_BROADLEAF,
          matrix: at(0, 0.42, 0, Math.sin(a) * tilt, 0, -Math.cos(a) * tilt),
        });
        // 小枝。先端の細かい分岐が無いと「フォーク」に見える。
        parts.push({
          geom: stem(0.014, 0.006, len * 0.62, 3),
          color: TWIG_MASS,
          matrix: at(
            Math.cos(a) * len * 0.55,
            0.42 + len * 0.78,
            Math.sin(a) * len * 0.55,
            Math.sin(a) * tilt * 0.6,
            0,
            -Math.cos(a) * tilt * 0.6,
          ),
        });
      }
    }
    for (let i = 0; i < WINTER_MASS.length; i++) {
      const [bx, by, bz, r] = WINTER_MASS[i]!;
      parts.push({
        geom: blob(seed + i * 13 + 7, 1),
        // 上の塊ほどわずかに明るく、灰緑に寄せる（日が当たる面）。
        color: mixHex(TWIG_MASS, 0x7f8467, i * 0.24).getHex(),
        matrix: at(bx, by, bz, 0, i * 1.1, 0, 1).scale(v.set(r, r * 0.82, r)),
      });
    }
    return finish(parts);
  }

  if (branched && !noTrunk) {
    // 枝は幹の途中から左右へ。角度を変えて 2 本だけ出す。
    parts.push({
      geom: stem(0.026, 0.012, 0.3, 4),
      color: TRUNK_BROADLEAF,
      matrix: at(0, 0.34, 0, 0, 0.4, 0.62),
    });
    parts.push({
      geom: stem(0.024, 0.012, 0.27, 4),
      color: TRUNK_BROADLEAF,
      matrix: at(0, 0.36, 0, 0, 2.6, -0.55),
    });
  }
  const blobs: [number, number, number, number][] = [
    [0, 0.72, 0, 0.34],
    [0.17, 0.6, 0.07, 0.26],
    [-0.13, 0.63, -0.11, 0.24],
  ];
  for (let i = 0; i < blobs.length; i++) {
    const [bx, by, bz, r] = blobs[i]!;
    parts.push({
      geom: blob(seed + i * 11, 1),
      color: canopyColor(pal, Math.min(1, shade + i * 0.09)),
      matrix: at(bx, by, bz, 0, i, 0, 1).scale(v.set(r, r * 0.94, r)),
    });
  }
  return finish(parts);
}

/**
 * 街路樹（春は桜、それ以外は青々とした緑）。
 *
 * 街路樹は剪定されているので、自然木より樹冠が丸く・幹がまっすぐ。
 * 根元に土のマス（植樹枡）を付けると、歩道に「置いてある」のではなく
 * 「植わっている」ように見える。
 */
export function streetTreeGeometry(season: number, shade: number, noTrunk = false): BufferGeometry {
  const pal = STREET_TREE_SEASON[season] ?? STREET_TREE_SEASON[1]!;
  const bare = season === 3; // 冬（Season.Winter）は落葉
  const seed = Math.round(shade * 61) + 900;
  const parts: Part[] = [];
  if (!noTrunk) {
    // 植樹枡
    parts.push({ geom: boxGeom(0.42, 0.05, 0.42), color: GROUND.soil, matrix: at(0, 0, 0) });
    parts.push({ geom: stem(0.055, 0.038, 0.5, 6), color: TRUNK_BROADLEAF, matrix: at(0, 0.02, 0) });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      parts.push({
        geom: stem(0.024, 0.012, 0.26, 4),
        color: TRUNK_BROADLEAF,
        matrix: at(0, 0.42, 0, Math.sin(a) * 0.5, 0, Math.cos(a) * 0.5),
      });
    }
  }
  if (bare) {
    // 冬の街路樹は強剪定されていて、太い枝が数本上を向いているだけになる。
    // 日本の冬の並木の、あの「拳のような」形。
    if (!noTrunk) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.8;
        parts.push({
          geom: stem(0.02, 0.009, 0.22, 3),
          color: canopyColor(pal, 0.5),
          matrix: at(0, 0.6, 0, Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55),
        });
      }
    }
    // 街路樹も遠景では枝が消えて幹色の点だけが残るので、
    // 自然木と同じ「枝の塊」を小さめに乗せる。
    for (let i = 0; i < 2; i++) {
      const [bx, by, bz, r] = WINTER_MASS[i]!;
      parts.push({
        geom: blob(seed + i * 5, 1),
        color: mixHex(TWIG_MASS, 0x6a7060, i * 0.25).getHex(),
        matrix: at(bx, by * 0.95, bz, 0, i * 1.4, 0, 1).scale(v.set(r * 0.8, r * 0.68, r * 0.8)),
      });
    }
  } else {
    const blobs: [number, number, number, number][] = [
      [0, 0.72, 0, 0.33],
      [0.16, 0.66, 0.1, 0.24],
      [-0.15, 0.68, -0.07, 0.23],
      [0.02, 0.83, -0.05, 0.19],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const [bx, by, bz, r] = blobs[i]!;
      parts.push({
        geom: blob(seed + i * 7, 1),
        color: canopyColor(pal, Math.min(1, shade + i * 0.08)),
        matrix: at(bx, by, bz, 0, i * 1.3, 0).scale(v.set(r, r * 0.86, r)),
      });
    }
  }
  return finish(parts);
}

/**
 * 竹。日本の里山と社寺の裏にはたいてい生えている。
 *
 * 1 インスタンスで 4 本立てる。竹は単体では細すぎて見えないうえ、
 * 実際にも群生するので、株ごと 1 個のジオメトリにするのが自然で安い。
 */
export function bambooGeometry(season: number, shade: number): BufferGeometry {
  const pal = BAMBOO_SEASON[season] ?? BAMBOO_SEASON[1]!;
  const parts: Part[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + shade * 3;
    const r = 0.09 + hash2(i, 3) * 0.07;
    const hh = 0.72 + hash2(i, 9) * 0.28;
    const lean = 0.05 + hash2(i, 21) * 0.09;
    parts.push({
      geom: stem(0.016, 0.01, hh, 4),
      color: TRUNK_BAMBOO,
      matrix: at(Math.cos(a) * r, 0, Math.sin(a) * r, Math.sin(a) * lean, 0, -Math.cos(a) * lean),
    });
    // 葉は先端に薄く広がる塊で表す。
    parts.push({
      geom: blob(i * 13 + 3, 1),
      color: canopyColor(pal, Math.min(1, shade + i * 0.1)),
      matrix: at(Math.cos(a) * r * 2.1, hh * 0.86, Math.sin(a) * r * 2.1, 0, a, 0).scale(
        v.set(0.15, 0.11, 0.15),
      ),
    });
  }
  return finish(parts);
}

/**
 * 低木・草むら。
 *
 * 木と地面の間が空いていると「模型の芝生に木を刺した」ように見える。
 * 木のふもとや空き地に丈の低い塊を散らすと、地面と植生がつながる。
 */
export function shrubGeometry(season: number, shade: number): BufferGeometry {
  const pal = SHRUB_SEASON[season] ?? SHRUB_SEASON[1]!;
  const parts: Part[] = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + shade * 5;
    const r = 0.16 + hash2(i + 40, 7) * 0.12;
    parts.push({
      geom: blob(i * 23 + 71, 1),
      color: canopyColor(pal, Math.min(1, shade * 0.6 + i * 0.2)),
      matrix: at(Math.cos(a) * r, 0.16 + hash2(i, 5) * 0.1, Math.sin(a) * r, 0, a, 0).scale(
        v.set(0.3, 0.24, 0.3),
      ),
    });
  }
  return finish(parts);
}

/**
 * 岩。
 *
 * 1 個の八面体だと「置かれた宝石」になる。大小 3 個を食い込ませて
 * 積むと、崩れた岩塊になる。色は明度差だけで付ける（岩に色味は無い）。
 */
export function rockGeometry(seed: number, snowy: boolean): BufferGeometry {
  const parts: Part[] = [];
  const chunks: [number, number, number, number, number][] = [
    [0, 0.3, 0, 0.5, 1.0],
    [0.28, 0.18, 0.12, 0.3, 0.86],
    [-0.22, 0.14, -0.2, 0.26, 0.78],
  ];
  for (let i = 0; i < chunks.length; i++) {
    const [x, y, z, r, shade] = chunks[i]!;
    const base = snowy ? GROUND.snow : GROUND.rock;
    parts.push({
      geom: blob(seed + i * 37, 1),
      color: mixHex(0x000000, base, shade).getHex(),
      matrix: at(x, y, z, 0.2 * i, i * 1.7, 0.15 * i).scale(v.set(r, r * 0.78, r * 0.92)),
    });
  }
  const g = mergeParts(parts);
  // 岩は「地面に半分埋まっている」ほうが自然なので、下端を切らずに沈める前提で
  // 高さ 1 に正規化はしない（呼び出し側でスケールする）。
  return applyVerticalAO(g, 0.5, 1.1, 1.6);
}

/**
 * 田んぼの畦。土の盛り上がりと、上を歩ける平らな面。
 * 上面をわずかに草色にすると、コンクリートの縁石ではなく畦に見える。
 */
export function bundGeometry(season: number): BufferGeometry {
  const grass = SHRUB_SEASON[season] ?? SHRUB_SEASON[1]!;
  const parts: Part[] = [
    { geom: boxGeom(1, 0.75, 1), color: GROUND.soil, matrix: at(0, 0, 0) },
    { geom: boxGeom(0.86, 0.3, 0.86), color: canopyColor(grass, 0.4), matrix: at(0, 0.7, 0) },
  ];
  return applyVerticalAO(mergeParts(parts), 0.72, 1.04, 1.4);
}

/**
 * 敷地の小物（塀・生垣・物置・駐車パッド）の共通ジオメトリ。
 *
 * 形の違いは **拡大率だけ** で作る。塀は薄く長く、生垣は少し厚く、
 * 物置は箱、駐車パッドは板。1 種類のジオメトリで済ませれば
 * InstancedMesh が 1 つで足り、ドローコールが 4 つではなく 1 つになる。
 *
 * 角を落としてあるのは、街区の空き地に何十個も並ぶものだからで、
 * 鋭い辺のままだと「立方体を置いた」感じが強く出てしまう。
 * 足元を暗くしておくと、地面に置いたときにそこだけ影が溜まって接地する。
 */
export function lotPropGeometry(): BufferGeometry {
  return applyVerticalAO(chamferedUnitBox(0.05), 0.66, 1.06, 1.5);
}

/** 底面 y=0 の直方体。 */
function boxGeom(sx: number, sy: number, sz: number): BufferGeometry {
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(0, sy / 2, 0);
  return g;
}

/**
 * 部品をまとめ、足元に擬似 AO を焼く。
 *
 * 木の根元が明るいままだと、地面から生えているのではなく
 * 「地面の上に立っている」ように見える。下を暗くするだけで接地する。
 */
function finish(parts: Part[]): BufferGeometry {
  return applyVerticalAO(mergeParts(parts), 0.58, 1.08, 2.1);
}
