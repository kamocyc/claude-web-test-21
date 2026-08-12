import { TICKS_PER_DAY } from '@shared/constants';
import { GOOD_NAMES_JA, Good, MODE_NAMES_JA } from '@shared/enums';
import { buildScenario } from './scenario';
import { Simulation } from './simulation';

/**
 * ヘッドレス実行ハーネス。
 *
 *   npm run sim:headless -- --seed 42 --days 180
 *
 * 描画なしでシミュレーションだけを回し、日次の指標を表として出す。
 * 「経路探索が確実に動く」「街が発展する」といった要求を、
 * 人間が眺めなくても機械的に確認できるようにするのが目的。
 * 経済のフィードバックループが発散/停滞したときも、まずここで気づける。
 */

interface Options {
  seed: number;
  days: number;
  size: number;
  population: number;
  quiet: boolean;
  every: number;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { seed: 42, days: 120, size: 48, population: 400, quiet: false, every: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): number => Number(argv[++i]);
    if (a === '--seed') o.seed = next();
    else if (a === '--days') o.days = next();
    else if (a === '--size') o.size = next();
    else if (a === '--population') o.population = next();
    else if (a === '--every') o.every = next();
    else if (a === '--quiet') o.quiet = true;
  }
  return o;
}

export interface DayRecord {
  day: number;
  population: number;
  buildings: number;
  employed: number;
  unemployed: number;
  homeless: number;
  happiness: number;
  tripsCompleted: number;
  tripsFailed: number;
  avgCommuteMin: number;
  modeShare: number[];
  cacheHitRate: number;
  cash: number;
  stockouts: number;
  trucks: number;
  demandR: number;
  demandC: number;
  demandI: number;
  demandA: number;
}

/** シナリオを組んで N 日回し、日次記録を返す。 */
export function runHeadless(opts: {
  seed: number;
  days: number;
  size?: number;
  population?: number;
  onDay?: (rec: DayRecord, sim: Simulation) => void;
}): { sim: Simulation; records: DayRecord[]; tickMsAvg: number } {
  const sim = new Simulation(opts.seed);
  buildScenario(sim, { size: opts.size ?? 48, seedPopulation: opts.population ?? 400 });

  const records: DayRecord[] = [];
  const t0 = Date.now();
  let ticks = 0;

  for (let day = 0; day < opts.days; day++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) {
      sim.tick();
      ticks++;
    }
    const s = sim.stats();
    const rec: DayRecord = {
      day,
      population: s.population,
      buildings: s.buildings,
      employed: s.employed,
      unemployed: s.unemployed,
      homeless: s.homeless,
      happiness: s.avgHappiness,
      tripsCompleted: s.tripsCompleted,
      tripsFailed: s.tripsFailed,
      avgCommuteMin: s.avgCommuteMin,
      modeShare: s.modeShare,
      cacheHitRate: s.cacheHitRate,
      cash: s.cash,
      stockouts: s.stockouts,
      trucks: s.trucksActive,
      demandR: s.demand.residential,
      demandC: s.demand.commercial,
      demandI: s.demand.industrial,
      demandA: s.demand.agriculture,
    };
    records.push(rec);
    opts.onDay?.(rec, sim);
  }

  const elapsed = Date.now() - t0;
  return { sim, records, tickMsAvg: ticks > 0 ? elapsed / ticks : 0 };
}

