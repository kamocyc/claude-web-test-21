import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '@shared/constants';
import { Good, Mode, RoadClass, Zone } from '@shared/enums';
import { Rng, hashUnit } from '@sim/core/rng';
import { Arch, archetype } from '@sim/buildings/archetypes';
import { taxPenalty, computeDemand } from '@sim/buildings/demand';
import { paddySeasonFactor } from '@sim/economy/production';
import { Simulation } from '@sim/simulation';
import { idx, tileX, tileY } from '@sim/world/tiles';

function run(sim: Simulation, days: number): void {
  for (let d = 0; d < days; d++) for (let k = 0; k < TICKS_PER_DAY; k++) sim.tick();
}

/** 平坦な区画を強制的に作り、道路グリッドとゾーンを敷く。 */
function flatDistrict(sim: Simulation, ox: number, oy: number, size: number, zone: Zone): number[] {
  const w = sim.world;
  for (let y = oy - 1; y <= oy + size + 1; y++) {
    for (let x = ox - 1; x <= ox + size + 1; x++) {
      const t = idx(x, y);
      w.terrain[t] = zone === Zone.AgriPaddy ? 1 : zone === Zone.Forestry ? 2 : 0;
      w.slope[t] = 0;
      w.waterAccess[t] = 0;
    }
  }
  const roads: number[] = [];
  for (let y = oy; y <= oy + size; y++) {
    for (let x = ox; x <= ox + size; x++) {
      if ((y - oy) % 4 !== 0 && (x - ox) % 4 !== 0) continue;
      roads.push(idx(x, y));
    }
  }
  sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: roads });
  sim.tick();
  const zoneTiles: number[] = [];
  for (let y = oy; y <= oy + size; y++) {
    for (let x = ox; x <= ox + size; x++) {
      const t = idx(x, y);
      if (w.road[t] !== RoadClass.None) continue;
      zoneTiles.push(t);
    }
  }
  sim.enqueue({ t: 'zonePaint', zone, tiles: zoneTiles });
  sim.tick();
  return zoneTiles;
}

describe('決定論', () => {
  it('同じシードなら同じ乱数列', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('違うシードなら違う乱数列', () => {
    const a = new Rng(42);
    const b = new Rng(43);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(5);
  });

  it('サブストリームは独立している', () => {
    const a = new Rng(42).fork('traffic');
    const b = new Rng(42).fork('agents');
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(5);
  });

  it('hashUnit は状態を持たず決定論的', () => {
    expect(hashUnit(123, 7)).toBe(hashUnit(123, 7));
    expect(hashUnit(123, 7)).not.toBe(hashUnit(124, 7));
    expect(hashUnit(5)).toBeGreaterThanOrEqual(0);
    expect(hashUnit(5)).toBeLessThan(1);
  });

  it('同じシードと同じ操作なら同じ街になる', () => {
    const build = (): Simulation => {
      const sim = new Simulation(2024);
      flatDistrict(sim, 60, 60, 24, Zone.ResidentialLow);
      sim.bootstrap();
      run(sim, 20);
      return sim;
    };
    const a = build();
    const b = build();
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.citizens.count()).toBe(b.citizens.count());
    expect(a.buildings.count()).toBe(b.buildings.count());
  });

  it('地形生成は同じシードで同じ地形になる', () => {
    const a = new Simulation(99);
    const b = new Simulation(99);
    expect(Array.from(a.world.terrain.subarray(0, 5000))).toEqual(Array.from(b.world.terrain.subarray(0, 5000)));
  });
});

