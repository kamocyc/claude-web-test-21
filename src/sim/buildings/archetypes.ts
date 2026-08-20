import { Good, Service, Zone } from '@shared/enums';

/**
 * 建物アーキタイプの定義テーブル。ゲームバランスの大半がこの 1 つの表にある。
 * 生産レシピ・雇用・公害・必要サービスをすべてデータとして持たせ、
 * ロジック側は表を読むだけにする。
 */
export interface Archetype {
  id: number;
  nameJa: string;
  zone: Zone;
  /** フットプリント（タイル）。 */
  w: number;
  h: number;
  minLevel: number;
  maxLevel: number;
  /** レベル 1 あたりの世帯数（住宅のみ）。 */
  households: number;
  /** レベル 1 あたりの雇用数。 */
  jobs: number;
  /** 生産レシピ。 */
  inputs: { good: Good; per: number }[];
  /**
   * 入力を「どちらか一方でよい」扱いにする。
   * 食品工場は米でも野菜でも操業できる。両方必須にすると、片方の供給が途切れた
   * だけで食料生産が完全に止まり、街全体が飢えて連鎖崩壊する。
   */
  anyInput: boolean;
  output: Good;
  /** レベル 1・満員稼働・1 時間あたりの生産量。 */
  outputPerHour: number;
  /** 在庫上限（入出力それぞれ）。 */
  storage: number;
  /** 月次維持費（円）。プレイヤ設置の公共施設のみ非ゼロ。 */
  upkeep: number;
  /** 設置費（円）。プレイヤが直接置く建物のみ。 */
  buildCost: number;
  pollution: number;
  noise: number;
  /** 周辺地価への影響（正負）。 */
  landValueEffect: number;
  /** 提供する公共サービス（Service ビットマスク）。 */
  provides: number;
  /** サービス到達半径（タイル）。 */
  serviceRadius: number;
  /** レジャー目的地としての魅力度。0 なら目的地にならない。 */
  leisureAppeal: number;
  /** プレイヤが直接設置する建物か（true ならゾーンから自然発生しない）。 */
  playerPlaced: boolean;
  /**
   * この建物が出現するのに必要な市の人口。
   * 開幕からタワーマンションが林立すると、街が育った実感が消えてしまう。
   */
  minCityPopulation: number;
  /** 描画に使う形状キー。 */
  mesh: string;
}

function def(a: Partial<Archetype> & { id: number; nameJa: string; zone: Zone; mesh: string }): Archetype {
  return {
    w: 1,
    h: 1,
    minLevel: 1,
    maxLevel: 1,
    households: 0,
    jobs: 0,
    inputs: [],
    anyInput: false,
    output: Good.None,
    outputPerHour: 0,
    storage: 0,
    upkeep: 0,
    buildCost: 0,
    pollution: 0,
    noise: 0,
    landValueEffect: 0,
    provides: 0,
    serviceRadius: 0,
    leisureAppeal: 0,
    playerPlaced: false,
    minCityPopulation: 0,
    ...a,
  } as Archetype;
}

export const Arch = {
  // --- 住宅 ---
  House: 0,
  Apartment: 1,
  Mansion: 2,
  TowerMansion: 3,
  // --- 商業 ---
  Konbini: 4,
  Shotengai: 5,
  Supermarket: 6,
  ZakkyoBuilding: 7,
  OfficeBuilding: 8,
  // --- 工業 ---
  SmallFactory: 9,
  Factory: 10,
  Sawmill: 11,
  RiceMill: 12,
  Warehouse: 13,
  // --- 農林 ---
  Paddy: 14,
  Field: 15,
  ForestryPlot: 16,
  // --- 公共（プレイヤ設置） ---
  Station: 17,
  School: 18,
  Hospital: 19,
  Police: 20,
  FireStation: 21,
  Park: 22,
  Shrine: 23,
  CityHall: 24,
  // --- 住宅（追加分）---
  // Arch の値はセーブデータに入るので、途中に挿入せず末尾に足す。
  MidRiseApartment: 25,
  SmallMansion: 26,
} as const;

