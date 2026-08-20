import {
  ACTIVITY_NAMES_JA,
  GOOD_NAMES_JA,
  MODE_NAMES_JA,
  Overlay,
  SEASON_NAMES_JA,
  ZONE_NAMES_JA,
  Zone,
} from '@shared/enums';
import { CitizenFlag } from '@sim/agents/citizens';
import { SCHEDULE_NAMES_JA } from '@sim/agents/schedules';
import { archetype } from '@sim/buildings/archetypes';
import { handleSlot } from '@sim/buildings/buildings';
import type { AlertKind } from '@sim/core/events';
import type { Simulation } from '@sim/simulation';
import { MILESTONES, currentMilestone, isUnlocked, nextMilestone, requiredPopulation } from './milestones';
import { OVERLAY_ITEMS, TOOL_CATEGORIES, type ToolState, hintFor } from './tools';
import { TUTORIAL_STEPS, Tutorial, countCity } from './tutorial';

/**
 * 日本語 UI。Cities: Skylines のレイアウトに寄せてある。
 *
 * 素の DOM で組み、更新は 4Hz。60fps の描画ループの隣で
 * 仮想 DOM の差分計算を走らせたくないので、フレームワークは使わない。
 */

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btn = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', undefined, label) as HTMLButtonElement;
  b.onclick = onClick;
  return b;
};

const yen = (v: number): string => `${Math.round(v).toLocaleString('ja-JP')}円`;
const man = (v: number): string => `${Math.round(v / 10000).toLocaleString('ja-JP')}万円`;

export interface UiCallbacks {
  onSpeed(speed: number): void;
  onTool(patch: Partial<ToolState>): void;
  onOverlay(o: Overlay): void;
  onTax(zone: Zone, pct: number): void;
  onFollowCitizen(): void;
  onSave(): void;
  onLoad(): void;
}

export class Ui {
  private readonly root: HTMLElement;
  private readonly cb: UiCallbacks;
  readonly tool: ToolState;
  readonly tutorial = new Tutorial();

  /** 都市名。 */
  cityName = 'あたらしい街';

  private cityInfo!: HTMLElement;
  private milestoneBox!: HTMLElement;
  private subtools!: HTMLElement;
  private categories!: HTMLElement;
  private demandBox!: HTMLElement;
  private inspector!: HTMLElement;
  private statsPanel!: HTMLElement;
  private statsToggle!: HTMLButtonElement;
  private alertsPanel!: HTMLElement;
  private tutorialBox!: HTMLElement;
  private hint!: HTMLElement;
  private cursorTip!: HTMLElement;

  private categoryButtons = new Map<string, HTMLButtonElement>();
  private itemButtons = new Map<string, HTMLButtonElement>();
  private overlayButtons = new Map<string, HTMLButtonElement>();
  private speedButtons: HTMLButtonElement[] = [];
  private rciFills: HTMLElement[] = [];

  private openCategory: string | null = null;
  private alerts: { message: string; kind: AlertKind }[] = [];
  private lastUpdate = 0;
  private lastPopulationForUnlocks = -1;
  private celebrateUntil = 0;

  selectedCitizen = -1;
  selectedBuilding = -1;

  constructor(root: HTMLElement, tool: ToolState, cb: UiCallbacks) {
    this.root = root;
    this.tool = tool;
    this.cb = cb;
    this.buildHint();
    this.buildCityInfo();
    this.buildMilestone();
    this.buildToolbar();
    this.buildDemandBox();
    this.buildInspector();
    this.buildStats();
    this.buildAlerts();
    this.buildTutorial();
    this.buildCursorTip();
  }

  // ================= 構築 =================

  private buildCityInfo(): void {
    this.cityInfo = el('div', 'panel');
    this.cityInfo.id = 'cityinfo';
    this.root.appendChild(this.cityInfo);
  }

  private buildMilestone(): void {
    this.milestoneBox = el('div', 'panel');
    this.milestoneBox.id = 'milestone';
    this.root.appendChild(this.milestoneBox);
  }

