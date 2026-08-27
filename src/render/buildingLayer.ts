import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { TERRAIN_HEIGHT_SCALE, TILE_M } from '@shared/constants';
import { archetype } from '@sim/buildings/archetypes';
import type { Simulation } from '@sim/simulation';
import { tileX, tileY } from '@sim/world/tiles';
import { RoofKind, meshStyle } from './theme';

/**
 * 建物の描画。形状キーごとに InstancedMesh を 1 つ持つ。
 * 建物が数千あってもドローコールは形状の種類数（数十）で済む。
 *
 * インスタンス行列の書き込みは「建物の増減があったとき」だけ。
 * 毎フレーム全建物を走査すると、それだけでフレーム予算を使い切る。
 *
 * 箱 1 つでは街に見えないので、上に 3 つ足してある:
 * 屋根（切妻・寄棟・陸屋根）、立面の窓の帯、そして夜に灯る窓。
 * どれも「部品ごとに 1 メッシュ」の作りを崩さないので、
 * ドローコールは 3 増えるだけで済む。
 */

/** 窓の帯を出す最低の高さ (m)。平屋に帯を入れると横縞のプレハブに見える。 */
const WINDOW_MIN_HEIGHT = 11;
/** 1 棟あたりの窓の帯の最大本数。高層でも増やしすぎない。 */
const MAX_WINDOW_BANDS = 7;
const WINDOW_COLOR = 0x3d4750;
/** 夜に灯る窓の色。ライトの影響を受けない材質で描くので、暗い中でも光って見える。 */
const WINDOW_LIT_COLOR = 0xffd98a;
/** 鳥居の朱色。 */
const TORII_COLOR = 0xc0392b;
/** 駅のホーム上屋。 */
const CANOPY_COLOR = 0xb9c0c8;
/** 夜とみなす時間帯（1 日 0..1）。 */
const NIGHT_FROM = 17.5 / 24;
const NIGHT_TO = 5.5 / 24;

/**
 * 切妻屋根。単位サイズ（幅 1・高さ 1・奥行 1、底面 y=0）で、棟は X 方向に通る。
 * 建物の長辺に棟を合わせたいので、向きは呼び出し側で 90 度回す。
 */
function gableGeometry(): BufferGeometry {
  const a = [-0.5, 0, -0.5];
  const b = [0.5, 0, -0.5];
  const c = [0.5, 0, 0.5];
  const d = [-0.5, 0, 0.5];
  const r0 = [-0.5, 1, 0];
  const r1 = [0.5, 1, 0];
  const tris = [
    // 北側の流れ
    a, r0, r1,
    a, r1, b,
    // 南側の流れ
    d, c, r1,
    d, r1, r0,
    // 妻side（三角形の壁）
    a, d, r0,
    b, r1, c,
  ];
  const pos = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    pos[i * 3] = tris[i]![0]!;
    pos[i * 3 + 1] = tris[i]![1]!;
    pos[i * 3 + 2] = tris[i]![2]!;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return geom;
}

/** 屋根の形ごとのジオメトリ。単位サイズ・底面 y=0 という規約は本体と共通。 */
function roofGeometry(kind: RoofKind): BufferGeometry | null {
  if (kind === RoofKind.Gable) return gableGeometry();
  if (kind === RoofKind.Hip) {
    // 4 角錐 = 寄棟（方形）。回転させて軒の向きを揃える。
    const g = new ConeGeometry(0.72, 1, 4);
    g.rotateY(Math.PI / 4);
    g.translate(0, 0.5, 0);
    return g;
  }
  if (kind === RoofKind.Flat) {
    // 陸屋根はパラペット（立ち上がり）を回す。本体より少し広げると、
    // 屋上の縁が線として出て、平らな箱が建物に見える。
    const g = new BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
    return g;
  }
  return null;
}

export class BuildingLayer {
  readonly group = new Object3D();
  private readonly bodies = new Map<string, InstancedMesh>();
  private readonly roofs = new Map<string, InstancedMesh>();
  private windows: InstancedMesh;
  private windowsLit: InstancedMesh;
  /** 目印になる建物だけに付ける小物（鳥居・駅のホーム上屋）。数が少ないので 1 本にまとめる。 */
  private props: InstancedMesh;
  private propCapacity = 512;
  private windowCapacity = 0;
  private lastEpoch = -1;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();

