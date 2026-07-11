# @torihanaku/storage-upload

Supabase Storage へのテナント分離バイナリアップロード（`{tenant_id}/{filename}` パスプレフィックスでの分離・PNG/SVG/JPG/WebP許可リスト・公開URL生成。supabase-js 非依存の raw fetch 実装）。

## 主要API

```ts
import {
  uploadTenantAsset,
  isAllowedImageMime,
  extensionForImageMime,
} from "@torihanaku/storage-upload";

// MIME検証（route側の許可リストを再利用可能なヘルパーとして提供）
if (!isAllowedImageMime(file.type)) return new Response("unsupported", { status: 415 });
const filename = `logo-${Date.now()}.${extensionForImageMime(file.type)}`;

// テナントスコープでアップロード（upsert）→ 公開URLを取得
const { publicUrl, storagePath } = await uploadTenantAsset(
  {
    supabaseUrl: myConfig.supabaseUrl,   // 例 "https://xxxx.supabase.co"
    serviceKey: myConfig.serviceRoleKey, // service role key
    bucket: "white-label-assets",        // 省略時デフォルト
  },
  tenantId,
  new Uint8Array(await file.arrayBuffer()),
  filename,
  file.type,
);
```

## 依存

なし（fetch標準のみ。supabase-js 不使用で Storage REST API を直接叩く）。

## 注入ポイント

- `config.supabaseUrl` / `config.serviceKey` — 必須（env読みはしないので呼び出し側の設定層から渡す）
- `config.bucket` — バケット名（デフォルト `white-label-assets`）
- `config.fetchImpl` — fetch実装の差し替え（テスト用。デフォルト `globalThis.fetch`）

## 想定ランタイム

Node.js 18+ / Bun / Edge（サーバーサイド。service role key を扱うためクライアントでは使わないこと）。

## 出典

`dev-dashboard-v2/server/lib/white-label/asset-upload.ts`（MIME許可リストと拡張子マッピングは同 `server/routes/white-label.ts` から抽出）
