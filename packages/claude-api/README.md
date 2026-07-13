# @torihanaku/claude-api

Anthropic Messages API の raw-fetch ラッパー（プレーンチャット / Tool Use ループ / JSON構造化出力 / 使用量トラッキングフック / prompt caching ヘッダー）。`@anthropic-ai/sdk` 非依存。

## 主要API

```ts
import { createClaudeClient, extractText, parseJsonResponse } from "@torihanaku/claude-api";

const client = createClaudeClient({
  apiKey: "sk-ant-...",                 // 必須（ライブラリ内で env は一切読まない）
  // apiUrl: "https://api.anthropic.com/v1/messages",  // 省略時デフォルト
  // model: "claude-sonnet-4-6",                        // 省略時デフォルト
  onUsage: (u) => costTracker.add(u),   // 呼び出しごとの input/output トークン（コスト按分用）
});

// 1) 低レベル呼び出し
const res = await client.callClaude("You are a bot", [{ role: "user", content: "Hi" }], {
  maxTokens: 2000,   // default 4000
  timeout: 30_000,   // default 60_000（AbortController によるハードタイムアウト）
  tools: [...],      // Tool Use 定義（省略でプレーンチャット）
});
const text = extractText(res);                    // 最初の text ブロック（error 応答は throw）
const data = parseJsonResponse(res, fallback);    // JSON パース（失敗時 fallback）

// 2) 便利ラッパー（エラー時は fallback / "" を返す）
const json = await client.generateJson("Return JSON.", "list 3 colors", { items: [] });
const txt  = await client.generateText("You are concise.", "hello");

// 3) Tool Use ループ（stop_reason が tool_use でなくなるまで、最大 maxIterations 回）
const result = await client.runToolLoop(system, messages, tools,
  async (name, input) => executeTool(name, input),  // string を返す executor
  { maxIterations: 5 });
// result: { text, toolsUsed, iterations }
```

## 依存

なし（peerDependencies なし。`fetch` / `AbortController` があるランタイムで動作）。

## 設定ポイント（何を注入するか）

- `apiKey`（必須）: 元コードの `env.ANTHROPIC_API_KEY` 相当。呼び出し側が Secret Manager 等から取得して渡す
- `apiUrl` / `model`: 元コードの `config.ANTHROPIC_API_URL` / `ANTHROPIC_MODEL`（デフォルト値は元コードと同一）
- `onUsage` / `setUsageHook()`: 元コードの `setClaudeUsageHook`（module-global）を per-client 化。コスト按分の集計側を注入する
- fetch タイムアウトヘルパー（元 `server/lib/helpers.ts` の `fetchWithTimeout`）は private コピーとして内包

## 想定ランタイム

any（Node 18+ / Bun / Deno / edge — `fetch` 標準搭載環境）

## 出典

- `実運用SaaS/server/lib/claude-api-client.ts`
- `実運用SaaS/server/lib/helpers.ts`（fetchWithTimeout のみ内包）
- テスト: `実運用SaaS/tests/claude-api-client.test.ts`
