import { describe, expect, it } from 'vitest';
import { Activity, Good, Mode, RoadClass, Zone } from '@shared/enums';
import { runHeadless } from '@sim/harness';
import { Simulation } from '@sim/simulation';
import { idx } from '@sim/world/tiles';
import { CitizenFlag } from '@sim/agents/citizens';
import { handleSlot } from '@sim/buildings/buildings';
import { Arch } from '@sim/buildings/archetypes';

/**
 * 統合テスト。
 *
 * 「プレイヤの適切な操作で街が発展する」「市民の移動と経路探索が確実に動く」
 * という要求そのものを機械的に検査する。ヘッドレスで街を組み立てて 90 日回し、
 * 破綻していないことを不変条件として確認する。
 */
describe('街の 90 日運転', () => {
  const { sim, records, tickMsAvg } = runHeadless({ seed: 42, days: 90, size: 72, population: 800 });
  const first = records[0]!;
  const last = records[records.length - 1]!;

  it('人口が増える（街が発展する）', () => {
    expect(first.population).toBeGreaterThan(0);
    expect(last.population).toBeGreaterThan(first.population);
  });

  it('人口が爆発しない（フィードバックループが発散しない）', () => {
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1]!.population;
      const cur = records[i]!.population;
      // 1 日で 1.5 倍を超える増加は、需要モデルの発散を意味する
      expect(cur).toBeLessThan(Math.max(200, prev * 1.5));
    }
  });

  it('建物が建ち、道路と用途地域が反映されている', () => {
    expect(last.buildings).toBeGreaterThan(100);
    let stations = 0;
    for (const s of sim.buildings.each()) {
      if (sim.buildings.archetypeId[s] === Arch.Station) stations++;
    }
    expect(stations).toBeGreaterThan(0);
  });

  it('市民が実際に移動を完了している', () => {
    expect(last.tripsCompleted).toBeGreaterThan(last.population * 0.5);
  });

  it('経路探索がほぼ失敗しない', () => {
    // 失敗率 2% 未満
    expect(last.tripsFailed).toBeLessThan(Math.max(20, last.tripsCompleted * 0.02));
    expect(sim.router.totalFailures / Math.max(1, sim.router.totalSearches)).toBeLessThan(0.05);
  });

  it('経路キャッシュが効いている（性能戦略が機能している）', () => {
    // ヒット率は日次でリセットされ、転居や転職が重なった日は一時的に落ちる。
    // 1 日だけを見ると偶然で上下するので、直近 30 日の平均で評価する。
    const window = records.slice(-30);
    const avg = window.reduce((a, r) => a + r.cacheHitRate, 0) / window.length;
    expect(avg).toBeGreaterThan(0.8);
    expect(sim.router.cache.size).toBeLessThanOrEqual(20_000);
  });

  it('複数の交通手段が実際に使い分けられている', () => {
    const used = last.modeShare.filter((s) => s > 0.02).length;
    expect(used).toBeGreaterThanOrEqual(3);
    // 駅を敷いたので鉄道が使われているはず
    expect(last.modeShare[Mode.Rail]!).toBeGreaterThan(0.02);
  });

  it('どの市民も同じ状態に張り付いたままにならない', () => {
    let stuck = 0;
    for (const id of sim.citizens.each()) {
      if (sim.citizens.state[id] === Activity.WaitingForRoute) {
        const waited = sim.clock.tick - sim.citizens.waitingSince[id]!;
        if (waited > 240) stuck++;
      }
      if (sim.citizens.state[id] === Activity.Traveling) {
        const traveling = sim.clock.tick - sim.citizens.tripDepartTick[id]!;
        if (traveling > 720) stuck++;
      }
    }
    expect(stuck).toBe(0);
  });

  it('市民の建物参照が健全（世代タグが破綻していない）', () => {
    let badHome = 0;
    let badWork = 0;
    for (const id of sim.citizens.each()) {
      const home = sim.citizens.homeBuilding[id]!;
      if (home !== 0 && !sim.buildings.valid(home)) badHome++;
      const work = sim.citizens.workBuilding[id]!;
      if (work !== 0 && !sim.buildings.valid(work)) badWork++;
    }
    expect(badHome).toBe(0);
    expect(badWork).toBe(0);
  });

  it('就業者の職場は必ず定員内に収まっている', () => {
    const filled = new Map<number, number>();
    for (const id of sim.citizens.each()) {
      if (!sim.citizens.has(id, CitizenFlag.Employed)) continue;
      const w = sim.citizens.workBuilding[id]!;
      if (!sim.buildings.valid(w)) continue;
      const slot = handleSlot(w);
      filled.set(slot, (filled.get(slot) ?? 0) + 1);
    }
    for (const [slot, n] of filled) {
      expect(n).toBeLessThanOrEqual(sim.buildings.jobsTotal[slot]!);
    }
  });

  it('住民数が住戸容量を超えない', () => {
    for (const s of sim.buildings.each()) {
      expect(sim.buildings.residents[s]!).toBeLessThanOrEqual(sim.buildings.capacityResidents[s]!);
    }
  });

  it('数値が NaN / Infinity にならない', () => {
    const s = sim.stats();
    for (const v of [s.cash, s.avgHappiness, s.avgCommuteMin, s.demand.residential, s.demand.commercial, s.demand.industrial, s.demand.agriculture]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const id of sim.citizens.each()) {
      expect(Number.isFinite(sim.citizens.incomeYenMo[id]!)).toBe(true);
    }
  });

  it('サプライチェーンが一巡している（田んぼ・林業から食品・日用品まで）', () => {
    const s = sim.stats();
    // 1 年目の春なので米は生育期。原木・木材・食品・日用品は流れているはず。
    expect(s.goodsStock[Good.Logs]! + s.goodsStock[Good.Lumber]!).toBeGreaterThan(0);
    expect(s.goodsStock[Good.Food]!).toBeGreaterThan(0);
    expect(s.goodsStock[Good.ConsumerGoods]!).toBeGreaterThan(0);
    // トラックが実際に道路を走って配送している
    expect(sim.freight.totalDelivered).toBeGreaterThan(100);
  });

  it('市民が買い物にほぼ成功している（物流が市民に届いている）', () => {
    const s = sim.stats();
    expect(s.shoppingFailed).toBeLessThan(last.tripsCompleted * 0.15);
  });

  it('市民の幸福度が維持されている', () => {
    expect(last.happiness).toBeGreaterThan(100);
  });

  it('財政が破綻しない', () => {
    expect(Number.isFinite(last.cash)).toBe(true);
    expect(sim.budget.history.length).toBeGreaterThan(1);
  });

  it('1 tick の処理時間が予算内（×10 速度でも 1 フレームに収まる）', () => {
    // 16.6ms のフレーム予算に対し、10 tick 分で 8ms 以内
    expect(tickMsAvg * 10).toBeLessThan(8);
  });

  it('経路探索の予算が守られている', () => {
    expect(sim.router.expansionsSpent).toBeLessThanOrEqual(40_000);
  });
});

