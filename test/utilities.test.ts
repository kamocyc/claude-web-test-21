import { describe, expect, it } from 'vitest';
import { UTILITY_GRACE_DAYS } from '@shared/constants';
import { Terrain } from '@shared/enums';
import { Arch } from '@sim/buildings/archetypes';
import { BuildingStore, handleSlot } from '@sim/buildings/buildings';
import { idx } from '@sim/world/tiles';
import type { World } from '@sim/world/world';
import { UtilitySystem, canBuildUtility } from '@sim/world/utilities';
import { layRoadLine, makeTestWorld } from './helpers';

/**
 * 矩形を「平地・傾斜 0・水辺から遠い」に均す。
 *
 * `makeTestWorld` は地形を生成したままの World を返すので、これをやらないと
 * シードによっては建物が海や山に当たって `create` が黙って 0 を返し、
 * テストが「電気が来ていない」ではなく「建物が無い」で通ってしまう。
 */
function flatten(world: World, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = idx(x, y);
      world.terrain[t] = Terrain.Plain;
      world.slope[t] = 0;
      world.waterAccess[t] = 255;
    }
  }
}

/** 建物を建ててスロット番号を返す。建たなかったらテストをその場で落とす。 */
function place(world: World, buildings: BuildingStore, archId: number, x: number, y: number): number {
  const handle = buildings.create(world, archId, idx(x, y), 1);
  expect(handle, `(${x},${y}) に建物 ${archId} を建てられなかった`).not.toBe(0);
  return handleSlot(handle);
}

/**
 * 道路を敷いたあとの後始末。
 * `Simulation.rebuildNetwork` が接道点を取り直しているのと同じことをする。
 * これを省くと、あとから敷いた道路が既存建物の接道タイルに反映されない。
 */
function refreshAll(world: World, buildings: BuildingStore): void {
  for (const s of buildings.each()) buildings.refreshAccess(world, s);
}

describe('連結成分と供給', () => {
  it('発電所と道路でつながっていない建物には電気が来ない', () => {
    const world = makeTestWorld(7);
    flatten(world, 15, 15, 50, 70);
    // 10 タイル以上離した 2 本の道路。ROAD_ACCESS_RADIUS(4) の 2 倍より遠いので、
    // 建物が意図しないほうの道路に接道することはない。
    layRoadLine(world, 20, 20, 40, 20);
    layRoadLine(world, 20, 60, 40, 60);

    const buildings = new BuildingStore(64);
    const solar = place(world, buildings, Arch.SolarFarm, 24, 61);
    const nearPlant = place(world, buildings, Arch.House, 30, 61);
    const farAway = place(world, buildings, Arch.House, 30, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);

    expect(utilities.componentOfBuilding(nearPlant)).toBe(utilities.componentOfBuilding(solar));
    expect(utilities.componentOfBuilding(farAway)).not.toBe(utilities.componentOfBuilding(solar));
    expect(utilities.hasPower(nearPlant)).toBe(true);
    expect(utilities.hasPower(farAway)).toBe(false);
  });

  it('接道していない建物にはどの成分にも属さず電気も水も来ない', () => {
    const world = makeTestWorld(11);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 40, 20);

    const buildings = new BuildingStore(64);
    place(world, buildings, Arch.SolarFarm, 24, 21);
    // 道路から 4 タイルより遠い = ROAD_ACCESS_RADIUS の外。
    const isolated = place(world, buildings, Arch.House, 30, 40);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);

    expect(utilities.componentOfBuilding(isolated)).toBe(-1);
    expect(utilities.hasPower(isolated)).toBe(false);
    expect(utilities.hasWater(isolated)).toBe(false);
  });

  it('浄水場があれば同じ道路網の建物に水が来る', () => {
    const world = makeTestWorld(13);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 40, 20);
    // 浄水場の足元だけ取水できるようにする。
    world.waterAccess[idx(24, 21)] = 0;

    const buildings = new BuildingStore(64);
    place(world, buildings, Arch.WaterWorks, 24, 21);
    const house = place(world, buildings, Arch.House, 30, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);

    expect(utilities.hasWater(house)).toBe(true);
    // 発電所は建てていないので電気だけは来ない。上水と電力は別勘定。
    expect(utilities.hasPower(house)).toBe(false);
  });
});

