import { App } from '@app/app';

/**
 * エントリポイント。
 *
 * 起動時に「何もない土地から始める」か「できあがった街を見る」かを選ばせる。
 * URL の ?seed= で地形のシードを変えられる（同じシードなら必ず同じ地形になる）。
 */
const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');
if (!canvas || !uiRoot) throw new Error('#viewport / #ui-root が見つかりません');

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 42) || 42;

const startup = document.createElement('div');
startup.id = 'startup';
startup.innerHTML = `
  <h1>都市開発シミュレーション</h1>
  <p>
    市民を 1 人ひとり個別にシミュレートする街づくりゲームです。<br />
    住民はそれぞれ職業・自宅・年齢・交通手段の好みを持ち、実際に経路を探して街を移動します。
  </p>
  <div class="choices">
    <button class="primary" id="btn-new">何もない土地から始める（チュートリアル付き）</button>
    <button id="btn-sample">できあがった街を見る</button>
  </div>
  <div class="status" id="startup-status"></div>
`;
document.body.appendChild(startup);

const status = startup.querySelector('#startup-status') as HTMLElement;

function launch(mode: 'new' | 'sample'): void {
  status.textContent = mode === 'new' ? '地形を生成しています…' : '街を生成しています（数秒かかります）…';
  // 表示を更新させてから重い処理に入る
  requestAnimationFrame(() => {
    setTimeout(() => {
      const app = new App(canvas!, uiRoot!, seed);
      if (mode === 'new') app.startEmpty();
      else app.startSample();
      startup.remove();
      app.start();
      // デバッグ用のフック（E2E テストやコンソールからの操作に使う）
      (window as unknown as { __game: App }).__game = app;
    }, 30);
  });
}

(startup.querySelector('#btn-new') as HTMLButtonElement).onclick = () => launch('new');
(startup.querySelector('#btn-sample') as HTMLButtonElement).onclick = () => launch('sample');

// ?start=sample / ?start=new で開始画面を飛ばせる（テスト用）
const auto = params.get('start');
if (auto === 'sample' || auto === 'new') launch(auto);
