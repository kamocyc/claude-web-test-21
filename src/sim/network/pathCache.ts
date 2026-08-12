import { PATH_CACHE_CAPACITY } from '@shared/constants';
import type { Mode } from '@shared/enums';
import type { Path } from './pathfinder';

interface Entry {
  path: Path;
  lastUsed: number;
}

/**
 * 経路キャッシュ。キーは (出発ノード, 到着ノード, モード)。
 *
 * 建物単位ではなく**道路ノード単位**で持つのが要点。40 世帯のマンションも
 * 200 人のオフィスも接道点は 1 つなので、ヒット率が跳ね上がる。
 *
 * 重要な規約: **混雑ではキャッシュを捨てない**。キャッシュしているのは
 * 「経路」であって「所要時間」ではない。混雑で無効化すると、交通量が最大の
 * まさにその瞬間にキャッシュが全滅して探索が爆発する（この設計が失敗する典型例）。
 * 捨てるのはネットワーク自体が変わったときだけ。
 */
export class PathCache {
  private map = new Map<number, Entry>();
  private clock = 0;

  hits = 0;
  misses = 0;

  private static key(origin: number, dest: number, mode: Mode): number {
    // ノード数の上限を 2^21 (約 200 万) と仮定。TILE_COUNT = 65536 なので十分。
    return (origin * 2097152 + dest) * 8 + mode;
  }

  get(origin: number, dest: number, mode: Mode, graphVersion: number): Path | null {
    const k = PathCache.key(origin, dest, mode);
    const e = this.map.get(k);
    if (!e) {
      this.misses++;
      return null;
    }
    // ネットワークが変わっていたら遅延的に破棄する（一括スキャンしない）。
    if (e.path.version !== graphVersion) {
      this.map.delete(k);
      this.misses++;
      return null;
    }
    e.lastUsed = ++this.clock;
    this.hits++;
    return e.path;
  }

  set(origin: number, dest: number, mode: Mode, path: Path): void {
    if (this.map.size >= PATH_CACHE_CAPACITY) this.evict();
    this.map.set(PathCache.key(origin, dest, mode), { path, lastUsed: ++this.clock });
  }

  /** 最も長く使われていないエントリを 1/16 まとめて捨てる（毎回 1 件だと走査コストが割に合わない）。 */
  private evict(): void {
    const target = Math.max(1, PATH_CACHE_CAPACITY >> 4);
    const entries: { k: number; t: number }[] = [];
    for (const [k, e] of this.map) entries.push({ k, t: e.lastUsed });
    entries.sort((a, b) => a.t - b.t);
    for (let i = 0; i < target && i < entries.length; i++) this.map.delete(entries[i]!.k);
  }

  get size(): number {
    return this.map.size;
  }

  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  clear(): void {
    this.map.clear();
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}