export const ARCHETYPES: Archetype[] = [
  // ---------------- 住宅 ----------------
  def({
    id: Arch.House,
    nameJa: '一戸建て',
    zone: Zone.ResidentialLow,
    mesh: 'house',
    maxLevel: 2,
    households: 1,
    landValueEffect: 2,
  }),
  def({
    id: Arch.Apartment,
    nameJa: 'アパート',
    zone: Zone.ResidentialLow,
    mesh: 'apartment',
    w: 1,
    h: 2,
    minLevel: 2,
    maxLevel: 3,
    households: 6,
    noise: 8,
  }),
  def({
    id: Arch.Mansion,
    nameJa: 'マンション',
    zone: Zone.ResidentialMid,
    mesh: 'mansion',
    w: 2,
    h: 2,
    minLevel: 2,
    maxLevel: 4,
    households: 24,
    noise: 12,
    landValueEffect: 4,
    minCityPopulation: 1200,
  }),
  def({
    id: Arch.TowerMansion,
    nameJa: 'タワーマンション',
    zone: Zone.ResidentialMid,
    mesh: 'tower',
    w: 2,
    h: 2,
    minLevel: 5,
    maxLevel: 5,
    households: 90,
    noise: 14,
    landValueEffect: 12,
    minCityPopulation: 6000,
  }),

  // ---------------- 商業 ----------------
  def({
    id: Arch.Konbini,
    nameJa: 'コンビニ',
    zone: Zone.CommercialLocal,
    mesh: 'konbini',
    maxLevel: 2,
    jobs: 6,
    inputs: [{ good: Good.Food, per: 1 }],
    storage: 40,
    noise: 6,
    landValueEffect: 3,
  }),
  def({
    id: Arch.Shotengai,
    nameJa: '商店街',
    zone: Zone.CommercialLocal,
    mesh: 'shotengai',
    maxLevel: 3,
    jobs: 5,
    inputs: [
      { good: Good.Food, per: 1 },
      { good: Good.ConsumerGoods, per: 1 },
    ],
    anyInput: true,
    storage: 50,
    noise: 10,
    landValueEffect: 5,
    leisureAppeal: 30,
  }),
  def({
    id: Arch.Supermarket,
    nameJa: 'スーパー',
    zone: Zone.CommercialLocal,
    mesh: 'supermarket',
    w: 2,
    h: 2,
    minLevel: 2,
    maxLevel: 3,
    jobs: 25,
    inputs: [{ good: Good.Food, per: 1 }],
    storage: 200,
    minCityPopulation: 800,
    noise: 14,
    landValueEffect: 4,
  }),
  def({
    id: Arch.ZakkyoBuilding,
    nameJa: '雑居ビル',
    zone: Zone.CommercialCentral,
    mesh: 'zakkyo',
    minLevel: 2,
    maxLevel: 4,
    jobs: 20,
    inputs: [{ good: Good.ConsumerGoods, per: 1 }],
    storage: 60,
    noise: 18,
    landValueEffect: 6,
    leisureAppeal: 45,
  }),
  def({
    id: Arch.OfficeBuilding,
    nameJa: 'オフィスビル',
    zone: Zone.CommercialCentral,
    mesh: 'office',
    w: 2,
    h: 2,
    minLevel: 3,
    maxLevel: 5,
    jobs: 70,
    noise: 12,
    landValueEffect: 10,
    minCityPopulation: 3000,
  }),

  // ---------------- 工業 ----------------
  def({
    id: Arch.SmallFactory,
    nameJa: '町工場',
    zone: Zone.IndustrialLight,
    mesh: 'smallfactory',
    maxLevel: 2,
    jobs: 10,
    inputs: [{ good: Good.Lumber, per: 1 }],
    output: Good.ConsumerGoods,
    outputPerHour: 3,
    storage: 60,
    pollution: 14,
    noise: 20,
    landValueEffect: -6,
  }),
  def({
    id: Arch.Factory,
    nameJa: '工場',
    zone: Zone.IndustrialHeavy,
    mesh: 'factory',
    w: 2,
    h: 2,
    minLevel: 2,
    maxLevel: 4,
    jobs: 45,
    inputs: [{ good: Good.Lumber, per: 1 }],
    output: Good.ConsumerGoods,
    outputPerHour: 10,
    storage: 200,
    pollution: 45,
    noise: 35,
    landValueEffect: -18,
  }),
  def({
    id: Arch.Sawmill,
    nameJa: '製材所',
    zone: Zone.IndustrialHeavy,
    mesh: 'sawmill',
    w: 2,
    h: 2,
    jobs: 22,
    inputs: [{ good: Good.Logs, per: 1 }],
    output: Good.Lumber,
    outputPerHour: 18,
    storage: 200,
    pollution: 22,
    noise: 30,
    landValueEffect: -10,
  }),
  def({
    id: Arch.RiceMill,
    nameJa: '食品工場',
    zone: Zone.IndustrialLight,
    mesh: 'ricemill',
    w: 2,
    h: 2,
    jobs: 26,
    inputs: [
      { good: Good.Rice, per: 1 },
      { good: Good.Vegetables, per: 1 },
    ],
    anyInput: true,
    output: Good.Food,
    outputPerHour: 16,
    storage: 240,
    pollution: 12,
    noise: 20,
    landValueEffect: -6,
  }),
  def({
    id: Arch.Warehouse,
    nameJa: '倉庫',
    zone: Zone.IndustrialLight,
    mesh: 'warehouse',
    w: 2,
    h: 2,
    jobs: 10,
    storage: 600,
    pollution: 5,
    noise: 18,
    landValueEffect: -6,
  }),

  // ---------------- 農林 ----------------
  def({
    id: Arch.Paddy,
    nameJa: '田んぼ',
    zone: Zone.AgriPaddy,
    mesh: 'paddy',
    w: 2,
    h: 2,
    jobs: 4,
    output: Good.Rice,
    outputPerHour: 8,
    storage: 300,
    landValueEffect: 1,
    leisureAppeal: 4,
  }),
  def({
    id: Arch.Field,
    nameJa: '畑',
    zone: Zone.AgriField,
    mesh: 'field',
    w: 2,
    h: 2,
    jobs: 3,
    output: Good.Vegetables,
    outputPerHour: 6,
    storage: 200,
    landValueEffect: 1,
  }),
  def({
    id: Arch.ForestryPlot,
    nameJa: '林業区画',
    zone: Zone.Forestry,
    mesh: 'forestry',
    w: 2,
    h: 2,
    jobs: 5,
    output: Good.Logs,
    outputPerHour: 9,
    storage: 200,
    landValueEffect: 2,
    leisureAppeal: 6,
  }),

  // ---------------- 公共（プレイヤ設置） ----------------
  def({
    id: Arch.Station,
    nameJa: '駅',
    zone: Zone.None,
    mesh: 'station',
    w: 2,
    h: 2,
    jobs: 12,
    upkeep: 180_000,
    buildCost: 24_000_000,
    landValueEffect: 30,
    provides: Service.Transit,
    serviceRadius: 12,
    playerPlaced: true,
    leisureAppeal: 20,
  }),
  def({
    id: Arch.School,
    nameJa: '学校',
    zone: Zone.None,
    mesh: 'school',
    w: 2,
    h: 2,
    jobs: 25,
    upkeep: 900_000,
    buildCost: 18_000_000,
    landValueEffect: 8,
    provides: Service.Education,
    serviceRadius: 18,
    playerPlaced: true,
  }),
  def({
    id: Arch.Hospital,
    nameJa: '病院',
    zone: Zone.None,
    mesh: 'hospital',
    w: 2,
    h: 2,
    jobs: 40,
    upkeep: 1_600_000,
    buildCost: 32_000_000,
    landValueEffect: 6,
    provides: Service.Health,
    serviceRadius: 24,
    playerPlaced: true,
  }),
  def({
    id: Arch.Police,
    nameJa: '交番',
    zone: Zone.None,
    mesh: 'police',
    jobs: 8,
    upkeep: 320_000,
    buildCost: 6_000_000,
    landValueEffect: 4,
    provides: Service.Safety,
    serviceRadius: 16,
    playerPlaced: true,
  }),
  def({
    id: Arch.FireStation,
    nameJa: '消防署',
    zone: Zone.None,
    mesh: 'fire',
    w: 2,
    h: 2,
    jobs: 14,
    upkeep: 620_000,
    buildCost: 12_000_000,
    provides: Service.Fire,
    serviceRadius: 20,
    playerPlaced: true,
  }),
  def({
    id: Arch.Park,
    nameJa: '公園',
    zone: Zone.Park,
    mesh: 'park',
    upkeep: 60_000,
    buildCost: 1_200_000,
    landValueEffect: 14,
    provides: Service.Park,
    serviceRadius: 10,
    playerPlaced: true,
    leisureAppeal: 60,
  }),
  def({
    id: Arch.Shrine,
    nameJa: '神社',
    zone: Zone.None,
    mesh: 'shrine',
    w: 2,
    h: 2,
    jobs: 3,
    upkeep: 90_000,
    buildCost: 5_000_000,
    landValueEffect: 18,
    provides: Service.Park,
    serviceRadius: 12,
    playerPlaced: true,
    leisureAppeal: 85,
  }),
  def({
    id: Arch.CityHall,
    nameJa: '役所',
    zone: Zone.None,
    mesh: 'cityhall',
    w: 2,
    h: 2,
    jobs: 40,
    upkeep: 800_000,
    buildCost: 20_000_000,
    landValueEffect: 10,
    playerPlaced: true,
  }),

  // ---------------- 住宅（中密度の隙間を埋める） ----------------
  // 中高層住居ゾーンには 2×2 の建物しか無かったので、6×6 の街区の内側 5×5 に
  // マンションが 4 棟しか入らず、L 字の 9 タイルが永久に空いていた。
  // 「中密度を密集させた」のに実際には密にならない、という食い違いを直す。
  def({
    id: Arch.MidRiseApartment,
    nameJa: '中層アパート',
    zone: Zone.ResidentialMid,
    mesh: 'apartment',
    w: 1,
    h: 2,
    minLevel: 2,
    maxLevel: 4,
    households: 14,
    noise: 10,
    landValueEffect: 2,
    minCityPopulation: 400,
  }),
  def({
    id: Arch.SmallMansion,
    nameJa: '小規模マンション',
    zone: Zone.ResidentialMid,
    mesh: 'mansion',
    minLevel: 2,
    maxLevel: 4,
    households: 8,
    noise: 9,
    landValueEffect: 2,
    minCityPopulation: 600,
  }),
];

