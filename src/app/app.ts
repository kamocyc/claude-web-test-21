import { MAX_TICKS_PER_FRAME, TICKS_PER_SECOND_AT_1X, TILE_M } from '@shared/constants';
import { Activity, Mode, Overlay, type Zone } from '@shared/enums';
import { Renderer } from '@render/renderer';
import { citizenPosition } from '@sim/agents/activity';
import { Simulation } from '@sim/simulation';
import { buildScenario } from '@sim/scenario';
import { MAP_W } from '@shared/constants';
import { Ui } from '@ui/ui';
import { ToolKind, commandFor, initialToolState, previewTiles } from '@ui/tools';

/**
 * アプリケーションの統括。
 *
 * 「固定ステップでシミュレーションを進め、描画は毎フレーム補間する」形にする。
 * 1 フレームで消化する tick 数に上限を設けているのは、重い tick が続いたときに
 * 「遅れを取り戻そうとしてさらに重くなる」死のスパイラルを避けるため。
 */
export class App {
  readonly sim: Simulation;
  readonly renderer: Renderer;
  readonly ui: Ui;
  private readonly canvas: HTMLCanvasElement;

  private speed = 1;
  private accumulator = 0;
  private lastTime = 0;
  private fps = 60;
  private fpsSamples = 0;
  private fpsAccum = 0;

