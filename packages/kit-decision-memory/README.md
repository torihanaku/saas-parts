# @torihanaku/kit-decision-memory

ナレッジ / 意思決定メモリキット — 「なぜそうしたのか」を組織の記憶として蓄積・検索するための自己完結パッケージ。

## 機能説明

| モジュール | 機能 |
|---|---|
| `memory-service.ts` | 組織記憶（decision_log / failure_recipe / success_recipe）の蓄積とセマンティック検索 + LLM 要約 |
| `decision-service.ts` | 意思決定レコードのライフサイクル（CRUD）＋ 抽出候補のステージング → confirm / reject リンク |
| `why-search.ts` | 「なぜこうしたのか?」検索。過去の意思決定ログを根拠に引用付きで回答 |
| `extractor.ts` | 自由文（チャット / 会議書き起こし）からの LLM 意思決定抽出 + 二層 dedup（sourceRef 完全一致 / 埋め込み類似） |
| `onboarding.ts` | 新任者向けトピック解説（直近の意思決定 20 件 + 組織コンテキストから一発要約） |
| `onboarding-persona.ts` | オンボーディング AI ペルソナ（全 mem_type 統合・会話履歴対応・引用必須・フォローアップ質問付き） |
| `archive.ts` | 失敗博物館 / 成功レシピのアーカイブ閲覧（インラインタグ `[channel:meta]` / `#hashtag` のファセット抽出） |
| `handoff.ts` | 担当者交代向け「案件の全経緯」引き継ぎ Markdown 生成（mem_type 別バケット + 連絡先抽出 + LLM ナラティブ） |
| `bm25.ts` | 内蔵 BM25 キーワード検索（EmbeddingSearcher 未注入時のフォールバック。日本語は 2-gram） |
| `stores.ts` | ストレージ注入インターフェース + インメモリ実装（テスト・プロトタイプ用） |

## コア API

```ts
import {
  InstitutionalMemoryService,
  DecisionLogService,
  WhySearchService,
  DecisionExtractorService,
  OnboardingService,
  OnboardingPersonaService,
  MemoryArchiveService,
  HandoffService,
  InMemoryMemoryStore,
  InMemoryDecisionStore,
  InMemoryPendingDecisionStore,
} from "@torihanaku/kit-decision-memory";

// ── ナレッジ蓄積 + 検索
const memory = new InstitutionalMemoryService({
  store: new InMemoryMemoryStore(),
  embedder,        // 任意: テキスト → ベクトル
  searcher,        // 任意: セマンティック検索（未注入なら内蔵 BM25）
  generateText,    // 任意: LLM 要約
});
await memory.logMemory(tenantId, { memType: "failure_recipe", subject, content });
const { results, summary } = await memory.searchMemory(tenantId, "値引きの失敗", { topK: 5 });
const failures = await memory.getMemoryByType(tenantId, "failure_recipe", 50);

// ── 意思決定ログ（CRUD + 抽出候補フロー）
const decisions = new DecisionLogService({ store, pendingStore, embedder, onDecisionRecorded });
const rec = await decisions.create(tenantId, { decisionType: "stop", subject, reason });
await decisions.update(tenantId, rec.id, { reason: "..." });   // コア項目変更時のみ埋め込み再計算
const pending = await decisions.stagePending(tenantId, { sourceRef, rawText, extractedType: "stop" });
await decisions.confirmPending(tenantId, pending.id, { overrides: { subject: "..." } });

// ── why 検索
const why = new WhySearchService({ store, searcher, generateText });
const { answer, citations, hasAnswer } = await why.search({ tenantId, question: "なぜ広告を止めた?" });

// ── LLM 抽出（チャット / 議事録 → 意思決定レコード）
const extractor = new DecisionExtractorService({ store, generateJson, embedder, dupSearcher });
const { inserted, decision, reason } = await extractor.extract({ tenantId, source: "slack", sourceRef, rawText });

// ── オンボーディング
const onboarding = new OnboardingService({ store, generateText, channelKeywords: ["Facebook", "メール"] });
const persona = new OnboardingPersonaService({ memory, generateText });
const answer2 = await persona.answer({ tenantId, question: "会社の方針を教えて", conversationHistory });

// ── アーカイブ / 引き継ぎ
const archive = new MemoryArchiveService({ store: memoryStore });
const { items, facets } = await archive.listArchive(tenantId, { type: "failure", channel: "meta" });
const handoff = new HandoffService({ store: memoryStore, generateText });
const { markdown } = await handoff.buildHandoffSummary({ tenantId, caseId, fromUser: "田中" });
```

