import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_SECOND_AT_1X, TILE_COUNT } from '@shared/constants';
import { Activity, Good, Mode, RoadClass, Zone } from '@shared/enums';
import { runHeadless } from '@sim/harness';
import { decodeSave, encodeSave } from '@sim/persistence';
import { buildScenario } from '@sim/scenario';
import { hashArrays } from '@sim/core/hash';
import { Simulation } from '@sim/simulation';
import { idx, tileDistanceM } from '@sim/world/tiles';
import { CitizenFlag } from '@sim/agents/citizens';
import { SCHEDULES, ScheduleKind } from '@sim/agents/schedules';
import { handleSlot } from '@sim/buildings/buildings';
import { Arch } from '@sim/buildings/archetypes';
import { traceRailLines, trainHeads } from '@sim/network/railLines';

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
    expect(sim.router.cache.size).toBeLessThanOrEqual(120_000);
  });

  it('複数の交通手段が実際に使い分けられている', () => {
    const used = last.modeShare.filter((s) => s > 0.02).length;
    expect(used).toBeGreaterThanOrEqual(3);
    // 駅を敷いたので鉄道が使われているはず
    expect(last.modeShare[Mode.Transit]!).toBeGreaterThan(0.02);
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

  it('ベッドタウンから中心市街地へ通勤する人がいる', () => {
    // サンプルのシナリオは中心市街地とベッドタウンの 2 つでできている。
    // ベッドタウンに商業核を置いていた頃は住民が全員そこで就職してしまい、
    // 2 つを結ぶ幹線道路も鉄道もモード選択も、意図した役割を一度も果たしていなかった。
    const c = sim.citizens;
    const b = sim.buildings;
    let employed = 0;
    let longHaul = 0;
    for (let i = 0; i < c.high; i++) {
      if (!c.isAlive(i)) continue;
      const h = c.homeBuilding[i]!;
      const w = c.workBuilding[i]!;
      if (!b.valid(h) || !b.valid(w)) continue;
      employed++;
      const home = b.originTile[handleSlot(h)]!;
      const work = b.originTile[handleSlot(w)]!;
      // 市街地 1 つの差し渡しを超える距離＝別の市街地へ通っている
      if (tileDistanceM(home, work) > 12_000) longHaul++;
    }
    expect(employed).toBeGreaterThan(100);
    expect(longHaul / employed).toBeGreaterThan(0.05);
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
    // ×10 速度は 12 tick/秒 × 10 = 120 tick/秒。60fps なら 1 フレーム 2 tick。
    // 16.6ms のフレーム予算のうち、シミュレーションに割けるのは 6ms 程度。
    const ticksPerFrameAt10x = (TICKS_PER_SECOND_AT_1X * 10) / 60;
    expect(tickMsAvg * ticksPerFrameAt10x).toBeLessThan(6);
  });

  it('経路探索の予算が守られている', () => {
    expect(sim.router.expansionsSpent).toBeLessThanOrEqual(40_000);
  });
});

