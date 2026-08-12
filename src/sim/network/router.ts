import { MAX_EXPANSIONS_PER_PATH, MAX_EXPANSIONS_PER_TICK } from '@shared/constants';
import type { Mode } from '@shared/enums';
import type { Graph } from './graph';
import { PathCache } from './pathCache';
import { Pathfinder, type Path } from './pathfinder';

/**
 * 経路探索のフロントエンド。キャッシュと 1 tick あたりの探索予算を束ねる。
 *
 * 予算を超えたリクエストは失敗ではなく「まだ返せない」として扱い、呼び出し側は
 * 次の tick に再要求する。市民から見れば出発が数分ずれるだけで、プレイヤには
 * 見えない。逆にこれが無いと、幹線道路を 1 本撤去した瞬間に全市民が同時に
 * 再探索してフレームが飛ぶ。
 */
export class Router {
  private readonly finder = new Pathfinder();
  readonly cache = new PathCache();

  /** この tick で使い切ったノード展開数。 */
  private spent = 0;
  /** 統計 */
  searchesThisTick = 0;
  deferredThisTick = 0;
  totalSearches = 0;
  totalFailures = 0;

  beginTick(): void {
    this.spent = 0;
    this.searchesThisTick = 0;
    this.deferredThisTick = 0;
  }

  /** 予算に余裕があるか。 */
  get hasBudget(): boolean {
    return this.spent < MAX_EXPANSIONS_PER_TICK;
  }

  /**
   * 経路を取得する。
   * - キャッシュヒット時は即座に返す（予算を消費しない）
   * - ミスかつ予算内なら探索して返す
   * - ミスかつ予算切れなら `undefined` を返す（＝次 tick に再要求せよ）
   * - 探索して見つからなければ `null`（＝到達不能。再要求しても無駄）
   */
  getPath(graph: Graph, origin: number, dest: number, mode: Mode, perturbSeed = 0): Path | null | undefined {
    if (origin < 0 || dest < 0) return null;
    if (origin === dest) {
      return { nodes: new Int32Array([origin]), edges: new Int32Array(0), costSec: 0, lengthM: 0, mode, version: graph.version };
    }
    const cached = this.cache.get(origin, dest, mode, graph.version);
    if (cached) return cached;

    if (!this.hasBudget) {
      this.deferredThisTick++;
      return undefined;
    }

    const budget = Math.min(MAX_EXPANSIONS_PER_PATH, MAX_EXPANSIONS_PER_TICK - this.spent);
    const path = this.finder.search(graph, origin, dest, mode, perturbSeed, budget);
    this.spent += this.finder.stats.expansions;
    this.searchesThisTick++;
    this.totalSearches++;
    if (!path) {
      this.totalFailures++;
      return null;
    }
    this.cache.set(origin, dest, mode, path);
    return path;
  }

  /**
   * 所要時間だけが欲しい場合（交通手段選択の候補評価など）。
   * こちらもキャッシュを共有するので、選ばれたモードの経路は再探索されない。
   */
  estimateSec(graph: Graph, origin: number, dest: number, mode: Mode): number {
    const p = this.getPath(graph, origin, dest, mode, 0);
    if (p === undefined) return Infinity;
    return p ? p.costSec : Infinity;
  }

  get expansionsSpent(): number {
    return this.spent;
  }
}