## 注入ポイント

すべて `types.ts` / `extractor.ts` で定義。**このパッケージは何も import しない**（`process.env` / Supabase / 他 `@torihanaku/*` への依存ゼロ）。

| インターフェース | 形 | 充足例 |
|---|---|---|
| `Embedder` | `embed(text) => Promise<number[]>` | `@torihanaku/embeddings` のプロバイダがそのまま満たす（import はしない） |
| `EmbeddingSearcher` | `search(query, { tenantId, topK, threshold, memType? }) => Promise<{id, similarity}[]>` | pgvector RPC（`match_institutional_memory` / `match_decisions_by_embedding`）のラッパー。未注入時は内蔵 BM25 にフォールバック |
| `TextGenerator` | `(system, user, { maxTokens? }) => Promise<string>` | Claude 等の LLM 呼び出し。未注入なら要約 / 回答生成をスキップ（結果は常に返る） |
| `JsonGenerator` | `(system, user, { maxTokens? }) => Promise<unknown>` | LLM の JSON モード（抽出用）。パース済みオブジェクトを返す |
| `MemoryStore` / `DecisionStore` / `PendingDecisionStore` | `stores.ts` 参照 | 本番は Postgres 実装、テストは `InMemory*` |
| `SourceExtractor` | `{ source, fetchCandidates(tenantId) }` | Slack / Notion 等の取り込み口（本家の slack-extractor / notion-extractor 相当）。キットは実装を持たない |
| `onDecisionRecorded` | `(decision) => void \| Promise<void>` | 登録後フック（本家: バイアス検知キュー投入）。失敗しても本処理に影響しない |
| `ServiceContext` | `{ now?, generateId? }` | テスト決定性のための時刻 / id 注入 |
| `KitLogger` | `{ info, error }` | デフォルト no-op |

## SQL スキーマ（出典プロジェクトの参考実装）

キット自体は SQL に依存しないが、本番ストア実装の参考として出典スキーマを記す。

### `dd_decision_log`（意思決定ログ — `DecisionStore` 相当）

```sql
-- 出典: supabase/migrations/202604200009_g9_s1_why_foundation.sql
CREATE TABLE dd_decision_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('start','stop','change','pivot','archive')),
  subject TEXT NOT NULL,
  context TEXT NOT NULL,
  reason TEXT NOT NULL,            -- なぜそうしたか（Why）
  alternatives_considered TEXT,
  decided_by UUID REFERENCES auth.users(id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','slack','email','meeting')),
  source_ref TEXT,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- インデックス: tenant / (tenant, decision_type) / (tenant, decided_at DESC)
--             / hnsw (embedding vector_cosine_ops)
-- RLS: tenant_id = current_tenant_id() の二重ポリシー（authenticated + service_role）
```

### `dd_slack_extracted_decisions`（抽出候補ステージング — `PendingDecisionStore` 相当）

```sql
-- 出典: 同上。キットでは slack_permalink → sourceRef / slack_channel → channel に汎用化
CREATE TABLE dd_slack_extracted_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slack_permalink TEXT NOT NULL,
  slack_channel TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  extracted_subject TEXT,
  extracted_reason TEXT,
  extracted_type TEXT,
  confidence NUMERIC(3,2),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','merged')),
  confirmed_decision_id UUID REFERENCES dd_decision_log(id),
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id)
);
```

### `dd_institutional_memory`（組織記憶 — `MemoryStore` 相当）

