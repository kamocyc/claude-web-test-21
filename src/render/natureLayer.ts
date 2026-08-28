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
import { hash2 } from './groundPalette';
import { CARRIAGE_HALF, WALK_OUTER } from './roadLayer';
import {
  bambooGeometry,
  broadleafGeometry,
  bundGeometry,
  coniferGeometry,
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
 */
const TRUNK_LOD_DISTANCE = 800;

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
    this.walk(sim, true);
    this.streetTrees.end();
    this.bamboo.end();
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
        const ox = planted ? (k - (count - 1) / 2) * 3.2 : (((g >>> 3) % 100) / 100 - 0.5) * TILE_M * 0.72;
        const oz = planted ? ((i % 3) - 1) * 3.0 : (((g >>> 11) % 100) / 100 - 0.5) * TILE_M * 0.72;
        const height = conifer ? 9 + ((g >>> 23) % 70) / 10 : 7 + ((g >>> 23) % 50) / 10;
        // 樹形も少し崩す。幅を高さと別に散らすと、同じ木の反復が消える。
        const spread = height * (0.86 + ((g >>> 13) % 32) / 100);
        this.put(
          slot,
          cx + ox,
          gy,
          cz + oz,
          spread,
          height,
          spread,
          ((g >>> 25) % 360) * (Math.PI / 180),
          // 冬の落葉樹は「枝の塊」＝ほぼ無彩色なので、色相を振ると
          // 朝夕の低い日射を拾って個体ごとに赤やピンクに転ぶ。
          // 遠景ではそれが「田園に散った赤い粒」に戻るので、冬だけ振れ幅を絞る。
          this.jitterCanopy(
            g,
            conifer ? 0.022 : winter ? 0.014 : 0.05,
            conifer ? 0.16 : winter ? 0.15 : 0.24,
          ),
        );
      }
    }
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
    this.treeMaterial.dispose();
    this.rockMaterial.dispose();
  }
}

const WHITE = new Color(1, 1, 1);
