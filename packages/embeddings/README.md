# @torihanaku/embeddings

マルチプロバイダの埋め込み(Embedding)抽象化 — プロバイダレジストリ / OpenAI プロバイダ / テナント別月次コストガードレール（注入ストア方式）。

## 主要API

```ts
import {
  registerProvider, setPrimaryProvider, embedText, embedBatch,
  createOpenAIProvider, setEmbedGuard,
  createCostPipeline, type EmbeddingCostStore,
} from "@torihanaku/embeddings";

// 1) 起動時にプロバイダを登録（API キーは呼び出し側が注入）
registerProvider(createOpenAIProvider(process.env.OPENAI_API_KEY!)); // slug: "openai-3-small"
setPrimaryProvider("openai-3-small"); // 省略時デフォルトも "openai-3-small"（元 EMBEDDING_PRIMARY_MODEL）

// 2) 呼び出し側はプロバイダを知らずに埋め込み
const vec  = await embedText("こんにちは");            // number[]（1536次元）
const vecs = await embedBatch(["a", "b"], "openai-3-small");

// 3) 同意ガード（任意・元 consent-guard の注入版）。userId+tenantId があるときのみ呼ばれる
setEmbedGuard(async ({ userId, tenantId, purpose }) => {
  await requireConsent(userId, tenantId, purpose); // throw すると埋め込みをブロック
});

// 4) 月次コストパイプライン（ストアを注入。デフォルト上限 ¥5,000/テナント/月）
const store: EmbeddingCostStore = {
  getMonthlyCost: async (tenantId, yearMonth) => db.selectCostRow(tenantId, yearMonth), // 行 or null
  incrementCost: async (entry) => db.atomicIncrement(entry),                            // 更新後の行
};
const pipeline = createCostPipeline({ store /*, monthlyLimitJpy, embed, logInfo, logError */ });
const { embedding, costJpy, monthlyTotalJpy } =
  await pipeline.embedMemoryText("tenant-1", "決定理由のテキスト");
// 予算超過は EmbeddingBudgetExceededError を throw（埋め込みAPIを呼ぶ前に判定）
```

新しいプロバイダの追加: `EmbeddingProvider`（`slug` / `dimension` / `maxInputTokens` / `embed` / `embedBatch`）を実装して `registerProvider()` するだけ。

## 依存

なし（peerDependencies なし。`fetch` があるランタイムで動作）。

## 設定ポイント（何を注入するか）

- OpenAI API キー: `createOpenAIProvider(apiKey)` の必須引数（元は `env.OPENAI_API_KEY` フォールバック）
- 主プロバイダ: `setPrimaryProvider(slug)`（元は env `EMBEDDING_PRIMARY_MODEL`）
- 同意ガード: `setEmbedGuard(guard)`（元は `feature-flags` + `consent-guard` への直結。未設定ならノーチェック＝フラグOFF相当）
- コスト台帳: `EmbeddingCostStore` インターフェース（元は Supabase `dd_embedding_costs` テーブル + `increment_embedding_cost` RPC）
- ロガー: `logInfo` / `logError` コールバック（デフォルト: info は無音、error は console.error）

## スコープ外（意図的に移植していないもの）

- **類似検索（similarity search）**: 元実装は Supabase の pgvector RPC（例: `match_decisions_by_embedding` — threshold/top-K/テナントフィルタを SQL 側で実施）に密結合しており、汎用化するとただの「RPC 呼び出し」になるため移植対象外。本パッケージで生成したベクトルを各プロダクトの pgvector/Supabase 検索に渡す想定。
- Gemini 等の追加プロバイダ: 元リポにも OpenAI 以外の実装は存在しない（レジストリ設計上、後付け可能）。

## 想定ランタイム

any（Node 18+ / Bun / Deno — `fetch` 標準搭載環境）

## 出典

- `実運用SaaS/server/lib/embedding-client.ts`（レジストリ）
- `実運用SaaS/server/lib/embedding-providers/types.ts` / `openai.ts`
- `実運用SaaS/server/lib/institutional-memory/embedding-pipeline.ts`（コストパイプライン）
- テスト: `tests/embedding-client.test.ts` / `tests/embedding-providers/openai.test.ts` / `server/__tests__/embedding-pipeline.test.ts`
