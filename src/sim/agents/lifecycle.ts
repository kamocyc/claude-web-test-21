import {
  DAYS_PER_YEAR,
  JOB_SEEKERS_PER_DAY,
  MORTALITY_A,
  MORTALITY_B,
  RELOCATE_PATIENCE_DAYS,
  RETIRE_AGE,
  TARGET_TFR,
  WORK_AGE_MIN,
} from '@shared/constants';
import { Activity, Mode, Service } from '@shared/enums';
import type { Clock } from '@sim/core/clock';
import type { Rng } from '@sim/core/rng';
import type { TimeWheel } from '@sim/core/timeWheel';
import type { BuildingStore } from '@sim/buildings/buildings';
import { handleSlot } from '@sim/buildings/buildings';
import type { TazMatrix } from '@sim/network/tazMatrix';
import type { World } from '@sim/world/world';
import type { ActivitySystem } from './activity';
import { CitizenFlag, type CitizenStore } from './citizens';
import {
  buildHousingIndex,
  buildJobIndex,
  leaveJob,
  loseHome,
  seekHome,
  seekJob,
  type HousingIndex,
  type JobIndex,
} from './matching';
import { ScheduleKind, pickSchedule } from './schedules';

export interface LifecycleStats {
  births: number;
  deaths: number;
  immigrants: number;
  emigrants: number;
  employed: number;
  unemployed: number;
  homeless: number;
  jobIndex: JobIndex;
  housingIndex: HousingIndex;
}

export interface LifecycleContext {
  world: World;
  buildings: BuildingStore;
  citizens: CitizenStore;
  taz: TazMatrix;
  clock: Clock;
  rng: Rng;
  wheel: TimeWheel;
  activity: ActivitySystem;
}

let nextHouseholdId = 1;

/**
 * 市民を 1 人生成する。嗜好はここで一度だけ引き、生涯変わらない。
 * 「同じ条件の市民が全員同じ交通手段を選ぶ」のを防ぐのがこの個人差の役目。
 */
export function createCitizen(
  ctx: LifecycleContext,
  age: number,
  homeHandle: number,
  householdId: number,
): number {
  const c = ctx.citizens;
  const rng = ctx.rng;
  const id = c.alloc();

  c.flags[id] = CitizenFlag.Alive;
  c.age[id] = age;
  c.birthDay[id] = rng.int(DAYS_PER_YEAR);
  c.education[id] = age < 15 ? 0 : age < 18 ? 1 : rng.weightedPick([10, 45, 30, 15]) + 1;
  c.skill[id] = Math.max(0, Math.min(255, Math.round(rng.normal(90 + c.education[id]! * 28, 34))));
  c.happiness[id] = 150;
  c.incomeYenMo[id] = 0;
  c.homeBuilding[id] = homeHandle;
  c.workBuilding[id] = 0;
  c.householdId[id] = householdId;

  // モードごとの個人的な好み（体感分の加算）。σ=6 分は 1 本のバス待ちに相当する程度のばらつき。
  c.prefWalk[id] = clampI8(rng.normal(0, 6));
  c.prefBike[id] = clampI8(rng.normal(0, 6));
  c.prefCar[id] = clampI8(rng.normal(0, 7));
  c.prefRail[id] = clampI8(rng.normal(0, 6));
  c.leisureTaste[id] = Math.max(0, Math.min(255, Math.round(rng.normal(120, 50))));

  const canDrive = age >= 18 && rng.chance(0.72);
  c.set(id, CitizenFlag.HasLicense, canDrive);
  // 自動車保有率。日本の地方都市を想定して高めだが、都心では駐車コストで抑制される。
  c.set(id, CitizenFlag.OwnsCar, canDrive && rng.chance(0.62));
  c.set(id, CitizenFlag.TransitPass, false);
  c.set(id, CitizenFlag.Retired, age >= RETIRE_AGE);
  c.set(id, CitizenFlag.Student, age >= 6 && age < 18);

  c.scheduleId[id] = pickSchedule(age, false, age >= RETIRE_AGE, rng.chance(0.08));
  c.scheduleStep[id] = 0;
  c.state[id] = Activity.AtHome;
  c.unhappyDays[id] = 0;
  c.lastCommuteMin[id] = 0;
  c.tripsCompleted[id] = 0;
  c.tripPath[id] = null;

  if (ctx.buildings.valid(homeHandle)) {
    const slot = handleSlot(homeHandle);
    c.currentTile[id] = ctx.buildings.originTile[slot]!;
    ctx.buildings.residents[slot] = ctx.buildings.residents[slot]! + 1;
  }
  return id;
}