  constructor() {
    this.group.name = 'buildings';
    this.windows = this.makeWindowMesh(1, false);
    this.windowsLit = this.makeWindowMesh(1, true);
    this.props = this.makePropMesh();
  }

  private makePropMesh(): InstancedMesh {
    const geom = new BoxGeometry(1, 1, 1);
    geom.translate(0, 0.5, 0);
    const mesh = new InstancedMesh(geom, new MeshLambertMaterial({}), this.propCapacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * 鳥居。神社は箱と屋根だけだと「赤い小屋」にしか見えないが、
   * 鳥居が 1 つ立つだけで何の建物か一目で分かるようになる。
   */
  private placeTorii(index: number, cx: number, cz: number, gy: number, w: number): number {
    const span = Math.min(6.5, w * 0.62);
    const h = 5.4;
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
      this.pos.set(x, y, z);
      this.scl.set(sx, sy, sz);
      this.quat.identity();
      this.mat.compose(this.pos, this.quat, this.scl);
      this.props.setMatrixAt(index, this.mat);
      this.color.setHex(TORII_COLOR);
      this.props.setColorAt(index, this.color);
      index++;
    };
    const front = cz + w * 0.72;
    put(cx - span / 2, gy, front, 0.5, h, 0.5); // 柱
    put(cx + span / 2, gy, front, 0.5, h, 0.5);
    put(cx, gy + h, front, span * 1.35, 0.55, 0.85); // 笠木
    put(cx, gy + h * 0.76, front, span * 1.05, 0.4, 0.6); // 貫
    return index;
  }

  private makeWindowMesh(count: number, lit: boolean): InstancedMesh {
    const geom = new BoxGeometry(1, 1, 1);
    geom.translate(0, 0.5, 0);
    // 灯りはライティングを受けない材質にする。Lambert で描くと、
    // 太陽が沈んだ時点で窓も一緒に暗くなって「灯り」にならない。
    const material = lit
      ? new MeshBasicMaterial({ color: WINDOW_LIT_COLOR })
      : new MeshLambertMaterial({ color: WINDOW_COLOR });
    const mesh = new InstancedMesh(geom, material, count);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = !lit;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * その形状キーのメッシュを、必要な本数を収められる大きさで用意する。
   *
   * 以前は「街の全建物数」を全形状キーに一律で配っていた。形状キーは 24 種類
   * あるので、建物 1 万棟の街では使われないインスタンス枠が数十 MB ぶん
   * GPU に載る。キーごとに実際の棟数で確保すれば、その無駄が消える。
   */
  private ensureMesh(key: string, need: number): { body: InstancedMesh; roof: InstancedMesh | null } {
    const style = meshStyle(key);
    let body = this.bodies.get(key);
    if (!body || body.instanceMatrix.count < need) {
      if (body) this.destroy(body);
      // vertexColors は付けない。InstancedMesh の setColorAt は instanceColor に書き込み、
      // three.js は USE_INSTANCING_COLOR として別に扱う。vertexColors:true にすると
      // geometry の color 属性（存在しない）も掛けようとして全部真っ黒になる。
      const geom = new BoxGeometry(1, 1, 1);
      geom.translate(0, 0.5, 0); // 単位ボックス（底面が y=0）
      body = new InstancedMesh(geom, new MeshLambertMaterial({}), Math.max(16, need * 2));
      body.count = 0;
      body.frustumCulled = false;
      this.bodies.set(key, body);
      this.group.add(body);
    }

    let roof = this.roofs.get(key) ?? null;
    const wantRoof = style.roofKind !== RoofKind.None;
    if (wantRoof && (!roof || roof.instanceMatrix.count < need)) {
      if (roof) this.destroy(roof);
      const geom = roofGeometry(style.roofKind)!;
      roof = new InstancedMesh(geom, new MeshLambertMaterial({}), Math.max(16, need * 2));
      roof.count = 0;
      roof.frustumCulled = false;
      this.roofs.set(key, roof);
      this.group.add(roof);
    }
    return { body, roof: wantRoof ? roof : null };
  }

  /**
   * インスタンス群を捨てる。
   * `InstancedMesh.dispose()` は three r0.171 では morphTexture しか解放しないので、
   * ジオメトリとマテリアルは明示的に捨てないと、街が育つたびに漏れ続ける。
   */
  private destroy(mesh: InstancedMesh): void {
    this.group.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as MeshLambertMaterial | MeshBasicMaterial).dispose();
    mesh.dispose();
  }

  /**
   * 次の update で必ず作り直させる。
   * セーブデータを読み込んだときのように、エポックが「進まずに変わる」場合に使う。
   */
  invalidate(): void {
    this.lastEpoch = -1;
  }

  /** 夜になったら窓を灯す。位置は update で決まっているので、ここは表示の切り替えだけ。 */
  setTimeOfDay(dayFraction: number): void {
    const night = dayFraction >= NIGHT_FROM || dayFraction < NIGHT_TO;
    this.windows.visible = !night;
    this.windowsLit.visible = night;
  }

  /** 建物の増減があったときだけインスタンスを作り直す。 */
  update(sim: Simulation): void {
    if (sim.world.epochs.buildings === this.lastEpoch) return;
    this.lastEpoch = sim.world.epochs.buildings;

    const counts = new Map<string, number>();
    const b = sim.buildings;

    // 形状キーごとの棟数を先に数える。確保はキー単位で行う。
    const need = new Map<string, number>();
    let windowsNeeded = 0;
    for (const slot of b.each()) {
      const a = archetype(b.archetypeId[slot]!);
      need.set(a.mesh, (need.get(a.mesh) ?? 0) + 1);
      windowsNeeded += this.bandCount(a.mesh, b.level[slot]!);
    }
    for (const [key, n] of need) this.ensureMesh(key, n);
    if (windowsNeeded > this.windowCapacity) {
      this.windowCapacity = Math.max(1024, windowsNeeded * 2);
      this.destroy(this.windows);
      this.destroy(this.windowsLit);
      this.windows = this.makeWindowMesh(this.windowCapacity, false);
      this.windowsLit = this.makeWindowMesh(this.windowCapacity, true);
    }

    for (const mesh of this.bodies.values()) mesh.count = 0;
    for (const mesh of this.roofs.values()) mesh.count = 0;
    let win = 0;
    let lit = 0;
    let prop = 0;

    for (const slot of b.each()) {
      const a = archetype(b.archetypeId[slot]!);
      const style = meshStyle(a.mesh);
      const { body, roof } = this.ensureMesh(a.mesh, need.get(a.mesh) ?? 1);

      const level = b.level[slot]!;
      const origin = b.originTile[slot]!;
      const ox = tileX(origin);
      const oy = tileY(origin);
      const w = a.w * TILE_M * style.inset;
      const d = a.h * TILE_M * style.inset;
      const height = style.baseHeight + style.perLevel * (level - 1);
      const groundY = sim.world.heightDm[origin]! * TERRAIN_HEIGHT_SCALE;

      const cxw = (ox + a.w / 2) * TILE_M;
      const czw = (oy + a.h / 2) * TILE_M;

      // 本体
      this.pos.set(cxw, groundY, czw);
      this.scl.set(w, height, d);
      this.quat.identity();
      this.mat.compose(this.pos, this.quat, this.scl);
      const bi = counts.get(a.mesh + ':b') ?? 0;
      body.setMatrixAt(bi, this.mat);
      // 同じ形でも 1 棟ずつ僅かに色を変えて、のっぺり感を消す
      const jitter = ((slot * 2654435761) % 1000) / 1000;
      this.color.setHex(style.color);
      this.color.offsetHSL(0, 0, (jitter - 0.5) * 0.09);
      body.setColorAt(bi, this.color);
      counts.set(a.mesh + ':b', bi + 1);
      body.count = bi + 1;

      // 屋根
      if (roof) {
        this.placeRoof(roof, counts, a.mesh, style.roofKind, cxw, czw, groundY + height, w, d, height);
        this.color.setHex(style.roofColor);
        roof.setColorAt((counts.get(a.mesh + ':r') ?? 1) - 1, this.color);
      }

      // 窓の帯。等間隔に入れるだけで階数が読めるようになり、
      // 同じ高さの箱が並んでいても「何階建てか」で見分けが付く。
      const bands = this.bandCount(a.mesh, level);
      for (let k = 0; k < bands && win < this.windowCapacity; k++) {
        const t = (k + 1) / (bands + 1);
        this.pos.set(cxw, groundY + height * t - 0.6, czw);
        this.scl.set(w * 1.012, 1.2, d * 1.012);
        this.quat.identity();
        this.mat.compose(this.pos, this.quat, this.scl);
        this.windows.setMatrixAt(win, this.mat);
        win++;
        // 夜は全部の階が灯るわけではない。全灯させると街が均一に光って
        // 「光る箱」の集合になるので、棟と階でばらす。
        const litHash = ((slot * 2654435761) >>> 0) + k * 97;
        if (litHash % 100 < 62 && lit < this.windowCapacity) {
          this.windowsLit.setMatrixAt(lit, this.mat);
          lit++;
        }
      }

      // 目印の小物
      if (prop + 4 <= this.propCapacity) {
        if (a.mesh === 'shrine') {
          prop = this.placeTorii(prop, cxw, czw, groundY, w);
        } else if (a.mesh === 'station') {
          // ホームの上屋。駅本体より広く薄い庇を張り出すと、
          // 「屋根の下にホームがある」ことが遠目にも分かる。
          this.pos.set(cxw, groundY + height * 0.86, czw);
          this.scl.set(w * 1.5, 0.5, d * 1.1);
          this.quat.identity();
          this.mat.compose(this.pos, this.quat, this.scl);
          this.props.setMatrixAt(prop, this.mat);
          this.color.setHex(CANOPY_COLOR);
          this.props.setColorAt(prop, this.color);
          prop++;
        }
      }
    }

    this.windows.count = win;
    this.windowsLit.count = lit;
    this.props.count = prop;

    for (const mesh of [
      ...this.bodies.values(),
      ...this.roofs.values(),
      this.windows,
      this.windowsLit,
      this.props,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** その建物に入れる窓の帯の本数。 */
  private bandCount(meshKey: string, level: number): number {
    const style = meshStyle(meshKey);
    const height = style.baseHeight + style.perLevel * (level - 1);
    if (height < WINDOW_MIN_HEIGHT) return 0;
    return Math.min(MAX_WINDOW_BANDS, Math.max(1, Math.round(height / 9)));
  }

  private placeRoof(
    roof: InstancedMesh,
    counts: Map<string, number>,
    meshKey: string,
    kind: RoofKind,
    cx: number,
    cz: number,
    topY: number,
    w: number,
    d: number,
    height: number,
  ): void {
    if (kind === RoofKind.Flat) {
      // パラペットは低く、本体より僅かに広く。
      this.pos.set(cx, topY, cz);
      this.scl.set(w * 1.05, 0.9, d * 1.05);
      this.quat.identity();
    } else {
      const roofH = Math.min(5.5, Math.max(2.2, height * 0.42));
      this.pos.set(cx, topY, cz);
      if (kind === RoofKind.Gable) {
        // 棟は長辺に沿わせる。短辺に通すと、細長い家に不自然な三角形が載る。
        const alongX = w >= d;
        this.scl.set(alongX ? w * 1.16 : d * 1.16, roofH, alongX ? d * 1.16 : w * 1.16);
        this.quat.setFromAxisAngle(this.axisY, alongX ? 0 : Math.PI / 2);
      } else {
        this.scl.set(w * 1.16, roofH, d * 1.16);
        this.quat.identity();
      }
    }
    this.mat.compose(this.pos, this.quat, this.scl);
    const ri = counts.get(meshKey + ':r') ?? 0;
    roof.setMatrixAt(ri, this.mat);
    counts.set(meshKey + ':r', ri + 1);
    roof.count = ri + 1;
  }

  dispose(): void {
    for (const mesh of [...this.bodies.values(), ...this.roofs.values()]) this.destroy(mesh);
    this.destroy(this.windows);
    this.destroy(this.windowsLit);
    this.destroy(this.props);
    this.bodies.clear();
    this.roofs.clear();
  }
}
