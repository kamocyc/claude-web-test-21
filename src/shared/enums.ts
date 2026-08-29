/**
 * 全レイヤ共通の列挙型。数値は TypedArray に直接格納されるため、
 * 既存の値を変更するとセーブデータ互換性が壊れる点に注意。
 */

/** 地形。日本の地理（狭い平野・河川・山地・海岸）を意識した分類。 */
export const Terrain = {
  Plain: 0, // 平地
  Lowland: 1, // 低湿地（水田に最適）
  Forest: 2, // 森林（林業に必要）
  Hill: 3, // 丘陵
  Mountain: 4, // 山地（建設不可）
  Freshwater: 5, // 河川・湖
  Sea: 6, // 海
} as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

export const TERRAIN_NAMES_JA: Record<number, string> = {
  [Terrain.Plain]: '平地',
  [Terrain.Lowland]: '低湿地',
  [Terrain.Forest]: '森林',
  [Terrain.Hill]: '丘陵',
  [Terrain.Mountain]: '山地',
  [Terrain.Freshwater]: '河川',
  [Terrain.Sea]: '海',
};

/** 用途地域。日本の都市計画法の区分に寄せてある。 */
export const Zone = {
  None: 0,
  ResidentialLow: 1, // 第一種低層住居専用地域
  ResidentialMid: 2, // 中高層住居地域
  CommercialLocal: 3, // 近隣商業地域
  CommercialCentral: 4, // 商業地域
  IndustrialLight: 5, // 準工業地域
  IndustrialHeavy: 6, // 工業地域
  AgriPaddy: 7, // 農地（水田）
  AgriField: 8, // 農地（畑）
  Forestry: 9, // 林業地
  Park: 10, // 公園
} as const;
export type Zone = (typeof Zone)[keyof typeof Zone];

export const ZONE_NAMES_JA: Record<number, string> = {
  [Zone.None]: '未指定',
  [Zone.ResidentialLow]: '低層住居',
  [Zone.ResidentialMid]: '中高層住居',
  [Zone.CommercialLocal]: '近隣商業',
  [Zone.CommercialCentral]: '商業',
  [Zone.IndustrialLight]: '準工業',
  [Zone.IndustrialHeavy]: '工業',
  [Zone.AgriPaddy]: '農地(水田)',
  [Zone.AgriField]: '農地(畑)',
  [Zone.Forestry]: '林業',
  [Zone.Park]: '公園',
};

/** RCI 需要バーの区分。ゾーンを 4 グループに畳んだもの。 */
export const DemandKind = {
  Residential: 0,
  Commercial: 1,
  Industrial: 2,
  Agriculture: 3,
} as const;
export type DemandKind = (typeof DemandKind)[keyof typeof DemandKind];

/** 道路種別。0 は「道路なし」。 */
export const RoadClass = {
  None: 0,
  Street: 1, // 生活道路
  Avenue: 2, // 二車線道路
  Boulevard: 3, // 大通り
} as const;
export type RoadClass = (typeof RoadClass)[keyof typeof RoadClass];

export const ROAD_NAMES_JA: Record<number, string> = {
  [RoadClass.None]: 'なし',
  [RoadClass.Street]: '生活道路',
  [RoadClass.Avenue]: '二車線道路',
  [RoadClass.Boulevard]: '大通り',
};

/** 自由流速度 (km/h)。混雑していないリンクの通過時間はこれで決まる。 */
export const ROAD_SPEED_KMH: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 30,
  [RoadClass.Avenue]: 45,
  [RoadClass.Boulevard]: 60,
};
/**
 * 片方向の車線数。交差点で捌ける台数（飽和交通流率 × 車線数）と、
 * リンクに溜められる台数（長さ × 車線数）の両方を決める。
 * 生活道路を大通りに広げると行列が捌けるのは、この 2 つが同時に増えるため。
 */
export const ROAD_LANES: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 1,
  [RoadClass.Avenue]: 2,
  [RoadClass.Boulevard]: 3,
};
/**
 * **描き分けられる**車線数。収容台数はこちらで決まる。
 *
 * 車道の半幅は生活道路 3.1m・大通り 3.7m・幹線 4.3m（`CARRIAGE_HALF`）で、
 * 車幅は 1.7m。中心線から車 1 台ぶん空けて置くと、片方向に並べられる列は
 * 生活道路で 1 本、大通りと幹線で 2 本しかない（幹線の 3 本目は歩道に乗る）。
 *
 * モデルの車線数（`ROAD_LANES`）どおりに溜め込むと、描画は 1 リンクに
 * 収まらない台数を渡されて車体をめり込ませるか、はみ出した車を描かずに落とす。
 * 交差点で捌ける量は `ROAD_LANES` のままなので、道を広げる効果は失われない。
 */
