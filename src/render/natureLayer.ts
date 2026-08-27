import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { MAP_W, TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import { RoadClass, Season, Terrain, Zone } from '@shared/enums';
import type { Simulation } from '@sim/simulation';
import { neighbor, tileX, tileY } from '@sim/world/tiles';

/**
 * 自然の造形。
 *
 * 地形は地形メッシュが色を塗っているだけだった。森林は「濃い緑の平面」、
 * 山地は「灰色の平面」で、建物と車だけが立体という画になっていた。
 * 街の外側が平らなままだと、街の側をどれだけ作り込んでも
 * 「盤面の上に置いた模型」に見える。
 *
 * ここでは木・岩・田の畦を置く。数が桁違いに多い（森林だけで 1.7 万タイル）ので、
 * 他の描画レイヤと違う工夫が 2 つ要る。
 *
 * **1. 区画に分けて視錐台カリングを効かせる。**
 * 他のレイヤは `frustumCulled = false` の 1 メッシュで済ませているが、
 * それをここでやると、カメラを最大まで寄せていても 4 万本ぶんの頂点処理が
 * 毎フレーム走る。マップを 64 タイル角の区画に切り、区画ごとにメッシュを持つと、
 * three.js が区画単位で「見えていない」を判定して丸ごと捨ててくれる。
 *
 * **2. 木の色をジオメトリに焼き込む。**
 * `instanceColor` で色を変えると、幹と樹冠を別メッシュに分けるほかなくなり、
 * インスタンス数が倍になる（幹 4 万 ＋ 樹冠 4 万）。色は季節ごとに数種類しか
 * 無いのだから、種類ぶんのジオメトリを作って頂点色に焼いてしまえば、
 * 幹と樹冠を 1 つのインスタンスにまとめられる。季節が変わったときだけ
 * ジオメトリを作り直せばよい。
 *
 * 木の色は季節で変わる。田んぼの色と合わせて、街の時間経過が
 * 遠景からでも伝わるようになる。
 */

/** 区画の 1 辺（タイル）。320 / 64 = 5 で 25 区画。 */
const REGION_TILES = 64;
const REGIONS_X = MAP_W / REGION_TILES;
const REGION_COUNT = REGIONS_X * REGIONS_X;

/** 部品の種類。区画ごとにこの数だけメッシュを持つ。 */
const Kind = { Conifer: 0, BroadleafA: 1, BroadleafB: 2, Rock: 3, Bund: 4 } as const;
const KIND_COUNT = 5;

/** 森林タイル 1 枚に生やす本数。 */
const TREES_PER_FOREST = 2;
/** 丘陵・平地にまばらに生やす周期（タイルのハッシュの法）。 */
const HILL_PERIOD = 3;
const PLAIN_PERIOD = 11;
/** 山地に岩を置く周期。 */
const ROCK_PERIOD = 2;

/** 針葉樹（杉・檜）。日本の人工林はほぼこれ。 */
const CONIFER_COLORS: Record<number, number> = {
  [Season.Spring]: 0x3f7a4a,
  [Season.Summer]: 0x2f6b3c,
  [Season.Autumn]: 0x35633c,
  [Season.Winter]: 0x2b5236,
};
/**
 * 広葉樹は 2 種類の色で交互に生やす。1 色だと塗り絵に見えるので、
 * どの季節でも少し散らしておく。秋は紅葉と黄葉の差になる。
 */
const BROADLEAF_COLORS: Record<number, [number, number]> = {
  [Season.Spring]: [0x8cc063, 0x6fae55],
  [Season.Summer]: [0x4f9243, 0x3f8039],
  [Season.Autumn]: [0xc9702c, 0xd8a53a],
  [Season.Winter]: [0x7a6c58, 0x6d604f],
};

const TRUNK_COLOR = 0x6b5540;
const ROCK_COLOR = 0x7c7a72;
const SNOW_COLOR = 0xdfe4e8;
const BUND_COLOR = 0x8f7f5f;

/** 雪をかぶる標高 (dm)。冬だけ、これより高い山を白くする。 */
const SNOW_LINE_DM = 620;

/** 再構築のクールダウン（フレーム数）。建物のエポックは 1 日に何度も動く。 */
const REBUILD_COOLDOWN = 24;

export class NatureLayer {
  readonly group = new Object3D();
  /** [区画 * KIND_COUNT + 種類]。まだ 1 つも置いていない枠は null。 */
  private readonly meshes: (InstancedMesh | null)[] = new Array(REGION_COUNT * KIND_COUNT).fill(null);
  private readonly caps = new Int32Array(REGION_COUNT * KIND_COUNT);
  private readonly counts = new Int32Array(REGION_COUNT * KIND_COUNT);
  private readonly cursors = new Int32Array(REGION_COUNT * KIND_COUNT);
  /** 種類ごとのジオメトリ。季節が変わったら作り直す。 */
  private geoms: BufferGeometry[] = [];
  private readonly treeMaterial = new MeshLambertMaterial({ vertexColors: true });
  private readonly rockMaterial = new MeshLambertMaterial({});
  private readonly bundMaterial = new MeshLambertMaterial({ color: BUND_COLOR });
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
  }

  /** 情報表示のときは隠す（道路・線路レイヤと同じ理由）。 */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  invalidate(): void {
    this.seen.terrain = -1;
  }

  update(sim: Simulation): void {
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
      this.geomSeason = season;
    }
    // 1 周目で区画ごとの本数を数え、器を用意してから 2 周目で書き込む。
    // 器を先に確保しないと、区画ごとの容量が決められない。
    this.counts.fill(0);
    this.walk(sim, false);
    this.ensureMeshes();
    this.cursors.fill(0);
    this.walk(sim, true);
    this.finish();
  }

  /** 季節ぶんのジオメトリ。幹と樹冠を 1 つに合成し、色は頂点に焼き込む。 */
  private buildGeometries(season: number): void {
    for (const g of this.geoms) g.dispose();
    const conifer = CONIFER_COLORS[season] ?? CONIFER_COLORS[Season.Summer]!;
    const broad = BROADLEAF_COLORS[season] ?? BROADLEAF_COLORS[Season.Summer]!;
    // 冬の広葉樹は葉を落とすので、樹冠を小さく描く。
    const bare = season === Season.Winter;
    const bundGeom = new BoxGeometry(1, 1, 1);
    bundGeom.translate(0, 0.5, 0);
    this.geoms = [];
    this.geoms[Kind.Conifer] = coniferGeometry(conifer);
    this.geoms[Kind.BroadleafA] = broadleafGeometry(broad[0], bare);
    this.geoms[Kind.BroadleafB] = broadleafGeometry(broad[1], bare);
    this.geoms[Kind.Rock] = new OctahedronGeometry(1, 0);
    this.geoms[Kind.Bund] = bundGeom;
  }

  private materialFor(kind: number): MeshLambertMaterial {
    if (kind === Kind.Rock) return this.rockMaterial;
    if (kind === Kind.Bund) return this.bundMaterial;
    return this.treeMaterial;
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
        // 季節が変わってジオメトリを差し替えていることがある。
        mesh.geometry = this.geoms[s % KIND_COUNT]!;
        continue;
      }
      if (mesh) {
        this.group.remove(mesh);
        mesh.dispose();
      }
      // 建物が増減するたびに作り直さずに済むよう、少し余裕を持たせる。
      const cap = need + Math.max(32, need >> 2);
      const kind = s % KIND_COUNT;
      const next = new InstancedMesh(this.geoms[kind]!, this.materialFor(kind), cap);
      next.count = 0;
      // 区画ごとに視錐台カリングを効かせる。これがこのレイヤの肝。
      next.frustumCulled = true;
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
          this.put(slot, cx + ox, gy, cz + oz, vertical ? 0.9 : TILE_M, 0.45, vertical ? TILE_M : 0.9, 0);
        }
        continue;
      }

      // 道路・線路・建物の上には何も生やさない。
      if (world.road[i] !== RoadClass.None || world.rail[i] !== 0 || world.buildingRef[i] !== 0) continue;

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
        this.color.setHex(snowy ? SNOW_COLOR : ROCK_COLOR);
        this.put(
          slot,
          cx + ox,
          gy + size * 0.35,
          cz + oz,
          size,
          size * 0.8,
          size * 0.9,
          ((h >>> 17) % 360) * (Math.PI / 180),
          this.color,
        );
        continue;
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
        const kind = conifer ? Kind.Conifer : (g >>> 21) & 1 ? Kind.BroadleafA : Kind.BroadleafB;
        const slot = region * KIND_COUNT + kind;
        if (!place) {
          this.counts[slot]!++;
          continue;
        }
        // 植林地は列に並べる。自然林との違いが遠目にも分かる。
        const ox = planted ? (k - (count - 1) / 2) * 3.2 : (((g >>> 3) % 100) / 100 - 0.5) * TILE_M * 0.72;
        const oz = planted ? ((i % 3) - 1) * 3.0 : (((g >>> 11) % 100) / 100 - 0.5) * TILE_M * 0.72;
        const height = conifer ? 9 + ((g >>> 23) % 70) / 10 : 7 + ((g >>> 23) % 50) / 10;
        this.put(slot, cx + ox, gy, cz + oz, height, height, height, ((g >>> 25) % 360) * (Math.PI / 180));
      }
    }
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

  dispose(): void {
    for (const mesh of this.meshes) {
      if (mesh) mesh.dispose();
    }
    for (const g of this.geoms) g.dispose();
    this.treeMaterial.dispose();
    this.rockMaterial.dispose();
    this.bundMaterial.dispose();
  }
}

