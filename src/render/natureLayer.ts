import {
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { MAP_W, TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import { RoadClass, Season, Terrain, Zone } from '@shared/enums';
import type { Simulation } from '@sim/simulation';
import { neighbor, tileX, tileY } from '@sim/world/tiles';
import { surface } from './materials';
import { InstancePool } from './instancePool';
import { GROUND, LOT_PROPS, SHRUB_SEASON, hash2, mixHex } from './groundPalette';
import { CARRIAGE_HALF, WALK_OUTER } from './roadLayer';
import {
  bambooGeometry,
  broadleafGeometry,
  bundGeometry,
  coniferGeometry,
  lotPropGeometry,
  rockGeometry,
  shrubGeometry,
  streetTreeGeometry,
} from './vegetation';

/**
 * 自然の造形。
 *
 * 以前の木は「箱の幹 + 円錐 1 個」で、しかも全部が同じ大きさ・同じ色だった。
 * 森は「緑の円錐が整列した畑」に見えていた。木が木に見え、森が森に見えるには
 * 3 つが要る。
 *
 * **1. 樹冠が 1 個の凸形でないこと。**（`vegetation.ts` が受け持つ）
 * **2. 同じ木が 2 本と無いこと。** 大きさ・向き・色・位置をハッシュで散らす。
 *    とくに色を `instanceColor` で個体ごとにずらすのが効く。頂点カラーと
 *    掛け算で合成されるので、「幹と樹冠の塗り分け」を保ったまま
 *    個体の明暗と色味だけを動かせる。
 * **3. 種類が複数あること。** 針葉樹（杉の人工林）・広葉樹（雑木）・竹・
 *    街路樹・低木を、地形と用途地域から生え分けさせる。
 *
 * 数が桁違いに多い（森林だけで 1.7 万タイル）ので、描き方に 2 つ工夫がある。
 *
 * **区画に分けて視錐台カリングを効かせる。** マップを 80 タイル角の区画に切り、
 * 区画ごとにメッシュを持つ。カメラを寄せているとき、three.js が区画単位で
 * 「見えていない」を判定して丸ごと捨ててくれる。
 *
 * **数の少ない種類は区画に切らない。** 街路樹と竹は道路沿い・特定の地形にしか
 * 生えないので、区画に切るとドローコールだけが増えて中身が空になる。
 * こちらは 1 種類 1 メッシュにまとめる。
 */

/** 区画の 1 辺（タイル）。320 / 80 = 4 で 16 区画。 */
const REGION_TILES = 80;
const REGIONS_X = MAP_W / REGION_TILES;
const REGION_COUNT = REGIONS_X * REGIONS_X;

/** 区画ごとに持つ部品の種類。 */
const Kind = { Conifer: 0, Broadleaf: 1, Shrub: 2, Rock: 3, Bund: 4 } as const;
const KIND_COUNT = 5;

/** 森林タイル 1 枚に生やす本数。 */
const TREES_PER_FOREST = 2;
/** 丘陵・平地にまばらに生やす周期（タイルのハッシュの法）。 */
const HILL_PERIOD = 3;
const PLAIN_PERIOD = 11;
/**
 * 低木・草むらの周期。
 * 密にしすぎると、草地一面に茶色い塊が散らばって「ゴミが落ちている」ように見える。
 */
const SHRUB_PERIOD = 9;
/** 山地に岩を置く周期。 */
const ROCK_PERIOD = 2;
/** 竹林の周期。里山の縁にだけ、まばらに。 */
const BAMBOO_PERIOD = 23;

/** 雪をかぶる標高 (dm)。冬だけ、これより高い山を白くする。 */
const SNOW_LINE_DM = 620;

/** 再構築のクールダウン（フレーム数）。建物のエポックは 1 日に何度も動く。 */
const REBUILD_COOLDOWN = 24;

/**
 * 幹を描くのをやめるカメラ距離 (m)。
 *
 * この距離だと木 1 本が 2px 前後にしかならない。そこに幹（＝樹冠と補色に近い
 * 赤茶の細い棒）を混ぜても「木らしさ」は 1px も増えず、色の異なる粒が
 * 増えるだけになる。冬に樹冠が痩せると、その粒だけが残って
 * 「田園に赤い点が数千個散っている」ように見えていた。
 * 遠景では樹冠だけの LOD ジオメトリに差し替える。
 *
 * しきい値を 800 から下げてある。朝夕の低い日射は橙なので、幹の赤茶が
 * そのまま増幅される。街区より引いた時点で幹は 1px を割っているのだから、
 * 早めに落としたほうが「同じ色の粒が散っている」印象を避けられる。
 */
const TRUNK_LOD_DISTANCE = 600;

/**
 * 敷地の小物を描くカメラ距離 (m)。
 *
 * 塀も物置も 2m 前後の物なので、これより引くと数画素に潰れて
 * 「地面に散った点」にしかならない。街区を見下ろす距離までで十分。
 *
 * 700m まで伸ばすことも試したが、やめた。その距離では 1 画素が 0.7m あり、
 * 駐車マスの白線も物置の柱も**画素の網に当たったところだけが塗られる点**になる。
 * 街区の内側を埋めたくて足した物が、そのまま「地面に散った白い粒」という
 * 別の指摘に化ける。埋めるのは、物が物として見える距離までにする。
 */
const LOT_PROP_LOD_DISTANCE = 620;

/** 向き d (0=北,1=東,2=南,3=西) の外向き単位ベクトル。街路樹をどの辺に植えるかで使う。 */
const OUT_X = [0, 1, 0, -1] as const;
const OUT_Z = [-1, 0, 1, 0] as const;

export class NatureLayer {
  readonly group = new Object3D();
  /** [区画 * KIND_COUNT + 種類]。まだ 1 つも置いていない枠は null。 */
  private readonly meshes: (InstancedMesh | null)[] = new Array(REGION_COUNT * KIND_COUNT).fill(null);
  private readonly caps = new Int32Array(REGION_COUNT * KIND_COUNT);
  private readonly counts = new Int32Array(REGION_COUNT * KIND_COUNT);
  private readonly cursors = new Int32Array(REGION_COUNT * KIND_COUNT);
  /** 種類ごとのジオメトリ。季節が変わったら作り直す。 */
  private geoms: BufferGeometry[] = [];
  /** 遠景用（幹なし）のジオメトリ。中身が変わらない種類は `geoms` を指す。 */
  private farGeoms: BufferGeometry[] = [];
  /** いま遠景ジオメトリを使っているか。距離の帯をまたいだときだけ差し替える。 */
  private far = false;

  /** 数の少ない種類は区画に切らずに 1 メッシュで持つ。 */
  private readonly streetTrees: InstancePool;
  private readonly bamboo: InstancePool;
  /**
   * 敷地の小物（塀・生垣・物置・駐車パッド）。
   *
   * 用途地域を指定しただけで建物がまだ建っていない土地は、以前は
   * 「用途の色を混ぜた四角」で塗っていた。塗りをやめると今度はただの
   * 草地になり、街区の中に穴が空く。実際の日本の街区の空き地は、
   * 砕石を敷いた月極駐車場か、ブロック塀と生垣に囲われた更地で、
   * だいたい隅にプレハブの物置が建っている。それを数個置くだけで
   * 「区画データ」ではなく「まだ建っていない敷地」に見えるようになる。
   */
  private readonly lotProps: InstancePool;
  private lotPropsShown = true;
  /** 街路樹の遠景版（植樹枡と幹を落としたもの）。 */
  private streetTreeFar: BufferGeometry;
  private streetTreeNear: BufferGeometry;

  // 葉は薄いので裏からの光がわずかに透ける。粗さを下げすぎると
  // 樹冠がプラスチックになるので、拡散寄りのまま少しだけ反射を残す。
  // 葉も岩も鏡面反射をほとんど持たない。既定の envMapIntensity 1 のままだと、
  // 低い視点で見たときにフレネル反射で空の色が乗って白く飛ぶ。
  private readonly treeMaterial = surface({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    envMapIntensity: 0.3,
  });
  private readonly rockMaterial = surface({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    envMapIntensity: 0.25,
  });
  /** 塀・物置・駐車パッド。人工物なので岩や葉より少しだけ反射する。 */
  private readonly propMaterial = surface({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.03,
    envMapIntensity: 0.35,
  });
  private geomSeason = -1;

  /** 直近に反映したエポックと季節。1 つでも変われば作り直す。 */
  private readonly seen = { terrain: -1, zoning: -1, roads: -1, rail: -1, buildings: -1, season: -1 };
  private cooldown = 0;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();

  constructor() {
    this.group.name = 'nature';
    this.buildGeometries(Season.Summer);
    this.geomSeason = Season.Summer;
    this.streetTreeNear = streetTreeGeometry(Season.Summer, 0.5);
    this.streetTreeFar = streetTreeGeometry(Season.Summer, 0.5, true);
    this.streetTrees = new InstancePool(
      this.streetTreeNear,
      this.treeMaterial,
      this.group,
      true,
      2048,
    );
    this.bamboo = new InstancePool(
      bambooGeometry(Season.Summer, 0.5),
      this.treeMaterial,
      this.group,
      true,
      512,
    );
    this.lotProps = new InstancePool(lotPropGeometry(), this.propMaterial, this.group, true, 4096);
  }

  /** 情報表示のときは隠す（道路・線路レイヤと同じ理由）。 */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  invalidate(): void {
    this.seen.terrain = -1;
  }

  /**
   * @param camDistance カメラの注視点からの距離 (m)。遠景で幹を落とす LOD に使う。
   *   既定を 0 にしてあるのは、呼び出し元（renderer.ts）が渡さなくても
   *   「近景 = 全部描く」で従来どおり動くようにするため。
   */
  update(sim: Simulation, camDistance = 0): void {
    this.applyLod(camDistance > TRUNK_LOD_DISTANCE);
    const showLots = camDistance < LOT_PROP_LOD_DISTANCE;
    if (showLots !== this.lotPropsShown) {
      this.lotPropsShown = showLots;
      this.lotProps.setVisible(showLots);
    }
    const e = sim.world.epochs;
    const season = sim.clock.season;
    const changed =
      this.seen.terrain !== e.terrain ||
      this.seen.zoning !== e.zoning ||
      this.seen.roads !== e.roads ||
      this.seen.rail !== e.rail ||
      this.seen.buildings !== e.buildings ||
      this.seen.season !== season;
    if (!changed) return;
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }
    this.cooldown = REBUILD_COOLDOWN;
    this.seen.terrain = e.terrain;
    this.seen.zoning = e.zoning;
    this.seen.roads = e.roads;
    this.seen.rail = e.rail;
    this.seen.buildings = e.buildings;
    this.seen.season = season;

    if (this.geomSeason !== season) {
      this.buildGeometries(season);
      this.streetTreeNear.dispose();
      this.streetTreeFar.dispose();
      this.streetTreeNear = streetTreeGeometry(season, 0.55);
      this.streetTreeFar = streetTreeGeometry(season, 0.55, true);
      this.streetTrees.setGeometry(this.far ? this.streetTreeFar : this.streetTreeNear);
      this.bamboo.mesh.geometry.dispose();
      this.bamboo.setGeometry(bambooGeometry(season, 0.5));
      this.geomSeason = season;
    }
    // 1 周目で区画ごとの本数を数え、器を用意してから 2 周目で書き込む。
    // 器を先に確保しないと、区画ごとの容量が決められない。
    this.counts.fill(0);
    this.walk(sim, false);
    this.ensureMeshes();
    this.cursors.fill(0);
    this.streetTrees.begin();
    this.bamboo.begin();
    this.lotProps.begin();
    this.walk(sim, true);
    this.streetTrees.end();
    this.bamboo.end();
    this.lotProps.end();
    // grow() でメッシュが作り直されている可能性があるので、LOD を掛け直す。
    this.lotProps.setVisible(this.lotPropsShown);
    this.finish();
  }

  /** 季節ぶんのジオメトリ。幹と樹冠を 1 つに合成し、色は頂点に焼き込む。 */
  private buildGeometries(season: number): void {
    for (const g of this.geoms) g.dispose();
    // 幹を持つ種類だけ遠景版を別に持つ。低木・岩・畦は幹が無いので同じ物を指す
    // （2 本持っても中身が同じで、頂点バッファを無駄に倍持つだけになる）。
    for (let k = 0; k < KIND_COUNT; k++) {
      const g = this.farGeoms[k];
      if (g && g !== this.geoms[k]) g.dispose();
    }
    const bare = season === Season.Winter;
    this.geoms = [];
    this.geoms[Kind.Conifer] = coniferGeometry(season, 0.5);
    this.geoms[Kind.Broadleaf] = broadleafGeometry(season, 0.5, false, bare);
    this.geoms[Kind.Shrub] = shrubGeometry(season, 0.5);
    this.geoms[Kind.Rock] = rockGeometry(7, false);
    this.geoms[Kind.Bund] = bundGeometry(season);
    this.farGeoms = this.geoms.slice();
    this.farGeoms[Kind.Conifer] = coniferGeometry(season, 0.5, true);
    this.farGeoms[Kind.Broadleaf] = broadleafGeometry(season, 0.5, false, bare, true);
  }

  /** いまの LOD で使うべきジオメトリ。 */
  private geomFor(kind: number): BufferGeometry {
    return (this.far ? this.farGeoms[kind] : this.geoms[kind])!;
  }

  /**
   * 遠景 LOD の切り替え。
   *
   * 木の位置は変えないので、区画メッシュのジオメトリ参照を差し替えるだけで済む
   * （インスタンス行列は書き直さない）。距離の帯をまたいだときしか通らない。
   */
  private applyLod(far: boolean): void {
    if (far === this.far) return;
    this.far = far;
    for (let s = 0; s < this.meshes.length; s++) {
      const mesh = this.meshes[s];
      if (mesh) mesh.geometry = this.geomFor(s % KIND_COUNT);
    }
    this.streetTrees.setGeometry(far ? this.streetTreeFar : this.streetTreeNear);
  }

  private materialFor(kind: number): typeof this.treeMaterial {
    return kind === Kind.Rock || kind === Kind.Bund ? this.rockMaterial : this.treeMaterial;
  }

  /** 数え終わった本数に合わせて、区画ごとのメッシュを用意する。 */
  private ensureMeshes(): void {
    for (let s = 0; s < this.counts.length; s++) {
      const need = this.counts[s]!;
      const mesh = this.meshes[s];
      if (need === 0) {
        if (mesh) mesh.count = 0;
        continue;
      }
      if (mesh && this.caps[s]! >= need) {
        // 季節や LOD が変わってジオメトリを差し替えていることがある。
        mesh.geometry = this.geomFor(s % KIND_COUNT);
        continue;
      }
      if (mesh) {
        this.group.remove(mesh);
        mesh.dispose();
      }
      // 建物が増減するたびに作り直さずに済むよう、少し余裕を持たせる。
      const cap = need + Math.max(32, need >> 2);
      const kind = s % KIND_COUNT;
      const next = new InstancedMesh(this.geomFor(kind), this.materialFor(kind), cap);
      next.count = 0;
      // 区画ごとに視錐台カリングを効かせる。これがこのレイヤの肝。
      next.frustumCulled = true;
      // instanceColor を先に確保する。個体ごとの色ずらしに必ず使う。
      next.setColorAt(0, WHITE);
      this.group.add(next);
      this.meshes[s] = next;
      this.caps[s] = cap;
    }
  }

  private finish(): void {
    for (let s = 0; s < this.meshes.length; s++) {
      const mesh = this.meshes[s];
      if (!mesh) continue;
      mesh.count = this.cursors[s]!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /**
   * タイルを走査して部品を置く。
   *
   * `place` が false のときは数えるだけ。**数える周と置く周で必ず同じ判定を通す**
   * 必要があるので、1 つのループを 2 回まわす形にしてある。
   */
  private walk(sim: Simulation, place: boolean): void {
    const world = sim.world;
    const season = sim.clock.season;
    const winter = season === Season.Winter;

    for (let i = 0; i < TILE_COUNT; i++) {
      const terrain = world.terrain[i]!;
      if (terrain === Terrain.Sea || terrain === Terrain.Freshwater) continue;

      const zone = world.zone[i]!;
      const x = tileX(i);
      const y = tileY(i);
      const region = ((y / REGION_TILES) | 0) * REGIONS_X + ((x / REGION_TILES) | 0);
      const gy = world.heightDm[i]! * TERRAIN_HEIGHT_SCALE;
      const cx = (x + 0.5) * TILE_M;
      const cz = (y + 0.5) * TILE_M;
      const h = (i * 2654435761) >>> 0;

      // --- 街路樹 ---
      // 道路タイルの、道路が繋がっていない辺（＝歩道のある辺）に植える。
      // 全部の辺に植えると並木というより生垣になり、田畑の間の農道にまで
      // 街路樹が並んで日本の風景から外れるので、用途地域で密度を変える。
      if (world.road[i] !== RoadClass.None) {
        if (place) this.putStreetTrees(sim, i, cx, cz, gy, h);
        continue;
      }

      // 田んぼの畦。隣が田んぼでない辺にだけ盛る。
      // 全部の辺に置くと 1 枚ずつ囲われた升目になり、日本の水田の
      // 「大きな区画がいくつか」という見え方から外れる。
      if (zone === Zone.AgriPaddy) {
        for (let d = 0; d < 4; d++) {
          const nb = neighbor(i, d);
          if (nb >= 0 && world.zone[nb] === Zone.AgriPaddy) continue;
          const slot = region * KIND_COUNT + Kind.Bund;
          if (!place) {
            this.counts[slot]!++;
            continue;
          }
          const edge = TILE_M / 2 - 0.45;
          const ox = d === 1 ? edge : d === 3 ? -edge : 0;
          const oz = d === 2 ? edge : d === 0 ? -edge : 0;
          const vertical = d === 1 || d === 3;
          // 畦は「土を盛った細い道」。太く高くすると木の板を並べたように見える。
          this.put(slot, cx + ox, gy - 0.12, cz + oz, vertical ? 0.7 : TILE_M, 0.42, vertical ? TILE_M : 0.7, 0);
        }
        continue;
      }

      // 線路・建物の上には何も生やさない。
      if (world.rail[i] !== 0 || world.buildingRef[i] !== 0) continue;

      // --- 空き地の小物 ---
      // 用途を指定しただけで建物がまだ建っていない土地。
      // ここを空のままにすると街区の中に穴が空くので、敷地の設えを置く。
      // 数える周と置く周で必ず同じ判定を通す（ここで枝分かれが食い違うと、
      // 区画ごとの容量と実際に置く数がずれる）。
      if (zone >= Zone.ResidentialLow && zone <= Zone.IndustrialHeavy) {
        if (place) this.putLotProps(world, i, cx, cz, gy, h, season, zone);
        continue;
      }

      // --- 街区の裏の空き地 ---
      //
      // 用途地域が指定されていないのに、隣が建物になっているタイル。
      // 街区の内側（中庭）はほぼこれで、ここが素の草地のままだと、
      // 引きの画で**ブロックの真ん中がオリーブ灰の無地に抜ける**。
      // 実際の街区の内側は、塀で仕切られた駐車スペース・物置・室外機置場で
      // 埋まっていて、無地の地面が見えることはまず無い。
      // 3 枚に 1 枚は木と低木に譲る（庭木の無い裏庭も不自然なので）。
      if (zone === Zone.None && (h >>> 4) % 3 !== 0 && this.nextToBuilt(world, i)) {
        if (place) this.putBackLot(cx, cz, gy, h, season);
        continue;
      }

      if (terrain === Terrain.Mountain) {
        if (h % ROCK_PERIOD !== 0) continue;
        const slot = region * KIND_COUNT + Kind.Rock;
        if (!place) {
          this.counts[slot]!++;
          continue;
        }
        const size = 2.4 + ((h >>> 7) % 40) / 10;
        const ox = (((h >>> 3) % 100) / 100 - 0.5) * TILE_M * 0.7;
        const oz = (((h >>> 13) % 100) / 100 - 0.5) * TILE_M * 0.7;
        // 冬の高山は雪をかぶる。街から見上げたときの季節感がここで出る。
        const snowy = winter && world.heightDm[i]! > SNOW_LINE_DM;
        // 岩は色味を持たないので、明度だけを散らす。同じ灰色の塊が並ぶより、
        // 明暗が混ざっているほうが「崩れた斜面」に見える。
        const v = 0.78 + ((h >>> 11) % 45) / 100;
        if (snowy) this.color.setRGB(v * 1.25, v * 1.27, v * 1.3);
        else this.color.setRGB(v, v * 0.99, v * 0.95);
        this.put(
          slot,
          cx + ox,
          gy - size * 0.25,
          cz + oz,
          size,
          size * 0.8,
          size * 0.9,
          ((h >>> 17) % 360) * (Math.PI / 180),
          this.color,
        );
        continue;
      }

      // --- 竹林 ---
      // 森と平地の境目（＝里山の縁）に生える。日本の郊外の風景で、
      // 杉林でも雑木林でもない「明るい黄緑の藪」がこれ。
      if (place && zone === Zone.None && terrain !== Terrain.Mountain && h % BAMBOO_PERIOD === 5) {
        const near = this.nextTo(world, i, Terrain.Forest);
        if (near) {
          const size = 6 + ((h >>> 5) % 40) / 10;
          this.color.setRGB(1, 1, 1);
          this.pushProp(
            this.bamboo,
            cx + (((h >>> 3) % 100) / 100 - 0.5) * TILE_M * 0.6,
            gy,
            cz + (((h >>> 9) % 100) / 100 - 0.5) * TILE_M * 0.6,
            size,
            ((h >>> 15) % 360) * (Math.PI / 180),
            this.jitterCanopy(h, 0.1, 0.16),
          );
        }
      }

      // --- 低木・草むら ---
      // 木のふもとと空き地を埋める。木と地面が直接ぶつかっていると、
      // 「模型の芝生に木を刺した」ように見える。
      if (zone === Zone.None || zone === Zone.Park || zone === Zone.Forestry) {
        if (h % SHRUB_PERIOD === 2) {
          const slot = region * KIND_COUNT + Kind.Shrub;
          if (!place) this.counts[slot]!++;
          else {
            const size = 1.2 + ((h >>> 19) % 18) / 10;
            this.put(
              slot,
              cx + (((h >>> 7) % 100) / 100 - 0.5) * TILE_M * 0.8,
              gy - size * 0.12,
              cz + (((h >>> 17) % 100) / 100 - 0.5) * TILE_M * 0.8,
              size,
              size * (0.5 + ((h >>> 23) % 32) / 100),
              size,
              ((h >>> 27) % 360) * (Math.PI / 180),
              this.jitterCanopy(h ^ 0x5bf03635, 0.05, 0.22),
            );
          }
        }
      }

      // 木を何本生やすか。森林は密に、林業地は植林として規則的に、
      // 丘陵と平地には雑木がまばらに生える。
      let count = 0;
      let planted = false;
      if (zone === Zone.Forestry) {
        count = TREES_PER_FOREST;
        planted = true;
      } else if (zone !== Zone.None) {
        continue; // 用途地域が指定された土地は、いずれ建つので生やさない
      } else if (terrain === Terrain.Forest) {
        count = TREES_PER_FOREST;
      } else if (terrain === Terrain.Hill) {
        count = h % HILL_PERIOD === 0 ? 1 : 0;
      } else {
        count = h % PLAIN_PERIOD === 0 ? 1 : 0;
      }

      for (let k = 0; k < count; k++) {
        const g = ((h >>> (k * 5)) ^ (k * 0x9e3779b9)) >>> 0;
        // 森林と林業地は針葉樹が主体、丘や平地の雑木は広葉樹が主体。
        const conifer = terrain === Terrain.Forest || planted ? (g >>> 19) % 4 !== 0 : (g >>> 19) % 4 === 0;
        const kind = conifer ? Kind.Conifer : Kind.Broadleaf;
        const slot = region * KIND_COUNT + kind;
        if (!place) {
          this.counts[slot]!++;
          continue;
        }
        // 植林地は列に並べる。自然林との違いが遠目にも分かる。
        // 散布のオフセット。以前はタイルの ±36% に収めていたが、
        // 平地の雑木は 11 タイルに 1 本しか生えないので、
        // **散布の行がそのまま格子として見えていた**（前回の指摘）。
        // タイルの外まではみ出すところまで広げると、格子の位相が壊れて
        // 「まばらに散った雑木」に見える。
        const ox = planted ? (k - (count - 1) / 2) * 3.2 : (((g >>> 3) % 100) / 100 - 0.5) * TILE_M * 1.6;
        const oz = planted ? ((i % 3) - 1) * 3.0 : (((g >>> 11) % 100) / 100 - 0.5) * TILE_M * 1.6;
        // 大きさの散らしも広げる。冬の落葉樹は葉が無いぶん個体の輪郭が
        // 全部同じ「枝の塊」になるので、高さの幅で違いを作るしかない。
        const height = conifer ? 8.5 + ((g >>> 23) % 80) / 10 : 5.4 + ((g >>> 23) % 88) / 10;
        // 樹形も崩す。X と Z を**別々に**散らすのが肝で、等方に拡大している
        // うちはインスタンスごとの Y 回転が絵に何も足さない（回しても同じ輪郭）。
        // 楕円にしてから回すと、同じジオメトリでも向きの違う木として読める。
        // 針葉樹は円錐なので歪めすぎると倒れて見える。落葉樹だけ強く振る。
        const spread = height * (0.82 + ((g >>> 13) % 34) / 100);
        const squash = conifer ? 0.94 + ((g >>> 7) % 12) / 100 : 0.68 + ((g >>> 7) % 62) / 100;
        this.put(
          slot,
          cx + ox,
          gy,
          cz + oz,
          spread,
          height,
          spread * squash,
          ((g >>> 25) % 360) * (Math.PI / 180),
          // 冬の落葉樹は「枝の塊」＝ほぼ無彩色なので、色相を振ると
          // 朝夕の低い日射を拾って個体ごとに赤やピンクに転ぶ。
          // 遠景ではそれが「田園に散った赤い粒」に戻るので、冬だけ振れ幅を絞る。
          // 冬の落葉樹は「同じ黒い塊」に見えていた。色相を振ると朝夕の
          // 低い日射を拾って赤に転ぶので、色相はほぼ据え置きのまま
          // **明度の幅だけを大きく開く**。同じ灰褐色でも、明るい個体と
          // 暗い個体が混ざっていれば林として読める。
          this.jitterCanopy(
            g,
            conifer ? 0.022 : winter ? 0.02 : 0.05,
            conifer ? 0.16 : winter ? 0.32 : 0.24,
          ),
        );
      }
    }
  }

  /**
   * 空き地の設え。塀・生垣・物置・駐車マス・室外機・資材置場。
   *
   * 形はすべて 1 種類の面取り箱で、拡大率だけで作り分ける
   * （`lotPropGeometry`）。ドローコールを 1 本に抑えるためで、
   * 塀のように薄く長い物と物置のように厚い物を同じ箱で兼ねられる。
   * **1 区画あたりの箱を増やしてもドローコールは 1 本のまま**なので、
   * 「街区の中庭が無地のオリーブ灰」という指摘に対しては、
   * 物の種類と 1 区画あたりの点数を増やすのがいちばん安い答えになる。
   *
   * 敷地の境界は「道路に面した辺」に置く。道路に接していない奥の敷地は
   * ハッシュで辺を決める。全部の辺を囲うと升目になるので、必ず 1 辺だけ。
   */
  private putLotProps(
    world: Simulation['world'],
    i: number,
    cx: number,
    cz: number,
    gy: number,
    h: number,
    season: number,
    zone: number,
  ): void {
    // 道路に面した辺を探す。見つからなければハッシュで決める。
    let edge = -1;
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && world.road[nb] !== RoadClass.None) {
        edge = d;
        break;
      }
    }
    const key = h >>> 5;
    if (edge < 0) edge = key % 4;
    // 辺が南北向き（外向きが Z）なら、境界の物は X 方向に伸びる。
    const alongX = edge === 0 || edge === 2;
    const bx = cx + OUT_X[edge]! * (TILE_M / 2 - 0.45);
    const bz = cz + OUT_Z[edge]! * (TILE_M / 2 - 0.45);
    const run = TILE_M * 0.84;
    const thin = 0.24;

    // 工業地の敷地には資材とコンテナが積んである。用途で置く物を分けると、
    // 街区ごとに空き地の見え方が変わって、区画の性格が絵から読める
    // （住宅地の更地に鉄コンテナが積んであると、それだけで嘘になる）。
    const works = zone === Zone.IndustrialLight || zone === Zone.IndustrialHeavy;
    switch (works ? 4 + (key % 2) : key % 4) {
      case 0: {
        // 月極駐車場。砕石を敷いた板、区画の白線、奥側の低いブロック塀。
        this.color.setHex(LOT_PROPS.gravel).multiplyScalar(0.92 + ((key >>> 7) % 18) / 100);
        this.putBox(cx, gy + 0.01, cz, TILE_M * 0.82, 0.09, TILE_M * 0.82, this.color);
        // 駐車マスの白線。1 台 2.5m 幅なので、10m のタイルにちょうど 4 台ぶん入る。
        // 実寸の 12cm ではなく 24cm で引いてある。街区を見下ろす距離では
        // 12cm は 1 画素の 1/3 しかなく、**線ではなく点線状の粒**になる。
        // 塗料の色を砕石に寄せてあるので、太らせても白い帯には見えない。
        // **中庭が無地に見える原因は、面積の大きい物が 1 枚も無かったこと**ではなく、
        // 面の中に線が 1 本も無かったことのほうにある。線を 3 本引くだけで
        // 「砕石の板」が「駐車場」になる。
        this.color.setHex(LOT_PROPS.stall).multiplyScalar(0.9 + ((key >>> 3) % 16) / 100);
        for (let k = -1; k <= 1; k++) {
          const off = k * 2.5;
          this.putBox(
            alongX ? cx + off : cx,
            gy + 0.06,
            alongX ? cz : cz + off,
            alongX ? 0.24 : TILE_M * 0.66,
            0.05,
            alongX ? TILE_M * 0.66 : 0.24,
            this.color,
          );
        }
        const back = (edge + 2) & 3;
        this.color.setHex(LOT_PROPS.blockWall).multiplyScalar(0.9 + ((key >>> 11) % 20) / 100);
        this.putBox(
          cx + OUT_X[back]! * (TILE_M / 2 - 0.45),
          gy,
          cz + OUT_Z[back]! * (TILE_M / 2 - 0.45),
          alongX ? run : thin,
          0.62,
          alongX ? thin : run,
          this.color,
        );
        break;
      }
      case 1: {
        // 生垣。季節で色が変わるように、低木と同じパレットから引く。
        const pal = SHRUB_SEASON[season] ?? SHRUB_SEASON[Season.Summer]!;
        this.color.copy(mixHex(pal.dark, pal.light, ((key >>> 9) % 100) / 100));
        this.putBox(bx, gy, bz, alongX ? run : 0.8, 1.0 + ((key >>> 13) % 30) / 100, alongX ? 0.8 : run, this.color);
        // 生垣の内側に自転車置場。波板の屋根と細い柱 2 本。
        // 柱が無いと目線の高さで屋根が宙に浮くので、そこだけは省けない。
        const rx = cx - OUT_X[edge]! * 2.2;
        const rz = cz - OUT_Z[edge]! * 2.2;
        this.color.setHex(LOT_PROPS.shed).multiplyScalar(0.94 + ((key >>> 21) % 12) / 100);
        this.putBox(rx, gy + 2.0, rz, alongX ? 4.6 : 2.2, 0.12, alongX ? 2.2 : 4.6, this.color);
        // 柱は屋根より暗い色で、少し太らせる。細く明るい柱は、街区を
        // 見下ろす距離では 1 画素を割って「白い粒」にしかならない。
        this.color.multiplyScalar(0.62);
        for (let k = -1; k <= 1; k += 2) {
          this.putBox(
            rx + (alongX ? k * 2.0 : 0.9),
            gy,
            rz + (alongX ? 0.9 : k * 2.0),
            0.18,
            2.0,
            0.18,
            this.color,
          );
        }
        break;
      }
      case 2: {
        // 物置と塀。物置は敷地の隅に寄せる。
        this.color.setHex(LOT_PROPS.blockWall).multiplyScalar(0.9 + ((key >>> 11) % 20) / 100);
        this.putBox(bx, gy, bz, alongX ? run : thin, 1.5, alongX ? thin : run, this.color);
        const sx = ((key >>> 15) % 2 === 0 ? 1 : -1) * TILE_M * 0.26;
        const sz = ((key >>> 17) % 2 === 0 ? 1 : -1) * TILE_M * 0.26;
        this.color.setHex((key >>> 19) % 3 === 0 ? LOT_PROPS.shedAlt : LOT_PROPS.shed);
        this.putBox(cx + sx, gy, cz + sz, 2.5, 2.0 + ((key >>> 21) % 8) / 10, 1.8, this.color);
        // 室外機置場。物置の反対側の隅に 2〜3 台並べる。
        // 日本の敷地の隅にはたいていこれが据えてある。
        this.color.setHex(LOT_PROPS.unit).multiplyScalar(0.92 + ((key >>> 25) % 14) / 100);
        const n = 2 + ((key >>> 13) % 2);
        for (let k = 0; k < n; k++) {
          this.putBox(
            cx - sx + (alongX ? (k - (n - 1) / 2) * 1.05 : 0),
            gy,
            cz - sz + (alongX ? 0 : (k - (n - 1) / 2) * 1.05),
            alongX ? 0.85 : 0.4,
            0.65,
            alongX ? 0.4 : 0.85,
            this.color,
          );
        }
        break;
      }
      case 3: {
        // ブロック塀だけ。高さを散らすと、同じ塀が並ぶ反復が消える。
        this.color.setHex(LOT_PROPS.blockWall).multiplyScalar(0.88 + ((key >>> 11) % 24) / 100);
        this.putBox(bx, gy, bz, alongX ? run : thin, 1.3 + ((key >>> 23) % 60) / 100, alongX ? thin : run, this.color);
        // 更地に残った基礎（解体跡）と、その脇に積んだ土嚢の山。
        // 「何も無い草地」と「まだ建っていない敷地」を分けるのは、
        // 塀ではなくこういう**中途半端に残った物**だと思う。
        this.color.setHex(LOT_PROPS.gravel).multiplyScalar(0.86 + ((key >>> 5) % 20) / 100);
        this.putBox(cx, gy + 0.01, cz, 5.4, 0.16, 4.2, this.color);
        this.color.setHex(LOT_PROPS.crate).multiplyScalar(0.9 + ((key >>> 17) % 18) / 100);
        this.putBox(cx + 3.0, gy, cz - 2.6, 1.6, 0.7, 1.4, this.color);
        break;
      }
      case 4: {
        // 構内の資材置場。パレットとコンテナを段違いに積む。
        this.color.setHex(LOT_PROPS.gravel).multiplyScalar(0.9 + ((key >>> 7) % 16) / 100);
        this.putBox(cx, gy + 0.01, cz, TILE_M * 0.88, 0.1, TILE_M * 0.88, this.color);
        for (let k = 0; k < 3; k++) {
          const kh = (key >>> (k * 5 + 3)) >>> 0;
          const px = cx + ((kh % 100) / 100 - 0.5) * TILE_M * 0.6;
          const pz = cz + (((kh >>> 7) % 100) / 100 - 0.5) * TILE_M * 0.6;
          this.color
            .setHex(kh % 3 === 0 ? LOT_PROPS.crateAlt : LOT_PROPS.crate)
            .multiplyScalar(0.88 + ((kh >>> 13) % 22) / 100);
          this.putBox(px, gy, pz, 2.2 + ((kh >>> 17) % 14) / 10, 1.1 + ((kh >>> 19) % 16) / 10, 1.8, this.color);
        }
        break;
      }
      default: {
        // 構内の駐車場（従業員用）。トラックが据わる幅で線を引く。
        this.color.setHex(GROUND.lotPaved).multiplyScalar(0.93 + ((key >>> 7) % 14) / 100);
        this.putBox(cx, gy + 0.01, cz, TILE_M * 0.9, 0.1, TILE_M * 0.9, this.color);
        this.color.setHex(LOT_PROPS.stall).multiplyScalar(0.9 + ((key >>> 3) % 16) / 100);
        for (let k = -1; k <= 1; k++) {
          const off = k * 3.2;
          this.putBox(
            alongX ? cx + off : cx,
            gy + 0.07,
            alongX ? cz : cz + off,
            alongX ? 0.26 : TILE_M * 0.72,
            0.05,
            alongX ? TILE_M * 0.72 : 0.26,
            this.color,
          );
        }
        // 構内の隅に受電設備（キュービクル）。工場の敷地の記号。
        this.color.setHex(LOT_PROPS.unit).multiplyScalar(0.9 + ((key >>> 25) % 16) / 100);
        this.putBox(cx + TILE_M * 0.3, gy, cz + TILE_M * 0.3, 1.8, 1.9, 1.1, this.color);
        break;
      }
    }
  }

  /** 底面 y=0 の単位箱を実寸で置く（敷地の小物専用）。 */
  private putBox(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: Color,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(sx, sy, sz);
    this.quat.identity();
    this.mat.compose(this.pos, this.quat, this.scl);
    this.lotProps.push(this.mat, color);
  }

  /**
   * 街区の裏の空き地の設え。
   *
   * `putLotProps` と分けてあるのは、こちらが「建てる予定の無い土地」だから。
   * 更地の設え（駐車マスや資材置場）ではなく、**隣の家からはみ出してきた物**
   * ―― 塀・物置・室外機・物干し ―― を置くほうが街区の内側らしくなる。
   */
  private putBackLot(
    cx: number,
    cz: number,
    gy: number,
    h: number,
    season: number,
  ): void {
    // XOR の結果は符号付きになりうるので必ず符号なしに戻す。
    // 負のままだと `key % 4` が負になり、方向表の添字が外れて座標が NaN になる。
    const key = ((h >>> 7) ^ 0x2f6c1a3b) >>> 0;
    const edge = key % 4;
    const alongX = edge === 0 || edge === 2;
    const bx = cx + OUT_X[edge]! * (TILE_M / 2 - 0.4);
    const bz = cz + OUT_Z[edge]! * (TILE_M / 2 - 0.4);
    const run = TILE_M * 0.86;

    // 境界のブロック塀。裏の空き地でいちばん確実にあるのがこれ。
    this.color.setHex(LOT_PROPS.blockWall).multiplyScalar(0.86 + ((key >>> 5) % 26) / 100);
    this.putBox(bx, gy, bz, alongX ? run : 0.22, 1.1 + ((key >>> 9) % 70) / 100, alongX ? 0.22 : run, this.color);

    switch ((key >>> 11) % 3) {
      case 0: {
        // 裏の駐車スペース。舗装した板と、車 1 台ぶんの白線 2 本。
        this.color.setHex(LOT_PROPS.gravel).multiplyScalar(0.9 + ((key >>> 15) % 18) / 100);
        this.putBox(cx, gy + 0.01, cz, TILE_M * 0.7, 0.08, TILE_M * 0.7, this.color);
        this.color.setHex(LOT_PROPS.stall).multiplyScalar(0.92 + ((key >>> 3) % 14) / 100);
        for (let k = -1; k <= 1; k += 2) {
          this.putBox(
            alongX ? cx + k * 1.3 : cx,
            gy + 0.05,
            alongX ? cz : cz + k * 1.3,
            alongX ? 0.22 : TILE_M * 0.56,
            0.05,
            alongX ? TILE_M * 0.56 : 0.22,
            this.color,
          );
        }
        break;
      }
      case 1: {
        // 物置と室外機。日本の裏庭の記号。
        this.color.setHex((key >>> 17) % 3 === 0 ? LOT_PROPS.shedAlt : LOT_PROPS.shed);
        this.putBox(
          cx - OUT_X[edge]! * 2.4,
          gy,
          cz - OUT_Z[edge]! * 2.4,
          alongX ? 2.6 : 1.7,
          1.9 + ((key >>> 19) % 9) / 10,
          alongX ? 1.7 : 2.6,
          this.color,
        );
        this.color.setHex(LOT_PROPS.unit).multiplyScalar(0.92 + ((key >>> 23) % 14) / 100);
        for (let k = 0; k < 2; k++) {
          this.putBox(
            cx + (alongX ? (k - 0.5) * 1.05 : 2.6),
            gy,
            cz + (alongX ? 2.6 : (k - 0.5) * 1.05),
            alongX ? 0.85 : 0.4,
            0.62,
            alongX ? 0.4 : 0.85,
            this.color,
          );
        }
        break;
      }
      default: {
        // 庭。刈り込んだ植え込みを 2 株と、低い縁石。
        const pal = SHRUB_SEASON[season] ?? SHRUB_SEASON[Season.Summer]!;
        this.color.copy(mixHex(pal.dark, pal.light, ((key >>> 21) % 100) / 100));
        for (let k = 0; k < 2; k++) {
          const kh = (key >>> (k * 6 + 3)) >>> 0;
          const size = 1.0 + ((kh >>> 5) % 12) / 10;
          this.putBox(
            cx + ((kh % 100) / 100 - 0.5) * TILE_M * 0.5,
            gy,
            cz + (((kh >>> 7) % 100) / 100 - 0.5) * TILE_M * 0.5,
            size,
            size * 0.9,
            size,
            this.color,
          );
        }
        this.color.setHex(LOT_PROPS.blockWall).multiplyScalar(0.98);
        this.putBox(cx, gy, cz + TILE_M * 0.3, TILE_M * 0.6, 0.24, 0.2, this.color);
        break;
      }
    }
  }

  /** 隣接 4 タイルに建物が載っているか。街区の内側（中庭）の判定に使う。 */
  private nextToBuilt(world: Simulation['world'], i: number): boolean {
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && world.buildingRef[nb] !== 0) return true;
    }
    return false;
  }

  /** 隣接 4 タイルにその地形があるか。里山の縁の判定に使う。 */
  private nextTo(world: Simulation['world'], i: number, terrain: number): boolean {
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(i, d);
      if (nb >= 0 && world.terrain[nb] === terrain) return true;
    }
    return false;
  }

  /**
   * 街路樹。道路レイヤではなくここに置いてあるのは、
   * (a) 季節で色が変わる仕組みが植生側にあること、
   * (b) 道路グループは影を落とさない設定なので、木の影が消えてしまうこと、
   * の 2 つの理由による。
   */
  private putStreetTrees(sim: Simulation, i: number, cx: number, cz: number, gy: number, h: number): void {
    const world = sim.world;
    const conn = world.roadConn(i);
    for (let d = 0; d < 4; d++) {
      if (conn & (1 << d)) continue;
      const facing = neighbor(i, d);
      const zone = facing >= 0 ? world.zone[facing]! : Zone.None;
      const dense =
        zone === Zone.ResidentialMid ||
        zone === Zone.CommercialLocal ||
        zone === Zone.CommercialCentral ||
        zone === Zone.Park;
      // 低層住宅地は庭木が主役で街路樹はまばら。ここを密にすると郊外が並木道になる。
      const sparse = zone === Zone.ResidentialLow;
      const period = dense ? 2 : sparse ? 6 : 0;
      if (period === 0) continue;
      const key = (h ^ (d * 0x9e3779b9)) >>> 0;
      if (key % period !== 0) continue;
      const size = 5.4 + ((key >>> 5) % 26) / 10;
      // 歩道の上に植える。大通りは車道が広いぶん歩道が外に寄るので、
      // 車道の半幅を見て位置をずらす（そうしないと車道の真ん中に木が立つ）。
      const offset = Math.max(CARRIAGE_HALF[world.road[i]!]! + 0.55, WALK_OUTER - 1.0);
      this.pushProp(
        this.streetTrees,
        cx + OUT_X[d]! * offset,
        gy + 0.38,
        cz + OUT_Z[d]! * offset,
        size,
        ((key >>> 11) % 360) * (Math.PI / 180),
        this.jitterCanopy(key, 0.03, 0.18),
      );
    }
  }

  /**
   * 樹冠の色を個体ごとに散らす。
   *
   * `jitterColor`（materials.ts）は建物向けに色相の振れ幅が狭い。
   * 木は「同じ樹種でも日当たりと樹齢で色が全然違う」ので、
   * 色相をもう少し広く、明度はさらに広く振る必要がある。
   * 返す色は `instanceColor` に入り、頂点カラーと掛け算で合成される
   * （＝白 1.0 が「変化なし」）。
   */
  private jitterCanopy(hash: number, hue: number, light: number): Color {
    const a = hash2(hash & 0xffff, (hash >>> 16) & 0xffff) - 0.5;
    const b = hash2((hash >>> 8) & 0xffff, hash & 0xff) - 0.5;
    // 明度は掛け算なので 1 を中心に。色相は緑↔黄緑↔褐色の間で振る。
    const l = 1 + b * 2 * light;
    this.color.setHSL((1 + a * 2 * hue) % 1, 0.5, 0.5);
    // setHSL で作った色をそのまま掛けると全体が濁るので、白に寄せて薄める。
    const w = 0.72;
    this.color.setRGB(
      (this.color.r * 2 * (1 - w) + w) * l,
      (this.color.g * 2 * (1 - w) + w) * l,
      (this.color.b * 2 * (1 - w) + w) * l,
    );
    return this.color;
  }

  private put(
    slot: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rotY: number,
    color?: Color,
  ): void {
    const mesh = this.meshes[slot];
    if (!mesh) return;
    const index = this.cursors[slot]!;
    if (index >= this.caps[slot]!) return;
    this.pos.set(x, y, z);
    this.scl.set(sx, sy, sz);
    if (rotY === 0) this.quat.identity();
    else this.quat.setFromAxisAngle(this.axisY, rotY);
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
    if (color) mesh.setColorAt(index, color);
    this.cursors[slot] = index + 1;
  }

  /** 区画に切らない種類（街路樹・竹）の配置。 */
  private pushProp(
    pool: InstancePool,
    x: number,
    y: number,
    z: number,
    size: number,
    rotY: number,
    color: Color,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(size, size, size);
    if (rotY === 0) this.quat.identity();
    else this.quat.setFromAxisAngle(this.axisY, rotY);
    this.mat.compose(this.pos, this.quat, this.scl);
    pool.push(this.mat, color);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      if (mesh) mesh.dispose();
    }
    for (const g of this.geoms) g.dispose();
    for (let k = 0; k < KIND_COUNT; k++) {
      const g = this.farGeoms[k];
      if (g && g !== this.geoms[k]) g.dispose();
    }
    this.streetTreeNear.dispose();
    this.streetTreeFar.dispose();
    this.streetTrees.dispose();
    this.bamboo.mesh.geometry.dispose();
    this.bamboo.dispose();
    this.lotProps.mesh.geometry.dispose();
    this.lotProps.dispose();
    this.treeMaterial.dispose();
    this.rockMaterial.dispose();
    this.propMaterial.dispose();
  }
}

const WHITE = new Color(1, 1, 1);