  private buildToolbar(): void {
    const bar = el('div');
    bar.id = 'toolbar';

    this.subtools = el('div');
    this.subtools.id = 'subtools';
    bar.appendChild(this.subtools);

    this.categories = el('div');
    this.categories.id = 'categories';
    for (const cat of TOOL_CATEGORIES) {
      const b = el('button') as HTMLButtonElement;
      b.appendChild(el('span', 'icon', cat.icon));
      b.appendChild(el('span', undefined, cat.labelJa));
      b.onclick = (): void => this.toggleCategory(cat.key);
      this.categoryButtons.set(cat.key, b);
      this.categories.appendChild(b);
    }
    bar.appendChild(this.categories);
    this.root.appendChild(bar);
  }

  private buildDemandBox(): void {
    this.demandBox = el('div', 'panel');
    this.demandBox.id = 'demandbox';

    const rci = el('div');
    rci.id = 'rci';
    const colors = ['var(--r)', 'var(--c)', 'var(--i)', 'var(--a)'];
    const labels = ['住', '商', '工', '農'];
    for (let i = 0; i < 4; i++) {
      const col = el('div', 'col');
      // 上半分が正の需要、下半分が負の需要。中央が 0。
      const bar = el('div', 'bar');
      const up = el('i', 'up');
      const down = el('i', 'down');
      up.style.background = colors[i]!;
      down.style.background = colors[i]!;
      up.style.height = '0%';
      down.style.height = '0%';
      bar.appendChild(up);
      bar.appendChild(down);
      this.rciFills.push(up, down);
      col.appendChild(bar);
      col.appendChild(el('div', 'lab', labels[i]!));
      rci.appendChild(col);
    }
    this.demandBox.appendChild(rci);

    const ov = el('div');
    ov.id = 'overlays';
    for (const item of OVERLAY_ITEMS) {
      const b = btn(item.labelJa, () => {
        this.cb.onOverlay(item.overlay);
        this.markOverlay(item.key);
      });
      this.overlayButtons.set(item.key, b);
      ov.appendChild(b);
    }
    this.demandBox.appendChild(ov);
    this.root.appendChild(this.demandBox);
    this.markOverlay(`overlay:${Overlay.None}`);
  }

  private buildInspector(): void {
    this.inspector = el('div', 'panel');
    this.inspector.id = 'inspector';
    this.root.appendChild(this.inspector);
  }

  private buildStats(): void {
    this.statsToggle = btn('統計 ▸', () => {
      this.statsPanel.classList.toggle('open');
      this.statsToggle.textContent = this.statsPanel.classList.contains('open') ? '統計 ◂' : '統計 ▸';
    });
    this.statsToggle.id = 'statsToggle';
    this.root.appendChild(this.statsToggle);

    this.statsPanel = el('div', 'panel');
    this.statsPanel.id = 'stats';
    this.root.appendChild(this.statsPanel);
  }

  private buildAlerts(): void {
    this.alertsPanel = el('div', 'panel');
    this.alertsPanel.id = 'alerts';
    this.root.appendChild(this.alertsPanel);
  }

  private buildTutorial(): void {
    this.tutorialBox = el('div', 'panel');
    this.tutorialBox.id = 'tutorial';
    this.root.appendChild(this.tutorialBox);
  }

  private buildHint(): void {
    this.hint = el('div', 'panel');
    this.hint.id = 'hint';
    this.root.appendChild(this.hint);
  }

  private buildCursorTip(): void {
    this.cursorTip = el('div');
    this.cursorTip.id = 'cursorTip';
    this.root.appendChild(this.cursorTip);
  }

  // ================= ツール操作 =================

  private toggleCategory(key: string): void {
    this.openCategory = this.openCategory === key ? null : key;
    this.renderSubtools();
    this.markCategories();
  }

  private renderSubtools(): void {
    this.subtools.replaceChildren();
    this.itemButtons.clear();
    if (!this.openCategory) {
      this.subtools.classList.remove('open');
      return;
    }
    const cat = TOOL_CATEGORIES.find((c) => c.key === this.openCategory);
    if (!cat) return;
    this.subtools.classList.add('open');
    for (const item of cat.items) {
      const b = el('button') as HTMLButtonElement;
      const head = el('span');
      if (item.swatch !== undefined) {
        const s = el('span', 'swatch');
        s.style.background = `#${item.swatch.toString(16).padStart(6, '0')}`;
        head.appendChild(s);
      }
      head.appendChild(document.createTextNode(item.labelJa));
      b.appendChild(head);
      if (item.costJa) b.appendChild(el('span', 'cost', item.costJa));
      b.onclick = (): void => {
        if (b.disabled) return;
        this.setTool(item.apply);
      };
      this.itemButtons.set(item.key, b);
      this.subtools.appendChild(b);
    }
    this.lastPopulationForUnlocks = -1; // 解禁状態を貼り直させる
  }

