import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  Object3D,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { MAP_W, TERRAIN_HEIGHT_SCALE, TILE_COUNT, TILE_M } from '@shared/constants';
import { Terrain } from '@shared/enums';
import { idx, inBounds } from '@sim/world/tiles';
import type { Atmosphere } from './sky';

/**
 * 水面。
 *
 * これまで海と川は「地形メッシュの三角形を青く塗ったもの」だった。
 * 平らな青が地面と同じ材質で描かれているので、光の当たり方が土と同じになり、
 * どう見ても水に見えない。水が水に見えるのに要るのは、順に
 *
 *   1. **空の映り込み**（フレネル）。浅い角度で見た水面はほぼ鏡。
 *   2. **深さによる色の変化**。岸辺は明るい緑がかった色、沖は濃紺。
 *   3. **波**。法線を揺らすだけでいい。頂点を動かす必要はほとんど無い。
 *   4. **岸の泡**。水と陸の境界に白い縁があると、境界が「線」でなくなる。
 *
 * の 4 つで、どれも 1 枚のシェーダで足りる。ライトも影も要らない。
 *
 * ジオメトリは「水タイルの四角形」を 1 つのメッシュに集めたもの。
 * マップ全面の巨大な板 1 枚にしないのは、**岸からの距離を頂点属性として
 * 持たせたい**から。距離が頂点に入っていれば、深さも泡もフラグメントで
 * 何も探索せずに出せる。
 *
 * このレイヤは `TerrainMesh` が所有していて、地形と同じ再構築のきっかけで
 * 作り直される（地形が変わらない限り作り直さない）。
 */

/** 海面の高さ。地形メッシュの海底はこれより必ず下に来るようにしてある。 */
export const SEA_LEVEL = -0.5;
/** 川面を、その地点の地面の高さからどれだけ下げるか (m)。 */
export const RIVER_SINK = 0.55;
/** 「沖」とみなす岸からの距離（タイル）。これで深さの色を正規化する。 */
const DEEP_TILES = 7;

/**
 * 岸からの距離場。水タイルには「最も近い陸まで何タイルか」を、陸には 255 を入れる。
 *
 * 地形メッシュ側でも海底の深さを決めるのに使うので、ここで作って共有する。
 * 距離場が無いと、海底を一律の深さにするしかなく、岸辺が崖になる。
 */
export function computeShoreDistance(world: { terrain: Uint8Array }): Uint8Array {
  const dist = new Uint8Array(TILE_COUNT).fill(255);
  const queue = new Int32Array(TILE_COUNT);
  let head = 0;
  let tail = 0;
  const isWater = (t: number): boolean =>
    world.terrain[t] === Terrain.Sea || world.terrain[t] === Terrain.Freshwater;

  // 陸に接している水タイルを距離 0 として BFS を始める。
  for (let i = 0; i < TILE_COUNT; i++) {
    if (!isWater(i)) continue;
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    let edge = false;
    for (let k = 0; k < 4 && !edge; k++) {
      const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
      // マップの外は「陸ではない」扱い。端で泡が出ると額縁のように見える。
      if (!inBounds(nx, ny)) continue;
      if (!isWater(idx(nx, ny))) edge = true;
    }
    if (edge) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const d = dist[i]!;
    if (d >= DEEP_TILES + 2) continue;
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (!isWater(j) || dist[j]! <= d + 1) continue;
      dist[j] = d + 1;
      queue[tail++] = j;
    }
  }
  return dist;
}

/** 陸タイルから見た「水辺までの距離」。砂浜・護岸の帯を出すのに使う。 */
export function computeBeachDistance(world: { terrain: Uint8Array }): Uint8Array {
  const dist = new Uint8Array(TILE_COUNT).fill(255);
  const queue = new Int32Array(TILE_COUNT);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (world.terrain[i] === Terrain.Sea || world.terrain[i] === Terrain.Freshwater) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const d = dist[i]!;
    if (d >= 4) continue;
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = y + (k === 0 ? -1 : k === 2 ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (dist[j]! <= d + 1) continue;
      dist[j] = d + 1;
      queue[tail++] = j;
    }
  }
  return dist;
}