function clampI8(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v)));
}

export function newHouseholdId(): number {
  return nextHouseholdId++;
}

/** 決定論を保つため、シード読み込み時に世帯 ID カウンタも戻す。 */
export function resetHouseholdIds(): void {
  nextHouseholdId = 1;
}

/**
 * 日次のライフサイクル処理。全市民を毎日見るのではなく 1/7 ずつ処理して
 * 1 週間で一巡させる（人口 1 万人でも 1 日あたり 1400 人分の軽い処理で済む）。
 */
export class LifecycleSystem {
  private slice = 0;
  readonly stats: LifecycleStats = {
    births: 0,
    deaths: 0,
    immigrants: 0,
    emigrants: 0,
    employed: 0,
    unemployed: 0,
    homeless: 0,
    jobIndex: { byTaz: [], totalVacant: 0, totalJobs: 0 },
    housingIndex: { byTaz: [], totalVacant: 0, totalDwellings: 0 },
  };

  daily(ctx: LifecycleContext): void {
    const c = ctx.citizens;
    const b = ctx.buildings;
    const rng = ctx.rng;

    this.stats.births = 0;
    this.stats.deaths = 0;
    this.stats.immigrants = 0;
    this.stats.emigrants = 0;

    const jobIndex = buildJobIndex(b);
    const housingIndex = buildHousingIndex(b);
    this.stats.jobIndex = jobIndex;
    this.stats.housingIndex = housingIndex;

    const dayOfYear = ctx.clock.dayOfYear;
    const slice = this.slice;
    this.slice = (this.slice + 1) % 7;

    let employed = 0;
    let unemployed = 0;
    let homeless = 0;
    let jobSeekers = 0;

    for (const id of c.each()) {
      // --- 参照の健全性: 建物が壊れていたら参照を切る ---
      if (c.homeBuilding[id] !== 0 && !b.valid(c.homeBuilding[id]!)) c.homeBuilding[id] = 0;
      if (c.workBuilding[id] !== 0 && !b.valid(c.workBuilding[id]!)) {
        c.workBuilding[id] = 0;
        c.incomeYenMo[id] = 0;
        c.set(id, CitizenFlag.Employed, false);
      }

      if (c.homeBuilding[id] === 0) homeless++;
      if (c.has(id, CitizenFlag.Employed)) employed++;
      else if (c.age[id]! >= WORK_AGE_MIN && c.age[id]! < RETIRE_AGE) unemployed++;

      // 週に 1 度だけ重い処理を回す
      if (id % 7 !== slice) continue;

      // --- 加齢 ---
      if (c.birthDay[id] === dayOfYear) {
        const age = Math.min(120, c.age[id]! + 1);
        c.age[id] = age;
        if (age === RETIRE_AGE) {
          leaveJob(c, b, id);
          c.set(id, CitizenFlag.Retired, true);
          c.scheduleId[id] = ScheduleKind.Retired;
        }
        if (age === 18) {
          c.set(id, CitizenFlag.Student, false);
          c.set(id, CitizenFlag.HasLicense, rng.chance(0.72));
        }
      }

      // --- 死亡（Gompertz） ---
      const age = c.age[id]!;
      const pAnnual = MORTALITY_A * Math.exp(MORTALITY_B * age);
      // 週 1 回の判定なので年率を 52 で割る
      if (rng.chance(pAnnual / 52)) {
        this.kill(ctx, id);
        this.stats.deaths++;
        continue;
      }

      // --- 求職 ---
      if (
        !c.has(id, CitizenFlag.Employed) &&
        !c.has(id, CitizenFlag.Retired) &&
        age >= WORK_AGE_MIN &&
        age < RETIRE_AGE &&
        c.homeBuilding[id] !== 0 &&
        jobSeekers < JOB_SEEKERS_PER_DAY
      ) {
        jobSeekers++;
        if (seekJob(c, b, ctx.taz, jobIndex, rng, id)) {
          c.scheduleId[id] = pickSchedule(age, true, false, rng.chance(0.08));
          // 鉄道アクセスの良い勤め人は定期券を持つ（通勤の鉄道分担率を大きく押し上げる）
          const homeTile = b.valid(c.homeBuilding[id]!)
            ? b.originTile[handleSlot(c.homeBuilding[id]!)]!
            : -1;
          const pass = homeTile >= 0 && ctx.world.transitAccess[homeTile]! < 15;
          c.set(id, CitizenFlag.TransitPass, pass);
          ctx.activity.initCitizen(ctx as never, id);
        }
      }

      // --- 住居探し・転居 ---
      if (c.homeBuilding[id] === 0) {
        if (seekHome(c, b, ctx.taz, housingIndex, rng, id, ctx.world.landValue)) {
          c.unhappyDays[id] = 0;
          ctx.activity.initCitizen(ctx as never, id);
        } else {
          // 住むところが無い状態が続いたら転出
          c.unhappyDays[id] = c.unhappyDays[id]! + 7;
          if (c.unhappyDays[id]! > RELOCATE_PATIENCE_DAYS * 2) {
            this.emigrate(ctx, id);
            this.stats.emigrants++;
            continue;
          }
        }
      } else if (c.happiness[id]! < 70) {
        c.unhappyDays[id] = c.unhappyDays[id]! + 7;
        if (c.unhappyDays[id]! >= RELOCATE_PATIENCE_DAYS) {
          // まず転居を試み、それも駄目なら転出
          if (seekHome(c, b, ctx.taz, housingIndex, rng, id, ctx.world.landValue)) {
            c.unhappyDays[id] = 0;
            c.happiness[id] = 130;
            ctx.activity.initCitizen(ctx as never, id);
          } else if (c.unhappyDays[id]! > RELOCATE_PATIENCE_DAYS * 3) {
            this.emigrate(ctx, id);
            this.stats.emigrants++;
            continue;
          }
        }
      } else {
        c.unhappyDays[id] = 0;
      }

      // --- 出生 ---
      if (age >= 22 && age <= 42 && c.homeBuilding[id] !== 0) {
        const home = handleSlot(c.homeBuilding[id]!);
        const room = b.capacityResidents[home]! - b.residents[home]!;
        if (room > 0) {
          // TFR を 20 年の出産可能期間に均した週次確率
          const pWeek = TARGET_TFR / (20 * 52) / 2; // 母親側だけが産む想定で半分
          if (rng.chance(pWeek * (c.happiness[id]! / 160))) {
            createCitizen(ctx, 0, c.homeBuilding[id]!, c.householdId[id]!);
            this.stats.births++;
          }
        }
      }

      // --- 生活環境による幸福度の増減 ---
      // 基礎値をマイナスにしてあるのが要点。何もしなければ不満が溜まっていき、
      // 学校・病院・交番・公園を届かせて初めて満足が上回る。
      // 基礎をプラスにすると、プレイヤが何もしなくても全員が幸福度の上限に張り付き、
      // 公共サービスにも公害にも意味が無くなる。
      const homeTile = b.valid(c.homeBuilding[id]!) ? b.originTile[handleSlot(c.homeBuilding[id]!)]! : -1;
      if (homeTile >= 0) {
        let delta = -2;
        const svc = ctx.world.svcMask[homeTile]!;
        if ((svc & Service.Education) !== 0) delta += 1;
        if ((svc & Service.Health) !== 0) delta += 1;
        if ((svc & Service.Safety) !== 0) delta += 1;
        if ((svc & Service.Park) !== 0) delta += 1;
        if ((svc & Service.Transit) !== 0) delta += 1;

        const poll = ctx.world.pollution[homeTile]!;
        if (poll > 60) delta -= 2;
        if (poll > 120) delta -= 2;
        if (ctx.world.noise[homeTile]! > 140) delta -= 1;

        if (!c.has(id, CitizenFlag.Employed) && age >= WORK_AGE_MIN && age < RETIRE_AGE) delta -= 3;
        // 長時間通勤はじわじわ効く
        if (c.lastCommuteMin[id]! > 45) delta -= 1;

        c.happiness[id] = Math.max(0, Math.min(255, c.happiness[id]! + delta));
      }
    }

    this.stats.employed = employed;
    this.stats.unemployed = unemployed;
    this.stats.homeless = homeless;
  }

