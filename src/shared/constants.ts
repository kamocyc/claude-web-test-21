/** ゲーム全体のチューニング定数。ここ以外にマジックナンバーを置かない。 */

// ---------- ワールド ----------
/**
 * 1 タイルの「描画上の」一辺。ワールド座標・カメラ・建物や人や車両の寸法はこの単位。
 * シミュレーション上の実距離ではないことに注意（下の TILE_SPAN_M を参照）。
 */
export const TILE_M = 10;
/**
 * 1 タイルがシミュレーション上で表す実距離 (m)。地図は 1/15 スケールで描いている。
 *
 * 描画とシミュレーションで距離の単位を分けているのは、
 * 「1 日が実用的な長さで進む」ことと「人や車が現実的な速さに見える」ことを
 * 同時に成り立たせるため。この 2 つは次の式で結ばれている。
 *
 *   1 日の実時間（分） = 19152 ÷ （歩行者の見た目の速さ[m/s] × 1 タイルの実距離[m]）
 *
 * 10m/タイルのままだと、歩行者が歩く速さに見える時計では 1 日が実時間 8 時間になる。
 * 150m にすることで 1 日 32 分に収まり、見た目とシミュレーションが完全に一致する。
 *
 * 副次的に、これまで非現実的だった距離がすべて現実的な値になる
 * （駅の徒歩圏 120m → 900m、平均通勤 3 分 → 30 分前後、自転車と徒歩の
 * 距離上限が初めて実際に効くようになる）。
 */
export const TILE_SPAN_M = 150;
/** シミュレーション実距離 ÷ 描画単位。描画座標から実距離を出すときに掛ける。 */
export const SIM_PER_RENDER = TILE_SPAN_M / TILE_M;
/** 320 タイル = 48km 四方。市街地はこのうち数 km を占める。 */
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
/**
 * ×1 速度で 1 実秒あたり何 tick 進めるか。
 *
 * 0.75 = 1 tick が 1.33 実秒、1 日が実時間 32 分。
 * この値と TILE_SPAN_M の組み合わせで、歩行者が毎秒 0.4 タイル（＝歩く速さ）に見える。
 * 上げると街の発展は速くなるが、その分だけ人も車も電車も速く見える。
 * 12（1 日 2 分）だった頃は電車が地図を 0.2 秒で横断していた。
 */
export const TICKS_PER_SECOND_AT_1X = 0.75;
/** 1 フレームで消化する tick の上限。長い tick が続いても死のスパイラルに入らないための蓋。 */
export const MAX_TICKS_PER_FRAME = 8;
/**
 * 経済の反応を回す周期（tick）。
 *
 * 転入・求職・地価は元は「1 日 1 回」だった。1 日が 2 実分だった頃はそれで
 * 十分だったが、移動の見た目を実トリップに合わせて 1 日 = 32 実分にしたため、
 * 実時間で見ると 16 倍遅くなり「家を建てても 30 分誰も来ない」状態になった。
 * 1 日の長さと移動の見た目は変えず、経済の時間だけデフォルメして取り戻す。
 */
export const ECONOMY_PERIOD_TICKS = 120; // 2 シミュレーション時間 = ×1 で 2.7 実分
export const ECONOMY_PERIODS_PER_DAY = TICKS_PER_DAY / ECONOMY_PERIOD_TICKS;

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

// ---------- 交通流 ----------
/**
 * 画面の車 1 台が表す実際の車の台数。**この計画で一番大事な定数。**
 *
 * 人口 2000 の街では、朝ラッシュに最も混む道でも 1 時間に 33 台しか通らない。
 * 生活道路の実容量 600 台/時 の 5% で、実車 1 台 = 1 エージェントとして
 * 車間を取らせても行列は一生できない。
 *
 * 一方、地図は 1/15 縮尺（TILE_SPAN_M / TILE_M）で描いていて、車は 4.2m で描かれている。
 * この車 1 台が地図上で占める実距離は 63m ＝ 実車 9 台分の車列にあたる。
 * そこで「画面の車 1 台 = 実車およそ 9 台の車列」と定義し直すと、
 * 縮尺のデフォルメと台数のデフォルメが 1 個の係数に集約されて数字が噛み合う。
 *
 *   車列 1 台の長さ            65m      （描画の車長 4.2m × 15）
 *   1 リンク(150m)の収容        2 台     （150 / 65。車線数を掛ける）
 *   交差点の飽和交通流率        200 台列/時（実車 1800 ÷ 9）
 *   青が半分なら 1 方向の容量   100 台列/時
 *   実測のピーク需要（最混雑）  33〜100 台列/時
 *
 * つまり最混雑の数本だけが飽和し、残りは自由流になる。
 * ここを知らずに下の定数をいじると、渋滞が全域に出るか一切出ないかのどちらかになる。
 */
