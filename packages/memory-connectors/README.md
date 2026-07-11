# @torihanaku/memory-connectors

`@torihanaku/kit-decision-memory` から落とした**具体的な取り込みコネクタ**（Notion / Slack の意思決定抽出）＋ Slack ハンドオフ配信＋埋め込みコスト・パイプラインです。dev-dashboard-v2 `server/lib/institutional-memory/*` から移植しました。

kit-decision-memory 本体は `SourceExtractor` 契約だけを残しています。本パッケージの出力形は**その契約に一致**するため、import なしでペアリングできます（README 参照）。

## 対になるパッケージ

- `@torihanaku/kit-decision-memory` — `SourceExtractor.fetchCandidates()` は `{ sourceRef, rawText, decidedAt? }[]`（= 本パッケージの `SourceCandidate`）を返す契約です。本パッケージの `slackCandidate()` 等はこの形を生成します。相互 import はありません。

## 差し込み式の外部 I/O

すべての外部依存を注入します。SDK・シークレットへの直接依存はありません。

- **LLM**: `MemoryLlmClient`（`generateJson(system, user, fallback, opts)`）
- **Notion 候補ストア**: `NotionCandidateStore.upsertCandidates(rows)`
- **Slack 抽出ストア**: `SlackExtractStore.insertExtractedDecision(row)` / **consent**: `ConsentCheck`
- **Slack プロキシ**: `SlackProxy.request(method, path, body)`（Nango プロキシ相当）
- **埋め込み**: `Embedder(text, provider?)` / **コスト台帳**: `EmbeddingCostLedger`

## 収録モジュール

### Notion 意思決定候補 取り込み（`notion-extractor.ts`）
Notion ページ群から「始める/やめる/変える/軸を変える/アーカイブ」の意思決定候補を抽出し、レビュー待ち（pending）として保存します。`parseNotionPages` はリッチペイロード（properties title / blocks rich_text）をプレーンテキスト化します。

```ts
const res = await ingestNotionDecisionCandidates(
  { tenantId, pages: parseNotionPages(payload) },
  { llm, store: notionCandidateStore },
);
```

### Slack 意思決定抽出（`slack-extractor.ts`）
Slack メッセージ 1 件から意思決定を抽出し pending 保存します。外部データ分析の consent を確認します。

### Slack ハンドオフ配信（`handoff-slack.ts`）
ハンドオフ Markdown を Slack DM で best-effort 配信。ユーザー ID 直指定 or メール（lookupByEmail → conversations.open）に対応。失敗は `{ ok:false, note }` で握りつぶし、決して throw しません。

### 埋め込みパイプライン（`embedding-pipeline.ts`）
トークン見積り（4 文字 ≈ 1 トークン）＋テナント月次コスト追跡＋ソフト上限（¥5,000/月）。上限超過は `EmbeddingBudgetExceededError`。台帳への課金失敗は握りつぶし、埋め込み結果は使えるまま返します。

## テスト

- `notion-extractor.test.ts` — 候補抽出 / パース / db_error / 低信頼度除外
- `slack-extractor.test.ts` — consent / found=false / 既定信頼度 / candidate 生成
- `handoff-slack.test.ts` — ユーザー ID / メール解決 / 失敗 note / 非 throw / 切り詰め
- `embedding-pipeline.test.ts` — トークン/コスト見積り / 予算超過 / 課金失敗の握りつぶし
