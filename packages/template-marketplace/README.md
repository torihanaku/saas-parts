# @torihanaku/template-marketplace

成功施策テンプレートのマーケットプレイス。パターン匿名化（企業名・絶対数値・URL・メール除去）、テンプレ投稿/一覧/クローン/レビュー、高パフォーマンスキャンペーンからのLLMパターン抽出（重複排除つき）を提供。

## 主要API例

```ts
import {
  MarketplaceService,
  InMemoryMarketplaceStore,
  scrubText,
  extractAnonymizedPattern,
  extractSuccessSignals,
  extractPatterns,
  persistPatterns,
  selectTopDecile,
  patternHash,
} from "@torihanaku/template-marketplace";

const store = new InMemoryMarketplaceStore(); // 本番は DB 実装の MarketplaceStore を注入
const mp = new MarketplaceService({ store });

// 投稿（rawSource は service が匿名化してから保存。publish=false なら draft）
const tpl = await mp.submitTemplate(tenantId, userId, {
  title: "勝ちメール施策",
  campaignType: "email",
  rawSource: { subject: "Acme Inc. の売上を 200% 改善", channels: ["Email"] },
});

await mp.listMarketplace({ industry: "saas", search: "win", limit: 50 }); // published のみ・レーティング集計を重畳
await mp.cloneTemplate(tenantId, userId, { templateId: tpl!.id });        // published 検証 + clone_count 加算
await mp.addReview(tenantId, userId, { templateId: tpl!.id, rating: 5, comment: "…" }); // rating 1..5 整数・comment は scrub
await mp.getReviewSummaryForTemplate(tpl!.id); // { count, average, distribution: {1..5} }
await mp.listOwnTemplates(tenantId);           // 自テナントの draft 含む一覧

// LLM パターン抽出（LLM は JsonGenerator コールバックとして注入）
const patterns = await extractPatterns(campaigns, { generateJson: myLlmJson });
await persistPatterns(store, tenantId, patterns); // (tenant_id, pattern_hash) で upsert
```

## 依存
- peerDependencies: なし（`node:crypto` の sha256 のみ使用）

## 注入ポイント
- `MarketplaceStore` — dd_marketplace_templates / dd_marketplace_reviews / dd_marketplace_clones / vw_template_ratings 相当の読み書き（元 PostgREST クエリ形状を型付きメソッドで写像）
- `JsonGenerator` — LLM の JSON 生成コールバック（元実装の claude-api-client.generateJson + テナントBYOKキー解決を置換。キー解決は呼び出し側の責務）
- `InMemoryMarketplaceStore` の `uuid` / `now` — テスト決定性用

## 元実装からの変更点
- Supabase / supabase-admin 直接呼び出し → `MarketplaceStore` 注入（`server/lib/marketplace/extractor.ts` の抽出コアも同梱）
- 匿名化正規表現・scrub ロジック・top-decile 選定・pattern_hash・多層防御（LLM出力の再scrub）は無改変
- extractPatterns から tenantId / APIキー解決を除去（LLM コールバック注入に置換）。コールバック未設定時は警告して []（元実装のキー未設定時と同挙動）
- レーティングビュー参照失敗時に行キャッシュへフォールバックする挙動は維持

## 残課題
- HTTP ルート層（`server/routes/marketplace.ts`）のバリデーション/フラグゲートはアプリ側の責務として未移植
