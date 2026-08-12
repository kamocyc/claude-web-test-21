import { describe, expect, it } from 'vitest';
import { TILE_SPAN_M } from '@shared/constants';
import { Mode } from '@shared/enums';
import { Pathfinder, pathPosition, type PathPose } from '@sim/network/pathfinder';
import {
  TRAIN_LENGTH_M,
  railPoseAt,
  shuttleCycleSec,
  traceRailLines,
  trainHeads,
  type RailPose,
  type TrainHead,
} from '@sim/network/railLines';
import { idx } from '@sim/world/tiles';
import { buildGraph, layRail, layRoadLine, makeTestWorld } from './helpers';

const heads = (): TrainHead[] => Array.from({ length: 64 }, () => ({ distM: 0, forward: true }));
const pose = (): RailPose => ({ x: 0, z: 0, heading: 0 });

/** -π..π に畳んだ角度差。 */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

describe('線路の折れ線抽出', () => {
  it('直線の線路は 1 本の折れ線になり、長さがタイル数と一致する', () => {
    const world = makeTestWorld();
    layRail(world, 20, 20, 20, 60); // 41 タイル = 40 区間
    const station = idx(21, 30);
    const graph = buildGraph(world, [station]);

    const lines = traceRailLines(graph);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.nodes.length).toBe(41);
    // 線路長はシミュレーション上の実距離（描画単位ではない）
    expect(lines[0]!.lengthM).toBeCloseTo(40 * TILE_SPAN_M, 3);
    // 累積距離は単調増加
    for (let i = 1; i < lines[0]!.cumM.length; i++) {
      expect(lines[0]!.cumM[i]!).toBeGreaterThan(lines[0]!.cumM[i - 1]!);
    }
  });

  it('駅の無い線路は served=false になり、電車が走らない', () => {
    const world = makeTestWorld();
    layRail(world, 20, 20, 20, 60);
    const graph = buildGraph(world, []); // 駅なし

    const lines = traceRailLines(graph);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.served).toBe(false);
    expect(trainHeads(lines[0]!, 0, heads())).toBe(0);
  });

  it('駅を置くと served=true になり、電車が走る', () => {
    const world = makeTestWorld();
    layRail(world, 20, 20, 20, 60);
    const graph = buildGraph(world, [idx(21, 30)]);

    const lines = traceRailLines(graph);
    expect(lines[0]!.served).toBe(true);
    expect(trainHeads(lines[0]!, 0, heads())).toBeGreaterThan(0);
  });

  it('Y 字の分岐は 3 本に分割される（分岐を跨いで繋がない）', () => {
    const world = makeTestWorld();
    layRail(world, 20, 20, 20, 60); // 縦
    layRail(world, 21, 40, 34, 40); // 横（(20,40) が分岐点）
    const graph = buildGraph(world, [idx(19, 30)]);

    const lines = traceRailLines(graph);
    expect(lines).toHaveLength(3);
    // すべての区間がちょうど 1 回ずつ現れる（重複も抜けも無い）
    const totalSegments = lines.reduce((n, l) => n + l.nodes.length - 1, 0);
    expect(totalSegments).toBe(40 + 14);
  });

  it('編成長より短い線路には電車を走らせない', () => {
    const world = makeTestWorld();
    // 3 タイル = 300m。編成長（約 900m）に満たない
    layRail(world, 20, 20, 20, 22);
    const graph = buildGraph(world, [idx(21, 21)]);

    const lines = traceRailLines(graph);
    expect(lines[0]!.lengthM).toBeLessThan(TRAIN_LENGTH_M);
    expect(trainHeads(lines[0]!, 0, heads())).toBe(0);
  });
});

