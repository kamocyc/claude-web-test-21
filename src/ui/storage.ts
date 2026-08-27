import type { SaveMeta } from '@sim/persistence';

/**
 * セーブデータの置き場所。ここだけがブラウザ API に触れる。
 *
 * localStorage は使わない。人口 2000 の街で 1.4MB あり、文字列にすると
 * base64 で 1.9MB になる。多くのブラウザの上限が 5MB なので、
 * 街が育つと**保存した瞬間に静かに失敗する**。IndexedDB なら ArrayBuffer を
 * そのまま置けて、容量も桁が違う。
 */

const DB_NAME = 'city-sim';
const DB_VERSION = 1;
const STORE = 'saves';
/** ブラウザ内セーブのスロット名。今は 1 枠だけ。 */
export const AUTO_SLOT = 'last';

export interface StoredSave {
  meta: SaveMeta;
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB を開けませんでした'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => reject(req.error ?? new Error('セーブデータを読み書きできませんでした'));
        t.oncomplete = (): void => db.close();
      }),
  );
}

export function putSave(slot: string, save: StoredSave): Promise<unknown> {
  return tx('readwrite', (s) => s.put(save, slot) as IDBRequest<unknown>);
}

export function getSave(slot: string): Promise<StoredSave | undefined> {
  return tx('readonly', (s) => s.get(slot) as IDBRequest<StoredSave | undefined>);
}

/** ファイルとして書き出す。ブラウザ間・端末間で持ち運べるのはこちらだけ。 */
export function downloadSave(data: ArrayBuffer, fileName: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // click() が非同期に処理されることがあるので、少し待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ファイルを開かせる。キャンセルされたら null。 */
export function pickSaveFile(): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.city,application/octet-stream';
    input.onchange = (): void => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      void file.arrayBuffer().then(resolve);
    };
    // ダイアログを閉じただけのときは onchange が来ないので、
    // 呼び出し側が永久に待たないよう cancel も拾う。
    input.oncancel = (): void => resolve(null);
    input.click();
  });
}

/** 日付を含む既定のファイル名。 */
export function defaultFileName(cityName: string, dateJa: string): string {
  const safe = cityName.replace(/[\\/:*?"<>|]/g, '_');
  return `${safe}_${dateJa.replace(/[^0-9]/g, '')}.city`;
}
