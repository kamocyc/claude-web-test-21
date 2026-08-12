import { JOB_SAMPLE_COUNT, RETIRE_AGE, TAZ_COUNT, WORK_AGE_MIN } from '@shared/constants';
import { Mode } from '@shared/enums';
import { archetype, isResidential } from '@sim/buildings/archetypes';
import type { BuildingStore } from '@sim/buildings/buildings';
import { handleSlot } from '@sim/buildings/buildings';
import type { Rng } from '@sim/core/rng';
import { valueOfTime } from '@sim/network/modeChoice';
import type { TazMatrix } from '@sim/network/tazMatrix';
import { tazOf } from '@sim/world/tiles';
import { CitizenFlag, type CitizenStore } from './citizens';

/**
 * 職と住居のマッチング。
 *
 * 全市民 × 全求人の最適割当は O(N·M) で、この規模でも重すぎるし、
 * そもそも人間はそんな探し方をしない。TAZ 行列で通勤コストを即座に引けるので、
 * 「近そうな求人を数件サンプリングして一番マシなものを取る」貪欲法で十分。
 * 経路探索は 1 回も呼ばない。
 */

export interface JobIndex {
  /** TAZ ごとの空き求人がある建物スロット。 */
  byTaz: number[][];
  totalVacant: number;
  totalJobs: number;
}

export function buildJobIndex(buildings: BuildingStore): JobIndex {
  const byTaz: number[][] = [];
  for (let z = 0; z < TAZ_COUNT; z++) byTaz.push([]);
  let totalVacant = 0;
  let totalJobs = 0;
  for (const s of buildings.each()) {
    const total = buildings.jobsTotal[s]!;
    if (total === 0) continue;
    totalJobs += total;
    const vacant = total - buildings.jobsFilled[s]!;
    if (vacant <= 0) continue;
    totalVacant += vacant;
    byTaz[tazOf(buildings.originTile[s]!)]!.push(s);
  }
  return { byTaz, totalVacant, totalJobs };
}

export interface HousingIndex {
  byTaz: number[][];
  totalVacant: number;
  totalDwellings: number;
}

export function buildHousingIndex(buildings: BuildingStore): HousingIndex {
  const byTaz: number[][] = [];
  for (let z = 0; z < TAZ_COUNT; z++) byTaz.push([]);
  let totalVacant = 0;
  let totalDwellings = 0;
  for (const s of buildings.each()) {
    if (!isResidential(buildings.archetypeId[s]!)) continue;
    const cap = buildings.capacityResidents[s]!;
    totalDwellings += cap;
    const vacant = cap - buildings.residents[s]!;
    if (vacant <= 0) continue;
    totalVacant += vacant;
    byTaz[tazOf(buildings.originTile[s]!)]!.push(s);
  }
  return { byTaz, totalVacant, totalDwellings };
}

/** 建物のレベル・種別から 1 人あたりの月収を決める。 */
export function wageOf(buildings: BuildingStore, slot: number, skill: number): number {
  const a = archetype(buildings.archetypeId[slot]!);
  const base = 150_000 + a.landValueEffect * 2000 + buildings.level[slot]! * 28_000;
  return Math.max(90_000, Math.round(base * (0.7 + skill / 255)));
}

/**
 * 求職。候補を数件サンプルし、賃金から通勤コストを引いた実質手取りが最大の求人を取る。
 * @returns 就職できたら true
 */
export function seekJob(
  citizens: CitizenStore,
  buildings: BuildingStore,
  taz: TazMatrix,
  index: JobIndex,
  rng: Rng,
  id: number,
): boolean {
  const age = citizens.age[id]!;
  if (age < WORK_AGE_MIN || age >= RETIRE_AGE) return false;
  const home = citizens.homeBuilding[id]!;
  if (!buildings.valid(home)) return false;
  const homeTile = buildings.originTile[handleSlot(home)]!;
  const homeTaz = tazOf(homeTile);

  // 近い TAZ から順に候補を集める
  const candidates: number[] = [];
  const zoneOrder: { z: number; c: number }[] = [];
  for (let z = 0; z < TAZ_COUNT; z++) {
    if (index.byTaz[z]!.length === 0) continue;
    const c = taz.costBetweenZones(homeTaz, z, Mode.Car);
    zoneOrder.push({ z, c: Number.isFinite(c) ? c : 1e9 });
  }
  zoneOrder.sort((a, b) => a.c - b.c);
  for (const { z } of zoneOrder) {
    const list = index.byTaz[z]!;
    for (let k = 0; k < list.length && candidates.length < JOB_SAMPLE_COUNT; k++) {
      candidates.push(list[(rng.int(list.length) + k) % list.length]!);
    }
    if (candidates.length >= JOB_SAMPLE_COUNT) break;
  }
  if (candidates.length === 0) return false;

  const skill = citizens.skill[id]!;
  let best = -1;
  let bestScore = -Infinity;
  for (const slot of candidates) {
    if (buildings.alive[slot] !== 1) continue;
    if (buildings.jobsFilled[slot]! >= buildings.jobsTotal[slot]!) continue;
    const jobTile = buildings.originTile[slot]!;
    // 一番速いモードでの通勤時間を使う
    let bestSec = Infinity;
    for (let m = 0; m < 4; m++) {
      const s = taz.costBetweenTiles(homeTile, jobTile, m as Mode);
      if (s < bestSec) bestSec = s;
    }
    if (!Number.isFinite(bestSec)) continue;
    const wage = wageOf(buildings, slot, skill);
    const vot = valueOfTime(wage);
    // 往復 × 月 20 日の通勤コストを賃金から差し引く
    const commuteCost = (bestSec / 60) * 2 * 20 * vot;
    const score = wage - commuteCost;
    if (score > bestScore) {
      bestScore = score;
      best = slot;
    }
  }
  if (best < 0) return false;

  buildings.jobsFilled[best] = buildings.jobsFilled[best]! + 1;
  citizens.workBuilding[id] = buildings.handleOf(best);
  citizens.incomeYenMo[id] = wageOf(buildings, best, skill);
  citizens.set(id, CitizenFlag.Employed, true);
  // 通勤定期は鉄道アクセスが良い人が持つ
  return true;
}