describe('容量の不足', () => {
  it('容量を超えると一部の建物が停電する', () => {
    const world = makeTestWorld(21);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 80, 20);

    const buildings = new BuildingStore(64);
    // 太陽光 1 基 = 1000kW。オフィスビル（雇用 70）は 70 × POWER_PER_JOB_KW(0.9) = 63kW なので、
    // 16 棟（1008kW）で必ず足りなくなる。
    place(world, buildings, Arch.SolarFarm, 22, 22);
    const offices: number[] = [];
    for (let k = 0; k < 16; k++) offices.push(place(world, buildings, Arch.OfficeBuilding, 26 + k * 3, 21));
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);

    const totals = utilities.cityTotals();
    expect(totals.powerSupplyKw).toBe(1000);
    expect(totals.powerDemandKw).toBeGreaterThan(1000);
    // 全滅ではなく「一部」であること。
    expect(totals.unpowered).toBeGreaterThan(0);
    expect(totals.unpowered).toBeLessThan(17);
    // 打ち切りはスロット昇順。先に建った 15 棟が生き残り、最後の 1 棟が落ちる。
    expect(offices.slice(0, 15).every((s) => utilities.hasPower(s))).toBe(true);
    expect(utilities.hasPower(offices[15]!)).toBe(false);
  });

  it('容量を増やすと停電が解消する', () => {
    const world = makeTestWorld(21);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 80, 20);

    const buildings = new BuildingStore(64);
    place(world, buildings, Arch.SolarFarm, 22, 22);
    const offices: number[] = [];
    for (let k = 0; k < 16; k++) offices.push(place(world, buildings, Arch.OfficeBuilding, 26 + k * 3, 21));
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    expect(utilities.hasPower(offices[15]!)).toBe(false);

    // 道路の反対側に 2 基目。ROAD_ACCESS_RADIUS(4) 以内でないと接道せず、
    // 建っていても誰にも電気を送れない。
    place(world, buildings, Arch.SolarFarm, 22, 18);
    refreshAll(world, buildings);
    utilities.recompute(world, buildings);

    expect(utilities.cityTotals().unpowered).toBe(0);
    expect(utilities.hasPower(offices[15]!)).toBe(true);
  });
});

describe('道路のつなぎ替え', () => {
  it('道路を 1 本つなぐと停電が解消する', () => {
    const world = makeTestWorld(31);
    flatten(world, 15, 15, 50, 40);
    layRoadLine(world, 20, 20, 40, 20);
    layRoadLine(world, 20, 30, 40, 30);

    const buildings = new BuildingStore(64);
    const solar = place(world, buildings, Arch.SolarFarm, 24, 21);
    const houses = [
      place(world, buildings, Arch.House, 26, 31),
      place(world, buildings, Arch.House, 28, 31),
      place(world, buildings, Arch.House, 30, 31),
    ];
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    expect(houses.every((s) => utilities.hasPower(s))).toBe(false);
    expect(utilities.componentOfBuilding(houses[0]!)).not.toBe(utilities.componentOfBuilding(solar));

    // 2 本の道路を縦に 1 本つなぐ。管路は敷かない — 道路がそのまま電線になる。
    layRoadLine(world, 20, 20, 20, 30);
    refreshAll(world, buildings);
    utilities.recompute(world, buildings);

    expect(utilities.componentOfBuilding(houses[0]!)).toBe(utilities.componentOfBuilding(solar));
    expect(houses.every((s) => utilities.hasPower(s))).toBe(true);
    expect(utilities.cityTotals().unpowered).toBe(0);
  });
});

describe('設置制約', () => {
  it('浄水場は水辺から離れた場所には建てられない', () => {
    const world = makeTestWorld(41);
    flatten(world, 15, 15, 90, 60);

    // 乾いた内陸。
    expect(canBuildUtility(world, Arch.WaterWorks, idx(30, 30))).toBe(false);

    // 取水できる川のそば。フットプリント（2×2）のどこか 1 タイルが圏内なら建つ。
    world.waterAccess[idx(41, 40)] = 2;
    expect(canBuildUtility(world, Arch.WaterWorks, idx(40, 40))).toBe(true);
  });

  it('水辺を要らない施設はどこにでも建てられる', () => {
    const world = makeTestWorld(41);
    flatten(world, 15, 15, 90, 60);
    expect(canBuildUtility(world, Arch.SolarFarm, idx(30, 30))).toBe(true);
    expect(canBuildUtility(world, Arch.ThermalPowerPlant, idx(30, 30))).toBe(true);
    expect(canBuildUtility(world, Arch.SewagePlant, idx(30, 30))).toBe(true);
  });
});