export const VEHICLE_PLATOON = 9;
/**
 * 車列 1 台がリンク上で占める長さ (m)。**描画で 1 台が実際に食う長さ**に合わせる。
 *
 * 以前は車体の長さだけ（描画 4.2m × 15 = 65m）だった。ところが描画側は
 * 前後に最低 2.6m の車間を空ける（`MIN_HEADWAY_M`）ので、1 台が食う長さは
 * 6.8m ある。モデルが 4.33m 間隔（65 ÷ 15）で車を並べる一方、描画は 6.8m
 * 要求するので、行列ができるたびに 2.5m ぶん車体がめり込んでいた。
 * 描画側で車間を強制すると今度は後ろの車が押し出され、押し出しが大きすぎる車は
 * 描画から落とされる（実測で走行中の 11%）。
 *
 * 占有長を描画の実寸に合わせると、モデルが並べた位置がそのまま
 * 重ならない位置になる。1 リンクの収容は減る（生活道路 2 → 1 台）ので
 * 渋滞は起きやすくなるが、それは「見えている車の数だけ道に入る」という
 * 正しい方向のずれ方になる。
 */
export const VEHICLE_LENGTH_M = (4.2 + 2.6) * SIM_PER_RENDER;
/**
 * 1 車線に重ならずに並べられる車列の数。
 *
 * リンクは描画 10m（＝1 タイル）、車列 1 台の占有は 6.8m。停止線に 1 台と、
 * その 6.8m 後ろにもう 1 台まで乗る（3.2m と 10m の位置）。3 台目はリンクから
 * はみ出して前の車にめり込む。
 */
export const VEHICLES_PER_LANE = Math.floor(TILE_M / (VEHICLE_LENGTH_M / SIM_PER_RENDER)) + 1;
/**
 * 隣の車線の中心までの距離（描画 m）。
 *
 * 車幅 1.7m に対して 2.0m 取る。車道の半幅がいちばん狭い大通り (3.7m) でも、
 * 中心線側 1.3m ＋ 2.0m = 3.3m で、外側の車の端 (4.15m) が…と言いたいところだが
 * 大通りは 3.7m しかないので、外側の列は `LANE_OFFSET_M` から内側へ詰める
 * （`laneCenterM` を参照）。
 */
export const LANE_PITCH_M = 2.0;
/**
 * 車列の加速度 (m/s^2)。**シミュレーション上の実距離**での値。
 *
 * 実車 1 台の加速（2.5 m/s^2 級）より弱くしてある。理由が 2 つある。
 *
 * 1. 画面の 1 台は実車およそ 9 台の車列（`VEHICLE_PLATOON`）で、青になってから
 *    列の最後尾が動き出すまでを含めた「列としての立ち上がり」を表すため
 * 2. シミュレーション時間は実時間の 45 倍で進む（1 分が 1.33 実秒）。実車の
 *    加速をそのまま入れると、30km/h に乗るまでが 0.12 実秒 ―― 7 フレームで
 *    終わってしまい、加速している様子が見えない
 *
 * この値だと 30km/h までに 43m ＝ 画面で 2.9m（車体 0.7 台ぶん）走る。
 * 発進の溜めが目に見えて、かつもたつかない。
 */
export const VEHICLE_ACCEL_MS2 = 0.8;
/**
 * 車列の減速度 (m/s^2)。加速より強くする（実際の運転もそうなっている）。
 * 30km/h からの停止距離は 29m ＝ 画面で 1.9m。停止線や渋滞の最後尾の
 * 手前でこれだけ手前から緩み始める。大きくすると急停止、小さくすると
 * だらだら減速して交差点の手前が空きすぎる。
 */
export const VEHICLE_DECEL_MS2 = 1.2;
/** 1 車線あたりの飽和交通流率（実車 台/時）。青の間に交差点を捌ける率。 */
export const SATURATION_VPH_PER_LANE = 1800;
/**
 * 1 tick を何分割して交通流を解くか。
 * 1 tick = 1 分だと、車は 1 分に 1 リンク（150m）しか進めず時速 9km になってしまう。
 * 5 秒刻みにすると自由流で 1 分に 3〜4 リンク進み、信号も現実的な周期で書ける。
 */
