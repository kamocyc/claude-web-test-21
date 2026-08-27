import { App } from '@app/app';
import { AUTO_SLOT, getSave } from '@ui/storage';

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
    <button id="btn-continue" hidden>続きから</button>
    <button id="btn-open">セーブデータを開く</button>
  </div>
  <div class="status" id="startup-status"></div>
`;
document.body.appendChild(startup);

const status = startup.querySelector('#startup-status') as HTMLElement;

type StartMode = { kind: 'new' } | { kind: 'sample' } | { kind: 'load'; data: ArrayBuffer };

function launch(mode: StartMode): void {
  status.textContent =
    mode.kind === 'new'
      ? '地形を生成しています…'
      : mode.kind === 'sample'
        ? '街を生成しています（数秒かかります）…'
        : 'セーブデータを読み込んでいます…';
  // 表示を更新させてから重い処理に入る
  requestAnimationFrame(() => {
    setTimeout(() => {
      // 読み込みでは地形のシードがセーブデータ側で決まるので、ここのシードは仮のもの
      const app = new App(canvas!, uiRoot!, seed);
      try {
        if (mode.kind === 'new') app.startEmpty();
        else if (mode.kind === 'sample') app.startSample();
        else app.loadData(mode.data);
      } catch (e) {
        status.textContent = `読み込めませんでした: ${(e as Error).message}`;
        return;
      }
      startup.remove();
      app.start();
      // デバッグ用のフック（E2E テストやコンソールからの操作に使う）
      (window as unknown as { __game: App }).__game = app;
    }, 30);
  });
}

(startup.querySelector('#btn-new') as HTMLButtonElement).onclick = () => launch({ kind: 'new' });
(startup.querySelector('#btn-sample') as HTMLButtonElement).onclick = () => launch({ kind: 'sample' });

// ブラウザ内に前回の保存があれば「続きから」を出す
const btnContinue = startup.querySelector('#btn-continue') as HTMLButtonElement;
void getSave(AUTO_SLOT)
  .then((save) => {
    if (!save) return;
    const d = new Date(save.meta.savedAt);
    btnContinue.hidden = false;
    btnContinue.textContent = `続きから（${save.meta.cityName}・${save.meta.dateJa}・人口 ${save.meta.population.toLocaleString('ja-JP')}）`;
    btnContinue.title = `保存日時 ${d.toLocaleString('ja-JP')}`;
    btnContinue.onclick = (): void => launch({ kind: 'load', data: save.data });
  })
  .catch(() => {
    // IndexedDB が使えない環境（プライベートモードなど）では黙って諦める
  });

(startup.querySelector('#btn-open') as HTMLButtonElement).onclick = (): void => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.city,application/octet-stream';
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (file) void file.arrayBuffer().then((data) => launch({ kind: 'load', data }));
  };
  input.click();
};

// ?start=sample / ?start=new で開始画面を飛ばせる（テスト用）
const auto = params.get('start');
if (auto === 'sample' || auto === 'new') launch({ kind: auto });
