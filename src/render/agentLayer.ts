import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshLambertMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { AGENT_DRAW_DISTANCE_M, MAX_VISIBLE_AGENTS, MAX_VISIBLE_VEHICLES, VEHICLE_DRAW_DISTANCE_M } from '@shared/constants';
import { Activity, Mode } from '@shared/enums';
import { citizenPosition } from '@sim/agents/activity';
import type { Simulation } from '@sim/simulation';
import { TruckState } from '@sim/economy/freight';

/**
 * 移動中の市民と車両の描画。
 *
 * 位置はシミュレーションが毎 tick 更新しているのではなく、
 * (出発 tick, 到着 tick, 経路) から描画時に補間して求める。
 * これにより 1 万人分の座標更新を毎 tick 走らせずに済み、
 * かつ 12 tick/秒のシミュレーションでも 60fps で滑らかに動いて見える。
 *
 * さらに、カメラの近くにいるエージェントだけをインスタンス化する。
 * 引きの画では点にしかならないものに描画予算を使わない。
 */
export class AgentLayer {
  readonly group = new Object3D();
  private readonly pedestrians: InstancedMesh;
  private readonly cars: InstancedMesh;
  private readonly trains: InstancedMesh;
  private readonly trucks: InstancedMesh;
  private readonly materials: MeshLambertMaterial[] = [];

  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly quat = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly color = new Color();
  private readonly tmp = { x: 0, z: 0, heading: 0 };

  /** 直近フレームで描いた数（デバッグ表示用）。 */
  visiblePedestrians = 0;
  visibleVehicles = 0;