export const TRAFFIC_SUBSTEPS_PER_TICK = 12;
export const TRAFFIC_STEP_SEC = 60 / TRAFFIC_SUBSTEPS_PER_TICK;
/** 信号の 1 周期（サブステップ数）。12 = 60 秒。 */
export const SIGNAL_CYCLE_STEPS = 12;
/** 主道路に与える青の長さ（サブステップ）。残りが従道路。同格の交差点は半分ずつ。 */
export const SIGNAL_MAJOR_GREEN_STEPS = 8;
/** 交差点とみなす道路リンクの本数。これ未満のノードには信号を置かない。 */
export const SIGNAL_MIN_DEGREE = 3;
/**
 * これだけ連続で前に進めなかった車両は、満杯のリンクにも 1 台だけ入れる。
 * 閉路上の全リンクが満杯になると永久に止まる（グリッドロック）ための逃がし弁。
 */
export const GRIDLOCK_RELIEF_STEPS = 240;
/** 1 トリップの上限（tick）。超えたら移動失敗として打ち切る。 */
export const MAX_TRIP_TICKS = 480;
/**
 * トラック 1 台が「乗用車の車列 1 台」に対して占める大きさ（場所と交通容量の両方）。
 *
 * 乗用車は 1 台が実車 9 台の車列を表すが、トラックは配送 1 件 = 実車 1 台のまま。
 * 大型車は乗用車 2 台ぶんに数えるのが交通工学の慣習なので、2 ÷ 9 ≒ 0.22。
 *
 * ここを 2.5（＝車列 2.5 台ぶん）にしていたとき、人口 1400 の街で
 * 稼働トラック 587 台が道路を埋め尽くし、走行 572 台中 516 台が信号待ちになった。
 * トラックは建物 1 棟につき 1 台走りうるので、乗用車と同じ縮尺で数えてはいけない。
 */
export const TRUCK_PLATOON_EQUIV = 0.22;
/** リンク実測所要時間の EMA 係数（観測 1 回あたり）。 */
export const LINK_TIME_LAMBDA = 0.3;
/** 観測がこれだけ古いリンクは自由流に戻していく（tick）。 */
export const LINK_TIME_FORGET_TICKS = 60;
/** 経路コストへ実測を反映する間隔（tick）。 */
export const LINK_TIME_RELAX_TICKS = 10;
/**
 * これだけの本数の道路が収容いっぱいになったら、渋滞をプレイヤに通知する。
 *
 * 「全道路に対する割合」で見ていたが、地図の道路の大半は郊外の空いた道なので、
 * 街なかが完全に詰まっていても割合は 0.2% にしかならず一度も鳴らなかった。
 * 詰まっている本数そのもので見る。
 */
export const CONGESTION_ALERT_LINKS = 8;
/** 渋滞通知のクールダウン（tick）。1 日に何度も出さない。 */
export const CONGESTION_ALERT_COOLDOWN_TICKS = 480;

// ---------- 経路コスト ----------
/** 混雑による遅延の上限倍率。無限大コストが A* のヒープを壊すのを防ぐ。 */
export const MAX_CONGESTION_FACTOR = 8;
/** エッジコストの EMA 平滑化係数（1 分あたり）。経路選択の発振を抑える中心的な仕掛け。 */
export const COST_SMOOTHING_LAMBDA = 0.05;
/** 市民ごとのコスト摂動幅。等コストの並行路に流れを分散させる（確率的利用者均衡）。 */
export const COST_PERTURBATION = 0.05;

// ---------- 公共交通 ----------
/** 駅の徒歩アクセス圏（タイル）。8 タイル = 1.2km。 */
export const STATION_WALK_RADIUS = 8;
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

// ---------- 路線 ----------
/**
 * 停留所での停車時間（秒）。乗降と発進をまとめた値。
 * バスは停留所が多いので、これが積み上がって「各駅停車は遅い」が自然に出る。
 */