  /** ドラッグ操作の状態。 */
  private dragStart = -1;
  private hoverTile = -1;
  /** 経路確認ツールの始点。 */
  private probeFrom = -1;
  /** 追跡中の市民。 */
  private followCitizen = -1;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, seed: number) {
    this.canvas = canvas;
    this.sim = new Simulation(seed);
    this.renderer = new Renderer(canvas);

    const tool = initialToolState();
    this.ui = new Ui(uiRoot, tool, {
      onSpeed: (s) => {
        this.speed = s;
        this.sim.enqueue({ t: 'setSpeed', speed: s });
      },
      onTool: () => {
        this.probeFrom = -1;
        this.renderer.showRoute(null, this.sim);
      },
      onOverlay: (o: Overlay) => this.renderer.setOverlay(o),
      onTax: (zone: Zone, pct: number) => this.sim.enqueue({ t: 'setTax', zone, pct }),
      onFollowCitizen: () => {
        this.followCitizen = this.ui.selectedCitizen;
      },
    });
    this.ui.setSpeed(this.speed);

    this.attachInput();
    window.addEventListener('resize', () => this.renderer.resize(canvas));
  }

  /** 初期状態の街を組み立てる。 */
  bootstrapCity(): void {
    const result = buildScenario(this.sim, { size: 72, seedPopulation: 600 });
    const center = result.center;
    this.renderer.focusOn(((center % MAP_W) + 0.5) * TILE_M, (((center / MAP_W) | 0) + 0.5) * TILE_M);
    this.renderer.rig.distance = 520;
    this.renderer.invalidateOverlay();
  }

  // ---------------- 入力 ----------------

  private attachInput(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      // カメラ操作の修飾キーが押されているときはツールを起動しない
      if (e.button !== 0 || e.shiftKey || e.altKey) return;
      const tile = this.renderer.pickTile(e.clientX, e.clientY, canvas);
      if (tile < 0) return;
      this.dragStart = tile;
    });

    canvas.addEventListener('pointermove', (e) => {
      const tile = this.renderer.pickTile(e.clientX, e.clientY, canvas);
      this.hoverTile = tile;
      this.renderer.setCursorTile(tile, this.sim.world);
    });

    const finish = (e: PointerEvent): void => {
      if (this.dragStart < 0) return;
      const from = this.dragStart;
      this.dragStart = -1;
      const to = this.renderer.pickTile(e.clientX, e.clientY, canvas);
      if (to < 0) return;
      this.handleToolAction(from, to);
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => {
      this.dragStart = -1;
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        this.speed = this.speed === 0 ? 1 : 0;
        this.ui.setSpeed(this.speed);
      }
      if (e.key >= '1' && e.key <= '4') {
        const map = [0, 1, 3, 10];
        this.speed = map[Number(e.key) - 1]!;
        this.ui.setSpeed(this.speed);
      }
      if (e.key === 'Escape') {
        this.ui.selectedCitizen = -1;
        this.ui.selectedBuilding = -1;
        this.followCitizen = -1;
        this.probeFrom = -1;
        this.renderer.showRoute(null, this.sim);
      }
    });
  }

  private handleToolAction(from: number, to: number): void {
    const tool = this.ui.tool;

    if (tool.kind === ToolKind.RouteProbe) {
      if (this.probeFrom < 0) {
        this.probeFrom = to;
        this.renderer.showRoute(null, this.sim);
      } else {
        const path = this.sim.debugPath(this.probeFrom, to, Mode.Car);
        this.renderer.showRoute(path, this.sim);
        if (!path) this.ui.pushAlert('その 2 点を結ぶ自動車の経路はありません', 'noPath');
        else {
          this.ui.pushAlert(
            `経路: ${(path.costSec / 60).toFixed(0)} 分 / ${(path.lengthM / 1000).toFixed(2)} km`,
            'noPath',
          );
        }
        this.probeFrom = -1;
      }
      return;
    }

    if (tool.kind === ToolKind.Select) {
      this.selectAt(to);
      return;
    }

    const cmd = commandFor(tool, from, to);
    if (cmd) this.sim.enqueue(cmd);
  }

  /** クリックした地点の市民・建物を選ぶ。 */
  private selectAt(tile: number): void {
    // まず、そのタイルの近くを移動中の市民を探す
    const target = { x: ((tile % MAP_W) + 0.5) * TILE_M, z: (((tile / MAP_W) | 0) + 0.5) * TILE_M };
    const pos = { x: 0, z: 0, heading: 0 };
    let bestId = -1;
    let bestD2 = (TILE_M * 2.5) ** 2;
    const c = this.sim.citizens;
    for (let id = 0; id < c.high; id++) {
      if (!c.isAlive(id) || c.state[id] !== Activity.Traveling) continue;
      if (!citizenPosition(c, this.sim.graph, id, this.sim.clock.tick, pos)) continue;
      const dx = pos.x - target.x;
      const dz = pos.z - target.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestId = id;
      }
    }
    if (bestId >= 0) {
      this.ui.selectedCitizen = bestId;
      this.ui.selectedBuilding = -1;
      this.sim.activity.inspectedCitizen = bestId;
      return;
    }

    // 次に建物
    const ref = this.sim.world.buildingRef[tile]!;
    if (ref !== 0) {
      this.ui.selectedBuilding = ref - 1;
      this.ui.selectedCitizen = -1;
      return;
    }

    // 何もなければ、そのタイルに住んでいる市民のうち 1 人を選ぶ
    this.ui.selectedCitizen = -1;
    this.ui.selectedBuilding = -1;
  }

  // ---------------- ループ ----------------

  start(): void {
    this.lastTime = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;

      // FPS の移動平均
      this.fpsAccum += 1 / Math.max(1e-4, dt);
      this.fpsSamples++;
      if (this.fpsSamples >= 20) {
        this.fps = this.fpsAccum / this.fpsSamples;
        this.fpsAccum = 0;
        this.fpsSamples = 0;
      }

      // 固定ステップでシミュレーションを進める
      if (this.speed > 0) {
        this.accumulator += dt * TICKS_PER_SECOND_AT_1X * this.speed;
        let steps = 0;
        while (this.accumulator >= 1 && steps < MAX_TICKS_PER_FRAME) {
          this.sim.tick();
          this.accumulator -= 1;
          steps++;
        }
        // 追いつけない分は捨てる（死のスパイラルを避ける）
        if (this.accumulator > MAX_TICKS_PER_FRAME) this.accumulator = 0;
      }

      this.drainEvents();

      // 追跡中の市民にカメラを追従させる
      if (this.followCitizen >= 0 && this.sim.citizens.isAlive(this.followCitizen)) {
        const pos = { x: 0, z: 0, heading: 0 };
        if (citizenPosition(this.sim.citizens, this.sim.graph, this.followCitizen, this.sim.clock.tick, pos)) {
          this.renderer.focusOn(pos.x, pos.z);
        }
      }

      // ドラッグ中のプレビュー
      if (this.dragStart >= 0 && this.hoverTile >= 0) {
        const tiles = previewTiles(this.ui.tool, this.dragStart, this.hoverTile);
        this.renderer.setCursorTile(tiles.length > 0 ? tiles[tiles.length - 1]! : this.hoverTile, this.sim.world);
      }

      // 選択中の市民の経路を表示し続ける
      if (this.ui.selectedCitizen >= 0) {
        const path = this.sim.citizens.tripPath[this.ui.selectedCitizen];
        this.renderer.showRoute(path ?? null, this.sim);
      }

      this.renderer.render(this.sim, dt);
      this.ui.update(this.sim, now, this.fps, this.renderer.drawCalls, this.renderer.visibleAgents);

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** sim が出したイベントを UI と描画に反映する。 */
  private drainEvents(): void {
    const events = this.sim.world.events.drain();
    if (this.sim.world.events.overflowed) {
      // 取りこぼしが起きたら全再構築にフォールバックする
      this.renderer.invalidateOverlay();
      this.sim.world.events.clearOverflow();
    }
    for (const e of events) {
      if (e.t === 'alert') this.ui.pushAlert(e.message, e.kind);
    }
    // 地価などのオーバーレイは日次で変わるので、日付が変わったら作り直す
    if (this.sim.clock.tick % 1440 === 0 && this.renderer.overlay !== Overlay.None) {
      this.renderer.invalidateOverlay();
    }
  }
}