  private setTool(patch: Partial<ToolState>): void {
    Object.assign(this.tool, patch);
    this.cb.onTool(patch);
    this.markItems();
    this.hint.textContent = hintFor(this.tool);
  }

  private markCategories(): void {
    for (const [key, b] of this.categoryButtons) b.classList.toggle('active', key === this.openCategory);
  }

  private markItems(): void {
    for (const [key, b] of this.itemButtons) {
      let active = false;
      if (key === `tool:${this.tool.kind}`) active = true;
      if (this.tool.kind === 'road' && key === `road:${this.tool.roadClass}`) active = true;
      if (this.tool.kind === 'zone' && key === `zone:${this.tool.zone}`) active = true;
      if (this.tool.kind === 'place' && key === `place:${this.tool.archetypeId}`) active = true;
      b.classList.toggle('active', active);
    }
  }

  private markOverlay(key: string): void {
    for (const [k, b] of this.overlayButtons) b.classList.toggle('active', k === key);
  }

  setSpeed(speed: number): void {
    for (const b of this.speedButtons) b.classList.toggle('active', Number(b.dataset.speed) === speed);
  }

  pushAlert(message: string, kind: AlertKind): void {
    this.alerts.unshift({ message, kind });
    if (this.alerts.length > 40) this.alerts.pop();
    this.alertsPanel.classList.add('open');
  }

  /** カーソル横のツールチップ（費用・地形情報）。 */
  showCursorTip(x: number, y: number, text: string | null): void {
    if (!text) {
      this.cursorTip.style.display = 'none';
      return;
    }
    this.cursorTip.style.display = 'block';
    this.cursorTip.style.left = `${x + 16}px`;
    this.cursorTip.style.top = `${y + 18}px`;
    this.cursorTip.textContent = text;
  }

  // ================= 更新（4Hz） =================

  update(
    sim: Simulation,
    now: number,
    fps: number,
    drawCalls: number,
    visibleAgents: number,
    visibleVehicles = 0,
  ): void {
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;

    const counts = countCity(sim);
    if (this.tutorial.update(counts, sim)) this.celebrateUntil = now + 900;

    this.renderCityInfo(sim);
    this.renderMilestone(counts.population);
    this.renderDemand(sim);
    this.applyUnlocks(counts.population);
    this.renderInspector(sim);
    this.renderStats(sim, fps, drawCalls, visibleAgents, visibleVehicles);
    this.renderAlerts();
    this.renderTutorial(now);
  }

  private renderCityInfo(sim: Simulation): void {
    const s = sim.stats();
    this.cityInfo.replaceChildren();
    this.cityInfo.appendChild(el('div', 'name', this.cityName));

    const grid = el('div', 'grid');
    const add = (k: string, v: string, cls?: string): void => {
      grid.appendChild(el('div', 'k', k));
      grid.appendChild(el('div', `v${cls ? ' ' + cls : ''}`, v));
    };
    add('人口', s.population.toLocaleString('ja-JP'));
    add('資金', man(s.cash), s.cash < 0 ? 'bad' : undefined);
    // 決算を待たずに今の収支が分かるようにする
    const net = s.finance.net;
    add('収支/月', `${net >= 0 ? '+' : ''}${man(net)}`, net < 0 ? 'bad' : net > 0 ? 'good' : undefined);
    add('幸福度', `${Math.round((s.avgHappiness / 255) * 100)}%`, s.avgHappiness < 90 ? 'bad' : s.avgHappiness > 170 ? 'good' : undefined);
    const jobless = s.employed + s.unemployed;
    add('失業率', jobless > 0 ? `${Math.round((s.unemployed / jobless) * 100)}%` : '—', s.unemployed > s.employed * 0.2 ? 'bad' : undefined);
    this.cityInfo.appendChild(grid);

    const clock = el('div', 'clock');
    clock.appendChild(
      el(
        'div',
        'date',
        `${sim.clock.year}年${sim.clock.month}月${sim.clock.day}日 ${String(sim.clock.hour).padStart(2, '0')}:${String(sim.clock.minute).padStart(2, '0')} ${SEASON_NAMES_JA[sim.clock.season]!}`,
      ),
    );
    const sc = el('div');
    sc.id = 'speed';
    this.speedButtons = [];
    for (const [label, speed] of [
      // 1 日はそれぞれ実時間 32 / 8 / 1.6 分。×1 は街を眺めるための速度で、
      // 人も車も電車も現実的な速さに見える。発展させたいときは早送りする。
      ['❚❚', 0],
      ['▶', 1],
      ['▶▶', 4],
      ['▶▶▶', 20],
    ] as const) {
      const b = btn(label, () => {
        this.cb.onSpeed(speed);
        this.setSpeed(speed);
      });
      b.dataset.speed = String(speed);
      this.speedButtons.push(b);
      sc.appendChild(b);
    }
    clock.appendChild(sc);

    // セーブ / ロード。時計の下に置くのは、時間を止めてから保存する動線が自然なため。
    const io = el('div');
    io.id = 'saveio';
    io.appendChild(btn('保存', () => this.cb.onSave()));
    io.appendChild(btn('読込', () => this.cb.onLoad()));
    clock.appendChild(io);
    this.cityInfo.appendChild(clock);
    this.setSpeed(this.currentSpeed);
  }

