# @torihanaku/channel-summarizer

Slack・メール・会議録画 transcript など複数チャネルの生コンテンツを 1 回の LLM 呼び出しに統合し、「200 字以内の日本語サマリ＋構造化アクションアイテム（担当者・期日つき）」を抽出するサマライザ。LLM 呼び出しは注入式コールバック、チャネル種別は汎用文字列（既定ラベル・文字数上限つき、拡張可）です。

**失敗しても throw しません。** LLM エラー・JSON parse 失敗・API キー未解決のいずれでも空の `UnifiedSummary` を返し、`sources` に入力がそのまま残るため、入力データは失われません。

## 用途

- 「同じ案件の Slack スレッド＋メール＋会議メモをまとめて 1 つの要約にする」受信トレイ統合・デイリーダイジェスト機能
- BYOK（テナントごとの API キー）を前提としたマルチテナント SaaS の要約パイプライン
- チャネル種別を追加（例: `crm`, `chat`）してラベルと文字数上限だけ設定すれば同じパイプラインを共有

## API 例

```ts
import { createChannelSummarizer } from "@torihanaku/channel-summarizer";
import { generateJson } from "@torihanaku/claude-api"; // 互換シグネチャの LLM 呼び出し

const summarizer = createChannelSummarizer({
  // LLM 呼び出し (必須)。失敗時は fallback を返す実装が望ましい
  generateJson: (apiKey, system, userPrompt, fallback, options) =>
    generateJson(apiKey, system, userPrompt, fallback, options),
  // BYOK: tenant secret → 全体設定 の解決は呼び出し側の責務
  resolveApiKey: async (tenantId) =>
    (await tenantSecrets.get(tenantId, "ANTHROPIC_API_KEY")) ?? config.ANTHROPIC_API_KEY ?? null,
});

const result = await summarizer.summarizeMultiChannel(
  [
    { type: "slack", content: "@taro 来週リリース予定。レビュー Bob 担当。" },
    { type: "email", content: "Subject: Q3 PMF\n来週金曜までに ROI シート提出。" },
    { type: "transcript", content: "Bob: 来週デプロイ\nAlice: 了解" },
  ],
  "tenant-1",
);

// result.summary     → "来週金曜リリース。Bob がレビュー…" (200 字以内に clamp)
// result.actionItems → [{ text: "ROI シート提出", owner: "Taro", due: "2026-05-09" }, ...]
// result.sources     → 入力がそのまま返る (失敗時も保持)
```

### チャネル種別の拡張

```ts
const summarizer = createChannelSummarizer({
  generateJson: myLlm,
  channelLabels: { crm: "CRM (商談メモ)" },   // 既定 (slack/email/transcript) にマージ
  maxContentChars: { crm: 3000 },             // チャネルごとのプロンプト文字数上限
});
```

## 設定

`createChannelSummarizer(config)`:

| オプション | 既定値 | 説明 |
|---|---|---|
| `generateJson` | （必須） | LLM への JSON 生成コールバック。`(apiKey, system, userPrompt, fallback, { maxTokens }) => Promise<T>` |
| `resolveApiKey` | なし（ゲートスキップ） | tenantId → API キー。`null`/空なら LLM を呼ばず空結果。throw でも空結果。省略時は空文字キーで `generateJson` を呼ぶ |
| `channelLabels` | slack / email / transcript | プロンプト内のソースラベル。未知種別は type 文字列をそのまま表示 |
| `maxContentChars` | slack 4000 / email 4000 / transcript 6000（他 4000） | チャネルごとの入力文字数上限（超過分は `…(以下省略)`） |
| `systemPrompt` | 原典の日本語プロンプト | JSON 出力形式を指示する system prompt |
| `maxTokens` | `1200` | LLM の max tokens |
| `logger` | `console.error` | キー解決・LLM 失敗時のログ |

補助エクスポート: `normaliseActionItems()`（LLM 出力を厳密な `ActionItem[]` に矯正）、`clampSummary()`（200 字 clamp）、`DEFAULT_SYSTEM_PROMPT` / `DEFAULT_CHANNEL_LABELS` / `DEFAULT_MAX_CONTENT_CHARS`。

## Runtime

- Node.js 18+ / Bun / edge / ブラウザ（I/O は全て注入、環境依存 API なし）
- 外部依存なし・`process.env` 参照なし
- peerDependencies なし

## 出典

`dev-dashboard-v2` の `server/lib/multi-channel-summarizer.ts`（154 行, #1031 MVP / #1156 transcript 対応）。移植差分: `claude-api-client.generateJson` → 注入コールバック、BYOK（tenant secret → env fallback）→ 注入 `resolveApiKey`、`ChannelType` union → 汎用文字列＋設定拡張。プロンプト・正規化・clamp・空結果フォールバックのロジックは原典を維持。