describe('電車の走行', () => {
  const setup = (): ReturnType<typeof buildGraph> => {
    const world = makeTestWorld();
    layRail(world, 20, 20, 20, 100);
    return buildGraph(world, [idx(21, 60)]);
  };

  it('位置は周期 = 往復時間で厳密に繰り返す', () => {
    const line = traceRailLines(setup())[0]!;
    const cycleMin = shuttleCycleSec(line) / 60;
    const a = heads();
    const b = heads();
    const n = trainHeads(line, 12.5, a);
    expect(trainHeads(line, 12.5 + cycleMin, b)).toBe(n);
    for (let k = 0; k < n; k++) {
      expect(b[k]!.distM).toBeCloseTo(a[k]!.distM, 3);
      expect(b[k]!.forward).toBe(a[k]!.forward);
    }
  });

  it('時間を細かく進めても位置が飛ばない（連続に動く）', () => {
    const line = traceRailLines(setup())[0]!;
    const a = heads();
    const b = heads();
    const dtMin = 1 / 60;
    trainHeads(line, 30, a);
    const n = trainHeads(line, 30 + dtMin, b);
    for (let k = 0; k < n; k++) {
      // 折り返し中の編成を除き、1/60 分で進む距離は表定速度ぶんだけ
      if (a[k]!.forward !== b[k]!.forward) continue;
      expect(Math.abs(b[k]!.distM - a[k]!.distM)).toBeLessThan(30);
    }
  });

  it('折り返すと進行方向が π 反転する', () => {
    const graph = setup();
    const line = traceRailLines(graph)[0]!;
    const fwd = pose();
    const back = pose();
    railPoseAt(graph, line, 200, true, fwd);
    railPoseAt(graph, line, 200, false, back);
    expect(fwd.x).toBeCloseTo(back.x, 5);
    expect(fwd.z).toBeCloseTo(back.z, 5);
    expect(Math.abs(angleDiff(fwd.heading, back.heading))).toBeCloseTo(Math.PI, 5);
  });

  it('端を超える距離を渡しても線路上に収まる', () => {
    const graph = setup();
    const line = traceRailLines(graph)[0]!;
    const p = pose();
    railPoseAt(graph, line, -500, true, p);
    expect(p.x).toBeCloseTo(graph.nodeX[line.nodes[0]!]!, 5);
    railPoseAt(graph, line, line.lengthM + 500, true, p);
    const last = line.nodes[line.nodes.length - 1]!;
    expect(p.x).toBeCloseTo(graph.nodeX[last]!, 5);
    expect(p.z).toBeCloseTo(graph.nodeZ[last]!, 5);
  });
});

describe('経路上の位置', () => {
  const build = (): { graph: ReturnType<typeof buildGraph>; a: number; b: number } => {
    const world = makeTestWorld();
    layRoadLine(world, 20, 20, 60, 20);
    layRoadLine(world, 60, 20, 60, 50);
    const graph = buildGraph(world);
    return { graph, a: graph.roadNodeAt[idx(20, 20)]!, b: graph.roadNodeAt[idx(60, 50)]! };
  };

  it('f=0 は始点ノード、f=1 は終点ノードに一致する', () => {
    const { graph, a, b } = build();
    const path = new Pathfinder().search(graph, a, b, Mode.Walk)!;
    expect(path).not.toBeNull();

    const out: PathPose = { x: 0, z: 0, heading: 0, edge: -1 };
    expect(pathPosition(graph, path, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(graph.nodeX[a]!, 5);
    expect(out.z).toBeCloseTo(graph.nodeZ[a]!, 5);

    expect(pathPosition(graph, path, 1, out)).toBe(true);
    expect(out.x).toBeCloseTo(graph.nodeX[b]!, 5);
    expect(out.z).toBeCloseTo(graph.nodeZ[b]!, 5);
  });

  it('f を増やすと始点からの道のりが単調に増える', () => {
    const { graph, a, b } = build();
    const path = new Pathfinder().search(graph, a, b, Mode.Walk)!;
    const out: PathPose = { x: 0, z: 0, heading: 0, edge: -1 };
    let prev = -1;
    for (let i = 0; i <= 40; i++) {
      pathPosition(graph, path, i / 40, out);
      // 経路は L 字なので直線距離は使えない。マンハッタン距離が単調になる。
      const d = Math.abs(out.x - graph.nodeX[a]!) + Math.abs(out.z - graph.nodeZ[a]!);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = d;
    }
  });

  it('経路上のエッジ index を返す（徒歩区間か車道かの判定に使う）', () => {
    const { graph, a, b } = build();
    const path = new Pathfinder().search(graph, a, b, Mode.Car)!;
    const out: PathPose = { x: 0, z: 0, heading: 0, edge: -1 };
    for (let i = 0; i <= 10; i++) {
      pathPosition(graph, path, i / 10, out);
      expect(Array.from(path.edges)).toContain(out.edge);
    }
  });
});