/** 高さ 1・底面 y=0 に正規化した針葉樹。大きさはインスタンスの拡大率で決める。 */
function coniferGeometry(canopy: number): BufferGeometry {
  const trunk = new BoxGeometry(0.06, 0.34, 0.06);
  trunk.translate(0, 0.17, 0);
  const cone = new ConeGeometry(0.28, 0.72, 5);
  cone.translate(0, 0.64, 0);
  return mergeColored([
    { geom: trunk, color: TRUNK_COLOR },
    { geom: cone, color: canopy },
  ]);
}

/** 同じく広葉樹。冬は葉を落とすので樹冠を縮める。 */
function broadleafGeometry(canopy: number, bare: boolean): BufferGeometry {
  const trunk = new BoxGeometry(0.08, 0.44, 0.08);
  trunk.translate(0, 0.22, 0);
  const r = bare ? 0.21 : 0.37;
  const vr = bare ? 0.19 : 0.32;
  const crown = new OctahedronGeometry(1, 0);
  crown.scale(r, vr, r);
  crown.translate(0, bare ? 0.56 : 0.66, 0);
  return mergeColored([
    { geom: trunk, color: TRUNK_COLOR },
    { geom: crown, color: canopy },
  ]);
}

/**
 * 部品を 1 つのジオメトリに合成し、部品ごとの色を頂点色として焼き込む。
 * 索引の無いジオメトリ（多面体）も混ざるので、そこは連番の索引を作る。
 */
function mergeColored(parts: readonly { geom: BufferGeometry; color: number }[]): BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    const n = p.geom.getAttribute('position').count;
    vertexCount += n;
    indexCount += p.geom.getIndex()?.count ?? n;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint16Array(indexCount);

  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pos = p.geom.getAttribute('position');
    const nrm = p.geom.getAttribute('normal');
    const n = pos.count;
    position.set(pos.array as Float32Array, vo * 3);
    normal.set(nrm.array as Float32Array, vo * 3);
    const r = ((p.color >> 16) & 255) / 255;
    const g = ((p.color >> 8) & 255) / 255;
    const b = (p.color & 255) / 255;
    for (let v = 0; v < n; v++) {
      color[(vo + v) * 3] = r;
      color[(vo + v) * 3 + 1] = g;
      color[(vo + v) * 3 + 2] = b;
    }
    const src = p.geom.getIndex();
    for (let k = 0; k < (src?.count ?? n); k++) index[io + k] = (src ? src.getX(k) : k) + vo;
    io += src?.count ?? n;
    vo += n;
    p.geom.dispose();
  }

  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(position, 3));
  out.setAttribute('normal', new BufferAttribute(normal, 3));
  out.setAttribute('color', new BufferAttribute(color, 3));
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}
