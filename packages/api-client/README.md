# @torihanaku/api-client

## 用途

認証トークン注入・タイムアウト・エラーハンドリング・使用量上限フィードバックを一元化した、型付きのフロントエンド用 fetch ラッパーです。

## 主要API

```ts
import { createApiClient, ApiError, isAiNotConfigured } from '@torihanaku/api-client';

const api = createApiClient({
  baseUrl: '/api',                          // 省略時 '/api'
  getToken: async () => await auth.getAccessToken(),  // Bearer トークン取得（非同期OK）
  getStreamToken: () => readTokenFromStorageSync(),   // SSE用（同期必須）
  timeoutMs: 8000,                          // signal 未指定時のタイムアウト
  onError: (msg) => toast(msg),             // 403（権限なし）時のUIフィードバック
  onUsageLimit: (msg, details) => toast(msg), // 403 usage_limit_exceeded 時
});

// 型付きメソッド
const users = await api.get<User[]>('/users');
await api.post('/items', { name: 'a' });
await api.patch('/items/1', { name: 'b' });
await api.put('/items/1', { name: 'c' });
await api.del('/items/1');

// ファイルアップロード（multipart boundary はブラウザ任せ）
await api.upload('/files', formData);

// Server-Sent Events（トークンはクエリパラメータで付与）
const es = api.stream('/events', (data) => console.log(data));

// アンロード中でも届くビーコン
api.sendBeacon('/track', { event: 'unload' });

// Response を直接扱いたい場合
const res = await api.raw('/download');

// エラーは ApiError（status / statusText / body 付き）で throw される
try { await api.get('/x'); } catch (e) {
  if (e instanceof ApiError && e.status === 401) { /* ... */ }
}
```

## 依存

なし（ブラウザ標準の `fetch` / `EventSource` / `navigator.sendBeacon` を使用）。

## 設定ポイント（何を注入するか）

| 設定 | 役割 | 元実装での対応物 |
|------|------|------------------|
| `getToken` | Bearer トークンの取得（async可） | Supabase `auth.getSession()` |
| `getStreamToken` | SSE用の同期トークン取得 | localStorage の Supabase トークン直読み |
| `baseUrl` | 全リクエストのURLプレフィックス | ハードコードの `/api` |
| `onError` | 403（権限なし）のUI通知 | `globalThis.__showToast` |
| `onUsageLimit` | 使用量上限超過（403 `usage_limit_exceeded`）のUI通知 | `globalThis.__showToast` |
| `timeoutMs` | signal 未指定時の自動タイムアウト | 固定 8000ms |

コールバックはすべて省略可能。省略時はサイレントに throw のみ行います。

## 想定ランタイム

ブラウザ（フレームワーク非依存）。`stream()` は `window` / `EventSource`、`sendBeacon()` は `navigator` を参照するため SSR では呼ばないこと。`get/post` 等は fetch があれば Node でも動作します。

## 出典

`実運用SaaS/src/lib/api-client.ts`（約218行）