export const STOP_DWELL_SEC = 25;
/** 運行間隔の設定できる範囲（分）。 */
export const MIN_HEADWAY_MIN = 3;
export const MAX_HEADWAY_MIN = 30;
/** 1 編成・1 台の定員（人/便）。実車ベース。 */
export const BUS_CAPACITY = 70;
export const TRAIN_CAPACITY = 1000;
/**
 * 車両 1 台あたりの月次維持費（円）。運転士の人件費が主。
 * 運行間隔を縮めると必要な車両数が増え、そのぶん費用も増える。
 */
export const BUS_VEHICLE_UPKEEP = 850_000;
export const TRAIN_VEHICLE_UPKEEP = 4_200_000;
/** 停留所の設置費（円）。バス停は安く、駅は建物として別に建てる。 */
export const BUS_STOP_COST = 120_000;
/**
 * 混雑ペナルティの上限（分）。
 * 乗車率が定員を超えたぶんを待ち時間に上乗せする（＝積み残し）。
 * 上限を置かないと、一度あふれた路線が二度と選ばれなくなって振動する。
 */
export const CROWDING_PENALTY_MAX_MIN = 12;
/**
 * バス 1 台が道路で占める車列の長さ（画面上の車 1 台 = 実車 9 台に対する比）。
 * 実車の路線バスは 11m。乗用車 4.5m の車列 9 台分（63m）に対して 11/63 ≒ 0.17 だが、
 * 車間が広く発進が遅いぶんを見て少し重くする。
 */
export const BUS_PLATOON_EQUIV = 0.25;

// ---------- 電気・水道 ----------
/**
 * 供給は道路網の連結成分を伝わる（電線と水道管は道路の下を通っているものとする）。
 * 専用の管路を敷かせないのは、このタイル数だと操作が煩雑になる割に、
 * 意思決定が「繋いだかどうか」しか生まないため。
 */
/**
 * 需要は**定員 1 人あたり**で数える（`capacityResidents` / `jobsTotal`）。
 *
 * 実入居・実就業で数えると、転入や離職のたびに需要が揺れて、
 * ぎりぎりの街が経済期ごとに点いたり消えたりする。定員なら
 * 「この街区を建てたらいくら要るか」を建てる前に見積もれる。
 *
 * 値は日本の実績から。家庭用は 1 世帯 1.2kW・2.4 人世帯として 1 人 0.5kW、
 * 生活用水は 1 人 1 日 300L。事業所側は延べ床ではなく従業者定員で数えるので、
 * 「席 1 つあたり」に均した値になっている。
 */
/** 居住定員 1 人あたりの電力需要 (kW)。 */
export const POWER_PER_RESIDENT_KW = 0.5;
/** 雇用定員 1 人あたりの電力需要 (kW)。 */
export const POWER_PER_JOB_KW = 0.9;
/** 居住定員 1 人あたりの上水需要 (m3/日)。 */
export const WATER_PER_RESIDENT = 0.3;
/** 雇用定員 1 人あたりの上水需要 (m3/日)。 */
export const WATER_PER_JOB = 0.12;
/** 停電・断水が続いたときに建物が機能停止するまでの日数。 */
export const UTILITY_GRACE_DAYS = 2;
/**
 * 浄水場が取水できる水辺までの距離（タイル）。1 タイル = 150m なので 8 タイル = 1.2km。
 * 導水管を引く距離として現実的な範囲。
 *
 * 3 タイル（450m）にしていたときは、川がタイル 1 本の細い線なうえ
 * 「接道していて 2×2 が入る平地」まで同時に満たす場所がほとんど無く、
 * シナリオ生成でも浄水場が 1 つも建たない街ができた。
 * その街は上水が既存系統ぶんしか無いまま成長が止まる。
 * 逆に 20 も許すと街のどこにでも建ってしまい、立地の判断が消える。
 */
export const WATER_INTAKE_TILES = 8;

/**
 * 未処理の下水 1 m3/日 が生む公害の量。
 *
 * 単位は `Archetype.pollution` と同じ。目安として、上水を 100 m3/日 使う地区が
 * 下水処理場を持たないと 60 相当（＝工場 45 より少し重い）の公害源になる。
 * ここを 0.1 まで落とすと下水を無視しても何も起きず、施設を建てる理由が消える。
 * 逆に 2.0 にすると、下水処理場が 1 日遅れただけで地価が崩壊した。
 */
