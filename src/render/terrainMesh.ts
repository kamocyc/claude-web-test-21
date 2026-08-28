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
  terrainNoise2,
  valueNoise,
} from './groundPalette';
import { applySurfaceNoise } from './surfaceNoise';
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
    // 近距離のディテール。頂点は 1 タイル 10m 刻みなので、頂点カラーで作れる
    // むらは最小でも 10m ある。目線の高さで足元を見ると、その 10m のむらは
    // 画面いっぱいに引き伸ばされて「巨大なグラデーションの板」になる。
    // 世界座標のノイズを材質に差し込んで、1〜2m の粒を近くだけ重ねる。
    applySurfaceNoise(this.material, {
      scale: 2.8,
      color: 0.11,
      roughness: 0.06,
      bump: 0.035,
      fade: 220,
      // 地面も上を向いた広い面なので、遮蔽の無い環境マップの鏡面が
      // 視線が寝るほど乗ってくる。引きの画で郊外一面が「白っぽい単色の
      // オリーブ」に見えていたのは、素材の差がこの映り込みで潰れていたから。
      // 草地は実際にもほとんど鏡面反射を持たない。
      specular: 0.3,
    });
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
            // 明度だけでなく色相も動かす。明度だけだと「同じ色の濃淡」に
            // しかならず、草地の情報量が増えない。
            //
            // 動かす向きが肝で、**明るいところほど暖色（枯れて乾いた側）**に
            // 寄せる。以前は逆に青を足していたので、明るいところが青白く
            // なり「褪せた 1 色」に見えていた。実際の草地は、日の当たる乾いた
            // 場所ほど明るく黄土色に、水の残る日陰ほど暗く青緑になる。
            // 明度と色相が同じ向きに動くと、霞の掛かる遠景でも差が残る。
            const nz = terrainNoise(ox + cxl, oy + cyl);
            // 中周波のむら（1 周期 5 タイル ＝ 50m）を 1 本足す。
            // `terrainNoise` は 300m と 90m の 2 本しか持っておらず、
            // 俯瞰の 1 カットに入るのはせいぜい 1〜2 山。実測すると
            // 郊外の草地は端から端まで**単調なグラデーション 1 枚**で、
            // 「起伏も色の差も無い単一のオリーブ」と読まれたのはこれが原因だった。
            // 50m は俯瞰でも 30〜40px あるのでちらつかず、
            // 「田や原の区切りくらいの色ムラ」として読める。
            const nm = valueNoise((ox + cxl) * 0.2 + 41.5, (oy + cyl) * 0.2 - 17.9) - 0.5;
            const nt = nz + nm * 0.9;
            const m = 1 + nt * 0.28;
            r *= m * (1 + nt * 0.075);
            g *= m;
            bl *= m * (1 - nt * 0.095);
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

  /** 隣接 4 タイルに建物があるか（敷地際の地面を草のままにしないため）。 */
  private nextToBuilt(world: { buildingRef: Uint32Array }, t: number): boolean {
    for (let d = 0; d < 4; d++) {
      const nb = neighbor(t, d);
      if (nb >= 0 && world.buildingRef[nb] !== 0) return true;
    }
    return false;
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
    const tx = t % 320;
    const ty = (t / 320) | 0;
    const n = terrainNoise(tx * 0.55, ty * 0.55);
    // 2 本目のノイズは「乾湿」を決める。素材の比率が場所で変わることで、
    // 引きの画でも平野が単色にならない。
    const n2 = terrainNoise2(tx, ty);
    const c = groundColor(
      terrain,
      world.heightDm[t]!,
      world.slope[t]!,
      season,
      shore,
      n,
      this.scratch,
      n2,
    );

    // 川岸は砂浜ではなく玉石と護岸。日本の川はほぼ全部護岸されているので、
    // 海岸と同じ砂色にすると、内陸に唐突にビーチが現れる。
    if (shore <= 1 && this.nextToFresh(world, t)) {
      c.lerp(TMP.setHex(GROUND.gravel), 0.55).lerp(TMP.setHex(GROUND.revetment), 0.25);
    }

    /**
     * 宅地の地面。
     *
     * ここは作り直した。以前は「用途地域を指定して未建築のタイル」に
     * 用途の色（鮮やかな黄緑など）を 24% 混ぜていた。その結果、街区の中の
     * 空き地が彩度の高い四角として露出し、絵ではなく**区画データの可視化**に
     * 見えていた。さらに建物の載ったタイルには何もしていなかったので、
     * 建物と歩道の間に**草地の帯**が残り、目線のカットで
     * 「建物際に不自然な黄緑の帯が走っている」と読まれていた。
     *
     * 用途の色を使うのはやめ、周りの地面と同系の「草を刈って踏み固めた土」に
     * 寄せる。寄せ具合は 3 段階。
     *   建物が載っている  … 建物際は土間コンか砂利。いちばん強く。
     *   用途地域だけある  … 更地。半分ほど。
     *   建物の隣          … 庭・通路・裏の空き地。弱く。
     * 混ぜ具合と明度をタイルのハッシュで散らすので、隣り合う敷地が
     * 別々の土地に見える。
     */
    const zone = world.zone[t]!;
    const built = world.buildingRef[t] !== 0;
    const urban = built || (zone >= Zone.ResidentialLow && zone <= Zone.IndustrialHeavy);
    if (urban) {
      // 商業・工業の構内はほぼ全面が舗装、低層住居は土と庭が残る。
      // 素材を用途で切り替えるのが肝。同じ土色で明度だけ変えていたときは、
      // 市街地が丸ごと 1 枚の茶色い厚紙に見えていた。
      const paved = zone >= Zone.CommercialLocal && zone <= Zone.IndustrialHeavy;
      const base = built ? (paved ? 0.82 : 0.66) : paved ? 0.56 : 0.34;
      c.lerp(TMP.setHex(paved ? GROUND.lotPaved : GROUND.lotBare), base);

      /**
       * 敷地ごとのばらつき。
       *
       * ここはタイルのハッシュ（`t * 2654435761`）でやってはいけなかった。
       * 地面の頂点カラーは**角で 4 タイルを平均している**ので、
       * 1 タイルごとに独立した値はその平均でほぼ打ち消し合い、
       * 街区全体が平らな 1 色に均されてしまう（実際そうなっていた）。
       * 連続ノイズなら隣同士が相関しているので平均しても生き残り、
       * 「敷地ごとに舗装の打ち替え時期が違う」ムラとして読める。
       */
      const nx = tx * 0.42;
      const ny = ty * 0.42;
      const lot = terrainNoise2(nx, ny);
      c.lerp(TMP.setHex(GROUND.lotStain), Math.max(0, lot) * 0.34);
      c.multiplyScalar((built ? 0.86 : 0.95) + terrainNoise(nx + 51.7, ny - 8.3) * 0.14);
    } else if (zone === Zone.None && this.nextToBuilt(world, t)) {
      // 敷地の裏の空き地。草のままだと建物際に緑の帯が走るので、土に寄せる。
      c.lerp(TMP.setHex(GROUND.lotBare), 0.3);
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