const VERT = /* glsl */ `
  attribute float aShore;
  attribute float aSea;
  varying float vShore;
  varying float vSea;
  varying vec3 vWorld;
  uniform float uTime;
  #include <fog_pars_vertex>

  void main() {
    vShore = aShore;
    vSea = aSea;
    vec3 p = position;
    // 大きなうねりだけを頂点で出す。細かい波は法線だけで足りるので、
    // ここで刻んでも三角形の数が要るばかりで見た目は良くならない。
    // 岸では振幅を 0 にして、波が陸に食い込まないようにする。
    float swell = sin(p.x * 0.035 + uTime * 0.5) * cos(p.z * 0.029 - uTime * 0.37);
    p.y += swell * 0.17 * vShore;
    vWorld = p;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  varying float vShore;
  varying float vSea;
  varying vec3 vWorld;

  uniform float uTime;
  uniform float uNight;
  uniform float uSunIntensity;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  #include <fog_pars_fragment>

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /**
   * 波の法線。3 方向の進行波の「勾配」を足すだけ。
   * 高さそのものは要らないので、微分だけを直接書いている。
   */
  vec3 waveNormal(vec2 p, float t, float detail) {
    // うねりの位相を、ゆっくり変化するノイズでずらす。
    // 純粋な正弦波を足しただけだと必ず一定周期の畝が出て、
    // 水面ではなくコーデュロイの布に見える（実際にそうなった）。
    float warp = vnoise(p * 0.011) * 6.283;
    vec2 g = vec2(0.0);
    vec2 d1 = normalize(vec2(1.0, 0.42));
    vec2 d2 = normalize(vec2(-0.65, 1.0));
    vec2 d3 = normalize(vec2(0.3, -1.0));
    g += d1 * 0.026 * cos(dot(p, d1) * 0.19 + warp + t * 0.8);
    g += d2 * 0.019 * cos(dot(p, d2) * 0.41 - warp * 0.7 - t * 1.15);
    // 細かい波は近景でしか意味が無いので、遠くでは畳んでしまう。
    g += d3 * 0.012 * detail * cos(dot(p, d3) * 0.95 + t * 1.8);
    return normalize(vec3(-g.x, 1.0, -g.y));
  }

  void main() {
    // 遠いほど細かい波を消す。ミップマップの無い手続きノイズは
    // これをやらないと必ずモアレになる。
    float dist = length(cameraPosition - vWorld);
    float detail = 1.0 - smoothstep(120.0, 600.0, dist);
    vec3 N = waveNormal(vWorld.xz, uTime, detail);
    vec3 V = normalize(cameraPosition - vWorld);

    // フレネル。浅い角度ほど鏡になる。これが無い水は「青い床」にしかならない。
    float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.5);
    f = mix(0.035, 1.0, f);

    // 映り込む空。反射ベクトルの仰角で天頂色と地平色を混ぜる。
    // 本物の環境マップを引かなくても、空が 2 色のグラデーションである以上
    // これでほとんど同じ絵になる。
    vec3 R = reflect(-V, N);
    vec3 sky = mix(uHorizon, uZenith, clamp(R.y * 1.4, 0.0, 1.0));

    // 水そのものの色。岸辺は底が透けて明るく、沖は濃い。
    float depth = smoothstep(0.0, 0.5, vShore);
    vec3 body = mix(uShallow, uDeep, depth);

    vec3 col = mix(body, sky, f * 0.88);

    // 太陽（夜は月）の照り返し。1 点だけ強く光ると、水面が動いて見える。
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 180.0);
    col += uSunColor * spec * uSunIntensity * 1.8;

    // 岸の泡。距離だけで出すと縁取りになるので、ノイズで食い込ませて崩す。
    //
    // 泡は**海だけ**に出す。川は幅が 1〜2 タイルしかないので、
    // 岸からの距離で出すと川床から水面まで一面が真っ白になり、
    // 遠景で川が雪の帯に見える（実際にそうなった）。
    float band = (1.0 - smoothstep(0.0, 0.17, vShore)) * vSea;
    float n = vnoise(vWorld.xz * 0.30 + vec2(uTime * 0.45, -uTime * 0.26));
    float foam = smoothstep(0.42, 0.82, band * 0.75 + n * 0.55 * band);
    col = mix(col, vec3(0.90, 0.94, 0.95), foam * 0.85);

    // 夜。真っ暗にはせず、空の映り込みだけを残す。
    col *= mix(1.0, 0.32, uNight);

    // 浅いところは底が透ける。岸辺の砂が見えると「水際」が読める。
    // 透かしすぎると汀線が霞んで、水と砂の間が一面の白い靄になる。
    float alpha = mix(0.74, 0.99, smoothstep(0.0, 0.22, vShore));
    alpha = max(alpha, foam * 0.9);

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class WaterLayer {
  readonly group = new Object3D();
  private readonly material: ShaderMaterial;
  private mesh: Mesh | null = null;
  private readonly shallow = new Color();
  private readonly deep = new Color();

  constructor() {
    this.group.name = 'water';
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uNight: { value: 0 },
          uSunIntensity: { value: 1 },
          uShallow: { value: new Color(0x4d8a92) },
          uDeep: { value: new Color(0x16354f) },
          uZenith: { value: new Color(0x2a68b8) },
          uHorizon: { value: new Color(0xcadbe8) },
          uSunColor: { value: new Color(0xfff6e8) },
          uSunDir: { value: new Vector3(0, 1, 0) },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // 水面より下に沈んだ地形（海底）が見えるので、裏面は描かなくてよい。
      // ただし川では水面より高い岸を横から覗くことがあるので両面にする。
      side: DoubleSide,
      depthWrite: false,
      fog: true,
    });
  }

  /**
   * 水タイルからジオメトリを組む。
   *
   * 頂点は各タイル 4 つ。角の高さと岸距離は、その角に接する 4 タイルの平均を取る。
   * 平均を取らないと、隣り合うタイルで水面の高さが食い違って裂け目が走る
   * （地形メッシュが同じ理由で `cornerHeight` を平均しているのと同じ話）。
   */
  build(world: { terrain: Uint8Array; heightDm: Uint16Array }, shore: Uint8Array): void {
    const tiles: number[] = [];
    for (let i = 0; i < TILE_COUNT; i++) {
      const t = world.terrain[i]!;
      if (t === Terrain.Sea || t === Terrain.Freshwater) tiles.push(i);
    }
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (tiles.length === 0) return;

    const n = tiles.length;
    const pos = new Float32Array(n * 4 * 3);
    const sh = new Float32Array(n * 4);
    const sea = new Float32Array(n * 4);
    const index = new Uint32Array(n * 6);

    for (let k = 0; k < n; k++) {
      const i = tiles[k]!;
      const isSea = world.terrain[i] === Terrain.Sea ? 1 : 0;
      const x = i % MAP_W;
      const y = (i / MAP_W) | 0;
      const x0 = x * TILE_M;
      const z0 = y * TILE_M;
      const v = k * 4;
      const corners: [number, number][] = [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1],
      ];
      const xs = [x0, x0 + TILE_M, x0 + TILE_M, x0];
      const zs = [z0, z0, z0 + TILE_M, z0 + TILE_M];
      for (let c = 0; c < 4; c++) {
        const [cxi, cyi] = corners[c]!;
        const s = cornerSurface(world, shore, cxi, cyi);
        const b = (v + c) * 3;
        pos[b] = xs[c]!;
        pos[b + 1] = s.y;
        pos[b + 2] = zs[c]!;
        sh[v + c] = s.shore;
        sea[v + c] = isSea;
      }
      const o = k * 6;
      index[o] = v;
      index[o + 1] = v + 2;
      index[o + 2] = v + 1;
      index[o + 3] = v;
      index[o + 4] = v + 3;
      index[o + 5] = v + 2;
    }

    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(pos, 3));
    geom.setAttribute('aShore', new BufferAttribute(sh, 1));
    geom.setAttribute('aSea', new BufferAttribute(sea, 1));
    geom.setIndex(new BufferAttribute(index, 1));
    geom.computeBoundingSphere();
    const mesh = new Mesh(geom, this.material);
    // 水は不透明なものの後に描く。加えて、道路の光の板より先。
    mesh.renderOrder = 2;
    mesh.frustumCulled = true;
    // 影を落とすと水面の波で地面に縞が出るだけなので受けも落としもしない。
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  /** 時刻に応じて水の色と光を合わせる。毎フレーム呼ぶ（uniform を数個書くだけ）。 */
  update(atmo: Atmosphere, sunDir: Vector3, timeSec: number): void {
    const u = this.material.uniforms;
    u.uTime!.value = timeSec;
    u.uNight!.value = atmo.nightAmount;
    u.uSunIntensity!.value = atmo.sunIntensity;
    (u.uZenith!.value as Color).copy(atmo.zenith);
    (u.uHorizon!.value as Color).copy(atmo.horizon);
    (u.uSunColor!.value as Color).copy(atmo.sunColor);
    (u.uSunDir!.value as Vector3).copy(sunDir);
    // 水そのものの色も時刻で動かす。昼は緑がかった青、夕方は空の色を吸って
    // 紫に寄る。空だけが変わって水が変わらないと、途端に書き割りに見える。
    this.shallow.setHex(0x3d8288).lerp(atmo.horizon, 0.18 * (1 - atmo.nightAmount) + 0.06);
    this.deep.setHex(0x122b41).lerp(atmo.zenith, 0.2);
    (u.uShallow!.value as Color).copy(this.shallow);
    (u.uDeep!.value as Color).copy(this.deep);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    if (this.mesh) this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * タイル格子の「角」における水面の高さと岸距離。
 *
 * 角に接する 4 タイルのうち水タイルだけを平均する。陸を混ぜると
 * 岸辺で水面が持ち上がって、陸に水が乗り上げたように見える。
 */
function cornerSurface(
  world: { terrain: Uint8Array; heightDm: Uint16Array },
  shore: Uint8Array,
  cx: number,
  cy: number,
): { y: number; shore: number } {
  let sumY = 0;
  let sumS = 0;
  let n = 0;
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(x, y)) continue;
      const t = idx(x, y);
      const kind = world.terrain[t]!;
      if (kind !== Terrain.Sea && kind !== Terrain.Freshwater) continue;
      sumY +=
        kind === Terrain.Sea ? SEA_LEVEL : world.heightDm[t]! * TERRAIN_HEIGHT_SCALE - RIVER_SINK;
      sumS += Math.min(DEEP_TILES, shore[t]!) / DEEP_TILES;
      n++;
    }
  }
  if (n === 0) return { y: SEA_LEVEL, shore: 0 };
  return { y: sumY / n, shore: sumS / n };
}
