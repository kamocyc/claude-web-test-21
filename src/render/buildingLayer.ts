import { Color, Object3D, Vector3 } from 'three';
import { MAP_H, MAP_W, TERRAIN_HEIGHT_SCALE, TILE_M } from '@shared/constants';
import { archetype } from '@sim/buildings/archetypes';
import type { Simulation } from '@sim/simulation';
import { idx, tileX, tileY } from '@sim/world/tiles';
import { BuildingParts, setBuildingNight, setBuildingSky } from './buildingParts';
import { composeBuilding, rnd, type BuildCtx, type Facing } from './buildingShapes';
import { atmosphereAt, sunDirection } from './sky';
import { meshStyle, TIN_ROOFS } from './theme';

const hsl = { h: 0, s: 0, l: 0 };
const sunDir = new Vector3();

/**
 * 基準色を棟ハッシュで散らす。
 *
 * 以前は共通の `jitterColor` を使っていたが、あれは 1 つの乱数から
 * 色相と明度の両方を作っていた（＝色相が上がると必ず明度も上がる）。
 * 相関があると、散らしたはずの色が「明るい方は黄色、暗い方は青」という
 * 一本の線の上に乗ってしまい、街を引いて見たときに色の帯として読める。
 *
 * ここでは色相・彩度・明度に独立したハッシュを引き、
 * 色相 ±8度 / 明度 ±12% / 彩度 ±20% の範囲で散らす。
 * instanceColor に載せるだけなので追加のコストはゼロ。
 */
function scatterColor(base: number, hash: number, out: Color, strength = 1): Color {
  out.setHex(base);
  out.getHSL(hsl);
  const a = rnd(hash, 601) - 0.5; // 色相
  const b = rnd(hash, 602) - 0.5; // 彩度
  const c = rnd(hash, 603) - 0.5; // 明度
  out.setHSL(
    (hsl.h + a * (16 / 360) * strength + 1) % 1,
    Math.max(0, Math.min(1, hsl.s * (1 + b * 0.4 * strength))),
    Math.max(0.03, Math.min(0.97, hsl.l * (1 + c * 0.24 * strength))),
  );
  return out;
}

/**
 * 建物の描画。
 *
 * 以前は「形状キーごとに本体の箱 1 つ＋屋根 1 つ＋窓の黒い帯」だった。
 * 路上に降りると巨大なのっぺりした箱が並んでいるようにしか見えず、
 * ここが絵の質をいちばん落としていた。
 *
 * 作りを 2 段に分けて作り直してある。
 *
 * - **どう積むか**（`buildingShapes.ts`）: 用途ごとに基壇・セットバック・
 *   塔屋・屋上設備・庇・看板・鳥居・煙突を積む。形はすべて棟のハッシュから
 *   決めるので、同じ用途でも 2〜4 通りの量塊になり、反復が目立たない。
 * - **どう描くか**（`buildingParts.ts`）: 積まれた部品を十数種類の
 *   InstancedMesh（面取り箱・切妻・寄棟・円柱・受水槽・鳥居・室外機の列・
 *   排気筒・手すり・看板 2 種）に振り分ける。窓・バルコニー・シャッター・
 *   看板の文字はシェーダが部品のローカル座標から描くので、
 *   街に何棟建とうとドローコールはキットの数のまま増えない。
 *
 * インスタンスの書き込みは以前と同じく「建物の増減があったとき」だけ。
 * 夜の点灯は材質のユニフォーム 1 つで動くので、毎フレームの走査は要らない。
 */
export class BuildingLayer {
  readonly group = new Object3D();
  private readonly parts = new BuildingParts();
  private lastEpoch = -1;

  private readonly wall = new Color();
  private readonly roof = new Color();
  private readonly ctx: BuildCtx;

  constructor() {
    this.group.name = 'buildings';
    this.group.add(this.parts.group);
    this.ctx = {
      e: this.parts,
      cx: 0,
      cz: 0,
      gy: 0,
      w: 1,
      d: 1,
      height: 1,
      level: 1,
      hash: 0,
      front: 0,
      style: meshStyle('house'),
      wall: this.wall,
      roof: this.roof,
      roofRough: 0.74,
      roofMetal: 0.06,
    };
  }

  /**
   * 次の update で必ず作り直させる。
   * セーブデータを読み込んだときのように、エポックが「進まずに変わる」場合に使う。
   */
  invalidate(): void {
    this.lastEpoch = -1;
  }

  /**
   * 夜になったら窓を灯す。
   *
   * 帯ごと一斉に点けるのをやめ、材質に「夜の度合い」だけを渡す。
   * どの部屋が点くかはシェーダが (階, スパン, 棟ハッシュ) から決めるので、
   * 夕方から夜にかけて灯りが少しずつ増えていく。
   */
  setTimeOfDay(dayFraction: number): void {
    const atmo = atmosphereAt(dayFraction);
    setBuildingNight(atmo.nightAmount);
    // ガラスの映り込みは環境マップをやめてシェーダで空を引くようにしたので、
    // 空の色と太陽の向きをここから材質へ渡す。
    // 時刻が動くと窓に映る空も一緒に動く（夕方は窓が橙になる）。
    sunDirection(dayFraction, sunDir);
    setBuildingSky(atmo.zenith, atmo.horizon, sunDir, atmo.sunColor, atmo.sunIntensity);
  }