export const DRAWN_LANES: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 1,
  [RoadClass.Avenue]: 2,
  [RoadClass.Boulevard]: 2,
};
/** 建設費 (円/タイル) と月次維持費 (円/タイル)。 */
export const ROAD_BUILD_COST: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 60_000,
  [RoadClass.Avenue]: 180_000,
  [RoadClass.Boulevard]: 400_000,
};
export const ROAD_UPKEEP: Record<number, number> = {
  [RoadClass.None]: 0,
  [RoadClass.Street]: 900,
  [RoadClass.Avenue]: 2200,
  [RoadClass.Boulevard]: 4800,
};

/**
 * 交通手段。エッジのモードマスクにビットとして使う。
 *
 * `Transit`（値 3）はバスと鉄道の両方を指す。路線ごとにプラットフォーム・ノードを
 * 置き、乗車・乗車中・降車のエッジで表現するので、1 回のトリップの中で
 * 「バスで駅まで行って電車に乗り換える」が自然に出る。
 * モードを 4 つに保っているのは、`ModeTimes` の固定長タプル・`MODE_ASC` の行長・
 * 市民の選好配列・TAZ 行列がすべて `MODE_COUNT` に張り付いているため。
 */
export const Mode = {
  Walk: 0,
  Bike: 1,
  Car: 2,
  /** 公共交通（バス・鉄道）。値は 3 のまま — セーブデータに入っている。 */
  Transit: 3,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];
export const MODE_COUNT = 4;

export const MODE_NAMES_JA: Record<number, string> = {
  [Mode.Walk]: '徒歩',
  [Mode.Bike]: '自転車',
  [Mode.Car]: '自動車',
  [Mode.Transit]: '公共交通',
};

/** エッジのモードマスク（ビットフラグ）。 */
export const ModeBit = {
  Walk: 1 << 0,
  Bike: 1 << 1,
  Car: 1 << 2,
  /**
   * 線路タイルどうしを結ぶエッジ。
   * 経路探索には使わない（乗客は路線のプラットフォームを渡り歩く）が、
   * 線路の折れ線を抽出して自動路線と電車の描画に使うので残してある。
   */
  Rail: 1 << 3,
  /** 停留所 ↔ プラットフォームの乗降エッジ。公共交通クエリでのみ通行可能。 */
  Board: 1 << 4,
  /** プラットフォーム間の乗車中エッジ。運行間隔と区間所要が載る。 */
  Ride: 1 << 5,
} as const;

/** モード -> そのモードのクエリで通行可能なエッジマスク。 */
export const MODE_EDGE_MASK: Record<number, number> = {
  [Mode.Walk]: ModeBit.Walk,
  [Mode.Bike]: ModeBit.Walk | ModeBit.Bike,
  [Mode.Car]: ModeBit.Walk | ModeBit.Car,
  [Mode.Transit]: ModeBit.Walk | ModeBit.Board | ModeBit.Ride,
};

/** 各モードの最高速度 (km/h)。A* のヒューリスティックを許容的に保つために使う。 */
export const MODE_MAX_SPEED_KMH: Record<number, number> = {
  [Mode.Walk]: 4.8,
  [Mode.Bike]: 15,
  [Mode.Car]: 60,
  [Mode.Transit]: 70,
};

/** 市民の行動状態。 */
export const Activity = {
  Sleeping: 0, // 就寝
  AtHome: 1, // 在宅
  AtWork: 2, // 就業中
  AtSchool: 3, // 就学中
  Shopping: 4, // 買い物中
  Leisure: 5, // レジャー中
  WaitingForRoute: 6, // 経路探索待ち
  Traveling: 7, // 移動中
  Business: 8, // 業務で外出中（勤務先とは別の事業所にいる）
} as const;
export type Activity = (typeof Activity)[keyof typeof Activity];

export const ACTIVITY_NAMES_JA: Record<number, string> = {
  [Activity.Sleeping]: '就寝',
  [Activity.AtHome]: '在宅',
  [Activity.AtWork]: '勤務',
  [Activity.AtSchool]: '通学先',
  [Activity.Shopping]: '買い物',
  [Activity.Leisure]: 'レジャー',
  [Activity.WaitingForRoute]: '出発準備',
  [Activity.Traveling]: '移動中',
  [Activity.Business]: '外回り',
};

