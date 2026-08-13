import { INITIAL_CITIZEN_CAPACITY } from '@shared/constants';
import { Activity, Mode, Purpose } from '@shared/enums';
import type { Path } from '@sim/network/pathfinder';
import type { TravelerProfile } from '@sim/network/modeChoice';

/** 市民のビットフラグ。 */
export const CitizenFlag = {
  Alive: 1 << 0,
  HasLicense: 1 << 1,
  OwnsCar: 1 << 2,
  TransitPass: 1 << 3,
  Student: 1 << 4,
  Employed: 1 << 5,
  Retired: 1 << 6,
  /** 転出待ち。住居か職を失って一定日数が経った。 */
  Leaving: 1 << 7,
} as const;

/**
 * 市民ストア。SoA の TypedArray。
 *
 * 1 人あたり約 70 バイト。1 万人で 0.7MB、10 万人でも 7MB に収まる。
 * ここをオブジェクト配列にすると 1 万人で数十 MB になり、
 * 日次のライフサイクル処理が GC ヒッチとして目に見えるようになる。
 */
/**
 * セーブ対象の SoA 配列名。フィールドを足したらここにも足すこと。
 * `tripPath` は節点番号への参照なので保存できない（読み込み時に打ち切る）。
 */
export const CITIZEN_FIELDS = [
  'flags',
  'age',
  'birthDay',
  'education',
  'skill',
  'happiness',
  'incomeYenMo',
  'homeBuilding',
  'workBuilding',
  'householdId',
  'prefWalk',
  'prefBike',
  'prefCar',
  'prefRail',
  'leisureTaste',
  'state',
  'scheduleId',
  'scheduleStep',
  'wakeTick',
  'destBuilding',
  'currentTile',
  'purpose',
  'mode',
  'tripDepartTick',
  'tripArriveTick',
  'waitingSince',
  'unhappyDays',
  'lastCommuteMin',
  'tripsCompleted',
] as const;
export type CitizenField = (typeof CITIZEN_FIELDS)[number];

export class CitizenStore {
  capacity = 0;
  /** 使用中スロットの上限。 */
  high = 0;
  private freeList: number[] = [];

  // --- 属性 ---
  flags!: Uint8Array;
  age!: Uint8Array;
  /** 誕生日（年内の日）。加齢を 1 年に 1 回だけ起こすため。 */
  birthDay!: Uint16Array;
  /** 0 なし / 1 中卒 / 2 高卒 / 3 専門 / 4 大卒 */
  education!: Uint8Array;
  /** 技能 0..255。求人とのマッチングに使う。 */
  skill!: Uint8Array;
  happiness!: Uint8Array;
  incomeYenMo!: Int32Array;

  // --- 所属 ---
  /** 建物ハンドル（世代タグ付き）。0 = なし。 */
  homeBuilding!: Uint32Array;
  workBuilding!: Uint32Array;
  householdId!: Uint32Array;

  // --- 交通の好み（体感分の加算、正で好き） ---
  prefWalk!: Int8Array;
  prefBike!: Int8Array;
  prefCar!: Int8Array;
  prefRail!: Int8Array;
  /** レジャーへの出かけやすさ 0..255。 */
  leisureTaste!: Uint8Array;

  // --- 行動状態機械 ---
  state!: Uint8Array;
  scheduleId!: Uint8Array;
  scheduleStep!: Uint8Array;
  /** 次に状態遷移する絶対 tick。タイミングホイールのキー。 */
  wakeTick!: Uint32Array;
  /** 現在いる（または向かっている）建物ハンドル。 */
  destBuilding!: Uint32Array;
  /** 現在地のタイル。 */
  currentTile!: Uint32Array;
  purpose!: Uint8Array;

  // --- 移動中の状態 ---
  mode!: Uint8Array;
  tripDepartTick!: Uint32Array;
  tripArriveTick!: Uint32Array;
  /** 経路。移動中の市民だけ非 null。描画側はこれを時刻で補間する。 */
  tripPath: (Path | null)[] = [];
  /** 出発準備に入った tick。経路探索待ちが長すぎる市民の検出に使う。 */
  waitingSince!: Uint32Array;
  /** 直近のトリップで各モードがどう評価されたか（インスペクタ表示用、上位数人分のみ保持）。 */
  lastChoiceLog = new Map<number, string>();

  // --- 統計・不満 ---
  /** 不満が続いている日数。転居や転出のトリガ。 */
  unhappyDays!: Uint16Array;
  /** 直近に完了した通勤の所要分。 */
  lastCommuteMin!: Uint16Array;
  /** 生涯の完了トリップ数（検証用）。 */
  tripsCompleted!: Uint32Array;

  constructor(capacity = INITIAL_CITIZEN_CAPACITY) {
    this.grow(capacity);
  }

