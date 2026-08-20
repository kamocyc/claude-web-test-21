import { RoadClass, Zone } from '@shared/enums';
import { TILE_COUNT } from '@shared/constants';
import { Good } from '@shared/enums';
import { archetype } from '@sim/buildings/archetypes';
import type { Simulation } from '@sim/simulation';

/**
 * チュートリアル。
 *
 * 説明を読ませるのではなく、街の状態を見て「できたら次へ進む」形にする。
 * プレイヤは各ステップの指示どおりに操作するだけで、
 * 道路 → 用途地域 → 住民 → 職場 → 公共施設 → 鉄道 → サプライチェーン
 * という、このゲームの因果関係をひととおり体験できる。
 */

export interface TutorialStep {
  id: string;
  titleJa: string;
  bodyJa: string;
  /** このステップで使ってほしいツール（UI が光らせる）。 */
  highlight?: string;
  /** 達成判定。 */
  done(s: CityCounts, sim: Simulation): boolean;
}

/** 判定に使う集計値。毎回タイルを数え直すのは無駄なので 1 度だけ集計して渡す。 */
export interface CityCounts {
  roads: number;
  rail: number;
  zones: Record<number, number>;
  population: number;
  buildings: number;
  services: number;
  stations: number;
  lumberPerHour: number;
  foodPerHour: number;
  /** 発電容量 (kW) と浄水容量 (m3/日)。0 なら 1 基も建っていない。 */
  powerSupply: number;
  waterSupply: number;
}

export function countCity(sim: Simulation): CityCounts {
  const zones: Record<number, number> = {};
  let roads = 0;
  let rail = 0;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (sim.world.road[i] !== RoadClass.None) roads++;
    if (sim.world.rail[i] !== 0) rail++;
    const z = sim.world.zone[i]!;
    if (z !== Zone.None) zones[z] = (zones[z] ?? 0) + 1;
  }
  let services = 0;
  let stations = 0;
  for (const s of sim.buildings.each()) {
    const a = archetype(sim.buildings.archetypeId[s]!);
    if (a.playerPlaced) services++;
    if (a.provides !== 0 && a.serviceRadius >= 12 && a.nameJa === '駅') stations++;
  }
  const st = sim.stats();
  return {
    roads,
    rail,
    zones,
    population: st.population,
    buildings: st.buildings,
    services,
    stations: sim.stations.length,
    lumberPerHour: st.goodsProduced[Good.Lumber] ?? 0,
    foodPerHour: st.goodsProduced[Good.Food] ?? 0,
    powerSupply: st.utilities.powerSupplyKw,
    waterSupply: st.utilities.waterSupply,
  };
}