/** 移動の目的。交通手段選択のバイアスに使う。 */
export const Purpose = {
  Commute: 0, // 通勤
  School: 1, // 通学
  Shopping: 2, // 買い物
  Leisure: 3, // レジャー
  Home: 4, // 帰宅
  Business: 5, // 業務移動
} as const;
export type Purpose = (typeof Purpose)[keyof typeof Purpose];

export const PURPOSE_NAMES_JA: Record<number, string> = {
  [Purpose.Commute]: '通勤',
  [Purpose.School]: '通学',
  [Purpose.Shopping]: '買い物',
  [Purpose.Leisure]: 'レジャー',
  [Purpose.Home]: '帰宅',
  [Purpose.Business]: '業務',
};

/** 資源（財）。サプライチェーンの単位。 */
export const Good = {
  None: 0,
  Rice: 1, // 米
  Vegetables: 2, // 野菜
  Logs: 3, // 原木
  Lumber: 4, // 木材
  Food: 5, // 食品
  ConsumerGoods: 6, // 日用品
} as const;
export type Good = (typeof Good)[keyof typeof Good];
export const GOOD_COUNT = 7;

export const GOOD_NAMES_JA: Record<number, string> = {
  [Good.None]: '—',
  [Good.Rice]: '米',
  [Good.Vegetables]: '野菜',
  [Good.Logs]: '原木',
  [Good.Lumber]: '木材',
  [Good.Food]: '食品',
  [Good.ConsumerGoods]: '日用品',
};

/** 公共サービス。タイルの svcMask にビットで立つ。 */
export const Service = {
  Education: 1 << 0,
  Health: 1 << 1,
  Safety: 1 << 2,
  Fire: 1 << 3,
  Park: 1 << 4,
  Transit: 1 << 5,
} as const;

/** 季節。田んぼの生産と描画色に効く。 */
export const Season = {
  Spring: 0, // 春
  Summer: 1, // 夏
  Autumn: 2, // 秋
  Winter: 3, // 冬
} as const;
export type Season = (typeof Season)[keyof typeof Season];

export const SEASON_NAMES_JA: Record<number, string> = {
  [Season.Spring]: '春',
  [Season.Summer]: '夏',
  [Season.Autumn]: '秋',
  [Season.Winter]: '冬',
};

/** 情報オーバーレイの種類。 */
export const Overlay = {
  None: 0,
  LandValue: 1, // 地価
  Traffic: 2, // 交通量
  Pollution: 3, // 公害
  TransitAccess: 4, // 公共交通アクセス
  Zone: 5, // 用途地域
  Power: 6, // 電力
  Water: 7, // 上水道
} as const;
export type Overlay = (typeof Overlay)[keyof typeof Overlay];

export const OVERLAY_NAMES_JA: Record<number, string> = {
  [Overlay.None]: '通常',
  [Overlay.LandValue]: '地価',
  [Overlay.Traffic]: '交通量',
  [Overlay.Pollution]: '公害',
  [Overlay.TransitAccess]: '交通アクセス',
  [Overlay.Zone]: '用途地域',
  [Overlay.Power]: '電力',
  [Overlay.Water]: '上水道',
};

/**
 * 公共交通の車両種別。路線が持つ。
 *
 * バスは道路を走るので `TrafficSystem` の待ち行列に載り、渋滞に巻き込まれる。
 * 電車は専用軌道なので巻き込まれない — 路線を分ける理由はここにある。
 */
export const TransitKind = {
  Bus: 0,
  Train: 1,
} as const;
export type TransitKind = (typeof TransitKind)[keyof typeof TransitKind];

export const TRANSIT_KIND_NAMES_JA: Record<number, string> = {
  [TransitKind.Bus]: 'バス',
  [TransitKind.Train]: '電車',
};

/** 一方通行の向き。0 = 双方向。値はタイル配列に入るので変えない。 */
export const OneWay = {
  None: 0,
  North: 1,
  East: 2,
  South: 3,
  West: 4,
} as const;
export type OneWay = (typeof OneWay)[keyof typeof OneWay];

export const ONE_WAY_NAMES_JA: Record<number, string> = {
  [OneWay.None]: '双方向',
  [OneWay.North]: '北',
  [OneWay.East]: '東',
  [OneWay.South]: '南',
  [OneWay.West]: '西',
};