  /**
   * 転入。住宅需要が満たされていないときに新しい市民がやって来る。
   * 空き住戸に直接入れる（駅・港からのスポーンは v1 では省略）。
   */
  immigrate(ctx: LifecycleContext, count: number): number {
    const b = ctx.buildings;
    const housing = buildHousingIndex(b);
    if (housing.totalVacant <= 0) return 0;
    let placed = 0;
    const pool: number[] = [];
    for (const list of housing.byTaz) for (const s of list) pool.push(s);
    if (pool.length === 0) return 0;

    for (let k = 0; k < count; k++) {
      // 空きのある住戸を地価の高い順に少し偏らせて選ぶ
      let slot = -1;
      for (let attempt = 0; attempt < 8; attempt++) {
        const cand = pool[ctx.rng.int(pool.length)]!;
        if (b.alive[cand] === 1 && b.residents[cand]! < b.capacityResidents[cand]!) {
          slot = cand;
          break;
        }
      }
      if (slot < 0) break;
      const hh = newHouseholdId();
      const handle = b.handleOf(slot);
      // 単身か夫婦か。世帯人数は住戸の空きに収まる範囲で。
      const room = b.capacityResidents[slot]! - b.residents[slot]!;
      const size = Math.min(room, ctx.rng.chance(0.45) ? 1 : ctx.rng.range(2, 3));
      for (let p = 0; p < size; p++) {
        const age = p === 0 ? ctx.rng.range(22, 45) : ctx.rng.chance(0.5) ? ctx.rng.range(22, 45) : ctx.rng.range(0, 17);
        const id = createCitizen(ctx, age, handle, hh);
        ctx.activity.initCitizen(ctx as never, id);
        placed++;
      }
      this.stats.immigrants += size;
    }
    return placed;
  }

  private kill(ctx: LifecycleContext, id: number): void {
    const c = ctx.citizens;
    leaveJob(c, ctx.buildings, id);
    loseHome(c, ctx.buildings, id);
    c.set(id, CitizenFlag.Alive, false);
    c.free(id);
  }

  private emigrate(ctx: LifecycleContext, id: number): void {
    this.kill(ctx, id);
  }
}

/** 平均通勤時間（分）。0 除算を避けた素朴な集計。 */
export function averageCommuteMinutes(citizens: CitizenStore): number {
  let sum = 0;
  let n = 0;
  for (const id of citizens.each()) {
    const m = citizens.lastCommuteMin[id]!;
    if (m > 0) {
      sum += m;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** モード分担率。 */
export function modeShare(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return [0, 0, 0, 0];
  return counts.map((c) => c / total);
}

export { Mode };