describe('機能停止の猶予', () => {
  it('停電が続くと猶予日数のあとで機能停止する', () => {
    const world = makeTestWorld(51);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 40, 20);

    const buildings = new BuildingStore(64);
    const house = place(world, buildings, Arch.House, 26, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    expect(utilities.hasPower(house)).toBe(false);
    // 落ちた初日はまだ止めない。発電所を建て替える一瞬で街が崩れないようにするため。
    expect(utilities.isShutdown(house)).toBe(false);

    for (let d = 0; d < UTILITY_GRACE_DAYS - 1; d++) {
      utilities.dailyReview(buildings);
      expect(utilities.isShutdown(house)).toBe(false);
    }
    utilities.dailyReview(buildings);
    expect(utilities.powerOutageDays(house)).toBe(UTILITY_GRACE_DAYS);
    expect(utilities.isShutdown(house)).toBe(true);
    expect(utilities.cityTotals().shutdown).toBe(1);
  });

  it('供給が戻れば日の境界を待たずに機能停止が解ける', () => {
    const world = makeTestWorld(53);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 40, 20);
    world.waterAccess[idx(26, 18)] = 0;

    const buildings = new BuildingStore(64);
    const house = place(world, buildings, Arch.House, 26, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    for (let d = 0; d < UTILITY_GRACE_DAYS + 1; d++) utilities.dailyReview(buildings);
    expect(utilities.isShutdown(house)).toBe(true);

    place(world, buildings, Arch.SolarFarm, 22, 18);
    place(world, buildings, Arch.WaterWorks, 26, 18);
    refreshAll(world, buildings);
    utilities.recompute(world, buildings);

    expect(utilities.hasPower(house)).toBe(true);
    expect(utilities.hasWater(house)).toBe(true);
    expect(utilities.powerOutageDays(house)).toBe(0);
    expect(utilities.isShutdown(house)).toBe(false);
  });
});

describe('下水と公害', () => {
  it('下水処理場が無い地区は未処理の下水が公害になる', () => {
    const world = makeTestWorld(61);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 40, 20);

    const buildings = new BuildingStore(64);
    const house = place(world, buildings, Arch.House, 26, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    expect(utilities.sewagePollutionOf(house)).toBeGreaterThan(0);

    place(world, buildings, Arch.SewagePlant, 22, 22);
    refreshAll(world, buildings);
    utilities.recompute(world, buildings);

    const totals = utilities.cityTotals();
    expect(totals.sewageCapacity).toBeGreaterThan(totals.sewageDemand);
    expect(utilities.sewagePollutionOf(house)).toBe(0);
  });
});

describe('オーバーレイと集計', () => {
  it('オーバーレイは供給網の中だけを塗り、落ちている建物を区別できる', () => {
    const world = makeTestWorld(71);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 80, 20);

    const buildings = new BuildingStore(64);
    place(world, buildings, Arch.SolarFarm, 22, 22);
    const offices: number[] = [];
    for (let k = 0; k < 16; k++) offices.push(place(world, buildings, Arch.OfficeBuilding, 26 + k * 3, 21));
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);

    // 供給網の外（何も無い野原）は 0。
    expect(utilities.powerOverlay[idx(45, 45)]).toBe(0);
    // 道路の上は成分の充足度。
    expect(utilities.powerOverlay[idx(30, 20)]).toBeGreaterThan(0);
    // 落ちている建物は 1（＝網の中だが供給されていない）。
    const dark = buildings.originTile[offices[15]!]!;
    expect(utilities.powerOverlay[dark]).toBe(1);
  });

  it('連結成分ごとの内訳が地区の過不足を分けて出す', () => {
    const world = makeTestWorld(73);
    flatten(world, 15, 15, 50, 70);
    layRoadLine(world, 20, 20, 40, 20);
    layRoadLine(world, 20, 60, 40, 60);

    const buildings = new BuildingStore(64);
    place(world, buildings, Arch.SolarFarm, 24, 61);
    place(world, buildings, Arch.House, 30, 61);
    place(world, buildings, Arch.House, 30, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);

    const infos = utilities.componentInfos();
    expect(infos.length).toBe(2);
    const supplied = infos.find((i) => i.powerSupplyKw > 0)!;
    const starved = infos.find((i) => i.powerSupplyKw === 0)!;
    expect(supplied.powerSupplyKw).toBeGreaterThan(supplied.powerDemandKw);
    expect(starved.powerDemandKw).toBeGreaterThan(0);
    expect(starved.buildings).toBe(1);
    // 街全体の合計だけ見ていると「供給 1000kW、需要 6kW」で足りているように見える。
    // 地区ごとに分けて初めて、南の 1 棟が落ちていることが分かる。
    expect(starved.unpowered).toBe(1);
    expect(supplied.unpowered).toBe(0);
    // 代表タイルは成分内の最小 index に固定してある（決定論のため）。
    expect(utilities.componentOfTile(supplied.sampleTile)).toBe(supplied.component);
  });
});