  /** App から現在の速度を教えてもらう（再描画で active を復元するため）。 */
  currentSpeed = 1;

  private renderMilestone(population: number): void {
    const idx = currentMilestone(population);
    const cur = MILESTONES[idx]!;
    const next = nextMilestone(population);
    this.milestoneBox.replaceChildren();
    this.milestoneBox.appendChild(el('h3', undefined, 'マイルストーン'));
    this.milestoneBox.appendChild(el('div', 'rank', cur.nameJa));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    if (next) {
      const from = cur.population;
      const span = Math.max(1, next.population - from);
      fill.style.width = `${Math.max(2, Math.min(100, ((population - from) / span) * 100))}%`;
    } else {
      fill.style.width = '100%';
    }
    track.appendChild(fill);
    this.milestoneBox.appendChild(track);
    this.milestoneBox.appendChild(
      el(
        'div',
        'next',
        next
          ? `次: ${next.nameJa}（人口 ${next.population.toLocaleString('ja-JP')}）— ${next.summaryJa}`
          : 'すべて到達しました',
      ),
    );
  }

  private renderDemand(sim: Simulation): void {
    const d = sim.stats().demand;
    const values = [d.residential, d.commercial, d.industrial, d.agriculture];
    for (let i = 0; i < 4; i++) {
      const v = Math.max(-100, Math.min(100, values[i]!));
      // 高さはトラック全体（＝上下 2 分割）に対する割合なので半分にする。
      // 需要 100 で上半分をちょうど埋める。
      this.rciFills[i * 2]!.style.height = `${Math.max(0, v) / 2}%`;
      this.rciFills[i * 2 + 1]!.style.height = `${Math.max(0, -v) / 2}%`;
    }
  }

  /** マイルストーンに応じてツールの有効・無効を切り替える。 */
  private applyUnlocks(population: number): void {
    if (population === this.lastPopulationForUnlocks) return;
    this.lastPopulationForUnlocks = population;
    for (const cat of TOOL_CATEGORIES) {
      for (const item of cat.items) {
        const b = this.itemButtons.get(item.key);
        if (!b) continue;
        if (!item.unlock) {
          b.disabled = false;
          continue;
        }
        const ok = isUnlocked(item.unlock, population);
        b.disabled = !ok;
        const existing = b.querySelector('.lock');
        if (existing) existing.remove();
        if (!ok) {
          b.appendChild(el('span', 'lock', `人口 ${requiredPopulation(item.unlock)} で解禁`));
        }
      }
    }
  }

