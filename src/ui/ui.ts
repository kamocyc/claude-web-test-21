import {
  ACTIVITY_NAMES_JA,
  GOOD_NAMES_JA,
  MODE_NAMES_JA,
  OVERLAY_NAMES_JA,
  Overlay,
  ROAD_NAMES_JA,
  RoadClass,
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
import { ZONE_COLORS } from '@render/theme';
import { PLACEABLE_ARCHETYPES, ToolKind, hintFor, type ToolState } from './tools';

/**
 * 日本語 UI。素の DOM で組み、更新は 4Hz。
 *
 * 60fps の描画ループの隣で仮想 DOM の差分計算を走らせたくないので、
 * フレームワークは使わない。パネル数は固定で、更新頻度も低い。
 */

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const yen = (v: number): string => `${Math.round(v).toLocaleString('ja-JP')}円`;
const man = (v: number): string => `${Math.round(v / 10000).toLocaleString('ja-JP')}万円`;

export interface UiCallbacks {
  onSpeed(speed: number): void;
  onTool(state: Partial<ToolState>): void;
  onOverlay(o: Overlay): void;
  onTax(zone: Zone, pct: number): void;
  onFollowCitizen(): void;
}

export class Ui {
  private readonly root: HTMLElement;
  private readonly cb: UiCallbacks;
  readonly tool: ToolState;

  private topbar!: HTMLElement;
  private sidebar!: HTMLElement;
  private inspector!: HTMLElement;
  private alertsPanel!: HTMLElement;
  private hint!: HTMLElement;
  private speedButtons: HTMLButtonElement[] = [];
  private toolButtons = new Map<string, HTMLButtonElement>();

  private alerts: { message: string; kind: AlertKind }[] = [];
  private lastUpdate = 0;

  /** 選択中の市民 / 建物。 */
  selectedCitizen = -1;
  selectedBuilding = -1;

  constructor(root: HTMLElement, tool: ToolState, cb: UiCallbacks) {
    this.root = root;
    this.tool = tool;
    this.cb = cb;
    // ヒント欄はツールパレットの初期表示から参照されるので、先に作る
    this.buildHint();
    this.buildTopbar();
    this.buildToolbar();
    this.buildSidebar();
    this.buildInspector();
    this.buildAlerts();
  }

  // ---------------- 構築 ----------------

  private buildTopbar(): void {
    this.topbar = el('div', 'panel');
    this.topbar.id = 'topbar';
    this.root.appendChild(this.topbar);
  }

  private buildToolbar(): void {
    const bar = el('div', 'panel');
    bar.id = 'toolbar';

    const group = (title: string): HTMLElement => {
      const g = el('div', 'group');
      g.appendChild(el('div', 'group-title', title));
      const b = el('div', 'buttons');
      g.appendChild(b);
      bar.appendChild(g);
      return b;
    };

    const mkBtn = (key: string, label: string, onClick: () => void, swatch?: number): HTMLButtonElement => {
      const b = el('button') as HTMLButtonElement;
      if (swatch !== undefined) {
        const s = el('span', 'swatch');
        s.style.background = `#${swatch.toString(16).padStart(6, '0')}`;
        b.appendChild(s);
      }
      b.appendChild(document.createTextNode(label));
      b.onclick = onClick;
      this.toolButtons.set(key, b);
      return b;
    };

    // --- 操作 ---
    const g0 = group('操作');
    g0.appendChild(mkBtn('tool:select', '選択', () => this.setTool({ kind: ToolKind.Select })));
    g0.appendChild(mkBtn('tool:bulldoze', '撤去', () => this.setTool({ kind: ToolKind.Bulldoze })));
    g0.appendChild(mkBtn('tool:route', '経路確認', () => this.setTool({ kind: ToolKind.RouteProbe })));

    // --- 道路 ---
    const g1 = group('道路');
    for (const cls of [RoadClass.Street, RoadClass.Avenue, RoadClass.Boulevard]) {
      g1.appendChild(
        mkBtn(`road:${cls}`, ROAD_NAMES_JA[cls]!, () => this.setTool({ kind: ToolKind.Road, roadClass: cls })),
      );
    }

    // --- 鉄道 ---
    const g2 = group('鉄道');
    g2.appendChild(mkBtn('tool:rail', '線路', () => this.setTool({ kind: ToolKind.Rail })));

    // --- 用途地域 ---
    const g3 = group('用途地域');
    const zones: Zone[] = [
      Zone.ResidentialLow,
      Zone.ResidentialMid,
      Zone.CommercialLocal,
      Zone.CommercialCentral,
      Zone.IndustrialLight,
      Zone.IndustrialHeavy,
      Zone.AgriPaddy,
      Zone.AgriField,
      Zone.Forestry,
      Zone.None,
    ];
    for (const z of zones) {
      g3.appendChild(
        mkBtn(
          `zone:${z}`,
          z === Zone.None ? '解除' : ZONE_NAMES_JA[z]!,
          () => this.setTool({ kind: ToolKind.Zone, zone: z }),
          ZONE_COLORS[z],
        ),
      );
    }

    // --- 施設 ---
    const g4 = group('公共施設');
    for (const a of PLACEABLE_ARCHETYPES) {
      g4.appendChild(
        mkBtn(`place:${a.id}`, a.name, () => this.setTool({ kind: ToolKind.Place, archetypeId: a.id })),
      );
    }

    // --- 表示 ---
    const g5 = group('情報表示');
    for (const o of [Overlay.None, Overlay.Zone, Overlay.LandValue, Overlay.Traffic, Overlay.Pollution, Overlay.TransitAccess]) {
      const b = mkBtn(`overlay:${o}`, OVERLAY_NAMES_JA[o]!, () => {
        this.cb.onOverlay(o);
        this.markOverlay(o);
      });
      g5.appendChild(b);
    }

    this.root.appendChild(bar);
    this.markTool();
    this.markOverlay(Overlay.None);
  }

  private buildSidebar(): void {
    this.sidebar = el('div', 'panel');
    this.sidebar.id = 'sidebar';
    this.root.appendChild(this.sidebar);
  }

  private buildInspector(): void {
    this.inspector = el('div', 'panel');
    this.inspector.id = 'inspector';
    this.inspector.style.display = 'none';
    this.root.appendChild(this.inspector);
  }

  private buildAlerts(): void {
    this.alertsPanel = el('div', 'panel');
    this.alertsPanel.id = 'alerts';
    this.alertsPanel.appendChild(el('h3', undefined, '通知'));
    this.root.appendChild(this.alertsPanel);
  }

  private buildHint(): void {
    this.hint = el('div', 'panel');
    this.hint.id = 'hint';
    this.root.appendChild(this.hint);
  }

  // ---------------- 状態 ----------------

  private setTool(patch: Partial<ToolState>): void {
    Object.assign(this.tool, patch);
    this.cb.onTool(patch);
    this.markTool();
    this.hint.textContent = hintFor(this.tool);
  }

  private markTool(): void {
    for (const [key, btn] of this.toolButtons) {
      if (key.startsWith('overlay:')) continue;
      let active = false;
      if (key === `tool:${this.tool.kind}`) active = true;
      if (this.tool.kind === ToolKind.Road && key === `road:${this.tool.roadClass}`) active = true;
      if (this.tool.kind === ToolKind.Zone && key === `zone:${this.tool.zone}`) active = true;
      if (this.tool.kind === ToolKind.Place && key === `place:${this.tool.archetypeId}`) active = true;
      btn.classList.toggle('active', active);
    }
    this.hint.textContent = hintFor(this.tool);
  }

  private markOverlay(o: Overlay): void {
    for (const [key, btn] of this.toolButtons) {
      if (!key.startsWith('overlay:')) continue;
      btn.classList.toggle('active', key === `overlay:${o}`);
    }
  }

  setSpeed(speed: number): void {
    for (const b of this.speedButtons) {
      b.classList.toggle('active', Number(b.dataset.speed) === speed);
    }
  }

  pushAlert(message: string, kind: AlertKind): void {
    this.alerts.unshift({ message, kind });
    if (this.alerts.length > 40) this.alerts.pop();
  }

  // ---------------- 更新（4Hz） ----------------

  update(sim: Simulation, now: number, fps: number, drawCalls: number, visibleAgents: number): void {
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    this.renderTopbar(sim);
    this.renderSidebar(sim, fps, drawCalls, visibleAgents);
    this.renderInspector(sim);
    this.renderAlerts();
  }

  private renderTopbar(sim: Simulation): void {
    const s = sim.stats();
    this.topbar.replaceChildren();

    const stat = (label: string, value: string, cls?: string): void => {
      const d = el('div', 'stat');
      d.appendChild(el('div', 'label', label));
      const v = el('div', `value${cls ? ' ' + cls : ''}`, value);
      d.appendChild(v);
      this.topbar.appendChild(d);
    };

    stat('日時', `${sim.clock.month}月${sim.clock.day}日 ${String(sim.clock.hour).padStart(2, '0')}:${String(sim.clock.minute).padStart(2, '0')}`);
    stat('季節', SEASON_NAMES_JA[sim.clock.season]!);
    stat('人口', s.population.toLocaleString('ja-JP'));
    stat('資金', man(s.cash), s.cash < 0 ? 'bad' : undefined);
    stat('幸福度', `${Math.round((s.avgHappiness / 255) * 100)}%`, s.avgHappiness < 90 ? 'bad' : s.avgHappiness > 170 ? 'good' : undefined);

    // 速度
    const sc = el('div');
    sc.id = 'speed-controls';
    this.speedButtons = [];
    for (const [label, speed] of [
      ['⏸', 0],
      ['▶', 1],
      ['▶▶', 3],
      ['▶▶▶', 10],
    ] as const) {
      const b = el('button', undefined, label) as HTMLButtonElement;
      b.dataset.speed = String(speed);
      b.onclick = (): void => {
        this.cb.onSpeed(speed);
        this.setSpeed(speed);
      };
      this.speedButtons.push(b);
      sc.appendChild(b);
    }
    this.topbar.appendChild(sc);
  }

  private renderSidebar(sim: Simulation, fps: number, drawCalls: number, visibleAgents: number): void {
    const s = sim.stats();
    this.sidebar.replaceChildren();

    const row = (k: string, v: string, cls?: string): void => {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', `v${cls ? ' ' + cls : ''}`, v));
      this.sidebar.appendChild(r);
    };
    const head = (t: string): void => {
      this.sidebar.appendChild(el('hr'));
      this.sidebar.appendChild(el('h3', undefined, t));
    };

    this.sidebar.appendChild(el('h3', undefined, '需要'));
    const demands: [string, number][] = [
      ['住宅', s.demand.residential],
      ['商業', s.demand.commercial],
      ['工業', s.demand.industrial],
      ['農林', s.demand.agriculture],
    ];
    for (const [name, value] of demands) {
      const d = el('div', 'demand');
      d.appendChild(el('div', 'name', name));
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      const pct = Math.min(50, Math.abs(value) / 2);
      if (value >= 0) {
        fill.style.left = '50%';
        fill.style.width = `${pct}%`;
        fill.style.background = '#58c07a';
      } else {
        fill.style.left = `${50 - pct}%`;
        fill.style.width = `${pct}%`;
        fill.style.background = '#e06060';
      }
      track.appendChild(fill);
      d.appendChild(track);
      d.appendChild(el('div', 'num', String(Math.round(value))));
      this.sidebar.appendChild(d);
    }

    head('市民');
    row('就業 / 失業', `${s.employed.toLocaleString('ja-JP')} / ${s.unemployed.toLocaleString('ja-JP')}`);
    row('住居なし', String(s.homeless), s.homeless > 0 ? 'bad' : undefined);
    row('平均通勤時間', `${s.avgCommuteMin.toFixed(0)} 分`);
    row('1日の移動数', s.tripsCompleted.toLocaleString('ja-JP'));
    row('移動失敗', String(s.tripsFailed), s.tripsFailed > 20 ? 'bad' : undefined);

    head('交通分担率');
    for (let m = 0; m < 4; m++) {
      row(MODE_NAMES_JA[m]!, `${Math.round((s.modeShare[m] ?? 0) * 100)}%`);
    }

    head('産業・物流');
    for (let g = 1; g < 7; g++) {
      const stock = s.goodsStock[g] ?? 0;
      const prod = s.goodsProduced[g] ?? 0;
      row(GOOD_NAMES_JA[g]!, `${Math.round(stock).toLocaleString('ja-JP')} (時 +${prod.toFixed(0)})`);
    }
    row('稼働トラック', String(s.trucksActive));
    row('累計配送', sim.freight.totalDelivered.toLocaleString('ja-JP'));
    row('商品切れ', String(s.stockouts), s.stockouts > 20 ? 'bad' : undefined);

    head('財政');
    row('建物数', s.buildings.toLocaleString('ja-JP'));
    if (s.lastReport) {
      row('先月の収入', man(s.lastReport.income));
      row('先月の支出', man(s.lastReport.expense));
      row('収支', man(s.lastReport.net), s.lastReport.net < 0 ? 'bad' : 'good');
    }
    // 税率スライダ
    const taxRow = el('div');
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
      input.style.width = '96px';
      const out = el('span', 'v', `${input.value}%`);
      input.oninput = (): void => {
        out.textContent = `${input.value}%`;
        this.cb.onTax(zone, Number(input.value));
      };
      r.appendChild(input);
      r.appendChild(out);
      taxRow.appendChild(r);
    }
    this.sidebar.appendChild(taxRow);

    head('動作状況');
    row('FPS', String(Math.round(fps)));
    row('ドローコール', String(drawCalls));
    row('描画中の市民', String(visibleAgents));
    row('経路キャッシュ率', `${Math.round(s.cacheHitRate * 100)}%`);
    row('経路探索/tick', String(s.searchesThisTick));
    row('出発準備待ち', String(s.routeQueueDepth));
    row('グラフ規模', `${sim.graph.nodeCount} 節点`);
  }

  /**
   * 市民インスペクタ。
   * 「1 人ひとりをシミュレートしている」ことが実際に成り立っているかを
   * その場で確認できる、このゲームで最も重要な検証用 UI。
   */
  private renderInspector(sim: Simulation): void {
    if (this.selectedCitizen < 0 && this.selectedBuilding < 0) {
      this.inspector.style.display = 'none';
      return;
    }
    this.inspector.style.display = '';
    this.inspector.replaceChildren();

    const row = (k: string, v: string): void => {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', v));
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
      row('現在の行動', ACTIVITY_NAMES_JA[c.state[id]!] ?? '—');

      const home = c.homeBuilding[id]!;
      const work = c.workBuilding[id]!;
      row(
        '自宅',
        sim.buildings.valid(home) ? archetype(sim.buildings.archetypeId[handleSlot(home)]!).nameJa : 'なし',
      );
      row(
        '職場',
        sim.buildings.valid(work) ? archetype(sim.buildings.archetypeId[handleSlot(work)]!).nameJa : 'なし',
      );
      row('直近の通勤時間', c.lastCommuteMin[id]! > 0 ? `${c.lastCommuteMin[id]} 分` : '—');
      row('自動車保有', c.has(id, CitizenFlag.OwnsCar) ? 'あり' : 'なし');
      row('定期券', c.has(id, CitizenFlag.TransitPass) ? 'あり' : 'なし');
      row('完了した移動', String(c.tripsCompleted[id]));

      this.inspector.appendChild(el('hr'));
      this.inspector.appendChild(el('h3', undefined, '交通手段の好み（体感分）'));
      row('徒歩 / 自転車', `${c.prefWalk[id]} / ${c.prefBike[id]}`);
      row('自動車 / 鉄道', `${c.prefCar[id]} / ${c.prefRail[id]}`);

      // 直近の手段選択の内訳
      const explain = sim.activity.lastChoiceExplanation;
      if (explain) {
        this.inspector.appendChild(el('hr'));
        this.inspector.appendChild(el('h3', undefined, '直近の交通手段選択'));
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

      const follow = el('button', undefined, 'この市民を追う') as HTMLButtonElement;
      follow.onclick = (): void => this.cb.onFollowCitizen();
      this.inspector.appendChild(el('hr'));
      this.inspector.appendChild(follow);
      const close = el('button', undefined, '閉じる') as HTMLButtonElement;
      close.onclick = (): void => {
        this.selectedCitizen = -1;
      };
      this.inspector.appendChild(close);
      return;
    }

    // --- 建物インスペクタ ---
    const slot = this.selectedBuilding;
    if (sim.buildings.alive[slot] !== 1) {
      this.selectedBuilding = -1;
      this.inspector.style.display = 'none';
      return;
    }
    const a = archetype(sim.buildings.archetypeId[slot]!);
    this.inspector.appendChild(el('div', 'title', `${a.nameJa}（Lv${sim.buildings.level[slot]}）`));
    row('用途地域', ZONE_NAMES_JA[a.zone] ?? '—');
    if (a.households > 0) {
      row('入居世帯', `${sim.buildings.residents[slot]} / ${sim.buildings.capacityResidents[slot]}`);
    }
    if (a.jobs > 0) {
      row('就業者', `${sim.buildings.jobsFilled[slot]} / ${sim.buildings.jobsTotal[slot]}`);
    }
    row('接道', sim.buildings.accessTile[slot]! >= 0 ? 'あり' : 'なし（成長できません）');
    row('魅力度', `${Math.round((sim.buildings.desirability[slot]! / 255) * 100)}%`);

    if (a.inputs.length > 0 || a.output !== 0) {
      this.inspector.appendChild(el('hr'));
      this.inspector.appendChild(el('h3', undefined, '在庫'));
      a.inputs.forEach((inp, k) => {
        const amt = k === 0 ? sim.buildings.inAmtA[slot]! : sim.buildings.inAmtB[slot]!;
        row(`入荷 ${GOOD_NAMES_JA[inp.good]!}`, `${amt.toFixed(0)} / ${a.storage}`);
        const sup = sim.freight.supplierOf(slot, k);
        if (sup >= 0 && sim.buildings.alive[sup] === 1) {
          row('　仕入先', archetype(sim.buildings.archetypeId[sup]!).nameJa);
        } else {
          row('　仕入先', '未確保');
        }
      });
      if (a.output !== 0) {
        row(`出荷 ${GOOD_NAMES_JA[a.output]!}`, `${sim.buildings.outAmt[slot]!.toFixed(0)} / ${a.storage}`);
      }
      if (sim.buildings.stockoutDays[slot]! > 0) {
        const w = el('div', 'row');
        w.appendChild(el('span', 'k', '状態'));
        w.appendChild(el('span', 'v bad', `${sim.buildings.stockoutDays[slot]} 日間 在庫切れ`));
        this.inspector.appendChild(w);
      }
    }

    const close = el('button', undefined, '閉じる') as HTMLButtonElement;
    close.onclick = (): void => {
      this.selectedBuilding = -1;
    };
    this.inspector.appendChild(el('hr'));
    this.inspector.appendChild(close);
  }

  private renderAlerts(): void {
    this.alertsPanel.replaceChildren(el('h3', undefined, '通知'));
    if (this.alerts.length === 0) {
      this.alertsPanel.appendChild(el('div', 'tiny', '（なし）'));
      return;
    }
    for (const a of this.alerts.slice(0, 12)) {
      this.alertsPanel.appendChild(el('div', 'alert', a.message));
    }
  }
}
