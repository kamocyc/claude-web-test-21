/**
 * sim → render / UI への構造変化の通知。
 *
 * リングバッファで、溢れたら `overflowed` が立つ。溢れた場合は描画側が
 * 全再構築にフォールバックする。「イベントを取りこぼして描画がサイレントに
 * ずれる」というクラスのバグを設計から消すための規約。
 */

export type AlertKind =
  | 'noRoadAccess' // 接道なし
  | 'materialShortage' // 原材料不足
  | 'stockout' // 商品切れ
  | 'abandoned' // 廃墟化
  | 'budgetDeficit' // 赤字
  | 'noPath' // 経路なし
  | 'info'; // 操作の結果の通知（保存・読み込みなど）

export type SimEvent =
  | { t: 'buildingSpawned'; id: number }
  | { t: 'buildingRemoved'; id: number }
  | { t: 'buildingLeveled'; id: number; level: number }
  | { t: 'chunkDirty'; chunk: number }
  | { t: 'networkChanged' }
  | { t: 'alert'; kind: AlertKind; tile: number; message: string };

const CAPACITY = 4096;

export class EventRing {
  private buf: (SimEvent | undefined)[] = new Array<SimEvent | undefined>(CAPACITY);
  private head = 0;
  private count = 0;
  /** 取りこぼしが起きたか。描画側はこれを見て全再構築する。 */
  overflowed = false;

  push(e: SimEvent): void {
    if (this.count === CAPACITY) {
      this.overflowed = true;
      return;
    }
    this.buf[(this.head + this.count) % CAPACITY] = e;
    this.count++;
  }

  /** 溜まっているイベントを取り出して空にする。 */
  drain(): SimEvent[] {
    const out: SimEvent[] = [];
    for (let i = 0; i < this.count; i++) {
      const e = this.buf[(this.head + i) % CAPACITY];
      if (e) out.push(e);
    }
    this.head = 0;
    this.count = 0;
    return out;
  }

  clearOverflow(): void {
    this.overflowed = false;
  }

  get length(): number {
    return this.count;
  }
}

/**
 * 粗いダーティ検出のためのバージョン番号群。
 * イベントが精度を、こちらが「取りこぼしても最終的には正しくなる」保証を担う。
 */
export interface Epochs {
  terrain: number;
  zoning: number;
  roads: number;
  rail: number;
  buildings: number;
  overlay: number;
}

export function newEpochs(): Epochs {
  return { terrain: 0, zoning: 0, roads: 0, rail: 0, buildings: 0, overlay: 0 };
}
