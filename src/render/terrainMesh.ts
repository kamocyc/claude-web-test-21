import { BufferAttribute, BufferGeometry, Color, Mesh, Object3D, Vector3 } from 'three';
import { surface } from './materials';
import {
  CHUNK,
  CHUNKS_X,
  CHUNK_COUNT,
  TERRAIN_HEIGHT_SCALE,
  TILE_M,
} from '@shared/constants';
import { Overlay, RoadClass, Season, Terrain, Zone } from '@shared/enums';
import type { Simulation } from '@sim/simulation';
import { idx, inBounds, neighbor } from '@sim/world/tiles';
import { heatColor, zoneColor } from './theme';
import {
  GROUND,
  PADDY_WATER_SEASON,
  groundColor,
  terrainNoise,
} from './groundPalette';
import {
  RIVER_SINK,
  SEA_LEVEL,
  WaterLayer,
  computeBeachDistance,
  computeShoreDistance,
} from './waterLayer';
import { atmosphereAt, sunDirection } from './sky';

/**
 * 地形・道路・線路・ゾーンをまとめた地面メッシュ。
 *
 * 32×32 タイルのチャンクごとに 1 つの頂点カラー付きジオメトリを持ち、
 * 変更のあったチャンクだけを再構築する。全面再構築すると
 * 道路をドラッグするたびに 10 万タイル分のジオメトリを作り直すことになる。
 *
 * 以前の地面は「タイル 1 枚 = 1 色のべた塗り」だった。これには 2 つ問題がある。
 *
 * **1. タイル格子が見える。** 隣り合うタイルで色が階段状に変わるので、
 * 引きの画で地面が市松模様になる。ここでは色を **タイルではなく角** で決め、
 * 角に接する 4 タイルの色を平均する。隣り合う四角形が同じ角の色を共有するので、
 * 分類の境界が線ではなく勾配になり、格子が消える。
 * 道路・田んぼ・オーバーレイのように「境界が意味を持つ」ものは平均から外す。
 *
 * **2. 地形分類しか見えない。** 実際の地面の色を決めているのは分類ではなく
 * 標高と傾斜で、急斜面はどんな分類でも土と岩が出る。
 * `groundColor()` に素材を混ぜさせて、分類はその入力の 1 つに格下げした。
 *
 * 水面は別レイヤ（`WaterLayer`）が持つ。地形メッシュ側は「水底」を描く役に回り、
 * 岸からの距離に応じて海底を掘り下げる。こうすると岸辺が自然に浅くなって、
 * 砂浜の帯と水の透けが噛み合う。
 */
export class TerrainMesh {
  readonly group = new Object3D();
  private readonly meshes: Mesh[] = [];
  private readonly seenEpoch = new Uint32Array(CHUNK_COUNT);
  /**
   * 地面は粗い拡散面。
   *
   * `envMapIntensity` を落としてあるのが要点。既定の 1 のままだと、
   * 低い視点で地面を見たときにフレネル反射で空の色が乗り、
   * 地平線に向かって草地が真っ白に飛ぶ（実際にそうなった）。
   * 土や草は本来ほとんど鏡面反射しないので、下げるのが物理的にも正しい。
   */
  private readonly material = surface({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.22,
  });
  /** 現在表示中のオーバーレイ。変わったら全チャンクを作り直す。 */
  private overlay: Overlay = Overlay.None;
  private lastSeason = -1;

  private readonly water = new WaterLayer();
  /** 水タイルの岸からの距離（海底を掘るのに使う）。 */
  private shoreDist: Uint8Array = new Uint8Array(0);
  /** 陸タイルの水辺までの距離（砂浜の帯を出すのに使う）。 */
  private beachDist: Uint8Array = new Uint8Array(0);
  /**
   * 水面を組んだときの地形配列。**エポックではなく配列の同一性で見る。**
   * セーブデータを読むと World ごと差し替わるが、そのときエポックは 0 に戻るので、
   * 数値で比べると「変わっていない」と誤判定して前の海岸線が残る。
   */
  private waterWorld: Uint8Array | null = null;