  private renderTutorial(now: number): void {
    if (!this.tutorial.enabled) {
      this.tutorialBox.style.display = 'none';
      for (const b of this.categoryButtons.values()) b.classList.remove('pulse');
      return;
    }
    this.tutorialBox.style.display = '';
    this.tutorialBox.classList.toggle('celebrate', now < this.celebrateUntil);
    const step = this.tutorial.step;
    this.tutorialBox.replaceChildren();
    this.tutorialBox.appendChild(
      el('div', 'step', `チュートリアル ${Math.min(this.tutorial.stepIndex + 1, this.tutorial.total)} / ${this.tutorial.total}`),
    );
    this.tutorialBox.appendChild(el('div', 'title', step.titleJa));
    this.tutorialBox.appendChild(el('div', 'body', step.bodyJa));

    const actions = el('div', 'actions');
    if (!this.tutorial.isFinished) {
      actions.appendChild(
        btn('このステップを飛ばす', () => {
          this.tutorial.completed[this.tutorial.stepIndex] = true;
          // 1 つ進める（達成判定を待たずに）
          (this.tutorial as unknown as { index: number }).index++;
        }),
      );
    }
    actions.appendChild(
      btn(this.tutorial.isFinished ? '閉じる' : 'チュートリアルを終了', () => this.tutorial.close()),
    );
    this.tutorialBox.appendChild(actions);

    // 指示されたカテゴリを光らせる
    for (const [key, b] of this.categoryButtons) {
      b.classList.toggle('pulse', step.highlight === key && this.openCategory !== key);
    }
  }

  private renderInspector(sim: Simulation): void {
    if (this.selectedCitizen < 0 && this.selectedBuilding < 0) {
      this.inspector.style.display = 'none';
      return;
    }
    this.inspector.style.display = 'block';
    this.inspector.replaceChildren();

    const row = (k: string, v: string, cls?: string): void => {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', `v${cls ? ' ' + cls : ''}`, v));
      this.inspector.appendChild(r);
    };

    if (this.selectedCitizen >= 0) {
      const c = sim.citizens;
      const id = this.selectedCitizen;
      if (!c.isAlive(id)) {
        this.selectedCitizen = -1;
        this.inspector.style.display = 'none';
        return;
      }
      this.inspector.appendChild(el('div', 'title', `市民 #${id}`));
      row('年齢', `${c.age[id]} 歳`);
      row('生活パターン', SCHEDULE_NAMES_JA[c.scheduleId[id]!] ?? '—');
      row('学歴', ['なし', '中卒', '高卒', '専門・短大', '大卒'][c.education[id]!] ?? '—');
      row('月収', c.incomeYenMo[id]! > 0 ? yen(c.incomeYenMo[id]!) : '無職');
      row('幸福度', `${Math.round((c.happiness[id]! / 255) * 100)}%`);
      row('いまの行動', ACTIVITY_NAMES_JA[c.state[id]!] ?? '—');

      const home = c.homeBuilding[id]!;
      const work = c.workBuilding[id]!;
      row('自宅', sim.buildings.valid(home) ? archetype(sim.buildings.archetypeId[handleSlot(home)]!).nameJa : 'なし');
      row('職場', sim.buildings.valid(work) ? archetype(sim.buildings.archetypeId[handleSlot(work)]!).nameJa : 'なし');
      row('直近の通勤時間', c.lastCommuteMin[id]! > 0 ? `${c.lastCommuteMin[id]} 分` : '—');
      row('自動車 / 定期券', `${c.has(id, CitizenFlag.OwnsCar) ? '有' : '無'} / ${c.has(id, CitizenFlag.TransitPass) ? '有' : '無'}`);
      row('完了した移動', String(c.tripsCompleted[id]));

      this.inspector.appendChild(el('hr'));
      this.inspector.appendChild(el('h3', undefined, '交通手段の好み（体感分）'));
      row('徒歩 / 自転車', `${c.prefWalk[id]} / ${c.prefBike[id]}`);
      row('自動車 / 鉄道', `${c.prefCar[id]} / ${c.prefRail[id]}`);

      const explain = sim.activity.lastChoiceExplanation;
      if (explain) {
        this.inspector.appendChild(el('hr'));
        this.inspector.appendChild(el('h3', undefined, '直近の交通手段の選び方'));
        const chosen = c.mode[id]!;
        for (const o of explain) {
          const line = el('div', `mode-line${o.mode === chosen ? ' chosen' : ''}${o.available ? '' : ' unavailable'}`);
          line.appendChild(el('span', undefined, MODE_NAMES_JA[o.mode]!));
          line.appendChild(
            el(
              'span',
              undefined,
              o.available
                ? `${o.timeMin.toFixed(0)}分 ${Math.round(o.costYen)}円 → ${(o.probability * 100).toFixed(0)}%`
                : '利用不可',
            ),
          );
          this.inspector.appendChild(line);
        }
      }

      this.inspector.appendChild(el('hr'));
      const actions = el('div', 'actions');
      actions.appendChild(btn('この市民を追う', () => this.cb.onFollowCitizen()));
      actions.appendChild(
        btn('閉じる', () => {
          this.selectedCitizen = -1;
        }),
      );
      this.inspector.appendChild(actions);
      return;
    }

    // --- 建物 ---
    const slot = this.selectedBuilding;
    if (sim.buildings.alive[slot] !== 1) {
      this.selectedBuilding = -1;
      this.inspector.style.display = 'none';
      return;
    }
    const a = archetype(sim.buildings.archetypeId[slot]!);
    this.inspector.appendChild(el('div', 'title', `${a.nameJa}（Lv${sim.buildings.level[slot]}）`));
    row('用途地域', ZONE_NAMES_JA[a.zone] ?? '—');
    if (a.households > 0) row('入居世帯', `${sim.buildings.residents[slot]} / ${sim.buildings.capacityResidents[slot]}`);
    if (a.jobs > 0) row('就業者', `${sim.buildings.jobsFilled[slot]} / ${sim.buildings.jobsTotal[slot]}`);
    row('接道', sim.buildings.accessTile[slot]! >= 0 ? 'あり' : 'なし（成長できません）', sim.buildings.accessTile[slot]! >= 0 ? undefined : 'bad');
    row('魅力度', `${Math.round((sim.buildings.desirability[slot]! / 255) * 100)}%`);

    if (a.inputs.length > 0 || a.output !== 0) {
      this.inspector.appendChild(el('hr'));
      this.inspector.appendChild(el('h3', undefined, '在庫と取引'));
      a.inputs.forEach((inp, k) => {
        const amt = k === 0 ? sim.buildings.inAmtA[slot]! : sim.buildings.inAmtB[slot]!;
        row(`入荷 ${GOOD_NAMES_JA[inp.good]!}`, `${amt.toFixed(0)} / ${a.storage}`, amt < 1 ? 'bad' : undefined);
        const sup = sim.freight.supplierOf(slot, k);
        row(
          '　仕入先',
          sup >= 0 && sim.buildings.alive[sup] === 1 ? archetype(sim.buildings.archetypeId[sup]!).nameJa : '未確保',
          sup >= 0 ? undefined : 'warn',
        );
      });
      if (a.output !== 0) row(`出荷 ${GOOD_NAMES_JA[a.output]!}`, `${sim.buildings.outAmt[slot]!.toFixed(0)} / ${a.storage}`);
      if (sim.buildings.stockoutDays[slot]! > 0) {
        row('状態', `${sim.buildings.stockoutDays[slot]} 日間 在庫切れ`, 'bad');
      }
    }

    this.inspector.appendChild(el('hr'));
    this.inspector.appendChild(
      btn('閉じる', () => {
        this.selectedBuilding = -1;
      }),
    );
  }