export const POLLUTION_PER_UNTREATED_M3 = 0.6;


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
  /* 業務移動   */ [0, 1, 4, 3],
];
/** 時間価値 (円/分) の基礎値。所得で増える。 */
export const VOT_BASE_YEN_PER_MIN = 20;
/** 徒歩でこれを超える所要時間なら徒歩は選択肢から外す（分）。 */
export const MAX_WALK_MIN = 45;
/**
 * 自転車の最大距離 (m)。5km ＝ 約 20 分。
 * 実距離スケール以前は街全体が 3.2km しかなく、この上限は一度も効かなかった。
 */
export const MAX_BIKE_M = 5000;
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
/** 夜勤の割合。 */
export const NIGHT_SHIFT_SHARE = 0.08;
/** 早番（シフト勤務）の割合。夜勤に当たらなかった就業者から抽選する。 */
export const SHIFT_WORK_SHARE = 0.25;
/** 求職時に評価する求人候補数。 */
export const JOB_SAMPLE_COUNT = 8;
/** 1 経済期に処理する求職者数の上限（日換算で約 960 人）。 */
export const JOB_SEEKERS_PER_PERIOD = 80;
/** 転居判定のしきい値（不満が連続してこの日数を超えたら引っ越す）。 */
export const RELOCATE_PATIENCE_DAYS = 30;

// ---------- 建物・成長 ----------
/** 1 tick に評価するゾーンタイル数。 */
export const GROWTH_SCAN_PER_TICK = 128;
/**
 * 建設確率の係数。実際の確率は `GROWTH_BUILD_RATE × 需要 × 魅力度^2`。
 * 1 tick が 1/12 実秒だった頃の 0.02 のままだと、ゾーニングしてから最初の 1 軒が
 * 建つまで ×1 で 50 実分かかる。時計を遅くした分をここで戻す。
 */
export const GROWTH_BUILD_RATE = 0.1;
/**
 * レベルアップ / 廃墟化の判定に必要な連続日数。
 * 育つ側だけ速める。廃墟化と廃業まで速めると、サプライチェーンが立ち上がる前に
 * 上流が全滅する（過去に実際に起きた）ので据え置く。
 */
export const UPGRADE_PATIENCE_DAYS = 5;
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
/** 標高 (heightDm) → ワールド座標の Y。地形メッシュ・建物・人・カーソルで共通。 */
export const TERRAIN_HEIGHT_SCALE = 0.02;
/**
 * 交通量オーバーレイの色を塗り直す間隔（tick）。
 * 地価や公害は日次で足りるが、渋滞は分単位で育って引くので短くする。
 */
export const OVERLAY_REFRESH_TICKS = 5;
/** ドラッグ中のプレビューで同時に光らせるタイル数の上限。 */
export const MAX_PREVIEW_TILES = 4096;
/** 同時に描画する市民インスタンスの上限。 */
export const MAX_VISIBLE_AGENTS = 4000;
export const MAX_VISIBLE_VEHICLES = 3000;
/** 描画するトラックの上限。シミュレーション側の上限より少ないと黙って消えるので揃える。 */
export const MAX_VISIBLE_TRUCKS = MAX_TRUCKS;
/** 同時に描く路線バスの上限。路線数 × 車両数の見積もりより多めに取ってある。 */
export const MAX_VISIBLE_BUSES = 400;
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
/**
 * 交差点で角を丸める半径（描画メートル）。
 *
 * 経路はノードを直線で結んだ折れ線なので、そのままだと交差点に 90 度の角が立つ。
 * この長さぶんだけ手前から曲がり始める。車体が 4.2m なので、実車が交差点を
 * 曲がるときの回転半径（車 1 台強）に合わせて車体長と同じくらいに取ってある。
 * 大きくしすぎると交差点の手前から膨らんで対向車線にはみ出して見える。
 */
export const CORNER_RADIUS_M = 4.2;
/** 車線中心のオフセット (m)。日本は左側通行なので進行方向の左に寄せる。 */
export const LANE_OFFSET_M = 2.2;
/** 1 編成の両数。1 両だとただの箱に見えて電車と分からない。 */
export const TRAIN_CARS = 3;
/** 1 両の長さ (m) と連結面の間隔 (m)。 */
export const TRAIN_CAR_LENGTH_M = 19;
export const TRAIN_CAR_GAP_M = 1.4;
/**
 * 折り返しの停車時間（秒）。
 *
 * これが 0 だと、終端に着いた瞬間に走ったまま向きが 180 度入れ替わる。
 * 止まっている間に入れ替われば「着いて、停まって、戻る」に見える。
 */
export const TRAIN_TURNAROUND_SEC = 40;
