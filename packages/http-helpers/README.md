# @torihanaku/http-helpers

fetch 標準の Request/Response で動く HTTP サーバー向けの薄いレスポンスヘルパー集（gzip圧縮・ETag・ページネーション・タイムアウト付きfetch・Content-Type推定）。

## 主要API

```ts
import {
  jsonResponse,
  generateETag,
  checkConditionalRequest,
  parsePagination,
  paginatedResponse,
  fetchWithTimeout,
  getContentType,
} from "@torihanaku/http-helpers";

// 1KB超かつクライアントがgzip対応なら自動でgzip圧縮したJSONレスポンス
return jsonResponse({ items }, req, 200, { "Cache-Control": "no-store" });

// ETag + 条件付きリクエスト(304)
const etag = generateETag(data);
const notModified = checkConditionalRequest(req, etag);
if (notModified) return notModified;
return jsonResponse(data, req, 200, { ETag: etag });

// ?page=3&limit=10 → { page: 3, limit: 10, offset: 20 }（limitは1〜maxLimitにクランプ）
const { page, limit, offset } = parsePagination(new URL(req.url), 20, 100);
return jsonResponse(paginatedResponse(rows, total, page, limit), req);

// ハングしない外部API呼び出し（デフォルト30秒でabort）
const res = await fetchWithTimeout("https://api.example.com", { method: "POST" }, 10_000);

// 拡張子からContent-Type推定（静的ファイル配信用）
getContentType("app.css"); // "text/css; charset=utf-8"
```

## 依存

なし（Node組み込みの `zlib` / `crypto` のみ）。

## 設定ポイント（何を注入するか）

注入は不要。全て純関数。`jsonResponse` の圧縮閾値（1KB）とアルゴリズム（gzip）は固定。

## 想定ランタイム

node / bun（`gzipSync`・`Buffer` を使うため。fetch標準の `Request`/`Response` グローバルが必要 = Node 18+）。

## 出典

実運用SaaS `server/lib/helpers.ts`（テストは `tests/helpers.test.ts` から移植）。
