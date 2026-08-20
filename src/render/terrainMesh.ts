import { BufferAttribute, BufferGeometry, Mesh, MeshLambertMaterial, Object3D } from 'three';
import { CHUNK, CHUNKS_X, CHUNK_COUNT, TERRAIN_HEIGHT_SCALE, TILE_M } from '@shared/constants';
import { Overlay, RoadClass, Terrain, Zone } from '@shared/enums';
import type { Simulation } from '@sim/simulation';
import { idx, inBounds } from '@sim/world/tiles';
import { PADDY_SEASON_COLORS, ROAD_COLORS, TERRAIN_COLORS, heatColor, zoneColor } from './theme';

/**
 * 地形・道路・線路・ゾーンをまとめた地面メッシュ。
 *
 * 32×32 タイルのチャンクごとに 1 つの頂点カラー付きジオメトリを持ち、
 * 変更のあったチャンクだけを再構築する。全面再構築すると
 * 道路をドラッグするたびに 10 万タイル分のジオメトリを作り直すことになる。
 */
export class TerrainMesh {
  readonly group = new Object3D();
  private readonly meshes: Mesh[] = [];
  private readonly seenEpoch = new Uint32Array(CHUNK_COUNT);
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  /** 現在表示中のオーバーレイ。変わったら全チャンクを作り直す。 */
  private overlay: Overlay = Overlay.None;
  private lastSeason = -1;

