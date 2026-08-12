import { RoadClass } from '@shared/enums';
import { Graph } from '@sim/network/graph';
import { idx } from '@sim/world/tiles';
import { World } from '@sim/world/world';

/** テスト用に、指定した矩形を平地にして道路グリッドを敷いた World を作る。 */
export function makeTestWorld(seed = 1): World {
  return new World(seed);
}

/** 水平・垂直の直線道路を敷く。 */
export function layRoadLine(
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cls: RoadClass = RoadClass.Street,
): number[] {
  const tiles: number[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  for (;;) {
    const t = idx(x, y);
    // テストでは地形の都合で敷けないことがないよう、地形を平地に均しておく
    world.terrain[t] = 0;
    world.slope[t] = 0;
    if (world.setRoad(t, cls)) tiles.push(t);
    else if (world.road[t] === cls) tiles.push(t);
    if (x === x1 && y === y1) break;
    if (x !== x1) x += dx;
    else if (y !== y1) y += dy;
    else break;
  }
  return tiles;
}

/** 矩形の道路グリッドを敷く。 */
export function layRoadGrid(world: World, x0: number, y0: number, w: number, h: number, step = 4): void {
  for (let y = y0; y <= y0 + h; y++) {
    for (let x = x0; x <= x0 + w; x++) {
      if ((y - y0) % step !== 0 && (x - x0) % step !== 0) continue;
      const t = idx(x, y);
      world.terrain[t] = 0;
      world.slope[t] = 0;
      world.setRoad(t, RoadClass.Street);
    }
  }
}

export function buildGraph(world: World, stations: number[] = []): Graph {
  const g = new Graph();
  g.build(world, stations);
  return g;
}

/** 線路を直線で敷く。 */
export function layRail(world: World, x0: number, y0: number, x1: number, y1: number): number[] {
  const tiles: number[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  for (;;) {
    const t = idx(x, y);
    world.terrain[t] = 0;
    world.slope[t] = 0;
    if (world.setRail(t, true)) tiles.push(t);
    if (x === x1 && y === y1) break;
    if (x !== x1) x += dx;
    else if (y !== y1) y += dy;
    else break;
  }
  return tiles;
}