/** ゾーン種別 → そのゾーンで自然発生しうるアーキタイプ。 */
export const ZONE_ARCHETYPES: Record<number, number[]> = (() => {
  const m: Record<number, number[]> = {};
  for (const a of ARCHETYPES) {
    if (a.playerPlaced || a.zone === Zone.None) continue;
    (m[a.zone] ??= []).push(a.id);
  }
  return m;
})();

/** プレイヤが設置できる建物の一覧（ツールパレット用）。 */
export const PLACEABLE = ARCHETYPES.filter((a) => a.playerPlaced).map((a) => a.id);

export function archetype(id: number): Archetype {
  return ARCHETYPES[id]!;
}

/** 住宅系か。 */
export function isResidential(id: number): boolean {
  return ARCHETYPES[id]!.households > 0;
}
/** 商業系か（買い物の目的地になる）。 */
export function isShop(id: number): boolean {
  const a = ARCHETYPES[id]!;
  return a.zone === Zone.CommercialLocal || a.zone === Zone.CommercialCentral;
}
/** 生産（産出を持つ）建物か。 */
export function isProducer(id: number): boolean {
  return ARCHETYPES[id]!.output !== Good.None;
}
/** 入力資源を消費する建物か。 */
export function isConsumer(id: number): boolean {
  return ARCHETYPES[id]!.inputs.length > 0;
}