describe('セーブ／ロード', () => {
  it('保存するのは連続停電日数だけで、供給は道路から作り直せる', () => {
    const world = makeTestWorld(81);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 40, 20);

    const buildings = new BuildingStore(64);
    const house = place(world, buildings, Arch.House, 26, 21);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    for (let d = 0; d < UTILITY_GRACE_DAYS; d++) utilities.dailyReview(buildings);
    expect(utilities.isShutdown(house)).toBe(true);

    const arrays = utilities.saveArrays(buildings.high);
    expect(arrays.map((a) => a.name)).toEqual(['u.powerOutDays', 'u.waterOutDays']);

    const loaded = new UtilitySystem();
    loaded.restoreArrays(new Map(arrays.map((a) => [a.name, a.data])), buildings.high);
    // 連結成分と供給は保存していないので、読み込み後に取り直す。
    loaded.recompute(world, buildings);

    expect(loaded.powerOutageDays(house)).toBe(utilities.powerOutageDays(house));
    expect(loaded.isShutdown(house)).toBe(true);
    expect(loaded.componentOfBuilding(house)).toBe(utilities.componentOfBuilding(house));
  });
});

describe('決定論', () => {
  /** 同じ手順で街を作り、電気・水道の状態を全部書き出す。 */
  function buildAndSample(): {
    powered: number[];
    watered: number[];
    shutdown: number[];
    totals: ReturnType<UtilitySystem['cityTotals']>;
    overlay: number[];
  } {
    const world = makeTestWorld(2024);
    flatten(world, 15, 15, 90, 60);
    layRoadLine(world, 20, 20, 80, 20);
    layRoadLine(world, 20, 40, 50, 40);
    world.waterAccess[idx(26, 18)] = 0;

    const buildings = new BuildingStore(128);
    place(world, buildings, Arch.SolarFarm, 22, 18);
    place(world, buildings, Arch.WaterWorks, 26, 18);
    for (let k = 0; k < 8; k++) place(world, buildings, Arch.OfficeBuilding, 26 + k * 3, 21);
    for (let k = 0; k < 5; k++) place(world, buildings, Arch.House, 26 + k * 2, 41);
    refreshAll(world, buildings);

    const utilities = new UtilitySystem();
    utilities.recompute(world, buildings);
    utilities.dailyReview(buildings);
    utilities.recompute(world, buildings);

    const powered: number[] = [];
    const watered: number[] = [];
    const shutdown: number[] = [];
    for (const s of buildings.each()) {
      powered.push(utilities.hasPower(s) ? 1 : 0);
      watered.push(utilities.hasWater(s) ? 1 : 0);
      shutdown.push(utilities.isShutdown(s) ? 1 : 0);
    }
    return {
      powered,
      watered,
      shutdown,
      totals: utilities.cityTotals(),
      overlay: Array.from(utilities.powerOverlay.subarray(idx(15, 15), idx(60, 60))),
    };
  }

  it('同じ操作なら、どの建物が落ちるかまで含めて同じ結果になる', () => {
    const a = buildAndSample();
    const b = buildAndSample();
    expect(a.powered).toEqual(b.powered);
    expect(a.watered).toEqual(b.watered);
    expect(a.shutdown).toEqual(b.shutdown);
    expect(a.totals).toEqual(b.totals);
    expect(a.overlay).toEqual(b.overlay);
    // 「全部点いている」「全部落ちている」だと決定論を確かめたことにならないので、
    // ちゃんと供給が足りていない状態を作れているかも見る。
    expect(a.powered).toContain(0);
    expect(a.powered).toContain(1);
  });
});
