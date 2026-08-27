import {
  MAP_H,
  MAP_W,
  MAX_TICKS_PER_FRAME,
  OVERLAY_REFRESH_TICKS,
  TICKS_PER_DAY,
  TICKS_PER_SECOND_AT_1X,
  TILE_M,
} from '@shared/constants';
import { Activity, Mode, ONE_WAY_NAMES_JA, OneWay, Overlay, RoadClass, TERRAIN_NAMES_JA, ZONE_NAMES_JA, Zone } from '@shared/enums';
import { Renderer } from '@render/renderer';
import { citizenPosition } from '@sim/agents/activity';
import { archetype } from '@sim/buildings/archetypes';
import { Simulation } from '@sim/simulation';
import { decodeSave, encodeSave, type SaveMeta } from '@sim/persistence';
import { buildScenario, findCityCenter } from '@sim/scenario';
import { idx, tileX, tileY } from '@sim/world/tiles';
import { Ui } from '@ui/ui';
import { ToolKind, commandFor, costOf, dragDirection, initialToolState, previewTiles } from '@ui/tools';
import { AUTO_SLOT, defaultFileName, downloadSave, pickSaveFile, putSave } from '@ui/storage';

/**
 * アプリケーションの統括。
 *
 * 「固定ステップでシミュレーションを進め、描画は毎フレーム補間する」形にする。
 * 1 フレームで消化する tick 数に上限を設けているのは、重い tick が続いたときに
 * 「遅れを取り戻そうとしてさらに重くなる」死のスパイラルを避けるため。
 */
export class App {
  /** セーブデータの読み込みで丸ごと差し替わる（シードが違えば地形から作り直すため）。 */
  sim: Simulation;
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
      onSave: () => void this.saveToBrowserAndFile(),
      onLoad: () => void this.loadFromFile(),
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

  /**
   * できあがった街を読み込む（チュートリアルを飛ばして仕組みを眺めたい人向け）。
   *
   * 初期人口を多めにしてあるのは意図的。600 人で始めると開いた直後は人口 1300 の
   * 集落で、道路がどこも容量の 1 割も使われず、交通シミュレーションが何も起こさない。
   * ベッドタウンの雇用が埋まって中心市街地への通勤が始まるのは人口 3000 を超えてから
   * （実測で 600 人開始なら域外通勤 0 人、2000 人開始なら 454 人）。
   * ここを増やしてもシナリオ構築時間は 2 割ほどしか伸びない（大半は 8 日ぶんの tick）。
   */
  startSample(): void {
    const result = buildScenario(this.sim, { size: 72, seedPopulation: 2000 });
    this.renderer.focusOn((tileX(result.center) + 0.5) * TILE_M, (tileY(result.center) + 0.5) * TILE_M);
    this.renderer.rig.distance = 520;
    this.renderer.invalidateOverlay();
    this.ui.cityName = 'サンプルの街';
    this.ui.tutorial.close();
  }

  // ---------------- セーブ / ロード ----------------

  /** 今の街をバイト列にする。 */
  saveData(): { data: ArrayBuffer; meta: SaveMeta } {
    const meta: SaveMeta = {
      cityName: this.ui.cityName,
      savedAt: Date.now(),
      population: this.sim.citizens.count(),
      dateJa: `${this.sim.clock.year}年${this.sim.clock.month}月${this.sim.clock.day}日`,
    };
    return { data: encodeSave(this.sim.snapshot(), meta), meta };
  }

  /**
   * セーブデータを読み込む。
   *
   * シードが違えば地形そのものが違うので、`Simulation` を作り直して差し替える。
   * 描画側は毎フレーム `sim` を引数で受け取る作りなので、差し替えても
   * キャッシュを捨てさせるだけで済む。
   */
  loadData(buf: ArrayBuffer): SaveMeta {
    const { snapshot, meta } = decodeSave(buf);
    if (snapshot.seed !== this.sim.seed) this.sim = new Simulation(snapshot.seed);
    this.sim.restoreSnapshot(snapshot);

    this.ui.cityName = meta.cityName;
    this.ui.selectedCitizen = -1;
    this.ui.selectedBuilding = 0;
    this.followCitizen = -1;
    this.probeFrom = -1;
    this.dragStart = -1;
    this.accumulator = 0;
    this.renderer.showRoute(null, this.sim);
    this.renderer.invalidateAll();
    this.renderer.setPreviewTiles([], null);
    this.focusOnCity();
    this.ui.tutorial.close();
    this.ui.pushAlert(`${meta.cityName}（${meta.dateJa}・人口 ${meta.population.toLocaleString('ja-JP')}）を読み込みました`, 'info');
    return meta;
  }