  /** 建物の増減があったときだけインスタンスを作り直す。 */
  update(sim: Simulation): void {
    if (sim.world.epochs.buildings === this.lastEpoch) return;
    this.lastEpoch = sim.world.epochs.buildings;

    const b = sim.buildings;
    const world = sim.world;
    const ctx = this.ctx;
    this.parts.reset();

    for (const slot of b.each()) {
      const a = archetype(b.archetypeId[slot]!);
      const style = meshStyle(a.mesh);
      const origin = b.originTile[slot]!;
      const ox = tileX(origin);
      const oy = tileY(origin);
      const level = b.level[slot]!;

      // 棟ごとの固定ハッシュ。slot は建物が建て替わると使い回されるので、
      // 位置と用途から作る（同じ場所に同じ用途が建てば同じ形になる、で構わない）。
      const hash = (Math.imul(origin, 2654435761) ^ Math.imul(a.id + 7, 40503)) >>> 0;

      ctx.style = style;
      ctx.level = level;
      ctx.hash = hash;
      ctx.w = a.w * TILE_M * style.inset;
      ctx.d = a.h * TILE_M * style.inset;
      ctx.cx = (ox + a.w / 2) * TILE_M;
      ctx.cz = (oy + a.h / 2) * TILE_M;
      // 敷地の四隅のうち一番低いところに載せる。原点タイルの高さだけを見ると、
      // 斜面にまたがった建物の角が宙に浮く。
      ctx.gy = this.groundOf(world.heightDm, ox, oy, a.w, a.h);
      // 高さは棟ごとに少し散らす。階高で丸めるので、散らした結果は
      // 「1 階多い／少ない」という離散的な差になり、街並みに凹凸が出る。
      ctx.height = (style.baseHeight + style.perLevel * (level - 1)) * (0.93 + rnd(hash, 60) * 0.16);
      ctx.front = this.facingOf(b.accessTile[slot]!, ox, oy, a.w, a.h, hash);

      // 個体色。候補から 1 つ選び、さらに色相・彩度・明度を独立に散らす。
      const wallBase = style.walls[Math.floor(rnd(hash, 70) * style.walls.length) % style.walls.length]!;
      scatterColor(wallBase, hash, this.wall);
      const roofBase = style.roofs[Math.floor(rnd(hash, 71) * style.roofs.length) % style.roofs.length]!;
      // 屋根は壁ほど散らさない。同じ街区で屋根の色相まで暴れると、
      // 「色を散らした」ではなく「配色が壊れている」に見える。
      // 俯瞰では画面の 4 割が屋根なので、色相 ±6°・明度 ±8% は欲しい。
      // 瓦の起伏はテクスチャが持つので、ここは棟ごとの「焼きの違い」だけ。
      scatterColor(roofBase, hash ^ 0x5bf03, this.roof, 0.7);
      // 金属葺きだけ鈍く光らせる。同じ切妻でも材の違いが読めるようになる。
      const tin = TIN_ROOFS.has(roofBase);
      ctx.roofRough = tin ? 0.42 : 0.79;
      ctx.roofMetal = tin ? 0.55 : 0.06;

      composeBuilding(a.mesh, ctx);
    }

    this.parts.flush();
  }

  /** 敷地の四隅で一番低い地面の高さ。 */
  private groundOf(heightDm: Uint16Array, ox: number, oy: number, w: number, h: number): number {
    let min = Infinity;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const tx = Math.min(MAP_W - 1, ox + dx * (w - 1));
        const ty = Math.min(MAP_H - 1, oy + dy * (h - 1));
        const v = heightDm[idx(tx, ty)]!;
        if (v < min) min = v;
      }
    }
    return (min === Infinity ? 0 : min) * TERRAIN_HEIGHT_SCALE;
  }

  /**
   * 建物の正面（道路のある側）。
   *
   * 庇・看板・カーポート・鳥居はすべてこの向きに付ける。
   * 向きを乱数で決めると、看板が裏の空地を向いた建物が並んでしまう。
   * 接道タイルは sim が持っているので、それをそのまま使う。
   */
  private facingOf(access: number, ox: number, oy: number, w: number, h: number, hash: number): Facing {
    if (access >= 0) {
      const dx = tileX(access) + 0.5 - (ox + w / 2);
      const dy = tileY(access) + 0.5 - (oy + h / 2);
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
      if (Math.abs(dy) > 1e-6) return dy > 0 ? 0 : 2;
    }
    return (Math.floor(rnd(hash, 80) * 4) % 4) as Facing;
  }

  dispose(): void {
    this.parts.dispose();
  }
}