const z = (c: CityCounts, zone: Zone): number => c.zones[zone] ?? 0;

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'road',
    titleJa: '道路を敷く',
    bodyJa:
      '下の「道路」から生活道路を選び、地図をドラッグして道を引きましょう。\n街のすべては道路から始まります。道路に接していない土地には、建物は決して建ちません。',
    highlight: 'cat:road',
    done: (c) => c.roads >= 20,
  },
  {
    id: 'utilities',
    titleJa: '電気と水を用意する',
    bodyJa:
      '「公共施設」から太陽光発電所と浄水場を、引いた道路のそばに建てましょう。\n' +
      '電気と水は**道路の下を通って**届きます。道路で繋がっていない建物には届きません。\n' +
      '足りない地区には新しい建物が建たないので、街より先に用意しておくのが要点です。',
    highlight: 'cat:service',
    done: (c) => c.powerSupply > 0 && c.waterSupply > 0,
  },
  {
    id: 'residential',
    titleJa: '住宅地を指定する',
    bodyJa:
      '「用途地域」から低層住居を選び、道路沿いをドラッグで塗ります。\n直接建物を置くのではなく、用途を決めると住民が勝手に家を建てます。道路から離れすぎた区画には建ちません。',
    highlight: 'cat:zone',
    done: (c) => z(c, Zone.ResidentialLow) + z(c, Zone.ResidentialMid) >= 30,
  },
  {
    id: 'firstCitizen',
    titleJa: '最初の住民を迎える',
    bodyJa:
      '家が建つと人が引っ越してきます。画面右下の速度ボタン（▶▶▶）で時間を早めて待ちましょう。\n上の人口が増えれば成功です。',
    done: (c) => c.population >= 15,
  },
  {
    id: 'jobs',
    titleJa: '働く場所をつくる',
    bodyJa:
      '住民には仕事が要ります。畑（農地）か、解禁済みなら近隣商業を指定してください。\n職が足りないと失業者が増え、幸福度が下がって人が出ていきます。',
    highlight: 'cat:zone',
    done: (c) => z(c, Zone.AgriField) + z(c, Zone.AgriPaddy) + z(c, Zone.CommercialLocal) + z(c, Zone.IndustrialLight) >= 25,
  },
  {
    id: 'shops',
    titleJa: 'お店をつくる',
    bodyJa:
      '住民は買い物にも出かけます。近隣商業を指定して商店をつくりましょう。\n店がない、あるいは店の在庫が切れていると、買い物が失敗して不満が溜まります。',
    highlight: 'cat:zone',
    done: (c) => z(c, Zone.CommercialLocal) + z(c, Zone.CommercialCentral) >= 15,
  },
  {
    id: 'supply',
    titleJa: '食料を自給する',
    bodyJa:
      '商店に並ぶ食品は、田んぼや畑でとれた米・野菜を食品工場（準工業）が加工したものです。\nトラックが道路を走って運ぶので、農地・工場・商店が道路でつながっている必要があります。',
    highlight: 'cat:zone',
    done: (c) => c.foodPerHour > 0,
  },
  {
    id: 'services',
    titleJa: '公共施設を建てる',
    bodyJa:
      '「公共施設」から公園や交番を建てましょう。\nサービスが届いていない地区は幸福度が下がり続けます。届いて初めて満足が上回ります。',
    highlight: 'cat:service',
    done: (c) => c.services >= 2,
  },
  {
    id: 'rail',
    titleJa: '鉄道を通す',
    bodyJa:
      '人口 400 人で鉄道が解禁されます。線路を敷き、その脇に駅を置いてください。\n駅の周りは地価が大きく上がり、住宅が高密度化します。日本の街は駅を中心に育ちます。',
    highlight: 'cat:rail',
    done: (c) => c.stations >= 1,
  },
  {
    id: 'lumber',
    titleJa: '木材を自給する',
    bodyJa:
      '建物の建設には木材が要ります。地元に無いと輸入することになり、かなり高くつきます。\n森林地帯に道路を延ばして林業地を指定し、工業地に製材所を建てて、原木から木材をつくりましょう。',
    highlight: 'cat:zone',
    done: (c) => c.lumberPerHour > 0,
  },
  {
    id: 'done',
    titleJa: 'チュートリアル完了',
    bodyJa:
      'これで基本はひととおりです。あとは自由に街を育ててください。\n\n・移動中の市民をクリックすると、その人の 1 日と交通手段を選んだ理由が見られます\n・「情報表示」で地価・交通量・鉄道アクセスを重ねられます\n・道路を壊すと物流が止まり、店の在庫が切れて人が出ていきます',
    done: () => false,
  },
];

export class Tutorial {
  private index = 0;
  /** チュートリアルを表示するか。 */
  enabled = true;
  /** 直近の判定結果（UI がチェックマークを出すのに使う）。 */
  completed: boolean[] = TUTORIAL_STEPS.map(() => false);

  get step(): TutorialStep {
    return TUTORIAL_STEPS[Math.min(this.index, TUTORIAL_STEPS.length - 1)]!;
  }
  get stepIndex(): number {
    return this.index;
  }
  get total(): number {
    return TUTORIAL_STEPS.length;
  }
  get isFinished(): boolean {
    return this.index >= TUTORIAL_STEPS.length - 1;
  }

  /** 達成状況を見て、必要なら次のステップへ進む。進んだら true。 */
  update(counts: CityCounts, sim: Simulation): boolean {
    if (!this.enabled) return false;
    // 既に達成済みのステップも含めて記録しておく（一覧のチェック表示用）
    for (let k = 0; k <= this.index && k < TUTORIAL_STEPS.length; k++) {
      if (!this.completed[k]) this.completed[k] = TUTORIAL_STEPS[k]!.done(counts, sim);
    }
    if (this.index < TUTORIAL_STEPS.length - 1 && TUTORIAL_STEPS[this.index]!.done(counts, sim)) {
      this.completed[this.index] = true;
      this.index++;
      return true;
    }
    return false;
  }

  skip(): void {
    this.index = TUTORIAL_STEPS.length - 1;
  }

  close(): void {
    this.enabled = false;
  }
}
