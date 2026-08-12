import { RoadClass, Zone } from '@shared/enums';
import { Arch, PLACEABLE, archetype } from '@sim/buildings/archetypes';
import type { Command } from '@sim/commands';
import { forEachInRect, lineTiles, tileX, tileY } from '@sim/world/tiles';

/**
 * プレイヤのツール。ドラッグ操作をコマンドに変換するだけの薄い層。
 * sim を直接触らず、必ず Command を返す。
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
    archetypeId: Arch.Station,
  };
}

/** ドラッグ中のプレビュー対象タイル。 */
export function previewTiles(state: ToolState, from: number, to: number): number[] {
  switch (state.kind) {
    case ToolKind.Road:
    case ToolKind.Rail:
      // 道路と線路は L 字の直線で引く（斜めの道路は作らない）
      return lineTiles(from, to);
    case ToolKind.Zone:
    case ToolKind.Bulldoze: {
      // 矩形塗り
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

/** ツールの説明（画面下のヒント）。 */
export function hintFor(state: ToolState): string {
  switch (state.kind) {
    case ToolKind.Road:
      return 'ドラッグで道路を敷設 / Alt+ドラッグで画面移動 / 右ドラッグで回転';
    case ToolKind.Rail:
      return 'ドラッグで線路を敷設。道路と交差する箇所は踏切になります';
    case ToolKind.Zone:
      return 'ドラッグで矩形に用途地域を指定。道路に接していない区画には建物が建ちません';
    case ToolKind.Place:
      return `クリックで${archetype(state.archetypeId).nameJa}を設置`;
    case ToolKind.Bulldoze:
      return 'ドラッグで範囲を撤去（建物・道路・線路・用途地域）';
    case ToolKind.RouteProbe:
      return '2 点をクリックすると、その間の経路探索結果を表示します';
    case ToolKind.Select:
    default:
      return 'クリックで市民・建物を選択 / Alt+ドラッグで画面移動 / ホイールでズーム';
  }
}

/** 設置可能な建物の一覧（ツールパレット用）。 */
export const PLACEABLE_ARCHETYPES = PLACEABLE.map((id) => ({ id, name: archetype(id).nameJa, cost: archetype(id).buildCost }));
