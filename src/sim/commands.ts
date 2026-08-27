import type { RoadClass, TransitKind, Zone } from '@shared/enums';

/**
 * プレイヤ操作はすべてシリアライズ可能なコマンドとして表現し、tick 境界でのみ適用する。
 *
 * これにより「シード + コマンド列」だけで同じ街が再現できる。
 * 決定論テスト・セーブデータ・不具合の再現手順・後から sim を Worker に移す際の
 * メッセージ形式が、すべてこの 1 つの設計から手に入る。
 */
export type Command =
  | { t: 'buildRoad'; cls: RoadClass; tiles: number[] }
  | { t: 'buildRail'; tiles: number[] }
  | { t: 'placeBuilding'; archetype: number; tile: number }
  | { t: 'zonePaint'; zone: Zone; tiles: number[] }
  | { t: 'bulldoze'; tiles: number[] }
  | { t: 'setTax'; zone: Zone; pct: number }
  | { t: 'setSpeed'; speed: number }
  /** 一方通行。`dir` は `OneWay`。0 で解除。 */
  | { t: 'setOneWay'; dir: number; tiles: number[] }
  /** 路線を敷く。`stops` は停留所のタイル番号を通る順に並べたもの。 */
  | { t: 'createLine'; kind: TransitKind; stops: number[] }
  | { t: 'setLineHeadway'; line: number; headwayMin: number }
  | { t: 'deleteLine'; line: number };

export class CommandLog {
  /** [tick, command] のペア。 */
  readonly entries: { tick: number; cmd: Command }[] = [];

  record(tick: number, cmd: Command): void {
    this.entries.push({ tick, cmd });
  }

  toJSON(): string {
    return JSON.stringify(this.entries);
  }

  static fromJSON(json: string): CommandLog {
    const log = new CommandLog();
    const parsed = JSON.parse(json) as { tick: number; cmd: Command }[];
    for (const e of parsed) log.entries.push(e);
    return log;
  }
}