describe('プレイヤ操作への応答', () => {
  /**
   * 「プレイヤが道路を敷けばつながり、壊せば切れる」という、
   * このゲームで最も基本的な因果を直接検査する。
   */
  it('道路の敷設で経路がつながり、撤去で切れる', () => {
    const sim = new Simulation(5);
    const w = sim.world;
    // 2 本の孤立した道路を作る
    const flatten = (x: number, y: number): number => {
      const t = idx(x, y);
      w.terrain[t] = 0;
      w.slope[t] = 0;
      return t;
    };
    const west: number[] = [];
    const east: number[] = [];
    for (let x = 40; x <= 50; x++) west.push(flatten(x, 60));
    for (let x = 56; x <= 66; x++) east.push(flatten(x, 60));
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: [...west, ...east] });
    sim.tick();

    const from = west[0]!;
    const to = east[east.length - 1]!;
    // まだつながっていない
    expect(sim.debugPath(from, to, Mode.Car)).toBeNull();

    // プレイヤが間を埋める
    const gap: number[] = [];
    for (let x = 51; x <= 55; x++) gap.push(flatten(x, 60));
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: gap });
    sim.tick();
    const connected = sim.debugPath(from, to, Mode.Car);
    expect(connected).not.toBeNull();
    expect(connected!.costSec).toBeGreaterThan(0);

    // 1 タイル壊すと再び切れる
    sim.enqueue({ t: 'bulldoze', tiles: [idx(53, 60)] });
    sim.tick();
    expect(sim.debugPath(from, to, Mode.Car)).toBeNull();
  });

  it('駅を置くと周辺の鉄道アクセスが改善する', () => {
    const sim = new Simulation(6);
    const w = sim.world;
    for (let y = 58; y <= 66; y++) {
      for (let x = 55; x <= 70; x++) {
        const t = idx(x, y);
        w.terrain[t] = 0;
        w.slope[t] = 0;
      }
    }
    const roads: number[] = [];
    for (let x = 55; x <= 70; x++) roads.push(idx(x, 62));
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: roads });
    sim.tick();

    const probe = idx(60, 60);
    expect(w.transitAccess[probe]).toBe(255); // 圏外

    sim.enqueue({ t: 'placeBuilding', archetype: Arch.Station, tile: idx(59, 59) });
    sim.tick();
    expect(w.transitAccess[probe]).toBeLessThan(255); // 徒歩圏に入った
  });

  it('税率を上げると住宅需要が下がる', () => {
    const sim = new Simulation(7);
    const before = sim.stats().demand.residential;
    sim.enqueue({ t: 'setTax', zone: Zone.ResidentialLow, pct: 20 });
    sim.tick();
    expect(sim.budget.taxPct[Zone.ResidentialLow]).toBe(20);
    // 需要は日次で再計算されるので 1 日回す
    for (let k = 0; k < 1441; k++) sim.tick();
    expect(sim.stats().demand.residential).toBeLessThanOrEqual(before);
  });
});
