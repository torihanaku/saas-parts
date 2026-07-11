# @torihanaku/security-utils

セキュリティ系の小道具を1パッケージに集約したユーティリティ集です。Webhook署名（HMAC-SHA256）、SSRF安全なURL検証、パストラバーサル安全なパス結合、PIIハッシュ、Kintone Webhook署名検証を提供します。

> 入力バリデーション（UUID / email / body-size）は `@torihanaku/validation` の担当です。本パッケージは「守り（セキュリティ）側」のユーティリティに限定しています。

## 提供機能

| モジュール | エクスポート | 説明 |
|---|---|---|
| `signing` | `signPayload(payload, secret)` | HMAC-SHA256 でペイロードに署名（hex） |
| `signing` | `verifySignature(payload, signature, secret)` | タイミングセーフ比較で署名を検証 |
| `url` | `validateWebhookUrl(url)` | HTTPS必須＋プライベートIP/内部ホスト遮断（SSRF対策）。エラー文字列 or `null` を返す |
| `url` | `headCheck(url, timeoutMs?)` | SSRF preflight 後に HEAD で到達性確認（2xx/3xx=ok、絶対に throw しない） |
| `url` | `filterReachableUrls(urls, opts?)` | 並列HEADチェックし、到達可能なURLだけを元の順序で返す |
| `path` | `safeJoin(rootDir, requestPath)` | URLデコード＋正規化してルート外へ逃げるパスは `null` |
| `pii` | `hashEmail(email)` | trim + 小文字化して SHA-256 hex（メール用） |
| `pii` | `hashPii(value)` | 正規化なしの汎用 SHA-256 hex |
| `kintone` | `verifyKintoneSignature(body, signature, secret)` | Kintone Webhook（`X-Kintone-Signature`）の検証。空引数は fail-closed |

## SSRF 遮断対象

`localhost` / `127.0.0.0/8` / RFC1918（`10.` `172.16-31.` `192.168.`）/ `0.0.0.0/8` / リンクローカル `169.254.`（クラウドメタデータ含む）/ IPv6（`::1` `fc00::` `fd..` `fe80::`）/ `.local` `.internal` `.localhost` / `metadata.google.internal`。加えて HTTPS 以外のスキームと 2048 文字超の URL を拒否します。

## 使い方

```ts
import {
  signPayload, verifySignature,
  validateWebhookUrl, headCheck, filterReachableUrls,
  safeJoin, hashEmail, hashPii, verifyKintoneSignature,
} from "@torihanaku/security-utils";

// Webhook 送信側: 署名を付与
const sig = signPayload(body, secret);

// Webhook 受信側: 検証
if (!verifySignature(rawBody, headerSig, secret)) return new Response(null, { status: 401 });

// URL 登録時: SSRF ガード
const err = validateWebhookUrl(inputUrl); // string | null
if (err) throw new Error(err);

// 静的ファイル配信: パストラバーサル対策
const filePath = safeJoin(publicDir, req.path);
if (!filePath) return new Response(null, { status: 400 });
```

## 依存

- ランタイム依存なし（Node 標準の `node:crypto` / `node:path` / グローバル `fetch` のみ）
- `process.env` 参照なし。secret はすべて引数で渡します

## テスト

```bash
npx vitest run packages/security-utils
```
