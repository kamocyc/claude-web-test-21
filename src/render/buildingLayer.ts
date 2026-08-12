import {
  BoxGeometry,
  Color,
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { TILE_M } from '@shared/constants';
import { archetype } from '@sim/buildings/archetypes';
import type { Simulation } from '@sim/simulation';
import { tileX, tileY } from '@sim/world/tiles';
import { meshStyle } from './theme';

/**
 * 建物の描画。形状キーごとに InstancedMesh を 1 つ持つ。
 * 建物が数千あってもドローコールは形状の種類数（数十）で済む。
 *
 * インスタンス行列の書き込みは「建物の増減があったとき」だけ。
 * 毎フレーム全建物を走査すると、それだけでフレーム予算を使い切る。
 */
export class BuildingLayer {
  readonly group = new Object3D();
  private readonly bodies = new Map<string, InstancedMesh>();
  private readonly roofs = new Map<string, InstancedMesh>();
  private readonly materials: MeshLambertMaterial[] = [];
  private lastEpoch = -1;
  private capacity = 4096;

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly color = new Color();

  constructor() {
    this.group.name = 'buildings';
  }

  private ensureMesh(key: string): { body: InstancedMesh; roof: InstancedMesh | null } {
    let body = this.bodies.get(key);
    if (!body) {
      const style = meshStyle(key);
      // vertexColors は付けない。InstancedMesh の setColorAt は instanceColor に書き込み、
      // three.js は USE_INSTANCING_COLOR として別に扱う。vertexColors:true にすると
      // geometry の color 属性（存在しない）も掛けようとして全部真っ黒になる。
      const bodyMat = new MeshLambertMaterial({});
      this.materials.push(bodyMat);
      // 単位ボックス（底面が y=0）
      const geom = new BoxGeometry(1, 1, 1);
      geom.translate(0, 0.5, 0);
      body = new InstancedMesh(geom, bodyMat, this.capacity);
      body.count = 0;
      body.frustumCulled = false;
      this.bodies.set(key, body);
      this.group.add(body);

      if (style.roof) {
        const roofMat = new MeshLambertMaterial({});
        this.materials.push(roofMat);
        // 4 角錐 = 寄棟屋根。回転させて軒の向きを揃える。
        const roofGeom = new ConeGeometry(0.72, 1, 4);
        roofGeom.rotateY(Math.PI / 4);
        roofGeom.translate(0, 0.5, 0);
        const roof = new InstancedMesh(roofGeom, roofMat, this.capacity);
        roof.count = 0;
        roof.frustumCulled = false;
        this.roofs.set(key, roof);
        this.group.add(roof);
      }
    }
    return { body, roof: this.roofs.get(key) ?? null };
  }

  /** 建物の増減があったときだけインスタンスを作り直す。 */
  update(sim: Simulation): void {
    if (sim.world.epochs.buildings === this.lastEpoch) return;
    this.lastEpoch = sim.world.epochs.buildings;

    const counts = new Map<string, number>();
    const b = sim.buildings;

    // 必要な容量を先に見積もる
    let total = 0;
    for (const _ of b.each()) total++;
    if (total > this.capacity) {
      this.capacity = Math.max(total * 2, this.capacity * 2);
      for (const mesh of [...this.bodies.values(), ...this.roofs.values()]) {
        this.group.remove(mesh);
        mesh.dispose();
      }
      this.bodies.clear();
      this.roofs.clear();
    }

    for (const mesh of this.bodies.values()) mesh.count = 0;
    for (const mesh of this.roofs.values()) mesh.count = 0;

    for (const slot of b.each()) {
      const a = archetype(b.archetypeId[slot]!);
      const style = meshStyle(a.mesh);
      const { body, roof } = this.ensureMesh(a.mesh);

      const level = b.level[slot]!;
      const origin = b.originTile[slot]!;
      const ox = tileX(origin);
      const oy = tileY(origin);
      const w = a.w * TILE_M * style.inset;
      const d = a.h * TILE_M * style.inset;
      const height = style.baseHeight + style.perLevel * (level - 1);
      const groundY = sim.world.heightDm[origin]! * 0.02;

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

      // 瓦屋根
      if (roof) {
        const roofH = Math.min(4.5, Math.max(1.6, height * 0.28));
        this.pos.set(cxw, groundY + height, czw);
        this.scl.set(w * 1.16, roofH, d * 1.16);
        this.mat.compose(this.pos, this.quat, this.scl);
        const ri = counts.get(a.mesh + ':r') ?? 0;
        roof.setMatrixAt(ri, this.mat);
        this.color.setHex(style.roofColor);
        roof.setColorAt(ri, this.color);
        counts.set(a.mesh + ':r', ri + 1);
        roof.count = ri + 1;
      }
    }

    for (const mesh of [...this.bodies.values(), ...this.roofs.values()]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  dispose(): void {
    for (const mesh of [...this.bodies.values(), ...this.roofs.values()]) mesh.dispose();
    for (const m of this.materials) m.dispose();
  }
}