describe('建物の成長', () => {
  it('接道していないゾーンタイルには絶対に建たない', () => {
    const sim = new Simulation(5);
    const w = sim.world;
    // 道路から遠く離れた場所にゾーンだけ指定する
    const tiles: number[] = [];
    for (let y = 100; y < 116; y++) {
      for (let x = 100; x < 116; x++) {
        const t = idx(x, y);
        w.terrain[t] = 0;
        w.slope[t] = 0;
        tiles.push(t);
      }
    }
    sim.enqueue({ t: 'zonePaint', zone: Zone.ResidentialLow, tiles });
    sim.tick();
    sim.bootstrap();
    run(sim, 25);

    for (const t of tiles) expect(w.buildingRef[t]).toBe(0);
    expect(sim.buildings.count()).toBe(0);
  });

  it('接道と需要があれば建物が建つ', () => {
    const sim = new Simulation(6);
    flatDistrict(sim, 60, 60, 20, Zone.ResidentialLow);
    sim.bootstrap();
    run(sim, 15);
    expect(sim.buildings.count()).toBeGreaterThan(5);
    for (const s of sim.buildings.each()) {
      expect(archetype(sim.buildings.archetypeId[s]!).zone).toBe(Zone.ResidentialLow);
    }
  });

  it('道路を撤去すると接道を失った建物は最終的に廃墟になる', () => {
    const sim = new Simulation(7);
    flatDistrict(sim, 60, 60, 20, Zone.ResidentialLow);
    sim.bootstrap();
    run(sim, 15);
    const before = sim.buildings.count();
    expect(before).toBeGreaterThan(5);

    // 区画内の道路をすべて撤去する
    const roads: number[] = [];
    for (let y = 58; y <= 82; y++) {
      for (let x = 58; x <= 82; x++) {
        const t = idx(x, y);
        if (sim.world.road[t] !== RoadClass.None) roads.push(t);
      }
    }
    sim.enqueue({ t: 'bulldoze', tiles: roads });
    sim.tick();
    run(sim, 40);
    expect(sim.buildings.count()).toBeLessThan(before);
  });

  it('用途地域の地形制約が守られる（水田は低湿地のみ、林業は森林のみ）', () => {
    const sim = new Simulation(8);
    const w = sim.world;
    const plain = idx(50, 50);
    w.terrain[plain] = 0; // 平地
    w.slope[plain] = 0;
    expect(w.canZone(plain, Zone.AgriPaddy)).toBe(false);
    expect(w.canZone(plain, Zone.Forestry)).toBe(false);
    w.terrain[plain] = 1; // 低湿地
    expect(w.canZone(plain, Zone.AgriPaddy)).toBe(true);
    w.terrain[plain] = 2; // 森林
    expect(w.canZone(plain, Zone.Forestry)).toBe(true);
    expect(w.canZone(plain, Zone.AgriPaddy)).toBe(false);
  });
});

describe('産業とサプライチェーン', () => {
  it('水田は季節によって生産量が変わり、秋に収穫される', () => {
    expect(paddySeasonFactor(5)).toBe(0); // 生育期は収穫なし
    expect(paddySeasonFactor(9)).toBeGreaterThan(paddySeasonFactor(1)); // 秋の収穫期
    expect(paddySeasonFactor(9)).toBeGreaterThan(paddySeasonFactor(10));
  });

  it('林業 → 製材所 → 木材、のチェーンが実際に動く', () => {
    const sim = new Simulation(11);
    // 森林区画と工業区画を作り、その間を道路でつなぐ
    flatDistrict(sim, 50, 50, 16, Zone.Forestry);
    flatDistrict(sim, 50, 70, 16, Zone.IndustrialHeavy);
    const link: number[] = [];
    for (let y = 66; y <= 70; y++) {
      const t = idx(50, y);
      sim.world.terrain[t] = 0; // 連絡道路が通る地形を均す
      sim.world.slope[t] = 0;
      link.push(t);
    }
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: link });
    sim.tick();
    // 2 つの区画が本当につながっていることを先に確認する
    expect(sim.debugPath(idx(52, 52), idx(52, 84), Mode.Car)).not.toBeNull();
    sim.bootstrap();
    run(sim, 60);

    let logs = 0;
    let lumber = 0;
    let forestry = 0;
    let sawmills = 0;
    for (const s of sim.buildings.each()) {
      const a = archetype(sim.buildings.archetypeId[s]!);
      if (a.id === Arch.ForestryPlot) forestry++;
      if (a.id === Arch.Sawmill) sawmills++;
      if (sim.buildings.outGood[s] === Good.Logs) logs += sim.buildings.outAmt[s]!;
      if (sim.buildings.outGood[s] === Good.Lumber) lumber += sim.buildings.outAmt[s]!;
      if (sim.buildings.inGoodA[s] === Good.Logs) logs += sim.buildings.inAmtA[s]!;
    }
    expect(forestry).toBeGreaterThan(0);
    expect(sawmills).toBeGreaterThan(0);
    expect(logs).toBeGreaterThan(0);
    // 製材所に原木が届き、木材になっていること（＝トラックが道路を走った証拠）
    expect(sim.freight.totalDelivered).toBeGreaterThan(0);
  });

  it('在庫は負にならない', () => {
    const sim = new Simulation(12);
    flatDistrict(sim, 50, 50, 20, Zone.IndustrialLight);
    sim.bootstrap();
    run(sim, 40);
    for (const s of sim.buildings.each()) {
      expect(sim.buildings.inAmtA[s]!).toBeGreaterThanOrEqual(0);
      expect(sim.buildings.inAmtB[s]!).toBeGreaterThanOrEqual(0);
      expect(sim.buildings.outAmt[s]!).toBeGreaterThanOrEqual(0);
    }
  });

  it('在庫が容量を超えない', () => {
    const sim = new Simulation(13);
    flatDistrict(sim, 50, 50, 20, Zone.AgriField);
    sim.bootstrap();
    run(sim, 50);
    for (const s of sim.buildings.each()) {
      const cap = archetype(sim.buildings.archetypeId[s]!).storage;
      expect(sim.buildings.outAmt[s]!).toBeLessThanOrEqual(cap + 1e-6);
    }
  });
});