  /**
   * チャンク走査の再開位置。
   *
   * 以前は毎回 0 から走査していた。`invalidateAll()`（オーバーレイの更新や
   * イベントリングの溢れ）が 1 フレームに 1 回以上飛んでくると、
   * 毎フレーム先頭 8 チャンクだけを作り直して後半には永久に到達しない。
   * その結果、マップの大半のチャンクが「頂点が全部原点」のまま残り、
   * 視錐台カリングで消えて **地面に穴が空き、空が透けて見える**
   * （引きの画で地面の半分が真っ白な板に見えていた原因がこれ）。
   * 再開位置を持ち回せば、何度無効化されても全チャンクを順に踏める。
   */
  private scanCursor = 0;
  /** 初回だけは全チャンクを一気に作る。穴の空いた地面を 1 フレームでも見せないため。 */
  private primed = false;

  /** チャンク構築のための作業領域。毎回確保しないよう使い回す。 */
  private readonly tileColors = new Float32Array((CHUNK + 2) * (CHUNK + 2) * 3);
  private readonly tileHard = new Uint8Array((CHUNK + 2) * (CHUNK + 2));
  private readonly cornerH = new Float32Array((CHUNK + 3) * (CHUNK + 3));
  private readonly scratch = new Color();
  private readonly sunDir = new Vector3();

  constructor() {
    this.group.name = 'terrain';
    for (let c = 0; c < CHUNK_COUNT; c++) {
      const geom = new BufferGeometry();
      const tiles = CHUNK * CHUNK;
      geom.setAttribute('position', new BufferAttribute(new Float32Array(tiles * 4 * 3), 3));
      geom.setAttribute('normal', new BufferAttribute(new Float32Array(tiles * 4 * 3), 3));
      geom.setAttribute('color', new BufferAttribute(new Float32Array(tiles * 4 * 3), 3));
      const index = new Uint32Array(tiles * 6);
      for (let t = 0; t < tiles; t++) {
        const v = t * 4;
        const i = t * 6;
        index[i] = v;
        index[i + 1] = v + 2;
        index[i + 2] = v + 1;
        index[i + 3] = v;
        index[i + 4] = v + 3;
        index[i + 5] = v + 2;
      }
      geom.setIndex(new BufferAttribute(index, 1));
      const mesh = new Mesh(geom, this.material);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
      this.seenEpoch[c] = 0xffffffff; // 初回は必ず構築する
    }
    this.group.add(this.water.group);
  }

  setOverlay(o: Overlay): void {
    if (this.overlay === o) return;
    this.overlay = o;
    // 情報表示のときは水面を隠す。ヒートマップの上に波と映り込みが乗ると、
    // どの色がどの値なのかが読めなくなる。
    this.water.setVisible(o === Overlay.None);
    this.seenEpoch.fill(0xffffffff);
  }

  get currentOverlay(): Overlay {
    return this.overlay;
  }

  /** 変更のあったチャンクだけ再構築する。1 フレームあたりの上限を設けて処理時間を平準化する。 */
  update(sim: Simulation, maxChunksPerFrame = 8): void {
    // 水面は毎フレーム。色と波の位相を書き換えるだけ。
    const frac = sim.clock.dayFraction;
    this.water.update(atmosphereAt(frac), sunDirection(frac, this.sunDir), performance.now() * 0.001);

    // 距離場と水面のジオメトリは地形が変わったときだけ。地形は
    // 読み込み直後にしか変わらないので、実質 1 回きりの処理になる。
    if (this.waterWorld !== sim.world.terrain) {
      this.waterWorld = sim.world.terrain;
      this.shoreDist = computeShoreDistance(sim.world);
      this.beachDist = computeBeachDistance(sim.world);
      this.water.build(sim.world, this.shoreDist);
      this.seenEpoch.fill(0xffffffff);
      this.primed = false;
    }

    // 季節が変わると田んぼと草の色が変わるので全チャンクを対象にする
    const season = sim.clock.season;
    if (season !== this.lastSeason) {
      this.lastSeason = season;
      this.seenEpoch.fill(0xffffffff);
    }

    // 初回は全部作る。以降は 1 フレームの予算ぶんだけを、
    // 前回の続きから順に踏んでいく（先頭に戻らないのが肝）。
    const budget = this.primed ? maxChunksPerFrame : CHUNK_COUNT;
    let rebuilt = 0;
    for (let seen = 0; seen < CHUNK_COUNT && rebuilt < budget; seen++) {
      const c = this.scanCursor;
      this.scanCursor = (this.scanCursor + 1) % CHUNK_COUNT;
      if (this.seenEpoch[c] === sim.world.chunkEpoch[c]) continue;
      this.buildChunk(sim, c);
      this.seenEpoch[c] = sim.world.chunkEpoch[c]!;
      rebuilt++;
    }
    this.primed = true;
  }

