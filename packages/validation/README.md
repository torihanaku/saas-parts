# @torihanaku/validation

リクエスト処理向けの入力バリデーションユーティリティ（UUID v4検証・メール形式検証・ボディサイズ制限付きJSONパース・400/500エラーレスポンス封筒）。

## 主要API

```ts
import {
  isValidUUID,
  isValidEmail,
  parseBodyWithLimit,
  validationError,
  dbError,
} from "@torihanaku/validation";

if (!isValidUUID(params.id)) return validationError("invalid id");
if (!isValidEmail(body.email)) return validationError("invalid email");

// Content-Length と実テキスト長の両方を上限チェック（デフォルト 1MB）。超過や不正JSONは null
const body = await parseBodyWithLimit(req, 1_048_576);
if (!body) return validationError("invalid body");

// 標準エラー封筒
return validationError("missing field");        // 400 { error, code: "VALIDATION_ERROR" }
return dbError("query failed", "timeout 5s");    // 500 { error, code: "DB_ERROR", details? }
```

## 注意

`isValidUUID` は元実装のコメント上「UUID v4検証」ですが、正規表現は 8-4-4-4-12 の16進形状のみをチェックし、version/variant 桁は固定していません（忠実移植）。

## 依存

なし（fetch標準の `Request` / `Response` のみ）。

## 注入ポイント

なし（純粋関数のみ）。`parseBodyWithLimit` の上限バイト数は第2引数で指定可能（デフォルト 1MB）。

## 想定ランタイム

Node.js 18+ / Bun / Edge（fetch標準 Request/Response が使える環境）。

## 出典

`dev-dashboard-v2/server/lib/validation.ts`