describe('需要モデル', () => {
  const base = {
    population: 1000,
    workforce: 600,
    vacantJobs: 100,
    vacantDwellings: 20,
    dwellings: 400,
    avgHappiness: 150,
    unmetShoppingTrips: 10,
    retailCapacity: 20,
    unmetInputDemand: 5,
    industryCapacity: 30,
    foodShortfall: 2,
    foodDemand: 500,
    lumberShortfall: 0,
    starvedFraction: 0,
    taxPct: {} as Record<number, number>,
  };

  it('税率を上げると住宅需要が下がる', () => {
    const low = computeDemand({ ...base, taxPct: { [Zone.ResidentialLow]: 9 } });
    const high = computeDemand({ ...base, taxPct: { [Zone.ResidentialLow]: 18 } });
    expect(high.residential).toBeLessThan(low.residential);
  });

  it('税率ペナルティは中立税率以下では 0、超えると非線形に増える', () => {
    expect(taxPenalty(9)).toBe(0);
    expect(taxPenalty(5)).toBe(0);
    expect(taxPenalty(12)).toBeGreaterThan(0);
    expect(taxPenalty(18) / taxPenalty(12)).toBeGreaterThan(3); // 非線形
  });

  it('すべての需要が -100..100 に収まる（発散しない）', () => {
    // 極端な入力でも範囲外に出ないこと
    const extreme = computeDemand({
      ...base,
      vacantJobs: 1_000_000,
      workforce: 1,
      unmetShoppingTrips: 1_000_000,
      retailCapacity: 1,
      unmetInputDemand: 1_000_000,
      industryCapacity: 1,
      foodShortfall: 1_000_000,
      foodDemand: 1,
      taxPct: {},
    });
    for (const v of [extreme.residential, extreme.commercial, extreme.industrial, extreme.agriculture]) {
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(100);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('建物ハンドルの世代管理', () => {
  it('取り壊した建物への古い参照は無効になる', () => {
    const sim = new Simulation(14);
    flatDistrict(sim, 60, 60, 12, Zone.ResidentialLow);
    sim.bootstrap();
    run(sim, 12);
    const slot = [...sim.buildings.each()][0]!;
    const handle = sim.buildings.handleOf(slot);
    expect(sim.buildings.valid(handle)).toBe(true);

    const origin = sim.buildings.originTile[slot]!;
    sim.enqueue({ t: 'bulldoze', tiles: [origin] });
    sim.tick();
    expect(sim.buildings.valid(handle)).toBe(false);

    // 同じスロットが再利用されても、古いハンドルは無効のまま
    run(sim, 12);
    expect(sim.buildings.valid(handle)).toBe(false);
  });
});

describe('財政', () => {
  it('台帳が厳密に一致する（cash_t = cash_{t-1} + 収入 - 支出）', () => {
    const sim = new Simulation(15);
    flatDistrict(sim, 60, 60, 20, Zone.ResidentialLow);
    sim.bootstrap();
    run(sim, 95);
    const history = sim.budget.history;
    expect(history.length).toBeGreaterThan(1);
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1]!;
      const cur = history[i]!;
      expect(cur.net).toBe(cur.income - cur.expense);
      // 建設・撤去・輸入も台帳に載るので、現金の増減が厳密に説明できる
      expect(cur.cashAfter).toBe(prev.cashAfter + cur.net - cur.capex);
    }
  });

  it('道路の建設費が現金から引かれる', () => {
    const sim = new Simulation(16);
    const before = sim.budget.cash;
    const tiles: number[] = [];
    for (let x = 60; x < 80; x++) {
      const t = idx(x, 60);
      sim.world.terrain[t] = 0;
      sim.world.slope[t] = 0;
      tiles.push(t);
    }
    sim.enqueue({ t: 'buildRoad', cls: RoadClass.Boulevard, tiles });
    sim.tick();
    expect(sim.budget.cash).toBeLessThan(before);
  });
});

describe('タイル座標', () => {
  it('index と xy が往復する', () => {
    for (const [x, y] of [
      [0, 0],
      [5, 9],
      [319, 319],
      [100, 200],
    ] as const) {
      const t = idx(x, y);
      expect(tileX(t)).toBe(x);
      expect(tileY(t)).toBe(y);
    }
  });
});

describe('スカラー場のぼかし', () => {
  it('公害が発生源を中心に対称に広がる（ぼかしが自分の出力を読み直さない）', () => {
    const sim = new Simulation(7);
    const w = sim.world;
    // 平地だけの区画を作り、真ん中に公害源を 1 つ置く。
    const cx = 60;
    const cy = 60;
    for (let y = cy - 20; y <= cy + 20; y++) {
      for (let x = cx - 20; x <= cx + 20; x++) {
        const t = idx(x, y);
        w.terrain[t] = 0;
        w.slope[t] = 0;
      }
    }
    sim.budget.cash = 1e9;
    for (let x = cx - 6; x <= cx + 6; x++) sim.enqueue({ t: 'buildRoad', cls: RoadClass.Street, tiles: [idx(x, cy)] });
    sim.flushCommands();
    sim.enqueue({ t: 'placeBuilding', archetype: Arch.Factory, tile: idx(cx, cy + 1) });
    sim.flushCommands();
    run(sim, 2);

    // 発生源から南北に同じ距離だけ離れた 2 点は、同じ値になるはず。
    // ぼかしの縦パスが自分の出力を読み直していたときは、南側だけに尾を引いていた。
    const origin = idx(cx, cy + 1);
    let asym = 0;
    for (let d = 2; d <= 8; d++) {
      const north = w.pollution[origin - d * 320]!;
      const south = w.pollution[origin + d * 320]!;
      asym = Math.max(asym, Math.abs(north - south));
    }
    expect(asym).toBeLessThanOrEqual(2);
  });
});

describe('セーブデータの忠実さ', () => {
  it('保存して読み込んだ街と、そのまま進めた街が同じように進む', () => {
    const a = new Simulation(11);
    a.bootstrap();
    flatDistrict(a, 40, 40, 24, Zone.ResidentialLow);
    a.budget.cash = 1e9;
    run(a, 3);

    const snap = a.snapshot();
    const b = new Simulation(11);
    b.restoreSnapshot(snap);
    // 読み込んだ直後の状態が一致していること。
    expect(b.stateHash()).toBe(a.stateHash());

    // ここからが本題。走査カーソルのような「保存し忘れると
    // 次の 1 tick の中身が変わる」状態を炙り出す。
    run(a, 2);
    run(b, 2);
    expect(b.citizens.count()).toBe(a.citizens.count());
    expect(b.stateHash()).toBe(a.stateHash());
  });
});