function countEmployed(sim: Simulation): number {
  let n = 0;
  for (const id of sim.citizens.each()) if (sim.citizens.has(id, CitizenFlag.Employed)) n++;
  return n;
}

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

  it('一時停止中でもコマンドが適用される', () => {
    const sim = new Simulation(20);
    const tiles: number[] = [];
    for (let x = 60; x < 70; x++) {
      const t = idx(x, 60);
      sim.world.terrain[t] = 0;
      sim.world.slope[t] = 0;
      tiles.push(t);
    }
    const before = sim.budget.cash;
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles });
    // tick を回さずに反映される（停止中に街を作れる）
    sim.flushCommands();
    expect(sim.world.road[tiles[0]!]).toBe(RoadClass.Street);
    expect(sim.budget.cash).toBeLessThan(before);
    expect(sim.clock.tick).toBe(0);
  });

  it('駅を撤去すると電車が走らなくなる', () => {
    const sim = new Simulation(21);
    const w = sim.world;
    for (let y = 56; y <= 70; y++) {
      for (let x = 55; x <= 70; x++) {
        const t = idx(x, y);
        w.terrain[t] = 0;
        w.slope[t] = 0;
      }
    }
    const roads: number[] = [];
    for (let x = 55; x <= 70; x++) roads.push(idx(x, 62));
    const rails: number[] = [];
    for (let y = 56; y <= 70; y++) rails.push(idx(58, y));
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: roads });
    sim.enqueue({ t: 'buildRail', tiles: rails });
    sim.tick();

    const stationTile = idx(59, 60); // 2×2 なので道路(y=62)に掛からない位置に置く
    sim.enqueue({ t: 'placeBuilding', archetype: Arch.Station, tile: stationTile });
    sim.tick();

    const heads = Array.from({ length: 64 }, () => ({ distM: 0, forward: true }));
    const withStation = traceRailLines(sim.graph);
    expect(withStation.some((l) => l.served)).toBe(true);
    expect(withStation.reduce((n, l) => n + trainHeads(l, 0, heads), 0)).toBeGreaterThan(0);

    // 駅は「建物」なので、撤去してもグラフのバージョンが動かず、
    // 描画側の線路キャッシュが古いまま電車を走らせ続けていた。
    const versionBefore = sim.graph.version;
    sim.enqueue({ t: 'bulldoze', tiles: [stationTile] });
    sim.tick();
    expect(sim.graph.version).not.toBe(versionBefore);

    const without = traceRailLines(sim.graph);
    expect(without.some((l) => l.served)).toBe(false);
    expect(without.reduce((n, l) => n + trainHeads(l, 0, heads), 0)).toBe(0);
  });

  it('寄り道をやめた市民が自宅にワープしない', () => {
    const sim = new Simulation(22);
    const w = sim.world;
    for (let y = 58; y <= 64; y++) {
      for (let x = 58; x <= 68; x++) {
        const t = idx(x, y);
        w.terrain[t] = 0;
        w.slope[t] = 0;
      }
    }
    const roads: number[] = [];
    for (let x = 58; x <= 68; x++) roads.push(idx(x, 60));
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: roads });
    sim.tick();

    const homeTile = idx(59, 61);
    const home = sim.buildings.create(w, Arch.House, homeTile, 1);
    expect(home).not.toBe(0);
    const id = sim.addCitizen(35, home);

    // 勤務中で、次のステップは買い物。街に商店が 1 軒も無いので行き先は見つからない。
    const c = sim.citizens;
    const workTile = idx(66, 61);
    const steps = SCHEDULES[ScheduleKind.OfficeWorker]!.steps;
    c.scheduleId[id] = ScheduleKind.OfficeWorker;
    c.scheduleStep[id] = steps.findIndex((s) => s.activity === Activity.Shopping);
    c.state[id] = Activity.AtWork;
    c.currentTile[id] = workTile;
    sim.wheel.schedule(id, sim.clock.tick, sim.clock.tick);
    sim.tick();

    // 以前はここで自宅に瞬間移動していた。帰宅トリップが発生しなくなる原因。
    expect(c.currentTile[id]).toBe(workTile);
    expect(c.state[id]).toBe(Activity.AtWork);
  });

  it('保存して読み込むと同じ街に戻る', () => {
    const sim = new Simulation(31);
    buildScenario(sim, { size: 48, seedPopulation: 200 });
    for (let k = 0; k < 2000; k++) sim.tick();

    const before = {
      tick: sim.clock.tick,
      population: sim.citizens.count(),
      buildings: sim.buildings.count(),
      cash: sim.budget.cash,
      // stats() の就業者数は経済期ごとの集計なので最大 120 tick 古い。
      // 保存されているかを見たいのはフラグそのものなので、ここで数え直す。
      employed: countEmployed(sim),
      // 地面（用途地域・道路・線路・建物の配置）は 1 ビットも変わってはいけない
      land: hashArrays([sim.world.zone, sim.world.road, sim.world.rail, sim.world.buildingRef]),
    };

    const saved = encodeSave(sim.snapshot(), {
      cityName: 'テストの街',
      savedAt: 0,
      population: before.population,
      dateJa: '1985年1月1日',
    });

    const { snapshot, meta } = decodeSave(saved);
    expect(meta.cityName).toBe('テストの街');
    const loaded = new Simulation(snapshot.seed);
    loaded.restoreSnapshot(snapshot);

    expect(loaded.clock.tick).toBe(before.tick);
    expect(loaded.citizens.count()).toBe(before.population);
    expect(loaded.buildings.count()).toBe(before.buildings);
    expect(loaded.budget.cash).toBe(before.cash);
    expect(countEmployed(loaded)).toBe(before.employed);
    expect(hashArrays([loaded.world.zone, loaded.world.road, loaded.world.rail, loaded.world.buildingRef])).toBe(
      before.land,
    );
  });

  it('読み込んだ街がそのまま動き続ける', () => {
    const sim = new Simulation(32);
    buildScenario(sim, { size: 48, seedPopulation: 200 });
    for (let k = 0; k < 2000; k++) sim.tick();
    const saved = encodeSave(sim.snapshot(), { cityName: 'x', savedAt: 0, population: 0, dateJa: 'x' });

    const { snapshot } = decodeSave(saved);
    const loaded = new Simulation(snapshot.seed);
    loaded.restoreSnapshot(snapshot);
    const popAtLoad = loaded.citizens.count();

    // 読み込み時に走行中のトリップは打ち切るので、元の街と 1 人単位まで一致は
    // しない。ここで見たいのは「止まらずに動き続ける」こと。
    for (let k = 0; k < TICKS_PER_DAY; k++) loaded.tick();
    const s = loaded.stats();
    expect(loaded.citizens.count()).toBeGreaterThan(popAtLoad * 0.9);
    expect(s.tripsCompleted).toBeGreaterThan(popAtLoad * 0.5);
    expect(s.tripsFailed).toBeLessThan(Math.max(20, s.tripsCompleted * 0.02));
    expect(Number.isFinite(s.cash)).toBe(true);
  });

  it('別のゲームのファイルは読み込まずにエラーにする', () => {
    const junk = new Uint8Array(64);
    junk.set(new TextEncoder().encode('NOT A SAVE'));
    expect(() => decodeSave(junk.buffer)).toThrow();
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

/**
 * 生活のリズム。
 *
 * 就職・転居のたびに予約を取り直していたため、市民がタイミングホイールに
 * 予約を二重に持ち、1 日のステップを 2 倍速で消化して時計と位相がずれていた。
 * 一度ずれると戻らないので、会社員の 9 割が深夜に出勤する街になっていた。
 * 朝夕ラッシュはこの上に成り立つので、ここが崩れると渋滞の話が全部無意味になる。
 */
describe('生活のリズム', () => {
  const { sim } = runHeadless({ seed: 5, days: 20, size: 48, population: 400 });

  it('市民がタイミングホイールに予約を二重に持たない', () => {
    // 1 人 1 件が上限。移動中の車はホイールに載らないので下回ることはある。
    expect(sim.wheel.pending()).toBeLessThanOrEqual(sim.citizens.count());
    expect(sim.wheel.pending()).toBeGreaterThan(sim.citizens.count() * 0.8);
  });

  it('移動が朝夕に山を作り、深夜はほとんど動かない', () => {
    while (sim.clock.tick % TICKS_PER_DAY !== 0) sim.tick();
    const travelingAt = (hour: number): number => {
      while (sim.clock.tick % TICKS_PER_DAY !== hour * 60) sim.tick();
      const c = sim.citizens;
      let n = 0;
      for (let i = 0; i < c.high; i++) {
        if (!c.isAlive(i)) continue;
        if (c.state[i] === Activity.Traveling || c.state[i] === Activity.WaitingForRoute) n++;
      }
      return n;
    };
    const night = travelingAt(3);
    const morning = travelingAt(8);
    const evening = travelingAt(20);
    expect(morning).toBeGreaterThan(0);
    expect(evening).toBeGreaterThan(0);
    expect(night).toBeLessThan(morning * 0.2);
    expect(night).toBeLessThan(evening * 0.2);
  });

  it('就職しても市民が自宅にワープしない', () => {
    const s = new Simulation(11);
    const w = s.world;
    const roads: number[] = [];
    for (let x = 58; x <= 68; x++) roads.push(idx(x, 60));
    for (const t of roads) {
      w.terrain[t] = 0;
      w.slope[t] = 0;
    }
    s.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: roads });
    s.tick();

    const home = s.buildings.create(w, Arch.House, idx(59, 61), 1);
    const id = s.addCitizen(35, home);
    const c = s.citizens;
    const elsewhere = idx(66, 61);
    c.currentTile[id] = elsewhere;
    c.state[id] = Activity.AtWork;

    s.activity.rescheduleCitizen(s.activityContext(), id);

    expect(c.currentTile[id]).toBe(elsewhere);
    expect(c.state[id]).toBe(Activity.AtWork);
  });
});

