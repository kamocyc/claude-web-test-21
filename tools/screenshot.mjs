/**
 * 描画の確認用スクリーンショット撮影ツール（開発専用・ゲーム本体からは参照しない）。
 *
 *   node tools/screenshot.mjs [出力ディレクトリ] [--shots=overview,street,...]
 *
 * vite の dev サーバを立ち上げ、ヘッドレス Chromium（SwiftShader）で
 * サンプルの街を読み込み、決め打ちのカメラ・時刻で数枚撮る。
 * グラフィックの良し悪しは数字では測れないので、実際に絵を見て直すための足場。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  // playwright はグローバルにしか入っていないことが多い
  const globalRoot = execSync('npm root -g').toString().trim();
  ({ chromium } = createRequire(globalRoot + '/x.js')('playwright'));
}

const outDir = resolve(process.argv[2] ?? 'shots');
const only = (process.argv.find((a) => a.startsWith('--shots=')) ?? '').slice(8);
const port = Number(process.env.SHOT_PORT ?? 5199);
mkdirSync(outDir, { recursive: true });

/** 撮影アングル。距離・方位・仰角・時刻（0..1）。 */
const SHOTS = [
  { name: '01-overview-noon', dist: 900, azim: 0.7, elev: 48, hour: 12 },
  { name: '02-district-noon', dist: 380, azim: 0.9, elev: 34, hour: 12 },
  { name: '03-street-noon', dist: 210, azim: 1.2, elev: 20, hour: 12 },
  { name: '04-street-dusk', dist: 150, azim: 2.4, elev: 14, hour: 18.2 },
  { name: '05-district-night', dist: 340, azim: 0.9, elev: 30, hour: 21 },
  { name: '06-overview-morning', dist: 700, azim: 3.9, elev: 40, hour: 6.6 },
  // 目線の高さ。路面・歩道・車・人・街灯が「人が見る距離」でどう見えるかは
  // ここでしか分からない。俯瞰だけ見て作ると路上が空っぽのまま気づけない。
  // 道路は軸に平行なので、方位を軸に合わせないと街路を見通せない。
  { name: '07-eyelevel-noon', dist: 115, azim: 0.02, elev: 6, hour: 12 },
  { name: '08-eyelevel-night', dist: 118, azim: 0.02, elev: 6.5, hour: 20.5 },
];

/**
 * ソースを一時ディレクトリへ複製してから dev サーバを立てる。
 *
 * 撮影中に誰かがソースを触ると vite の HMR がページを読み込み直し、
 * その時点で window.__game が消えて撮影が落ちる（複数人で同時に
 * 作業していると必ず起きる）。複製の上で撮れば、撮影は今のソースの
 * スナップショットに対して最後まで走る。
 */
function isolateSources() {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  for (const entry of ['src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
    if (existsSync(entry)) cpSync(entry, join(dir, entry), { recursive: true });
  }
  // node_modules は複製すると重いのでリンクで済ませる
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

const workDir = process.env.SHOT_NO_ISOLATE ? process.cwd() : isolateSources();

// すでに立っている dev サーバがあれば使い回す（撮影のたびに 1 秒待たない）
let server = null;
let serverLog = '';
const alreadyUp = await fetch(`http://localhost:${port}/`).then((r) => r.ok).catch(() => false);
if (!alreadyUp) {
  server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
}

async function waitForServer(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('vite が起動しませんでした:\n' + serverLog);
}

const base = `http://localhost:${port}/`;
let browser;
try {
  await waitForServer(base);
  browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(base + '?start=sample&seed=42&fx=high', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game != null, null, { timeout: 180000 });
  // 実際に描かれたフレーム数を数える。ソフトウェア描画では 1 フレームに
  // 数秒かかることがあり、固定の秒数で待つと「まだ何も反映されていない絵」を
  // 撮ってしまう。
  await page.evaluate(() => {
    window.__frames = 0;
    const tick = () => {
      window.__frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const waitFrames = async (n) => {
    const from = await page.evaluate(() => window.__frames);
    await page.waitForFunction((a) => window.__frames >= a.from + a.n, { from, n }, { timeout: 300000 });
  };
  // 街の生成直後は建物・車のインスタンスがまだ 1 フレームも書かれていない
  await waitFrames(6);

  for (const shot of SHOTS) {
    if (only && !only.split(',').includes(shot.name.replace(/^\d+-/, '')) && !only.split(',').includes(shot.name)) continue;
    await page.evaluate((s) => {
      const g = window.__game;
      const rig = g.renderer.rig;
      rig.distance = s.dist;
      rig.azimuth = s.azim;
      rig.elevation = (s.elev * Math.PI) / 180;
      // 時刻を撮りたい時間に合わせる（1 tick = 1 分）
      const perDay = 24 * 60;
      const cur = g.sim.clock.tick % perDay;
      const want = Math.round(s.hour * 60) % perDay;
      g.sim.clock.tick += ((want - cur) + perDay) % perDay;
    }, shot);
    // 数フレーム回して補間・インスタンス更新を落ち着かせる
    // カメラと時刻を変えてから、実際に数フレーム描かれるまで待つ。
    await waitFrames(4);
    await page.screenshot({ path: resolve(outDir, shot.name + '.png'), timeout: 180000 });
    const stats = await page.evaluate(() => ({
      drawCalls: window.__game.renderer.drawCalls,
      tris: undefined,
    }));
    console.log(`${shot.name}  drawCalls=${stats.drawCalls}`);
  }
  if (errors.length) {
    console.log('--- ページのエラー ---');
    for (const e of errors.slice(0, 20)) console.log(e);
  }
  console.log('保存先: ' + outDir);
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
  if (workDir !== process.cwd()) rmSync(workDir, { recursive: true, force: true });
}
