import { App } from '@app/app';

/**
 * エントリポイント。
 * URL の ?seed= でマップのシードを変えられる（同じシードなら必ず同じ地形になる）。
 */
const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');
if (!canvas || !uiRoot) throw new Error('#viewport / #ui-root が見つかりません');

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 42) || 42;

// 街の初期構築は数秒かかるので、進行状況を出しておく
const splash = document.createElement('div');
splash.style.cssText =
  'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0e1116;color:#e8e6e1;font-family:sans-serif;font-size:15px;z-index:99;';
splash.textContent = '街を生成しています…';
document.body.appendChild(splash);

requestAnimationFrame(() => {
  const app = new App(canvas, uiRoot, seed);
  app.bootstrapCity();
  splash.remove();
  app.start();

  // デバッグ用のフック（E2E テストやコンソールからの操作に使う）
  (window as unknown as { __game: App }).__game = app;
});