```sql
-- 出典: supabase/migrations/202605030003_dd_institutional_memory.sql
CREATE TABLE dd_institutional_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  mem_type TEXT NOT NULL CHECK (mem_type IN ('decision_log','failure_recipe','success_recipe')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,           -- handoff では caseId としても使う
  decided_by TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- ivfflat (embedding vector_cosine_ops, lists=100)
```

### ベクトル検索 RPC（`EmbeddingSearcher` の充足例）

```sql
-- 出典: 202604200010_g9_s1_why_match_rpc.sql / 202605030003 内
match_decisions_by_embedding(query_embedding, match_tenant_id, match_threshold = 0.6, match_count = 5)
match_institutional_memory(query_embedding, match_tenant_id, match_threshold = 0.6, match_count = 5, filter_mem_type = NULL)
-- いずれも 1 - (embedding <=> query) を similarity として threshold 超のみ返す
```

## 落としたもの（と理由）

| 出典ファイル | 判断 |
|---|---|
| `slack-extractor.ts` / `notion-extractor.ts` | **落とした**。Slack API / Notion API 直結のソース固有コード。形だけ `SourceExtractor` インターフェースとして残した（`extractor.ts`） |
| `handoff-slack.ts` | **落とした**。Slack Webhook 配信。`buildHandoffSummary` が返す Markdown を任意のチャネルへ送ればよい |
| `embedding-pipeline.ts` | **落とした**。テナント別 ¥5,000/月の埋め込みコスト上限管理（`dd_embedding_costs` 前提）。キットでは `Embedder` 注入に集約し、コスト管理は呼び出し側の責務とした |
| `decision-log.ts`（MEM-2 ファサード） | **統合**。`recordDecision` / `listDecisions` は `memory-service.ts` / `decision-service.ts` と機能重複のため統合。90 日ソフトデリートの `runDecisionRetentionSweep` は `archived_at` 列前提の運用 cron のため未収録（必要なら store 実装側で `UPDATE ... SET archived_at` を cron 化） |
| ルート層（Express / fetch `Response`、`getTenantId` / feature flag / bias 検知キュー） | **落とした**。HTTP・認証・テナント解決はホスト側の責務。bias 検知連携は `onDecisionRecorded` フックに汎用化 |
| マーケ固有の語彙 | **パラメータ化**。チャネル辞書（Facebook/Instagram/...）→ `channelKeywords` 注入、「マーケティング組織」プロンプト → `systemPrompt` / `personaPrompt` 差し替え可、製品名（Folia）→ 汎用化 |

### BM25 についての注記

出典の `server/lib/bm25.ts` はキャラクター×スキルマッチング専用（TF=1 前提・proficiency 重み付き）で、本家の why 検索は pgvector を使い BM25 に依存していない。本キットの `bm25.ts` は「`EmbeddingSearcher` 未注入でも動く」ためのフォールバックとして、定数（k1=1.5, b=0.75）と方針のみ引き継いだ汎用文書版の**私製プライベートコピー**。汎用 BM25 は `@torihanaku/bm25` パッケージにも存在するが、キットの自己完結方針（`@torihanaku/*` 非依存）のため意図的に重複させている。

## 出典

`dev-dashboard-v2`（読み取りのみ・非公開）:

- `server/lib/institutional-memory.ts`（MEM-1 コア: logMemory / searchMemory / getMemoryByType）
- `server/lib/institutional-memory/why-search-service.ts`（why 検索）
- `server/lib/institutional-memory/decision-extractor.ts`（MEM-3 LLM 抽出 + dedup）
- `server/lib/institutional-memory/onboarding-service.ts` + `onboarding-persona.ts`（MEM-5 オンボーディング）
- `server/lib/institutional-memory/archive-helpers.ts` + `server/routes/memory-archive.ts`（MEM-6 失敗博物館 / 成功レシピ）
- `server/lib/institutional-memory/handoff-summarizer.ts` + `handoff-markdown.ts`（MEM-7 引き継ぎ）
- `server/routes/decisions/{index,crud,why,onboarding}.ts`（意思決定ライフサイクル + 抽出候補 confirm/reject）
- `supabase/migrations/202604200009` / `202604200010` / `202605030003`（スキーマ + ベクトル検索 RPC）