  constructor() {
    this.group.name = 'agents';

    const mk = (w: number, h: number, d: number, cap: number): InstancedMesh => {
      const geom = new BoxGeometry(w, h, d);
      geom.translate(0, h / 2, 0);
      // 建物と同じ理由で vertexColors は付けない（instanceColor だけを使う）
      const mat = new MeshLambertMaterial({});
      this.materials.push(mat);
      const mesh = new InstancedMesh(geom, mat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };

    this.pedestrians = mk(1.2, 3.4, 1.2, MAX_VISIBLE_AGENTS);
    this.cars = mk(2.0, 1.6, 4.4, MAX_VISIBLE_VEHICLES);
    this.trains = mk(3.0, 3.6, 18, 256);
    this.trucks = mk(2.6, 2.8, 7.0, 512);
  }

  update(sim: Simulation, camX: number, camZ: number, zoomFraction: number): void {
    let ped = 0;
    let car = 0;
    let train = 0;
    const tick = sim.clock.tick;

    // 引きの画では歩行者を描かない（点になるだけで、描画予算だけを食う）
    const drawPedestrians = zoomFraction < 0.45;
    const pedDist2 = AGENT_DRAW_DISTANCE_M * AGENT_DRAW_DISTANCE_M;
    const vehDist2 = VEHICLE_DRAW_DISTANCE_M * VEHICLE_DRAW_DISTANCE_M;

    const c = sim.citizens;
    for (let id = 0; id < c.high; id++) {
      if (!c.isAlive(id)) continue;
      if (c.state[id] !== Activity.Traveling) continue;
      const mode = c.mode[id]! as Mode;
      const isPed = mode === Mode.Walk || mode === Mode.Bike;
      if (isPed && !drawPedestrians) continue;
      if (isPed && ped >= MAX_VISIBLE_AGENTS) continue;
      if (!isPed && mode === Mode.Car && car >= MAX_VISIBLE_VEHICLES) continue;

      if (!citizenPosition(c, sim.graph, id, tick, this.tmp)) continue;
      const dx = this.tmp.x - camX;
      const dz = this.tmp.z - camZ;
      const d2 = dx * dx + dz * dz;

      const groundY = 0.2;
      this.quat.setFromAxisAngle(this.axisY, this.tmp.heading);

      if (isPed) {
        if (d2 > pedDist2) continue;
        this.pos.set(this.tmp.x, groundY, this.tmp.z);
        this.scl.set(1, 1, 1);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.pedestrians.setMatrixAt(ped, this.mat);
        // 自転車は少し色を変えて見分けられるようにする
        this.color.setHex(mode === Mode.Bike ? 0xe0a44a : 0xe8e0d0);
        this.pedestrians.setColorAt(ped, this.color);
        ped++;
      } else if (mode === Mode.Car) {
        if (d2 > vehDist2) continue;
        this.pos.set(this.tmp.x, groundY, this.tmp.z);
        this.scl.set(1, 1, 1);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.cars.setMatrixAt(car, this.mat);
        // 日本の車は白・シルバー・黒が多い
        const h = (id * 2654435761) % 100;
        this.color.setHex(h < 40 ? 0xe8e8e8 : h < 65 ? 0xa8adb2 : h < 85 ? 0x2a2d33 : 0x3a5a8a);
        this.cars.setColorAt(car, this.color);
        car++;
      } else if (mode === Mode.Rail) {
        // 鉄道利用者は個別に描かず、代表として車両を出す（本数を抑える）
        if (train >= 256) continue;
        if (id % 40 !== 0) continue;
        if (d2 > vehDist2 * 4) continue;
        this.pos.set(this.tmp.x, 1.2, this.tmp.z);
        this.scl.set(1, 1, 1);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.trains.setMatrixAt(train, this.mat);
        this.color.setHex(0xd8dde4);
        this.trains.setColorAt(train, this.color);
        train++;
      }
    }

    // トラック（物流）
    let truck = 0;
    const t = sim.freight.trucks;
    for (let i = 0; i < t.high && truck < 512; i++) {
      if (t.alive[i] !== 1) continue;
      const path = t.path[i];
      if (!path || path.edges.length === 0) continue;
      const depart = t.departTick[i]!;
      const arrive = t.arriveTick[i]!;
      const total = Math.max(1, arrive - depart);
      let f = Math.max(0, Math.min(1, (tick - depart) / total));
      // 帰路は経路を逆向きに進む
      if (t.state[i] === TruckState.Returning) f = 1 - f;

      const target = f * path.lengthM;
      let acc = 0;
      let px = 0;
      let pz = 0;
      let heading = 0;
      for (let e = 0; e < path.edges.length; e++) {
        const len = sim.graph.edgeLenM[path.edges[e]!]!;
        if (acc + len >= target || e === path.edges.length - 1) {
          const a = path.nodes[e]!;
          const bnode = path.nodes[e + 1]!;
          const lf = len > 0 ? Math.max(0, Math.min(1, (target - acc) / len)) : 0;
          const ax = sim.graph.nodeX[a]!;
          const az = sim.graph.nodeZ[a]!;
          const bx = sim.graph.nodeX[bnode]!;
          const bz = sim.graph.nodeZ[bnode]!;
          px = ax + (bx - ax) * lf;
          pz = az + (bz - az) * lf;
          heading = Math.atan2(bx - ax, bz - az);
          break;
        }
        acc += len;
      }
      const dx = px - camX;
      const dz = pz - camZ;
      if (dx * dx + dz * dz > vehDist2) continue;
      this.quat.setFromAxisAngle(this.axisY, heading);
      this.pos.set(px, 0.2, pz);
      this.scl.set(1, 1, 1);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.trucks.setMatrixAt(truck, this.mat);
      this.color.setHex(0x4a6a8a);
      this.trucks.setColorAt(truck, this.color);
      truck++;
    }

    this.pedestrians.count = ped;
    this.cars.count = car;
    this.trains.count = train;
    this.trucks.count = truck;
    for (const m of [this.pedestrians, this.cars, this.trains, this.trucks]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.visiblePedestrians = ped;
    this.visibleVehicles = car + train + truck;
  }

  dispose(): void {
    for (const m of [this.pedestrians, this.cars, this.trains, this.trucks]) m.dispose();
    for (const m of this.materials) m.dispose();
  }
}
