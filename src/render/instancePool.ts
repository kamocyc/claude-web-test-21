import {
  Color,
  InstancedMesh,
  Matrix4,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';

/**
 * 「必要になったぶんだけ伸びる InstancedMesh」。
 *
 * 道路の小物は、街の育ち方で必要数が 10 倍変わる。上限を決め打ちすると
 * 大きな街で黙って消えるか、小さな街で数万個ぶんの空バッファを抱えることになる。
 * かといって毎回作り直すのは論外なので、足りなくなったときだけ倍に伸ばす。
 *
 * 書き込みは `begin()` → `push()` × n → `end()` の 3 手。
 * `push` の途中で容量が尽きたら、その場で作り直して既存ぶんをコピーする。
 */
export class InstancePool {
  mesh: InstancedMesh;
  private cursor = 0;
  private capacity: number;
  /**
   * 表示状態と描画順を**プール側で覚えておく**。
   *
   * `grow()` はメッシュを作り直すので、呼び出し側が `mesh.visible` や
   * `mesh.renderOrder` を直接いじっていると、容量が増えた瞬間に既定値へ戻る。
   * 街が育って初めて「夜の光の板が急に手前に出る」「LOD で隠したはずの
   * 標示が復活する」といった、再現しづらい不具合になる。
   */
  private visible = true;
  private order = 0;

  constructor(
    private geometry: BufferGeometry,
    private readonly material: Material,
    private readonly parent: Object3D,
    private readonly colored: boolean,
    capacity = 256,
  ) {
    this.capacity = capacity;
    this.mesh = this.create(capacity);
  }

  private create(capacity: number): InstancedMesh {
    const m = new InstancedMesh(this.geometry, this.material, capacity);
    m.count = 0;
    m.visible = this.visible;
    m.renderOrder = this.order;
    // 道路の小物はマップ全体に散らばるので、区画に切らない限りカリングは効かない。
    // 効かないカリングのために毎フレーム境界球を計算するほうが無駄なので切る。
    m.frustumCulled = false;
    if (this.colored) {
      // instanceColor を最初から確保しておく。setColorAt が最初の 1 回で
      // バッファを作ると、その回だけ全インスタンスが白（未初期化）になる。
      m.setColorAt(0, WHITE);
    }
    this.parent.add(m);
    return m;
  }

  /** 季節でジオメトリを差し替えるときに使う。 */
  setGeometry(geom: BufferGeometry): void {
    this.geometry = geom;
    this.mesh.geometry = geom;
  }

  begin(): void {
    this.cursor = 0;
  }

  push(matrix: Matrix4, color?: Color): void {
    if (this.cursor >= this.capacity) this.grow();
    this.mesh.setMatrixAt(this.cursor, matrix);
    if (this.colored) this.mesh.setColorAt(this.cursor, color ?? WHITE);
    this.cursor++;
  }

  private grow(): void {
    const next = this.capacity * 2;
    const old = this.mesh;
    const mesh = this.create(next);
    mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.capacity * 16));
    if (this.colored && old.instanceColor && mesh.instanceColor) {
      mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, this.capacity * 3));
    }
    this.parent.remove(old);
    old.dispose();
    this.mesh = mesh;
    this.capacity = next;
  }

  end(): void {
    this.mesh.count = this.cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  get count(): number {
    return this.cursor;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.mesh.visible = v;
  }

  /** 描画順（加算合成の板を最後に描くなど）。`grow()` を跨いでも保たれる。 */
  setRenderOrder(o: number): void {
    this.order = o;
    this.mesh.renderOrder = o;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

const WHITE = new Color(1, 1, 1);