  /**
   * オーバーレイ値の更新だけを反映させたいとき（毎日など）。
   *
   * ここで水面まで作り直さないのは、この呼び出しがイベントリングの
   * 溢れでも飛んでくるため。地形が変わっていないのに海岸線の距離場を
   * 何度も計算し直す理由が無い（水面の作り直しは配列の同一性で判定する）。
   */
  invalidateAll(): void {
    this.seenEpoch.fill(0xffffffff);
  }

  private buildChunk(sim: Simulation, chunk: number): void {
    const world = sim.world;
    const mesh = this.meshes[chunk]!;
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position') as BufferAttribute;
    const nrm = geom.getAttribute('normal') as BufferAttribute;
    const col = geom.getAttribute('color') as BufferAttribute;
    const P = pos.array as Float32Array;
    const N = nrm.array as Float32Array;
    const C = col.array as Float32Array;

    const ox = (chunk % CHUNKS_X) * CHUNK;
    const oy = ((chunk / CHUNKS_X) | 0) * CHUNK;
    const season = sim.clock.season;

    // --- 1 周目: チャンクの外側 1 枚を含めたタイル色を作る ---
    // 角の色は隣接タイルの平均なので、チャンクの端でも外側の色が要る。
    // ここで先に作っておかないと、チャンクの継ぎ目に線が出る。
    const W = CHUNK + 2;
    for (let ly = -1; ly <= CHUNK; ly++) {
      for (let lx = -1; lx <= CHUNK; lx++) {
        const s = (ly + 1) * W + (lx + 1);
        const x = ox + lx;
        const y = oy + ly;
        if (!inBounds(x, y)) {
          this.tileColors[s * 3] = 0.4;
          this.tileColors[s * 3 + 1] = 0.45;
          this.tileColors[s * 3 + 2] = 0.35;
          this.tileHard[s] = 1;
          continue;
        }
        const t = idx(x, y);
        const c = this.tileColor(sim, t, season);
        this.tileColors[s * 3] = c.r;
        this.tileColors[s * 3 + 1] = c.g;
        this.tileColors[s * 3 + 2] = c.b;
        this.tileHard[s] = this.isHard(sim, t) ? 1 : 0;
      }
    }

    // --- 2 周目: 角の高さを先に作る ---
    // 法線を角ごとに出すのに、隣の角の高さが要る。タイルごとに
    // 平均を取り直すと同じ計算を 16 回することになるので、表にしておく。
    const HW = CHUNK + 3;
    for (let ly = -1; ly <= CHUNK + 1; ly++) {
      for (let lx = -1; lx <= CHUNK + 1; lx++) {
        this.cornerH[(ly + 1) * HW + (lx + 1)] = this.cornerHeight(world, ox + lx, oy + ly);
      }
    }

    // --- 3 周目: 頂点を書き出す ---
    let v = 0;
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const s = (ly + 1) * W + (lx + 1);
        const hard = this.tileHard[s] === 1;
        const x0 = (ox + lx) * TILE_M;
        const z0 = (oy + ly) * TILE_M;
        const base = v * 3;

        // 角は北西・北東・南東・南西の順。索引の並びと合わせてある。
        const cs: [number, number][] = [
          [lx, ly],
          [lx + 1, ly],
          [lx + 1, ly + 1],
          [lx, ly + 1],
        ];
        for (let k = 0; k < 4; k++) {
          const [cxl, cyl] = cs[k]!;
          const h = this.cornerH[(cyl + 1) * HW + (cxl + 1)]!;
          const b = base + k * 3;
          P[b] = x0 + (k === 1 || k === 2 ? TILE_M : 0);
          P[b + 1] = h;
          P[b + 2] = z0 + (k === 2 || k === 3 ? TILE_M : 0);

          // 法線は角の高さの中央差分から。面法線をタイル全体に配ると
          // 四角形ごとに陰影が段になり、丘が「階段」に見える。
          const hx0 = this.cornerH[(cyl + 1) * HW + cxl]!;
          const hx1 = this.cornerH[(cyl + 1) * HW + (cxl + 2)]!;
          const hz0 = this.cornerH[cyl * HW + (cxl + 1)]!;
          const hz1 = this.cornerH[(cyl + 2) * HW + (cxl + 1)]!;
          const nx = hx0 - hx1;
          const nz = hz0 - hz1;
          const ny = 2 * TILE_M;
          const len = Math.hypot(nx, ny, nz);
          N[b] = nx / len;
          N[b + 1] = ny / len;
          N[b + 2] = nz / len;

          // 色。境界が意味を持つタイル（道路・田んぼ・オーバーレイ）は
          // 自分の色をそのまま使い、それ以外は角で平均して滑らかにつなぐ。
          let r: number;
          let g: number;
          let bl: number;
          if (hard) {
            r = this.tileColors[s * 3]!;
            g = this.tileColors[s * 3 + 1]!;
            bl = this.tileColors[s * 3 + 2]!;
          } else {
            let sr = 0;
            let sg = 0;
            let sb = 0;
            let n = 0;
            for (let dy = -1; dy <= 0; dy++) {
              for (let dx = -1; dx <= 0; dx++) {
                const q = (cyl + dy + 1) * W + (cxl + dx + 1);
                if (q < 0 || q >= this.tileHard.length || this.tileHard[q] === 1) continue;
                sr += this.tileColors[q * 3]!;
                sg += this.tileColors[q * 3 + 1]!;
                sb += this.tileColors[q * 3 + 2]!;
                n++;
              }
            }
            if (n === 0) {
              r = this.tileColors[s * 3]!;
              g = this.tileColors[s * 3 + 1]!;
              bl = this.tileColors[s * 3 + 2]!;
            } else {
              r = sr / n;
              g = sg / n;
              bl = sb / n;
            }
            // 角の座標で引いた連続ノイズ。隣のタイルは同じ角の値を共有するので、
            // ばらつきが市松にならずに、まだらな地面になる。
            // 明度だけでなく緑と赤の比も少し動かす。明度だけだと
            // 「同じ色の濃淡」にしかならず、草地の情報量が増えない。
            const nz = terrainNoise(ox + cxl, oy + cyl);
            const m = 1 + nz * 0.21;
            r *= m * (1 - nz * 0.05);
            g *= m;
            bl *= m * (1 + nz * 0.06);
          }
          C[b] = r;
          C[b + 1] = g;
          C[b + 2] = bl;
        }
        v += 4;
      }
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    col.needsUpdate = true;
    geom.computeBoundingSphere();
  }

  /** 隣接 4 タイルに淡水があるか（川岸の護岸を出すのに使う）。 */
  private nextToFresh(world: { terrain: Uint8Array }, t: number): boolean {
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(t, d);
      if (nb >= 0 && world.terrain[nb] === Terrain.Freshwater) return true;
    }
    return false;
  }

  /** 角で色を平均してはいけないタイルか（境界が情報を持っているもの）。 */
  private isHard(sim: Simulation, t: number): boolean {
    if (this.overlay !== Overlay.None) return true;
    const world = sim.world;
    if (world.road[t] !== RoadClass.None) return true;
    if (world.zone[t] === Zone.AgriPaddy) return true;
    return false;
  }

  private tileColor(sim: Simulation, t: number, season: number): Color {
    const world = sim.world;

    // オーバーレイ表示が最優先
    switch (this.overlay) {
      case Overlay.LandValue:
        return heatColor(world.landValue[t]! / 255);
      case Overlay.Pollution:
        return heatColor(world.pollution[t]! / 255);
      case Overlay.TransitAccess: {
        const a = world.transitAccess[t]!;
        return heatColor(a >= 255 ? 0 : 1 - a / 20);
      }
      case Overlay.Power:
      case Overlay.Water: {
        // 供給網の中かどうかと、余裕の度合い。
        // 0 は「網の外」で、青く塗ると街じゅうが水色になるので暗く落とす。
        const src = this.overlay === Overlay.Power ? sim.utilities.powerOverlay : sim.utilities.waterOverlay;
        const v = src[t]!;
        if (v === 0) return zoneColor(-1).setHex(0x1b2026);
        return heatColor(1 - v / 255);
      }
      case Overlay.Zone:
        if (world.zone[t] !== Zone.None) return zoneColor(world.zone[t]!);
        break;
      case Overlay.Traffic: {
        // 道路タイルの混雑度。車がどれだけリンクを埋めているかをそのまま出す。
        if (world.road[t] === RoadClass.None) return zoneColor(-1).setHex(0x1b2026);
        const node = sim.graph.roadNodeAt[t]!;
        if (node < 0) return heatColor(0);
        let worst = 0;
        const e1 = sim.graph.edgeStart[node + 1] ?? 0;
        for (let e = sim.graph.edgeStart[node] ?? 0; e < e1; e++) {
          worst = Math.max(worst, sim.traffic.occupancy(e));
          const rev = sim.graph.reverseEdge(e);
          if (rev >= 0) worst = Math.max(worst, sim.traffic.occupancy(rev));
        }
        return heatColor(worst);
      }
      default:
        break;
    }

    const terrain = world.terrain[t]!;
    const shore = this.beachDist.length > 0 ? this.beachDist[t]! : 255;

    // 水底。水面レイヤが上に乗るので、ここは「透けて見える底」を塗る。
    // 岸辺は砂、沖は暗い泥にすると、水の色と重なって深さが出る。
    if (terrain === Terrain.Sea || terrain === Terrain.Freshwater) {
      const d = Math.min(1, (this.shoreDist.length > 0 ? this.shoreDist[t]! : 0) / 5);
      return this.scratch.setHex(GROUND.sand).lerp(TMP.setHex(0x3a4038), d);
    }

    // 道路タイル。舗装は道路レイヤが実寸で敷くので、ここでは
    // その下と路肩に当たる「締まった土」を塗る。以前のように
    // 灰色で塗りつぶすと、舗装の外側にもう一回り広い灰色の帯が残る。
    if (world.road[t] !== RoadClass.None) {
      return this.scratch.setHex(0x54514a);
    }

    // 田んぼは季節で色が変わる。街の時間経過が一番わかりやすく伝わる要素。
    if (world.zone[t] === Zone.AgriPaddy) {
      return this.scratch.setHex(PADDY_WATER_SEASON[season] ?? PADDY_WATER_SEASON[Season.Summer]!);
    }

    // 素材を混ぜて地面の色を作る。分類・標高・傾斜・季節・水辺までの距離。
    // ノイズを渡しているのは、傾斜だけで岩を出すと平らな山頂が
    // 一面の同じ灰色になって巨大な板に見えるため。
    const n = terrainNoise((t % 320) * 0.55, ((t / 320) | 0) * 0.55);
    const c = groundColor(terrain, world.heightDm[t]!, world.slope[t]!, season, shore, n, this.scratch);

    // 川岸は砂浜ではなく玉石と護岸。日本の川はほぼ全部護岸されているので、
    // 海岸と同じ砂色にすると、内陸に唐突にビーチが現れる。
    if (shore <= 1 && this.nextToFresh(world, t)) {
      c.lerp(TMP.setHex(GROUND.gravel), 0.55).lerp(TMP.setHex(GROUND.revetment), 0.25);
    }

    // ゾーン指定済みで未建築の土地は、用途の色をうっすら混ぜる
    if (world.zone[t] !== Zone.None && world.buildingRef[t] === 0) {
      const z = zoneColor(world.zone[t]!, TMP);
      c.setRGB(c.r * 0.76 + z.r * 0.24, c.g * 0.76 + z.g * 0.24, c.b * 0.76 + z.b * 0.24);
    }
    return c;
  }

  /**
   * タイル格子の「角」の高さ。周囲 4 タイルの平均を取ることで、
   * 隣り合う四角形が同じ頂点高さを共有し、地面が連続した曲面になる。
   *
   * 水面下は「水底」を返す。岸から離れるほど深くすると、
   * 岸辺が自然に浅くなって砂浜が水の下に続いて見える。
   * 一律の深さにすると、汀線がそのまま崖になる。
   */
  private cornerHeight(
    world: { terrain: Uint8Array; heightDm: Uint16Array },
    cx: number,
    cy: number,
  ): number {
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(x, y)) continue;
        const t = idx(x, y);
        const kind = world.terrain[t]!;
        if (kind === Terrain.Sea) {
          const d = this.shoreDist.length > 0 ? Math.min(6, this.shoreDist[t]!) : 3;
          sum += SEA_LEVEL - 0.25 - d * 0.5;
        } else if (kind === Terrain.Freshwater) {
          // 川床。水面（heightDm - RIVER_SINK）よりさらに掘る。
          sum += world.heightDm[t]! * TERRAIN_HEIGHT_SCALE - RIVER_SINK - 0.9;
        } else {
          sum += world.heightDm[t]! * TERRAIN_HEIGHT_SCALE;
        }
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.water.dispose();
    this.material.dispose();
  }
}

const TMP = new Color();
