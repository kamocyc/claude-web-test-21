/** ゲーム全体のチューニング定数。ここ以外にマジックナンバーを置かない。 */

// ---------- ワールド ----------
/** 1 タイルの一辺 (m)。一戸建ての敷地（約 100m²）が 1 タイルに収まる大きさ。 */
export const TILE_M = 10;
/** 320 タイル = 3.2km 四方。1 万人なら人口密度 1000 人/km² 前後の地方都市になる。 */
export const MAP_W = 320;
export const MAP_H = 320;
export const TILE_COUNT = MAP_W * MAP_H;
/** 描画チャンクの一辺（タイル数）。編集時の再構築単位。 */
export const CHUNK = 32;
export const CHUNKS_X = MAP_W / CHUNK;
export const CHUNKS_Y = MAP_H / CHUNK;
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y;

/** 交通解析ゾーン (TAZ)。ゾーン間コスト行列の粒度。 */
export const TAZ = 32; // 32x32 タイル = 1 TAZ
export const TAZ_X = MAP_W / TAZ;
export const TAZ_Y = MAP_H / TAZ;
export const TAZ_COUNT = TAZ_X * TAZ_Y;

// ---------- 時間 ----------
/** 1 tick = 1 シミュレーション分。 */
export const TICKS_PER_HOUR = 60;
export const TICKS_PER_DAY = 1440;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;
/** ×1 速度で 1 実秒あたり何 tick 進めるか。 */
export const TICKS_PER_SECOND_AT_1X = 12;
/** 1 フレームで消化する tick の上限。長い tick が続いても死のスパイラルに入らないための蓋。 */
export const MAX_TICKS_PER_FRAME = 8;

// ---------- 経路探索 ----------
/** 1 tick あたりに許す A* のノード展開総数。フレーム落ちを防ぐ予算。 */
export const MAX_EXPANSIONS_PER_TICK = 40_000;
/** 1 クエリあたりの展開上限。超えたら探索失敗として扱う。 */
export const MAX_EXPANSIONS_PER_PATH = 6_000;
/**
 * 経路キャッシュのエントリ上限（LRU）。
 *
 * 人口 7000 の街で実測すると、必要なキー数（出発ノード×到着ノード×モード）は
 * 2 万を超える。上限が足りないと追い出しが常時起きてヒット率が 75% まで落ち、
 * 1 tick の処理時間が 1.3ms まで悪化する（＝×10 速度でフレーム予算を食い潰す）。
 */
export const PATH_CACHE_CAPACITY = 120_000;
/** 建物 → 最寄り道路ノードを探す最大距離（タイル）。これを超えると「接道なし」。 */
export const ROAD_ACCESS_RADIUS = 4;

// ---------- 交通・渋滞 ----------
/** BPR の β。 */
export const BPR_BETA = 4;
/** 混雑による遅延の上限倍率。無限大コストが A* のヒープを壊すのを防ぐ。 */
export const MAX_CONGESTION_FACTOR = 8;
/** エッジコストの EMA 平滑化係数（1 分あたり）。経路選択の発振を抑える中心的な仕掛け。 */
export const COST_SMOOTHING_LAMBDA = 0.05;
/** 走行中の再探索を試みる確率。全員が一斉に経路を変えるのを防ぐ。 */
export const REROUTE_PROBABILITY = 0.1;
/** 再探索のトリガとなる ETA 超過率。 */
export const REROUTE_ETA_RATIO = 1.4;
/** 市民ごとのコスト摂動幅。等コストの並行路に流れを分散させる（確率的利用者均衡）。 */
export const COST_PERTURBATION = 0.05;
/** 交通量カウンタの減衰（1 分あたり）。直近 1 時間相当の移動平均になる。 */
export const VOLUME_DECAY = 1 / 60;

// ---------- 公共交通 ----------
/** 駅の徒歩アクセス圏（タイル）。 */
export const STATION_WALK_RADIUS = 12;
/** 待ち時間の体感重み（分/分）。 */
export const WAIT_WEIGHT = 2.0;
/** アクセス・イグレス徒歩の体感重み。 */
export const WALK_WEIGHT = 1.8;
/** 乗車ペナルティ（分）。 */
export const BOARD_PENALTY_MIN = 1.0;
/** 乗換ペナルティ（2 回目以降の乗車、分）。 */
export const TRANSFER_PENALTY_MIN = 4.0;
/** 既定の運行間隔（分）。待ち時間 = 運行間隔 / 2。 */
export const DEFAULT_HEADWAY_MIN = 8;
/** 鉄道の表定速度 (km/h)。 */
export const RAIL_SPEED_KMH = 70;

// ---------- 交通手段選択（多項ロジット） ----------
/** ロジットのスケール（分）。大きいほど選択がばらける。 */
export const LOGIT_THETA = 8.0;
/** モード固有定数（体感分）。正が「選ばれやすい」。鉄道が高いのは日本の文化的既定。 */
export const MODE_ASC: Record<number, number> = {
  0: 0, // 徒歩
  1: 2, // 自転車
  2: 6, // 自動車（快適性）
  3: 4, // 鉄道
};
/** 目的別のモードバイアス [purpose][mode]。 */
export const PURPOSE_MODE_BIAS: number[][] = [
  /* 通勤       */ [0, 1, 0, 3],
  /* 通学       */ [2, 3, -99, 2],
  /* 買い物     */ [1, 2, 5, 0],
  /* レジャー   */ [1, 2, 2, 3],
  /* 帰宅       */ [0, 1, 0, 3],
];
/** 時間価値 (円/分) の基礎値。所得で増える。 */
export const VOT_BASE_YEN_PER_MIN = 20;
/** 徒歩でこれを超える所要時間なら徒歩は選択肢から外す（分）。 */
export const MAX_WALK_MIN = 45;
/** 自転車の最大距離 (m)。 */
export const MAX_BIKE_M = 8000;
/** 運賃 */
export const RAIL_FARE_BASE_YEN = 140;
export const RAIL_FARE_PER_KM_YEN = 15;
export const RAIL_FARE_CAP_YEN = 1200;
export const CAR_COST_PER_KM_YEN = 12;
/** 目的地の用途地域別の駐車探索時間（分）。都心ほど車が不利になる。 */
export const PARKING_SEARCH_MIN: Record<number, number> = {
  0: 0,
  1: 0, // 低層住居
  2: 2, // 中高層住居
  3: 3, // 近隣商業
  4: 6, // 商業（都心）
  5: 1,
  6: 1,
  7: 0,
  8: 0,
  9: 0,
  10: 2,
};