/**
 * 「密集させるとラッシュ時に渋滞し、道を広げれば捌ける」という要求そのものを検査する。
 *
 * 同じ街を 2 通り作る。片方は幹線まで含めて全部を大通りにした街、
 * もう片方は大通りを 1 本も持たない生活道路だけの街。
 * 人口も建物も交通需要も同じなので、差は道路の太さだけになる。
 */
describe('道路の設計が渋滞を決める', () => {
  const measure = (widen: boolean) => {
    const sim = new Simulation(9);
    const result = buildScenario(sim, { size: 40, seedPopulation: 600, withRail: false });
    // 道路の付け替えで資金が尽きて途中で止まらないようにしておく
    sim.budget.cash = 5e9;
    const tiles: number[] = [];
    if (widen) {
      // 幹線まで含めて全部を大通りにした街
      tiles.push(...result.trunk);
      sim.enqueue({ t: 'buildRoad', cls: RoadClass.Boulevard, tiles });
    } else {
      // 大通りを 1 本も持たない、生活道路だけの街
      for (let t = 0; t < TILE_COUNT; t++) if (sim.world.road[t] === RoadClass.Boulevard) tiles.push(t);
      sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles });
    }
    expect(tiles.length).toBeGreaterThan(100);
    sim.tick();
    const days = 16;
    let worstShare = 0;
    let peakWaiting = 0;
    for (let day = 0; day < days; day++) {
      for (let k = 0; k < TICKS_PER_DAY; k++) {
        sim.tick();
        const min = sim.clock.tick % TICKS_PER_DAY;
        // 最後の 3 日の朝ラッシュ（7〜9 時）だけ見る
        if (day < days - 3 || min < 7 * 60 || min > 9 * 60) continue;
        const t = sim.traffic;
        const share = t.roadLinks > 0 ? t.stats.fullLinks / t.roadLinks : 0;
        if (share > worstShare) worstShare = share;
        if (t.stats.waiting > peakWaiting) peakWaiting = t.stats.waiting;
      }
    }
    const s = sim.stats();
    return { population: s.population, commute: s.avgCommuteMin, worstShare, peakWaiting };
  };

  const planned = measure(true);
  const packed = measure(false);

  it('同じ人口・同じ需要で比べている（差が出るのは道路だけ）', () => {
    // 道路を付け替えると所要時間が変わり、そこから成長の乱数列がわずかにずれる。
    // 「ほぼ同じ人口」であることが言えれば、差が交通の話であることの担保になる。
    expect(planned.population).toBeGreaterThan(1000);
    expect(Math.abs(planned.population - packed.population) / planned.population).toBeLessThan(0.05);
  });

  it('生活道路だけで固めるとラッシュ時に道が詰まる', () => {
    // 大通りにした街では、収容いっぱいになる道路はごく一部で収まる
    expect(planned.worstShare).toBeLessThan(0.02);
    // 生活道路だけの街では桁違いに詰まる
    expect(packed.worstShare).toBeGreaterThan(planned.worstShare * 3);
    expect(packed.peakWaiting).toBeGreaterThan(planned.peakWaiting);
  });

  it('渋滞が通勤時間に返ってくる', () => {
    // 瞬間値の遅延倍率は「たまたま数台が信号待ちしている」だけで跳ねるので、
    // 1 日を通した平均通勤時間で見る。
    expect(packed.commute).toBeGreaterThan(planned.commute * 1.2);
  });
});