  /** 建物の重心へカメラを寄せる。読み込み直後に街を画面に入れるため。 */
  private focusOnCity(): void {
    const b = this.sim.buildings;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const s of b.each()) {
      const t = b.originTile[s]!;
      sx += tileX(t);
      sz += tileY(t);
      n++;
    }
    const center = n > 0 ? { x: sx / n, y: sz / n } : { x: MAP_W / 2, y: MAP_H / 2 };
    this.renderer.focusOn((center.x + 0.5) * TILE_M, (center.y + 0.5) * TILE_M);
  }

  /**
   * 保存。ブラウザ内（IndexedDB）とファイルの両方に書き出す。
   *
   * ブラウザ内は「続きから」用、ファイルは持ち運び用。片方だけだと、
   * 履歴を消した瞬間に街が消えるか、毎回ファイルを選ばされるかのどちらかになる。
   */
  private async saveToBrowserAndFile(): Promise<void> {
    try {
      const { data, meta } = this.saveData();
      downloadSave(data, defaultFileName(meta.cityName, meta.dateJa));
      await putSave(AUTO_SLOT, { meta, data });
      this.ui.pushAlert(`${meta.dateJa} の街を保存しました（${(data.byteLength / 1024 / 1024).toFixed(1)}MB）`, 'info');
    } catch (e) {
      this.ui.pushAlert(`保存に失敗しました: ${(e as Error).message}`, 'budgetDeficit');
    }
  }

  private async loadFromFile(): Promise<void> {
    try {
      const buf = await pickSaveFile();
      if (!buf) return;
      this.loadData(buf);
    } catch (e) {
      this.ui.pushAlert(`読み込みに失敗しました: ${(e as Error).message}`, 'budgetDeficit');
    }
  }

  // ---------------- 入力 ----------------

  private attachInput(): void {
    const canvas = this.canvas;

    // 右ドラッグはカメラの回転に使うので、ブラウザのコンテキストメニューは全面的に止める。
    // canvas だけに付けていたため、UI パネルの上で右ボタンを離すとメニューが出ていた。
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.shiftKey || e.altKey) return;
      const tile = this.renderer.pickTile(e.clientX, e.clientY, canvas, this.sim.world);
      if (tile < 0) return;
      this.dragStart = tile;
    });

    canvas.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      const tile = this.renderer.pickTile(e.clientX, e.clientY, canvas, this.sim.world);
      this.hoverTile = tile;
      this.renderer.setCursorTile(tile, this.sim.world);
      this.updatePreview();
      this.updateCursorTip();
    });

    canvas.addEventListener('pointerleave', () => {
      this.hoverTile = -1;
      this.renderer.setCursorTile(-1, null);
      this.renderer.setPreviewTiles([], null);
      this.ui.showCursorTip(0, 0, null);
    });

    const finish = (e: PointerEvent): void => {
      if (this.dragStart < 0) return;
      const from = this.dragStart;
      this.dragStart = -1;
      const to = this.renderer.pickTile(e.clientX, e.clientY, canvas, this.sim.world);
      this.updatePreview();
      if (to < 0) return;
      this.handleToolAction(from, to);
      this.updateCursorTip();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => {
      this.dragStart = -1;
      this.updatePreview();
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        this.setSpeed(this.speed === 0 ? 1 : 0);
      }
      if (e.key >= '1' && e.key <= '4') {
        this.setSpeed([0, 1, 4, 20][Number(e.key) - 1]!);
      }
      if (e.key === 'Enter') this.commitLine();
      if (e.key === 'Escape') {
        this.lineStops.length = 0;
        this.ui.selectedCitizen = -1;
        this.ui.selectedBuilding = 0;
        this.followCitizen = -1;
        this.probeFrom = -1;
        this.renderer.showRoute(null, this.sim);
      }
    });
  }

  /**
   * キーボード（数字キー・スペース）からの速度変更。
   * コマンドを積むのを忘れないこと — 「シード + コマンド列で同じ街が再現できる」
   * という前提が、ここだけ抜けていると成立しなくなる。
   */
  private setSpeed(s: number): void {
    this.speed = s;
    this.ui.currentSpeed = s;
    this.ui.setSpeed(s);
    this.sim.enqueue({ t: 'setSpeed', speed: s });
  }

  /**
   * これから何がどこに敷かれるかを地面に光らせる。
   *
   * ドラッグ中に終点のタイルだけを光らせていたので、道路を引いている最中は
   * 「どこからどこまで敷かれるのか」が確定するまで分からなかった。
   * 敷ける／敷けないもタイルごとに色で返す（斜面や水面は赤くなる）。
   */
  /**
   * ドラッグ範囲のタイル列。**1 フレームに 1 回だけ計算する。**
   *
   * `updatePreview()` と `updateCursorTip()` が毎フレーム別々に呼んでいたので、
   * マップ端から端まで矩形をドラッグすると 10 万タイルの配列を 1 フレームに
   * 2 本作り、`canZone` を 20 万回評価していた（そのうち描くのは先頭 4096 枚だけ）。
   */
  private previewCache: { key: string; tiles: number[] } | null = null;

  /** 路線ツールで押していった停留所。確定するまでコマンドにしない。 */
  private lineStops: number[] = [];

  /** 集めた停留所で路線を作る。2 箇所未満なら黙って捨てる。 */
  private commitLine(): void {
    if (this.lineStops.length < 2) {
      this.lineStops.length = 0;
      return;
    }
    this.sim.enqueue({
      t: 'createLine',
      kind: this.ui.tool.transitKind,
      stops: [...this.lineStops],
    });
    this.ui.pushAlert(`${this.lineStops.length} 箇所の路線を作りました`, 'info');
    this.lineStops.length = 0;
  }

  private dragTiles(): number[] {
    const tool = this.ui.tool;
    const key = `${tool.kind}:${tool.zone}:${tool.archetypeId}:${this.dragStart}:${this.hoverTile}`;
    if (this.previewCache && this.previewCache.key === key) return this.previewCache.tiles;
    const tiles = previewTiles(tool, this.dragStart, this.hoverTile);
    this.previewCache = { key, tiles };
    return tiles;
  }

  private updatePreview(): void {
    const t = this.hoverTile;
    if (t < 0) {
      this.renderer.setPreviewTiles([], null);
      return;
    }
    const tool = this.ui.tool;
    const w = this.sim.world;

    if (tool.kind === ToolKind.Place) {
      // 建物はフットプリント全体を出す（1×1 とは限らない）
      const a = archetype(tool.archetypeId);
      const ok = this.sim.canPlace(tool.archetypeId, t);
      const tiles: number[] = [];
      const flags: boolean[] = [];
      const x0 = tileX(t);
      const y0 = tileY(t);
      for (let dy = 0; dy < a.h; dy++) {
        for (let dx = 0; dx < a.w; dx++) {
          if (x0 + dx >= MAP_W || y0 + dy >= MAP_H) continue;
          tiles.push(idx(x0 + dx, y0 + dy));
          flags.push(ok);
        }
      }
      this.renderer.setPreviewTiles(tiles, w, flags);
      return;
    }

    // 範囲を持つ道具はドラッグ中だけ出す（ホバー中は黄色いカーソルで足りる）
    if (this.dragStart < 0) {
      this.renderer.setPreviewTiles([], null);
      return;
    }
    if (tool.kind === ToolKind.TransitLine) {
      // 押した停留所を光らせておく。何箇所まで置いたかが地図の上で分かる。
      const stops = [...this.lineStops, t];
      this.renderer.setPreviewTiles(stops, w, stops.map(() => true));
      return;
    }
    const tiles = this.dragTiles();
    const flags = tiles.map((i) => {
      if (tool.kind === ToolKind.Road) return w.canBuildRoad(i);
      if (tool.kind === ToolKind.Rail) return w.canBuildRail(i);
      if (tool.kind === ToolKind.Zone) return tool.zone === Zone.None || w.canZone(i, tool.zone);
      if (tool.kind === ToolKind.OneWay) return w.road[i] !== RoadClass.None;
      return true;
    });
    this.renderer.setPreviewTiles(tiles, w, flags);
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
      const tiles = this.dragStart >= 0 ? this.dragTiles() : [t];
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
      // プレビューと同じ判定を使う。1 タイルだけ見る `canBuildStructure` だと、
      // 2×2 の建物で左上 1 マスだけ空いている場所に「建てられます」と出たあと、
      // プレビューは赤く、クリックしても拒否される、という食い違いが起きる。
      const ok = this.sim.canPlace(tool.archetypeId, t);
      this.ui.showCursorTip(
        this.pointerX,
        this.pointerY,
        ok ? `${a.nameJa} / ${a.buildCost.toLocaleString('ja-JP')}円` : 'ここには建てられません',
      );
      return;
    }
    if (tool.kind === ToolKind.Zone) {
      const tiles = this.dragStart >= 0 ? this.dragTiles() : [t];
      const ok = tiles.filter((i) => tool.zone === Zone.None || w.canZone(i, tool.zone)).length;
      this.ui.showCursorTip(this.pointerX, this.pointerY, `${ok} / ${tiles.length} マスに指定できます`);
      return;
    }
    if (tool.kind === ToolKind.OneWay) {
      const tiles = this.dragStart >= 0 ? this.dragTiles() : [t];
      const roads = tiles.filter((i) => w.road[i] !== RoadClass.None).length;
      const dir = this.dragStart >= 0 ? dragDirection(this.dragStart, t) : OneWay.None;
      const name = ONE_WAY_NAMES_JA[dir] ?? '解除';
      this.ui.showCursorTip(
        this.pointerX,
        this.pointerY,
        roads === 0 ? '道路がありません' : `${roads} マスを ${name} 向きの一方通行に`,
      );
      return;
    }
    if (tool.kind === ToolKind.TransitLine) {
      this.ui.showCursorTip(
        this.pointerX,
        this.pointerY,
        this.lineStops.length === 0
          ? '最初の停留所をクリック'
          : `停留所 ${this.lineStops.length} 箇所（Enter で確定）`,
      );
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

    // 路線は「1 ドラッグ = 1 コマンド」に収まらない唯一の道具。
    // 停留所を順に押していき、Enter か最後の停留所の再クリックで確定する
    // （経路確認ツールが既に「1 点目を覚えて 2 点目で確定」をやっているので、
    //   その形を多点に広げただけ）。
    if (tool.kind === ToolKind.TransitLine) {
      if (this.lineStops.length > 0 && this.lineStops[this.lineStops.length - 1] === to) {
        this.commitLine();
        return;
      }
      this.lineStops.push(to);
      this.ui.pushAlert(
        `停留所 ${this.lineStops.length} 箇所。Enter か最後の停留所をもう一度クリックで確定します`,
        'info',
      );
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
      this.ui.selectedBuilding = 0;
      this.sim.activity.inspectedCitizen = bestId;
      return;
    }

    const ref = this.sim.world.buildingRef[tile]!;
    if (ref !== 0 && this.sim.buildings.alive[ref - 1] === 1) {
      this.ui.selectedBuilding = this.sim.buildings.handleOf(ref - 1);
      this.ui.selectedCitizen = -1;
      return;
    }
    this.ui.selectedCitizen = -1;
    this.ui.selectedBuilding = 0;
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
      } else {
        // 停止中も操作は効かせる。tick が回らないとコマンドが適用されず、
        // 道路を引いても現れない・課金もされない、という状態になっていた。
        this.sim.flushCommands();
      }

      this.drainEvents();

      if (this.followCitizen >= 0 && this.sim.citizens.isAlive(this.followCitizen)) {
        const pos = { x: 0, z: 0, heading: 0, edge: -1 };
        if (citizenPosition(this.sim.citizens, this.sim.graph, this.followCitizen, this.sim.clock.tick, pos)) {
          this.renderer.focusOn(pos.x, pos.z);
        }
      }

      // 道具を切り替えた直後にも反映されるよう、プレビューは毎フレーム取り直す
      this.updatePreview();

      if (this.ui.selectedCitizen >= 0) {
        this.renderer.showRoute(this.sim.citizens.tripPath[this.ui.selectedCitizen] ?? null, this.sim);
      }

      // 端数 tick を渡して補間させる。これが無いと車も人も 12 段階/秒で飛ぶ。
      // 停止中は端数 1 ＝「最後に計算した tick の終わり」＝今の状態を出す。
      this.renderer.render(this.sim, dt, this.speed > 0 ? this.accumulator : 1);
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
    // オーバーレイの色の更新間隔。地価や公害は日次で十分だが、交通量は
    // 分単位で動くので、1 日 1 回だと画面の色が実態から 30 分ずれる
    // （×1 速度で 1 日 = 32 実分）。渋滞が育つ様子が見えないと意味がない。
    const every = this.renderer.overlay === Overlay.Traffic ? OVERLAY_REFRESH_TICKS : TICKS_PER_DAY;
    if (this.sim.clock.tick % every === 0 && this.renderer.overlay !== Overlay.None) {
      this.renderer.invalidateOverlay();
    }
  }

  /** マップの中央タイル（デバッグ・テスト用）。 */
  static centerTile(): number {
    return idx(MAP_W >> 1, MAP_H >> 1);
  }
}
