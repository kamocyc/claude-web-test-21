import { MAP_H, MAP_W, MAX_TICKS_PER_FRAME, TICKS_PER_SECOND_AT_1X, TILE_M } from '@shared/constants';
import { Activity, Mode, Overlay, RoadClass, TERRAIN_NAMES_JA, ZONE_NAMES_JA, Zone } from '@shared/enums';
import { Renderer } from '@render/renderer';
import { citizenPosition } from '@sim/agents/activity';
import { archetype } from '@sim/buildings/archetypes';
import { Simulation } from '@sim/simulation';
import { buildScenario, findCityCenter } from '@sim/scenario';
import { idx, tileX, tileY } from '@sim/world/tiles';
import { Ui } from '@ui/ui';
import { ToolKind, commandFor, costOf, initialToolState, previewTiles } from '@ui/tools';

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

  private dragStart = -1;
  private hoverTile = -1;
  private pointerX = 0;
  private pointerY = 0;
  private probeFrom = -1;
  private followCitizen = -1;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, seed: number) {
    this.canvas = canvas;
    this.sim = new Simulation(seed);
    this.renderer = new Renderer(canvas);

    const tool = initialToolState();
    this.ui = new Ui(uiRoot, tool, {
      onSpeed: (s) => {
        this.speed = s;
        this.ui.currentSpeed = s;
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
    this.ui.currentSpeed = this.speed;
    this.ui.setSpeed(this.speed);

    this.attachInput();
    window.addEventListener('resize', () => this.renderer.resize(canvas));
  }

  /**
   * 何もない土地から始める。
   * 道路も建物も無い状態で、プレイヤが最初の 1 本を引くところから街が育つ。
   */
  startEmpty(): void {
    const center = findCityCenter(this.sim.world);
    this.sim.bootstrap();
    this.renderer.focusOn((tileX(center) + 0.5) * TILE_M, (tileY(center) + 0.5) * TILE_M);
    this.renderer.rig.distance = 340;
    this.renderer.invalidateOverlay();
    this.ui.cityName = 'あたらしい街';
    this.ui.tutorial.enabled = true;
  }

  /** できあがった街を読み込む（チュートリアルを飛ばして仕組みを眺めたい人向け）。 */
  startSample(): void {
    const result = buildScenario(this.sim, { size: 72, seedPopulation: 600 });
    this.renderer.focusOn((tileX(result.center) + 0.5) * TILE_M, (tileY(result.center) + 0.5) * TILE_M);
    this.renderer.rig.distance = 520;
    this.renderer.invalidateOverlay();
    this.ui.cityName = 'サンプルの街';
    this.ui.tutorial.close();
  }

  // ---------------- 入力 ----------------

  private attachInput(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.shiftKey || e.altKey) return;
      const tile = this.renderer.pickTile(e.clientX, e.clientY, canvas);
      if (tile < 0) return;
      this.dragStart = tile;
    });

    canvas.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      const tile = this.renderer.pickTile(e.clientX, e.clientY, canvas);
      this.hoverTile = tile;
      this.renderer.setCursorTile(tile, this.sim.world);
      this.updateCursorTip();
    });

    canvas.addEventListener('pointerleave', () => {
      this.hoverTile = -1;
      this.renderer.setCursorTile(-1, null);
      this.ui.showCursorTip(0, 0, null);
    });

    const finish = (e: PointerEvent): void => {
      if (this.dragStart < 0) return;
      const from = this.dragStart;
      this.dragStart = -1;
      const to = this.renderer.pickTile(e.clientX, e.clientY, canvas);
      if (to < 0) return;
      this.handleToolAction(from, to);
      this.updateCursorTip();
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
        this.setSpeed(this.speed === 0 ? 1 : 0);
      }
      if (e.key >= '1' && e.key <= '4') {
        this.setSpeed([0, 1, 3, 10][Number(e.key) - 1]!);
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

  private setSpeed(s: number): void {
    this.speed = s;
    this.ui.currentSpeed = s;
    this.ui.setSpeed(s);
  }

  /** カーソル横に費用や地形を出す（Cities: Skylines と同じ感覚で操作できるように）。 */
  private updateCursorTip(): void {
    if (this.hoverTile < 0) {
      this.ui.showCursorTip(0, 0, null);
      return;
    }
    const tool = this.ui.tool;
    const w = this.sim.world;
    const t = this.hoverTile;

    if (tool.kind === ToolKind.Road || tool.kind === ToolKind.Rail) {
      const tiles = this.dragStart >= 0 ? previewTiles(tool, this.dragStart, t) : [t];
      const buildable = tiles.filter((i) =>
        tool.kind === ToolKind.Road ? w.canBuildRoad(i) : w.canBuildRail(i),
      ).length;
      const cost = costOf(tool, buildable);
      this.ui.showCursorTip(
        this.pointerX,
        this.pointerY,
        buildable === 0 ? 'ここには敷けません' : `${buildable} マス / ${Math.round(cost).toLocaleString('ja-JP')}円`,
      );
      return;
    }
    if (tool.kind === ToolKind.Place) {
      const a = archetype(tool.archetypeId);
      const ok = w.canBuildStructure(t);
      this.ui.showCursorTip(
        this.pointerX,
        this.pointerY,
        ok ? `${a.nameJa} / ${a.buildCost.toLocaleString('ja-JP')}円` : 'ここには建てられません',
      );
      return;
    }
    if (tool.kind === ToolKind.Zone) {
      const tiles = this.dragStart >= 0 ? previewTiles(tool, this.dragStart, t) : [t];
      const ok = tiles.filter((i) => tool.zone === Zone.None || w.canZone(i, tool.zone)).length;
      this.ui.showCursorTip(this.pointerX, this.pointerY, `${ok} / ${tiles.length} マスに指定できます`);
      return;
    }
    // 通常時は地形と用途を出す
    const parts = [TERRAIN_NAMES_JA[w.terrain[t]!] ?? ''];
    if (w.road[t] !== RoadClass.None) parts.push('道路');
    if (w.rail[t] !== 0) parts.push('線路');
    if (w.zone[t] !== Zone.None) parts.push(ZONE_NAMES_JA[w.zone[t]!]!);
    const ref = w.buildingRef[t]!;
    if (ref !== 0 && this.sim.buildings.alive[ref - 1] === 1) {
      parts.push(archetype(this.sim.buildings.archetypeId[ref - 1]!).nameJa);
    }
    this.ui.showCursorTip(this.pointerX, this.pointerY, parts.join(' / '));
  }

  private handleToolAction(from: number, to: number): void {
    const tool = this.ui.tool;

    if (tool.kind === ToolKind.RouteProbe) {
      if (this.probeFrom < 0) {
        this.probeFrom = to;
        this.renderer.showRoute(null, this.sim);
        this.ui.pushAlert('始点を設定しました。もう 1 点クリックしてください', 'noPath');
      } else {
        const path = this.sim.debugPath(this.probeFrom, to, Mode.Car);
        this.renderer.showRoute(path, this.sim);
        this.ui.pushAlert(
          path
            ? `経路: ${(path.costSec / 60).toFixed(0)} 分 / ${(path.lengthM / 1000).toFixed(2)} km`
            : 'その 2 点を結ぶ自動車の経路はありません',
          'noPath',
        );
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

  private selectAt(tile: number): void {
    const target = { x: (tileX(tile) + 0.5) * TILE_M, z: (tileY(tile) + 0.5) * TILE_M };
    const pos = { x: 0, z: 0, heading: 0, edge: -1 };
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

    const ref = this.sim.world.buildingRef[tile]!;
    if (ref !== 0 && this.sim.buildings.alive[ref - 1] === 1) {
      this.ui.selectedBuilding = ref - 1;
      this.ui.selectedCitizen = -1;
      return;
    }
    this.ui.selectedCitizen = -1;
    this.ui.selectedBuilding = -1;
  }

  // ---------------- ループ ----------------

  start(): void {
    this.lastTime = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;

      this.fpsAccum += 1 / Math.max(1e-4, dt);
      this.fpsSamples++;
      if (this.fpsSamples >= 20) {
        this.fps = this.fpsAccum / this.fpsSamples;
        this.fpsAccum = 0;
        this.fpsSamples = 0;
      }

      if (this.speed > 0) {
        this.accumulator += dt * TICKS_PER_SECOND_AT_1X * this.speed;
        let steps = 0;
        while (this.accumulator >= 1 && steps < MAX_TICKS_PER_FRAME) {
          this.sim.tick();
          this.accumulator -= 1;
          steps++;
        }
        if (this.accumulator > MAX_TICKS_PER_FRAME) this.accumulator = 0;
      }

      this.drainEvents();

      if (this.followCitizen >= 0 && this.sim.citizens.isAlive(this.followCitizen)) {
        const pos = { x: 0, z: 0, heading: 0, edge: -1 };
        if (citizenPosition(this.sim.citizens, this.sim.graph, this.followCitizen, this.sim.clock.tick, pos)) {
          this.renderer.focusOn(pos.x, pos.z);
        }
      }

      if (this.dragStart >= 0 && this.hoverTile >= 0) {
        const tiles = previewTiles(this.ui.tool, this.dragStart, this.hoverTile);
        this.renderer.setCursorTile(tiles.length > 0 ? tiles[tiles.length - 1]! : this.hoverTile, this.sim.world);
      }

      if (this.ui.selectedCitizen >= 0) {
        this.renderer.showRoute(this.sim.citizens.tripPath[this.ui.selectedCitizen] ?? null, this.sim);
      }

      // 端数 tick を渡して補間させる。これが無いと車も人も 12 段階/秒で飛ぶ。
      this.renderer.render(this.sim, dt, this.speed > 0 ? this.accumulator : 0);
      this.ui.update(
        this.sim,
        now,
        this.fps,
        this.renderer.drawCalls,
        this.renderer.visibleAgents,
        this.renderer.visibleVehicles,
      );

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private drainEvents(): void {
    const events = this.sim.world.events.drain();
    if (this.sim.world.events.overflowed) {
      this.renderer.invalidateOverlay();
      this.sim.world.events.clearOverflow();
    }
    for (const e of events) {
      if (e.t === 'alert') this.ui.pushAlert(e.message, e.kind);
    }
    if (this.sim.clock.tick % 1440 === 0 && this.renderer.overlay !== Overlay.None) {
      this.renderer.invalidateOverlay();
    }
  }

  /** マップの中央タイル（デバッグ・テスト用）。 */
  static centerTile(): number {
    return idx(MAP_W >> 1, MAP_H >> 1);
  }
}