  constructor() {
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
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
      this.seenEpoch[c] = 0xffffffff; // 初回は必ず構築する
    }
  }

  setOverlay(o: Overlay): void {
    if (this.overlay === o) return;
    this.overlay = o;
    this.seenEpoch.fill(0xffffffff);
  }

  get currentOverlay(): Overlay {
    return this.overlay;
  }

  /** 変更のあったチャンクだけ再構築する。1 フレームあたりの上限を設けて処理時間を平準化する。 */
  update(sim: Simulation, maxChunksPerFrame = 8): void {
    // 季節が変わると田んぼの色が変わるので全チャンクを対象にする
    const season = sim.clock.season;
    if (season !== this.lastSeason) {
      this.lastSeason = season;
      this.seenEpoch.fill(0xffffffff);
    }
    let rebuilt = 0;
    for (let c = 0; c < CHUNK_COUNT && rebuilt < maxChunksPerFrame; c++) {
      if (this.seenEpoch[c] === sim.world.chunkEpoch[c]) continue;
      this.buildChunk(sim, c);
      this.seenEpoch[c] = sim.world.chunkEpoch[c]!;
      rebuilt++;
    }
  }

  /** オーバーレイ値の更新だけを反映させたいとき（毎日など）。 */
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

    const cx = (chunk % CHUNKS_X) * CHUNK;
    const cy = ((chunk / CHUNKS_X) | 0) * CHUNK;
    const season = sim.clock.season;

    let v = 0;
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = cx + lx;
        const y = cy + ly;
        const t = idx(x, y);
        const x0 = x * TILE_M;
        const z0 = y * TILE_M;
        const x1 = x0 + TILE_M;
        const z1 = z0 + TILE_M;

        // 角の高さは周囲 4 タイルの平均。こうしないと隣り合うタイルの高さが違うたびに
        // 四角形の間に隙間が空き、地面じゅうに縦の裂け目が走って見える。
        const hNW = cornerHeight(world, x, y);
        const hNE = cornerHeight(world, x + 1, y);
        const hSE = cornerHeight(world, x + 1, y + 1);
        const hSW = cornerHeight(world, x, y + 1);

        const base = v * 3;
        P[base] = x0;
        P[base + 1] = hNW;
        P[base + 2] = z0;
        P[base + 3] = x1;
        P[base + 4] = hNE;
        P[base + 5] = z0;
        P[base + 6] = x1;
        P[base + 7] = hSE;
        P[base + 8] = z1;
        P[base + 9] = x0;
        P[base + 10] = hSW;
        P[base + 11] = z1;

        // 面法線（傾斜に応じた陰影がついて地形が読み取れるようになる）
        const nx = (hNW + hSW) / 2 - (hNE + hSE) / 2;
        const nz = (hNW + hNE) / 2 - (hSW + hSE) / 2;
        const len = Math.hypot(nx, TILE_M, nz);
        for (let k = 0; k < 4; k++) {
          N[base + k * 3] = nx / len;
          N[base + k * 3 + 1] = TILE_M / len;
          N[base + k * 3 + 2] = nz / len;
        }

        const c = this.tileColor(sim, t, season);
        for (let k = 0; k < 4; k++) {
          C[base + k * 3] = c.r;
          C[base + k * 3 + 1] = c.g;
          C[base + k * 3 + 2] = c.b;
        }
        v += 4;
      }
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    col.needsUpdate = true;
    geom.computeBoundingSphere();
  }

  private tileColor(sim: Simulation, t: number, season: number) {
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
        // 道路以外は暗く落とす（heatColor(0) は青なので、そのまま使うと
        // 街じゅうが水色に染まって道路の色が読めない）。
        if (world.road[t] === RoadClass.None) return zoneColor(-1).setHex(0x1b2026);
        const node = sim.graph.roadNodeAt[t]!;
        if (node < 0) return heatColor(0);
        let worst = 0;
        const e1 = sim.graph.edgeStart[node + 1] ?? 0;
        for (let e = sim.graph.edgeStart[node] ?? 0; e < e1; e++) {
          // 流出リンクの占有率と、そこへ入ってくるリンクの占有率の両方を見る。
          // 交差点で止まっている車列は流入側に溜まるので、片方だけでは赤くならない。
          worst = Math.max(worst, sim.traffic.occupancy(e));
          const rev = sim.graph.reverseEdge(e);
          if (rev >= 0) worst = Math.max(worst, sim.traffic.occupancy(rev));
        }
        return heatColor(worst);
      }
      default:
        break;
    }

    // 道路
    if (world.road[t] !== RoadClass.None) return zoneColor(-1).setHex(ROAD_COLORS[world.road[t]!]!);
    // 線路タイルは塗らない。以前はここで軌道敷の色（濃い茶）に塗りつぶしていたが、
    // 線路レイヤがバラストを実寸で敷くようになったので、そのままだと
    // 幅 4.6m のバラストの両脇に、幅 2.7m ずつの濃い茶色が残って
    // 「妙に広い土手」に見える。地面は地形の色のままにして、
    // 軌道はレイヤの造形だけで表す。

    // 田んぼは季節で色が変わる。街の時間経過が一番わかりやすく伝わる要素。
    if (world.zone[t] === Zone.AgriPaddy) return zoneColor(-1).setHex(PADDY_SEASON_COLORS[season]!);

    // ゾーン指定済みで未建築の土地は、用途の色をうっすら混ぜる
    if (world.zone[t] !== Zone.None && world.buildingRef[t] === 0) {
      const c = zoneColor(world.zone[t]!);
      const terr = TERRAIN_COLORS[world.terrain[t]!]!;
      const tr = ((terr >> 16) & 255) / 255;
      const tg = ((terr >> 8) & 255) / 255;
      const tb = (terr & 255) / 255;
      c.setRGB(c.r * 0.35 + tr * 0.65, c.g * 0.35 + tg * 0.65, c.b * 0.35 + tb * 0.65);
      return c;
    }

    return zoneColor(-1).setHex(TERRAIN_COLORS[world.terrain[t]!] ?? 0x808080);
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * タイル格子の「角」の高さ。周囲 4 タイルの平均を取ることで、
 * 隣り合う四角形が同じ頂点高さを共有し、地面が連続した曲面になる。
 */
function cornerHeight(world: { terrain: Uint8Array; heightDm: Uint16Array }, cx: number, cy: number): number {
  let sum = 0;
  let n = 0;
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(x, y)) continue;
      const t = idx(x, y);
      sum += world.terrain[t] === Terrain.Sea ? -1.5 : world.heightDm[t]! * TERRAIN_HEIGHT_SCALE;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}