  private grow(capacity: number): void {
    const g = <T extends ArrayBufferView & { set(a: never): void }>(old: T | undefined, make: (n: number) => T): T => {
      const next = make(capacity);
      if (old) next.set(old as never);
      return next;
    };
    this.flags = g(this.flags, (n) => new Uint8Array(n));
    this.age = g(this.age, (n) => new Uint8Array(n));
    this.birthDay = g(this.birthDay, (n) => new Uint16Array(n));
    this.education = g(this.education, (n) => new Uint8Array(n));
    this.skill = g(this.skill, (n) => new Uint8Array(n));
    this.happiness = g(this.happiness, (n) => new Uint8Array(n));
    this.incomeYenMo = g(this.incomeYenMo, (n) => new Int32Array(n));
    this.homeBuilding = g(this.homeBuilding, (n) => new Uint32Array(n));
    this.workBuilding = g(this.workBuilding, (n) => new Uint32Array(n));
    this.householdId = g(this.householdId, (n) => new Uint32Array(n));
    this.prefWalk = g(this.prefWalk, (n) => new Int8Array(n));
    this.prefBike = g(this.prefBike, (n) => new Int8Array(n));
    this.prefCar = g(this.prefCar, (n) => new Int8Array(n));
    this.prefRail = g(this.prefRail, (n) => new Int8Array(n));
    this.leisureTaste = g(this.leisureTaste, (n) => new Uint8Array(n));
    this.state = g(this.state, (n) => new Uint8Array(n));
    this.scheduleId = g(this.scheduleId, (n) => new Uint8Array(n));
    this.scheduleStep = g(this.scheduleStep, (n) => new Uint8Array(n));
    this.wakeTick = g(this.wakeTick, (n) => new Uint32Array(n));
    this.destBuilding = g(this.destBuilding, (n) => new Uint32Array(n));
    this.currentTile = g(this.currentTile, (n) => new Uint32Array(n));
    this.purpose = g(this.purpose, (n) => new Uint8Array(n));
    this.mode = g(this.mode, (n) => new Uint8Array(n));
    this.tripDepartTick = g(this.tripDepartTick, (n) => new Uint32Array(n));
    this.tripArriveTick = g(this.tripArriveTick, (n) => new Uint32Array(n));
    this.waitingSince = g(this.waitingSince, (n) => new Uint32Array(n));
    this.unhappyDays = g(this.unhappyDays, (n) => new Uint16Array(n));
    this.lastCommuteMin = g(this.lastCommuteMin, (n) => new Uint16Array(n));
    this.tripsCompleted = g(this.tripsCompleted, (n) => new Uint32Array(n));
    while (this.tripPath.length < capacity) this.tripPath.push(null);
    this.capacity = capacity;
  }

  /** セーブデータを流し込む前に容量を確保する。 */
  ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = Math.max(1, this.capacity);
    while (cap < n) cap *= 2;
    this.grow(cap);
  }

  /**
   * 読み込み後に使用中スロットと空きスロットを作り直す。
   * freeList を復元しないと、次に生成した市民が生きている市民を上書きする。
   */
  rebuildFreeList(high: number): void {
    this.high = high;
    this.freeList.length = 0;
    for (let i = high - 1; i >= 0; i--) {
      if ((this.flags[i]! & CitizenFlag.Alive) === 0) this.freeList.push(i);
    }
  }

  /** 新しい市民スロットを確保する。 */
  alloc(): number {
    const slot = this.freeList.pop();
    if (slot !== undefined) return slot;
    if (this.high >= this.capacity) this.grow(this.capacity * 2);
    return this.high++;
  }

  free(id: number): void {
    this.flags[id] = 0;
    this.tripPath[id] = null;
    this.homeBuilding[id] = 0;
    this.workBuilding[id] = 0;
    this.freeList.push(id);
  }

  isAlive(id: number): boolean {
    return (this.flags[id]! & CitizenFlag.Alive) !== 0;
  }
  has(id: number, flag: number): boolean {
    return (this.flags[id]! & flag) !== 0;
  }
  set(id: number, flag: number, on: boolean): void {
    if (on) this.flags[id] = this.flags[id]! | flag;
    else this.flags[id] = this.flags[id]! & ~flag;
  }

  /** 生存者を列挙する。 */
  *each(): Generator<number> {
    for (let i = 0; i < this.high; i++) {
      if ((this.flags[i]! & CitizenFlag.Alive) !== 0) yield i;
    }
  }

  count(): number {
    let c = 0;
    for (let i = 0; i < this.high; i++) if ((this.flags[i]! & CitizenFlag.Alive) !== 0) c++;
    return c;
  }

  /** 交通手段選択に渡すプロファイルを組み立てる（呼び出し側で使い回す）。 */
  fillProfile(id: number, out: TravelerProfile): TravelerProfile {
    out.id = id;
    out.prefWalk = this.prefWalk[id]!;
    out.prefBike = this.prefBike[id]!;
    out.prefCar = this.prefCar[id]!;
    out.prefRail = this.prefRail[id]!;
    out.incomeYenMo = this.incomeYenMo[id]!;
    out.age = this.age[id]!;
    out.hasCar = this.has(id, CitizenFlag.OwnsCar);
    out.hasTransitPass = this.has(id, CitizenFlag.TransitPass);
    return out;
  }

  /** 移動中か。 */
  isTraveling(id: number): boolean {
    return this.state[id] === Activity.Traveling;
  }
}

export function newTravelerProfile(): TravelerProfile {
  return {
    id: 0,
    prefWalk: 0,
    prefBike: 0,
    prefCar: 0,
    prefRail: 0,
    incomeYenMo: 0,
    age: 30,
    hasCar: false,
    hasTransitPass: false,
  };
}

export const DEFAULT_STATE = Activity.AtHome;
export const DEFAULT_MODE = Mode.Walk;
export const DEFAULT_PURPOSE = Purpose.Home;
