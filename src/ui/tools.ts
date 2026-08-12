import { OVERLAY_NAMES_JA, Overlay, ROAD_NAMES_JA, RoadClass, ZONE_NAMES_JA, Zone } from '@shared/enums';
import { Arch, PLACEABLE, archetype } from '@sim/buildings/archetypes';
import type { Command } from '@sim/commands';
import { forEachInRect, lineTiles, tileX, tileY } from '@sim/world/tiles';
import type { UnlockKey } from './milestones';

/**
 * プレイヤのツール。ドラッグ操作をコマンドに変換するだけの薄い層。
 * sim を直接触らず、必ず Command を返す。
 *
 * Cities: Skylines と同じく「カテゴリを選ぶ → そのカテゴリの道具が出る」二段構えにしてある。
 * 道具を全部並べると数が多すぎて、何がどれだか分からなくなる。
 */

export const ToolKind = {
  Select: 'select',
  Road: 'road',
  Rail: 'rail',
  Zone: 'zone',
  Place: 'place',
  Bulldoze: 'bulldoze',
  RouteProbe: 'route',
} as const;
export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

export interface ToolState {
  kind: ToolKind;
  roadClass: RoadClass;
  zone: Zone;
  archetypeId: number;
}

export function initialToolState(): ToolState {
  return {
    kind: ToolKind.Select,
    roadClass: RoadClass.Street,
    zone: Zone.ResidentialLow,
    archetypeId: Arch.Park,
  };
}

/** ツールバーの 1 項目。 */
export interface ToolItem {
  /** 一意キー。解禁判定にも使う。 */
  key: string;
  labelJa: string;
  /** 色見本（用途地域用）。 */
  swatch?: number;
  /** 費用の説明。 */
  costJa?: string;
  /** 解禁キー。未指定なら常時利用可。 */
  unlock?: UnlockKey;
  apply: Partial<ToolState>;
}

/** ツールバーのカテゴリ。 */
export interface ToolCategory {
  key: string;
  labelJa: string;
  icon: string;
  items: ToolItem[];
}

const yen = (v: number): string => (v >= 10000 ? `${Math.round(v / 10000).toLocaleString('ja-JP')}万円` : `${v}円`);

import { ROAD_BUILD_COST } from '@shared/enums';
import { RAIL_BUILD_COST } from '@shared/constants';
import { ZONE_COLORS } from '@render/theme';

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    key: 'cat:select',
    labelJa: '選択',
    icon: '🔍',
    items: [
      { key: 'tool:select', labelJa: '情報', apply: { kind: ToolKind.Select } },
      { key: 'tool:route', labelJa: '経路確認', apply: { kind: ToolKind.RouteProbe } },
    ],
  },
  {
    key: 'cat:road',
    labelJa: '道路',
    icon: '🛣️',
    items: [RoadClass.Street, RoadClass.Avenue, RoadClass.Boulevard].map((cls) => ({
      key: `road:${cls}`,
      labelJa: ROAD_NAMES_JA[cls]!,
      costJa: `${yen(ROAD_BUILD_COST[cls]!)}/マス`,
      unlock: `road:${cls}` as UnlockKey,
      apply: { kind: ToolKind.Road, roadClass: cls },
    })),
  },
  {
    key: 'cat:rail',
    labelJa: '鉄道',
    icon: '🚉',
    items: [
      {
        key: 'tool:rail',
        labelJa: '線路',
        costJa: `${yen(RAIL_BUILD_COST)}/マス`,
        unlock: 'rail',
        apply: { kind: ToolKind.Rail },
      },
      {
        key: `place:${Arch.Station}`,
        labelJa: '駅',
        costJa: yen(archetype(Arch.Station).buildCost),
        unlock: `place:${Arch.Station}` as UnlockKey,
        apply: { kind: ToolKind.Place, archetypeId: Arch.Station },
      },
    ],
  },
  {
    key: 'cat:zone',
    labelJa: '用途地域',
    icon: '🏘️',
    items: (
      [
        Zone.ResidentialLow,
        Zone.ResidentialMid,
        Zone.CommercialLocal,
        Zone.CommercialCentral,
        Zone.IndustrialLight,
        Zone.IndustrialHeavy,
        Zone.AgriPaddy,
        Zone.AgriField,
        Zone.Forestry,
        Zone.None,
      ] as Zone[]
    ).map((zone) => ({
      key: `zone:${zone}`,
      labelJa: zone === Zone.None ? '指定解除' : ZONE_NAMES_JA[zone]!,
      swatch: ZONE_COLORS[zone],
      unlock: `zone:${zone}` as UnlockKey,
      apply: { kind: ToolKind.Zone, zone },
    })),
  },
  {
    key: 'cat:service',
    labelJa: '公共施設',
    icon: '🏛️',
    items: PLACEABLE.filter((id) => id !== Arch.Station).map((id) => ({
      key: `place:${id}`,
      labelJa: archetype(id).nameJa,
      costJa: yen(archetype(id).buildCost),
      unlock: `place:${id}` as UnlockKey,
      apply: { kind: ToolKind.Place, archetypeId: id },
    })),
  },
  {
    key: 'cat:bulldoze',
    labelJa: '撤去',
    icon: '💥',
    items: [{ key: 'tool:bulldoze', labelJa: '撤去', apply: { kind: ToolKind.Bulldoze } }],
  },
];