  private renderStats(
    sim: Simulation,
    fps: number,
    drawCalls: number,
    visibleAgents: number,
    visibleVehicles: number,
  ): void {
    if (!this.statsPanel.classList.contains('open')) return;
    const s = sim.stats();
    this.statsPanel.replaceChildren();
    const row = (k: string, v: string, cls?: string): void => {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', `v${cls ? ' ' + cls : ''}`, v));
      this.statsPanel.appendChild(r);
    };
    const head = (t: string): void => {
      this.statsPanel.appendChild(el('hr'));
      this.statsPanel.appendChild(el('h3', undefined, t));
    };

    this.statsPanel.appendChild(el('h3', undefined, '市民'));
    row('就業 / 失業', `${s.employed.toLocaleString('ja-JP')} / ${s.unemployed.toLocaleString('ja-JP')}`);
    row('住居なし', String(s.homeless), s.homeless > 0 ? 'bad' : undefined);
    row('平均通勤時間', `${s.avgCommuteMin.toFixed(0)} 分`);
    row('1日の移動数', s.tripsCompleted.toLocaleString('ja-JP'));
    row('移動失敗', String(s.tripsFailed), s.tripsFailed > 20 ? 'bad' : undefined);

    head('交通分担率');
    for (let m = 0; m < 4; m++) row(MODE_NAMES_JA[m]!, `${Math.round((s.modeShare[m] ?? 0) * 100)}%`);

    head('道路の混雑');
    const tf = s.traffic;
    row('走行中の車両', tf.running.toLocaleString('ja-JP'));
    row(
      '信号待ち・渋滞',
      `${tf.waiting.toLocaleString('ja-JP')} 台`,
      tf.running > 0 && tf.waiting > tf.running * 0.5 ? 'bad' : tf.waiting > 0 ? 'warn' : undefined,
    );
    row(
      '詰まっている道路',
      `${(tf.congestedShare * 100).toFixed(1)}%`,
      tf.congestedShare > 0.05 ? 'bad' : tf.congestedShare > 0.01 ? 'warn' : undefined,
    );
    row('所要時間の倍率', `×${tf.avgDelay.toFixed(2)}`, tf.avgDelay > 1.5 ? 'bad' : tf.avgDelay > 1.2 ? 'warn' : undefined);

    head('産業・物流');
    for (let g = 1; g < 7; g++) {
      row(GOOD_NAMES_JA[g]!, `${Math.round(s.goodsStock[g] ?? 0).toLocaleString('ja-JP')} (時 +${(s.goodsProduced[g] ?? 0).toFixed(0)})`);
    }
    row('稼働トラック', String(s.trucksActive));
    row('累計配送', sim.freight.totalDelivered.toLocaleString('ja-JP'));
    row('在庫切れ', String(s.stockouts), s.stockouts > 20 ? 'bad' : undefined);

    // 決算を待たずに今の収支が見えるようにする（月換算の run-rate）
    head('収支（今の月換算）');
    const f = s.finance;
    row('住民税・固定資産税', man(f.incomeResidential));
    row('商業', man(f.incomeCommercial));
    row('工業', man(f.incomeIndustrial));
    row('農林', man(f.incomeAgriculture));
    row('収入 合計', man(f.income), 'good');
    row('道路 維持', `-${man(f.upkeepRoads)}`);
    row('鉄道 維持', `-${man(f.upkeepRail)}`);
    row('施設 維持', `-${man(f.upkeepServices)}`);
    row('支出 合計', `-${man(f.expense)}`, 'bad');
    row('収支', `${f.net >= 0 ? '+' : ''}${man(f.net)}`, f.net < 0 ? 'bad' : 'good');
    row('今月の建設費', `-${man(s.capexThisMonth)}`);
    if (s.deficitMonths > 0) row('赤字が続いた月数', String(s.deficitMonths), 'bad');

    head('財政');
    row('建物数', s.buildings.toLocaleString('ja-JP'));
    if (s.lastReport) {
      row('先月の収支', `${s.lastReport.net >= 0 ? '+' : ''}${man(s.lastReport.net)}`, s.lastReport.net < 0 ? 'bad' : 'good');
      row('先月の建設費', `-${man(s.lastReport.capex)}`);
    }
    for (const [label, zone] of [
      ['住宅税', Zone.ResidentialLow],
      ['商業税', Zone.CommercialLocal],
      ['工業税', Zone.IndustrialLight],
    ] as const) {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', label));
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '20';
      input.step = '1';
      input.value = String(sim.budget.taxPct[zone] ?? 9);
      input.style.width = '88px';
      const out = el('span', 'v', `${input.value}%`);
      input.oninput = (): void => {
        out.textContent = `${input.value}%`;
        this.cb.onTax(zone, Number(input.value));
      };
      r.appendChild(input);
      r.appendChild(out);
      this.statsPanel.appendChild(r);
    }

    head('動作状況');
    row('FPS', String(Math.round(fps)));
    row('ドローコール', String(drawCalls));
    row('描画中の市民', String(visibleAgents));
    row('描画中の車両', String(visibleVehicles));
    row('経路キャッシュ率', `${Math.round(s.cacheHitRate * 100)}%`);
    row('経路探索/tick', String(s.searchesThisTick));
    row('出発準備待ち', String(s.routeQueueDepth));
    row('グラフ規模', `${sim.graph.nodeCount} 節点`);

    head('チュートリアル');
    for (let i = 0; i < TUTORIAL_STEPS.length - 1; i++) {
      row(TUTORIAL_STEPS[i]!.titleJa, this.tutorial.completed[i] ? '✓' : '—', this.tutorial.completed[i] ? 'good' : undefined);
    }
  }

  private renderAlerts(): void {
    if (this.alerts.length === 0) {
      this.alertsPanel.classList.remove('open');
      return;
    }
    this.alertsPanel.replaceChildren(el('h3', undefined, '通知'));
    for (const a of this.alerts.slice(0, 8)) this.alertsPanel.appendChild(el('div', 'alert', a.message));
  }
}