// ---------- 市民 ----------
export const INITIAL_CITIZEN_CAPACITY = 4096;
/** 1 世帯あたりの上限人数。 */
export const MAX_HOUSEHOLD_SIZE = 5;
/** Gompertz 死亡率 p_annual = A * exp(B * age)。中央寿命 ≒ 84 歳（日本）。 */
export const MORTALITY_A = 2.5e-5;
export const MORTALITY_B = 0.085;
/** 合計特殊出生率。遊びやすさのため実際の日本より高めが既定。 */
export const TARGET_TFR = 1.8;
/** 就労年齢。 */
export const WORK_AGE_MIN = 18;
export const RETIRE_AGE = 65;
/** 求職時に評価する求人候補数。 */
export const JOB_SAMPLE_COUNT = 8;
/** 1 日に処理する求職者数の上限。 */
export const JOB_SEEKERS_PER_DAY = 400;
/** 転居判定のしきい値（不満が連続してこの日数を超えたら引っ越す）。 */
export const RELOCATE_PATIENCE_DAYS = 30;

// ---------- 建物・成長 ----------
/** 1 tick に評価するゾーンタイル数。 */
export const GROWTH_SCAN_PER_TICK = 128;
/** レベルアップ / 廃墟化の判定に必要な連続日数。 */
export const UPGRADE_PATIENCE_DAYS = 20;
export const ABANDON_PATIENCE_DAYS = 30;
/** 建設に必要な資材（1 建物あたり）。林業チェーンが街の成長速度を律速する。 */
export const CONSTRUCTION_LUMBER = 4;
/**
 * 地元の木材が足りないときの輸入価格（1 単位あたり）。
 * これが無いと「林業が無い → 建物が建たない → 林業も建たない」で街が永久に始まらない。
 * 高く付くので、林業と製材所を整えたプレイヤはその分だけ得をする。
 */
export const LUMBER_IMPORT_YEN = 260_000;

// ---------- 経済 ----------
export const STARTING_CASH_YEN = 2_500_000_000;
/** 中立となる税率 (%)。これを超えると需要にペナルティ。 */
export const NEUTRAL_TAX_PCT = 9;
export const DEFAULT_TAX_PCT = 9;
/** 月次の公共交通 1 駅あたり維持費。 */
export const STATION_UPKEEP = 180_000;
export const RAIL_BUILD_COST = 900_000;
export const RAIL_UPKEEP = 5_000;
export const STATION_BUILD_COST = 24_000_000;

// ---------- 産業・物流 ----------
/** トラック 1 台の積載量。 */
export const TRUCK_CAPACITY = 24;
/** 同時に走れるトラックの上限。無制限にすると交通シミュレーションが破綻する。 */
export const MAX_TRUCKS = 600;
/** 在庫がこの割合を下回ったら発注する。 */
export const REORDER_FRACTION = 0.55;
/** 物流ディスパッチの実行間隔（分）。 */
export const FREIGHT_DISPATCH_INTERVAL = 10;
/** 商店の在庫が尽きた状態がこの日数続くと廃業判定に入る。 */
export const STOCKOUT_ABANDON_DAYS = 20;

// ---------- 描画 ----------
/** 同時に描画する市民インスタンスの上限。 */
export const MAX_VISIBLE_AGENTS = 4000;
export const MAX_VISIBLE_VEHICLES = 3000;
/** 描画するトラックの上限。シミュレーション側の上限より少ないと黙って消えるので揃える。 */
export const MAX_VISIBLE_TRUCKS = MAX_TRUCKS;
/** 描画する電車の車両数の上限（編成数ではなく 1 両単位）。 */
export const MAX_VISIBLE_TRAIN_CARS = 512;
/** これより遠い歩行者は描画しない (m)。 */
export const AGENT_DRAW_DISTANCE_M = 700;
export const VEHICLE_DRAW_DISTANCE_M = 1400;
/** 電車は車より遠くからでも見える（大きいので引きの画でも意味がある）。 */
export const TRAIN_DRAW_DISTANCE_M = 3400;
/** カメラがこれより引いたら歩行者は描かない (m)。1px 未満にしかならない。 */
export const PEDESTRIAN_LOD_DISTANCE_M = 460;
/** 路上駐車を描く距離 (m)。歩行者より遠くまで見える。 */
export const PARKED_CAR_LOD_DISTANCE_M = 900;
/** 1 つの接道タイルに置く駐車の上限。 */
export const PARKED_CARS_PER_TILE = 4;
/** 車線中心のオフセット (m)。日本は左側通行なので進行方向の左に寄せる。 */
export const LANE_OFFSET_M = 2.2;
/** 1 編成の両数。1 両だとただの箱に見えて電車と分からない。 */
export const TRAIN_CARS = 3;
/** 1 両の長さ (m) と連結面の間隔 (m)。 */
export const TRAIN_CAR_LENGTH_M = 19;
export const TRAIN_CAR_GAP_M = 1.4;