/** 情報表示（オーバーレイ）はツールとは別枠。 */
export const OVERLAY_ITEMS: { key: string; labelJa: string; overlay: Overlay }[] = [
  Overlay.None,
  Overlay.Zone,
  Overlay.LandValue,
  Overlay.Traffic,
  Overlay.Pollution,
  Overlay.TransitAccess,
].map((o) => ({ key: `overlay:${o}`, labelJa: OVERLAY_NAMES_JA[o]!, overlay: o }));

/** ドラッグ中のプレビュー対象タイル。 */
export function previewTiles(state: ToolState, from: number, to: number): number[] {
  switch (state.kind) {
    case ToolKind.Road:
    case ToolKind.Rail:
      // 道路と線路は L 字の直線で引く（斜めの道路は作らない）
      return lineTiles(from, to);
    case ToolKind.Zone:
    case ToolKind.Bulldoze: {
      const tiles: number[] = [];
      forEachInRect(tileX(from), tileY(from), tileX(to), tileY(to), (i) => tiles.push(i));
      return tiles;
    }
    case ToolKind.Place:
      return [to];
    default:
      return [];
  }
}

/** ドラッグ確定時に発行するコマンド。 */
export function commandFor(state: ToolState, from: number, to: number): Command | null {
  const tiles = previewTiles(state, from, to);
  if (tiles.length === 0) return null;
  switch (state.kind) {
    case ToolKind.Road:
      return { t: 'buildRoad', cls: state.roadClass, tiles };
    case ToolKind.Rail:
      return { t: 'buildRail', tiles };
    case ToolKind.Zone:
      return { t: 'zonePaint', zone: state.zone, tiles };
    case ToolKind.Bulldoze:
      return { t: 'bulldoze', tiles };
    case ToolKind.Place:
      return { t: 'placeBuilding', archetype: state.archetypeId, tile: tiles[0]! };
    default:
      return null;
  }
}

/** 画面下のヒント。 */
export function hintFor(state: ToolState): string {
  switch (state.kind) {
    case ToolKind.Road:
      return `${ROAD_NAMES_JA[state.roadClass]!}：ドラッグで敷設`;
    case ToolKind.Rail:
      return '線路：ドラッグで敷設。道路と交差する箇所は踏切になります';
    case ToolKind.Zone:
      return state.zone === Zone.None
        ? '指定解除：ドラッグした範囲の用途地域を消します'
        : `${ZONE_NAMES_JA[state.zone]!}：ドラッグで矩形に指定。道路に接していない区画には建ちません`;
    case ToolKind.Place:
      return `${archetype(state.archetypeId).nameJa}：クリックで設置`;
    case ToolKind.Bulldoze:
      return '撤去：ドラッグした範囲の建物・道路・線路・用途地域を消します';
    case ToolKind.RouteProbe:
      return '経路確認：2 点をクリックすると、その間の経路を地図に描きます';
    case ToolKind.Select:
    default:
      return '情報：移動中の市民や建物をクリックすると詳細が出ます';
  }
}

/** ツールの見た目上の費用（カーソル横に出す）。 */
export function costOf(state: ToolState, tileCount: number): number {
  switch (state.kind) {
    case ToolKind.Road:
      return ROAD_BUILD_COST[state.roadClass]! * tileCount;
    case ToolKind.Rail:
      return RAIL_BUILD_COST * tileCount;
    case ToolKind.Place:
      return archetype(state.archetypeId).buildCost;
    default:
      return 0;
  }
}