function pad(s: string | number, n: number): string {
  return String(s).padStart(n);
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  console.log(`シード=${o.seed} 日数=${o.days} 市街地=${o.size}タイル 初期人口=${o.population}`);
  console.log('シナリオを構築中...');

  const { sim, records, tickMsAvg } = runHeadless({
    seed: o.seed,
    days: o.days,
    size: o.size,
    population: o.population,
    onDay: (rec) => {
      if (o.quiet || rec.day % o.every !== 0) return;
      if (rec.day === 0) {
        console.log(
          '\n  日  人口  建物  就業  失業  幸福  完了移動 失敗 通勤分  徒歩 自転 自動 鉄道  ｷｬｯｼｭ  欠品 ﾄﾗｯｸ    資金(万円)',
        );
      }
      const ms = rec.modeShare;
      console.log(
        `${pad(rec.day, 4)}${pad(rec.population, 6)}${pad(rec.buildings, 6)}${pad(rec.employed, 6)}${pad(
          rec.unemployed,
          6,
        )}${pad(rec.happiness.toFixed(0), 6)}${pad(rec.tripsCompleted, 10)}${pad(rec.tripsFailed, 5)}${pad(
          rec.avgCommuteMin.toFixed(0),
          7,
        )}${pad((ms[0]! * 100).toFixed(0) + '%', 6)}${pad((ms[1]! * 100).toFixed(0) + '%', 5)}${pad(
          (ms[2]! * 100).toFixed(0) + '%',
          5,
        )}${pad((ms[3]! * 100).toFixed(0) + '%', 5)}${pad((rec.cacheHitRate * 100).toFixed(0) + '%', 8)}${pad(
          rec.stockouts,
          6,
        )}${pad(rec.trucks, 6)}${pad(Math.round(rec.cash / 10000).toLocaleString('ja-JP'), 14)}`,
      );
    },
  });

  const last = records[records.length - 1]!;
  const first = records[0]!;
  const s = sim.stats();

  console.log('\n===== 最終状態 =====');
  console.log(`日時              : ${sim.clock.formatJa()}（${sim.clock.season === 0 ? '春' : sim.clock.season === 1 ? '夏' : sim.clock.season === 2 ? '秋' : '冬'}）`);
  console.log(`人口              : ${first.population} → ${last.population}`);
  console.log(`建物              : ${first.buildings} → ${last.buildings}`);
  console.log(`就業 / 失業       : ${last.employed} / ${last.unemployed}`);
  console.log(`住居なし          : ${last.homeless}`);
  console.log(`平均幸福度        : ${last.happiness.toFixed(1)} / 255`);
  console.log(`平均通勤時間      : ${last.avgCommuteMin.toFixed(1)} 分`);
  console.log(
    `交通分担率        : ${[0, 1, 2, 3].map((m) => `${MODE_NAMES_JA[m]} ${(last.modeShare[m]! * 100).toFixed(0)}%`).join(' / ')}`,
  );
  console.log(`1 日の完了移動数  : ${last.tripsCompleted}（失敗 ${last.tripsFailed}）`);
  console.log(`経路キャッシュ率  : ${(last.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`経路探索の総数    : ${sim.router.totalSearches}（失敗 ${sim.router.totalFailures}）`);
  console.log(`稼働トラック      : ${last.trucks}`);
  console.log(`欠品中の商店      : ${last.stockouts}`);
  console.log(`資金              : ${Math.round(s.cash).toLocaleString('ja-JP')} 円`);
  console.log(
    `需要 R/C/I/A      : ${last.demandR.toFixed(0)} / ${last.demandC.toFixed(0)} / ${last.demandI.toFixed(0)} / ${last.demandA.toFixed(0)}`,
  );

  console.log('\n----- 資源在庫 -----');
  for (let g = 1; g < 7; g++) {
    const stock = s.goodsStock[g] ?? 0;
    const prod = s.goodsProduced[g] ?? 0;
    console.log(`${GOOD_NAMES_JA[g as Good]!.padEnd(6, '　')}: 在庫 ${stock.toFixed(0).padStart(8)}  時間生産 ${prod.toFixed(1).padStart(7)}`);
  }

  console.log('\n----- 性能 -----');
  console.log(`1 tick の平均処理時間: ${tickMsAvg.toFixed(3)} ms`);
  console.log(`グラフ: ${sim.graph.nodeCount} ノード / ${sim.graph.edgeCount} エッジ`);
  // ×10 速度は 12 tick/秒 × 10 = 120 tick/秒。60fps なら 1 フレームあたり 2 tick。
  console.log(`（×10 速度 = 120 tick/秒。60fps なら 1 フレーム 2 tick で ${(tickMsAvg * 2).toFixed(2)} ms）`);

  const monthly = sim.budget.history[sim.budget.history.length - 1];
  if (monthly) {
    console.log('\n----- 直近の月次決算 -----');
    console.log(`収入: 住民税 ${monthly.incomeResidential.toLocaleString('ja-JP')} / 商業 ${monthly.incomeCommercial.toLocaleString('ja-JP')} / 工業 ${monthly.incomeIndustrial.toLocaleString('ja-JP')} / 農林 ${monthly.incomeAgriculture.toLocaleString('ja-JP')}`);
    console.log(`支出: 道路 ${monthly.upkeepRoads.toLocaleString('ja-JP')} / 鉄道 ${monthly.upkeepRail.toLocaleString('ja-JP')} / 施設 ${monthly.upkeepServices.toLocaleString('ja-JP')}`);
    console.log(`収支: ${monthly.net >= 0 ? '+' : ''}${monthly.net.toLocaleString('ja-JP')} 円`);
  }
}

// 直接実行されたときだけ main を走らせる（テストからは runHeadless を使う）。
const isMain =
  typeof process !== 'undefined' && process.argv[1] !== undefined && process.argv[1].includes('harness');
if (isMain) main();
