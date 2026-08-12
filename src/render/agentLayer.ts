import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshLambertMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { AGENT_DRAW_DISTANCE_M, MAX_VISIBLE_AGENTS, MAX_VISIBLE_VEHICLES, VEHICLE_DRAW_DISTANCE_M } from '@shared/constants';
import { Activity, Mode } from '@shared/enums';
import { citizenPosition } from '@sim/agents/activity';
import type { Simulation } from '@sim/simulation';
import { TruckState } from '@sim/economy/freight';
import { MAP_H, MAP_W, TILE_M } from '@shared/constants';
import { idx, tileX, tileY } from '@sim/world/tiles';

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

  /**
   * ワールド座標の地面の高さ (m)。
   *
   * 建物は標高の上に置いているのに、人や車だけ y=0 に置くと地面に埋まって
   * 一切見えなくなる。平野でも標高は数 m あるので、必ず地形に合わせる。
   */
  private groundAt(sim: Simulation, x: number, z: number): number {
    const tx = Math.max(0, Math.min(MAP_W - 1, Math.floor(x / TILE_M)));
    const tz = Math.max(0, Math.min(MAP_H - 1, Math.floor(z / TILE_M)));
    return sim.world.heightDm[idx(tx, tz)]! * 0.02;
  }

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

    // 人は実寸（肩幅 0.55m・身長 1.75m）。近景で見たときに建物や車と
    // 縮尺が合っていないと、街の大きさが読み取れなくなる。
    this.pedestrians = mk(0.55, 1.75, 0.35, MAX_VISIBLE_AGENTS);
    this.cars = mk(1.7, 1.45, 4.2, MAX_VISIBLE_VEHICLES);
    this.trains = mk(2.9, 3.6, 19, 256);
    this.trucks = mk(2.2, 2.6, 6.5, 512);
  }

  /**
   * @param camDistance カメラと注視点の距離 (m)。これで描画範囲を決める。
   *   ズームインするほど「近くを密に」、引くほど「歩行者は省く」。
   */
  update(sim: Simulation, camX: number, camZ: number, camDistance: number): void {
    let ped = 0;
    let car = 0;
    let train = 0;
    const tick = sim.clock.tick;

    // 歩行者は寄ったときだけ描く。引きの画では 1px 未満にしかならず、
    // 描画予算だけを食って何も見えない。
    const drawPedestrians = camDistance < 460;
    // 描画半径はカメラの距離に連動させる。寄ればその周辺だけを、
    // 少し引けば広く（ただし上限は設ける）。
    const pedRadius = Math.min(AGENT_DRAW_DISTANCE_M, camDistance * 2.4);
    const pedDist2 = pedRadius * pedRadius;
    const vehRadius = Math.min(VEHICLE_DRAW_DISTANCE_M, Math.max(500, camDistance * 2.2));
    const vehDist2 = vehRadius * vehRadius;

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

      const groundY = this.groundAt(sim, this.tmp.x, this.tmp.z) + 0.05;
      this.quat.setFromAxisAngle(this.axisY, this.tmp.heading);

      if (isPed) {
        if (d2 > pedDist2) continue;
        // 道路の中央ではなく端を歩かせる。全員が真ん中を一列で進むと、
        // 近景で見たときに人の流れではなく点線に見える。
        const side = ((id & 1) === 0 ? 1 : -1) * (2.4 + ((id >> 1) % 3) * 0.7);
        const ox = Math.cos(this.tmp.heading) * side;
        const oz = -Math.sin(this.tmp.heading) * side;
        this.pos.set(this.tmp.x + ox, groundY, this.tmp.z + oz);
        this.scl.set(1, 1, 1);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.pedestrians.setMatrixAt(ped, this.mat);
        // 服の色を人ごとに散らす。自転車は目立つ色にして見分けられるようにする。
        if (mode === Mode.Bike) {
          this.color.setHex(0xe08a3a);
        } else {
          const h = (id * 2654435761) >>> 0;
          this.color.setHSL(((h >>> 8) % 360) / 360, 0.28, 0.52 + ((h >>> 20) % 24) / 100);
        }
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
        if (id % 30 !== 0) continue;
        if (d2 > vehDist2 * 6) continue;
        this.pos.set(this.tmp.x, groundY + 1.0, this.tmp.z);
        this.scl.set(1, 1, 1);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.trains.setMatrixAt(train, this.mat);
        this.color.setHex(0xd8dde4);
        this.trains.setColorAt(train, this.color);
        train++;
      }
    }

    // --- 滞在中の市民 ---
    // 移動中の人だけを描くと、街が空っぽに見える。トリップは数分で終わるので、
    // どの瞬間を切り取っても移動中の人はごく一部しかいないため。
    // 勤務中・買い物中・在宅の市民も、その建物の敷地に立たせて描く。
    if (drawPedestrians && ped < MAX_VISIBLE_AGENTS) {
      const b = sim.buildings;
      for (let id = 0; id < c.high && ped < MAX_VISIBLE_AGENTS; id++) {
        if (!c.isAlive(id)) continue;
        const st = c.state[id]!;
        // 就寝中と経路待ちは屋内にいる扱い
        if (st === Activity.Sleeping || st === Activity.Traveling || st === Activity.WaitingForRoute) continue;
        // 在宅の人は一部だけ外に出す（全員が庭に立っていると不自然）
        if (st === Activity.AtHome && id % 4 !== 0) continue;

        const tile = c.currentTile[id]!;
        // 建物のタイル中心に置くと、人が家の中に埋まって見えない。
        // その建物の接道タイル（＝玄関前の道路）に立たせる。
        // 結果として人は通りに出るので、近景で街に人がいることが分かる。
        const ref = sim.world.buildingRef[tile]!;
        let standTile = tile;
        if (ref !== 0 && b.alive[ref - 1] === 1 && b.accessTile[ref - 1]! >= 0) {
          standTile = b.accessTile[ref - 1]!;
        }
        const wx = (tileX(standTile) + 0.5) * TILE_M;
        const wz = (tileY(standTile) + 0.5) * TILE_M;
        const dx = wx - camX;
        const dz = wz - camZ;
        if (dx * dx + dz * dz > pedDist2) continue;

        // タイル内に散らす（毎フレーム同じ位置になるよう ID から決める）
        const h = (id * 2654435761) >>> 0;
        const spread = TILE_M * 0.8;
        const ox = (((h >>> 4) % 100) / 100 - 0.5) * spread;
        const oz = (((h >>> 12) % 100) / 100 - 0.5) * spread;

        this.quat.setFromAxisAngle(this.axisY, ((h >>> 24) % 360) * (Math.PI / 180));
        this.pos.set(wx + ox, this.groundAt(sim, wx + ox, wz + oz) + 0.05, wz + oz);
        this.scl.set(1, 1, 1);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.pedestrians.setMatrixAt(ped, this.mat);
        this.color.setHSL(((h >>> 8) % 360) / 360, 0.26, 0.5 + ((h >>> 20) % 24) / 100);
        this.pedestrians.setColorAt(ped, this.color);
        ped++;
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
      this.pos.set(px, this.groundAt(sim, px, pz) + 0.05, pz);
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