/** 退職・解雇。求人の空きを戻す。 */
export function leaveJob(citizens: CitizenStore, buildings: BuildingStore, id: number): void {
  const w = citizens.workBuilding[id]!;
  if (buildings.valid(w)) {
    const slot = handleSlot(w);
    if (buildings.jobsFilled[slot]! > 0) buildings.jobsFilled[slot] = buildings.jobsFilled[slot]! - 1;
  }
  citizens.workBuilding[id] = 0;
  citizens.incomeYenMo[id] = 0;
  citizens.set(id, CitizenFlag.Employed, false);
}

/**
 * 住居探し。職場への通勤コストと家賃負担・地価で候補を評価する。
 * 転居が起きることで、街は鉄道網や職場の周りに自己組織化していく。
 */
export function seekHome(
  citizens: CitizenStore,
  buildings: BuildingStore,
  taz: TazMatrix,
  index: HousingIndex,
  rng: Rng,
  id: number,
  landValue: Uint8Array,
): boolean {
  if (index.totalVacant <= 0) return false;
  const work = citizens.workBuilding[id]!;
  const workTile = buildings.valid(work) ? buildings.originTile[handleSlot(work)]! : -1;

  const candidates: number[] = [];
  for (let attempt = 0; attempt < 24 && candidates.length < 8; attempt++) {
    const z = rng.int(TAZ_COUNT);
    const list = index.byTaz[z]!;
    if (list.length === 0) continue;
    candidates.push(list[rng.int(list.length)]!);
  }
  if (candidates.length === 0) return false;

  const income = citizens.incomeYenMo[id]!;
  let best = -1;
  let bestScore = -Infinity;
  for (const slot of candidates) {
    if (buildings.alive[slot] !== 1) continue;
    if (buildings.residents[slot]! >= buildings.capacityResidents[slot]!) continue;
    const tile = buildings.originTile[slot]!;
    const lv = landValue[tile]!;
    // 家賃は地価に比例。所得に対して重すぎる物件は避ける。
    const rent = 30_000 + lv * 900;
    if (income > 0 && rent > income * 0.45) continue;
    let commuteSec = 0;
    if (workTile >= 0) {
      let bestSec = Infinity;
      for (let m = 0; m < 4; m++) {
        const s = taz.costBetweenTiles(tile, workTile, m as Mode);
        if (s < bestSec) bestSec = s;
      }
      commuteSec = Number.isFinite(bestSec) ? bestSec : 7200;
    }
    // 質（地価）は正、通勤時間と家賃は負
    const score = lv * 3 - (commuteSec / 60) * 8 - rent / 6000;
    if (score > bestScore) {
      bestScore = score;
      best = slot;
    }
  }
  if (best < 0) return false;

  // 旧居から退去
  const old = citizens.homeBuilding[id]!;
  if (buildings.valid(old)) {
    const os = handleSlot(old);
    if (buildings.residents[os]! > 0) buildings.residents[os] = buildings.residents[os]! - 1;
  }
  buildings.residents[best] = buildings.residents[best]! + 1;
  citizens.homeBuilding[id] = buildings.handleOf(best);
  citizens.currentTile[id] = buildings.originTile[best]!;
  return true;
}

/** 住居を失う（建物が壊された等）。 */
export function loseHome(citizens: CitizenStore, buildings: BuildingStore, id: number): void {
  const h = citizens.homeBuilding[id]!;
  if (buildings.valid(h)) {
    const s = handleSlot(h);
    if (buildings.residents[s]! > 0) buildings.residents[s] = buildings.residents[s]! - 1;
  }
  citizens.homeBuilding[id] = 0;
}
