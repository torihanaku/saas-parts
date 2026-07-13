# @torihanaku/kit-research-navigator

調査アシスタント — 外部シグナル（ニュース / 検索 API / Hacker News 等）を取り込み、LLM で重要度判定（verdict）→ トレンドクラスタ検出 → 仮説カード生成 → アクション実行（issue 起票 / SNS ドラフト）→ 学び（learning）記録、までを一気通貫で回すパイプライン。

「シグナル → クラスタ → 仮説カード → verdict」のパイプライン機構そのものがこのキットのコア価値。LLM・埋め込み・シグナルソース・課題トラッカー・永続化はすべて注入制で、特定ベンダーに依存しない。

## 機能説明

```
[SignalSource 群]                     (HN / Exa / Perplexity / 自作ソース)
      │ fetchAllSignals()             ソース単位の失敗は握って続行
      ▼
[ingestSignals]                       重複 URL はスキップ (UNIQUE user_id+url 相当)
      │
      ├─ judgeVerdict()               埋め込み→類似シグナル関連付け→LLM 3値判定
      │     big_deal / worth_watching / meh (importance 0-100)
      │     LLM 不在・失敗時は meh フォールバック
      │
      ├─ ContextStore.insert()        判定結果を context として保存
      └─ big_deal → CardStore.insert  仮説カードを自動生成 (draft)

[reevaluateSignals]  (週次ジョブ)
      ├─ 窓内の worth_watching が閾値(3)以上 → トレンドとみなす
      │     代表 = importance 降順 → signalId 昇順 (決定的タイブレーク)
      │     LLM で仮説カード生成 → クラスタ全体を big_deal に昇格
      └─ 30日より古い meh を削除 (ノイズ掃除)

[カードのライフサイクル]
      draft → testing → validated / invalidated (遷移表で強制)
      ステータス変更のたびに learning を自動記録
      アクション: issue 起票 / SNS ドラフト生成 / 却下 / 保留

[buildWeeklyBrief]   直近7日を verdict 別に集計、上位5件 + source 内訳
[generateStackRecommendation]  RAG: 埋め込み検索→LLM推薦→幻覚ガード→URL到達性フィルタ
[suggestRelatedIssues]         カード×既存 issue の類似度を LLM 採点して突合
```

## コア API

```ts
import {
  // パイプライン
  ingestSignals,          // シグナル取り込み → verdict → context → 自動カード
  reevaluateSignals,      // 週次: トレンド昇格 + 古い meh の削除
  judgeVerdict,           // 単一シグナルの重要度判定
  buildWeeklyBrief,       // 週次ブリーフ集計
  fetchSignalDetail,      // シグナル + context + 関連シグナル

  // 仮説カード
  draftHypothesis,        // コンテキスト文 → 4項目仮説ドラフト (zod 検証 + 1 リトライ)
  generateManualCard,     // 手動入力 → UseCaseCard (zod 検証 + 1 リトライ)
  buildStackAdvisorCard,  // Stack Advisor 推薦 → カード (LLM 不要・決定的)
  createManualCard, createStackCard, listCards, getCardDetail,
  updateCardStatus,       // 遷移表 VALID_TRANSITIONS で強制 + learning 自動記録
  addLearning, executeCardAction,

  // アドバイザ・突合
  generateStackRecommendation,  // RAG スタック推薦
  suggestRelatedIssues, linkIssueToCard,

  // ソース実装例
  createHackerNewsSource, createExaSearchSource, createPerplexityNewsSource,

  // インメモリストア (テスト/プロトタイプ用)
  MemorySignalStore, MemoryContextStore, MemoryCardStore,
  MemoryActionStore, MemoryLearningStore, MemoryStackStore,
} from "@torihanaku/kit-research-navigator";

// 最小構成の例
const deps = {
  signalStore: new MemorySignalStore(),
  contextStore: new MemoryContextStore(),
  cardStore: new MemoryCardStore(),
  llm: myLlmClient, // LlmClient 実装を注入
};
const sources = [createHackerNewsSource({ limit: 10 })];
const result = await ingestSignals("user-1", sources, deps);
// => { fetched, inserted, skippedDuplicates, cardsCreated, createdCards }

const weekly = await reevaluateSignals("user-1", { ...deps, llm: myLlmClient });
// => { promoted, purged, promotedCard }
```

## 注入ポイント（ports.ts）

| Port | 役割 | 元実装 |
|------|------|--------|
| `LlmClient` | `generateJson<T>` / `generateText`。失敗は null 返し (throw しない) | claude-api-client |
| `Embedder` | `(text) => number[]` | embedding-client (OpenAI/Vertex 等) |
| `UrlChecker` | 到達可能な URL のみ返す。省略時は素通し | url-validator.filterReachableUrls |
| `SignalSource` | `{ name, fetch(ctx) }`。HN/Exa/Perplexity の実装例を同梱 (API キー・fetch 注入) | ingestion/* |
| `IssueProvider` | `listOpenIssues` / `createIssue`。GitHub API 呼び出しを一般化 | github-subissue-matcher + action-executor |
| `SignalStore` ほか 5 ストア | 永続化の抽象。インメモリ実装同梱、本番は下記 SQL で実装 | supabase REST/RPC |

すべての時刻は `now?: () => Date` で注入可能（テストの決定性確保）。API キーは各ソースのオプションとして渡す（環境変数の直接参照はしない）。

## SQL スキーマ（参考: 元実装の Supabase migration）

ストアを RDB で実装する場合の参考スキーマ。pgvector を利用。

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- シグナル (取り込んだ外部情報)
CREATE TABLE nav_signals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  source      text NOT NULL,
  url         text NOT NULL,
  title       text NOT NULL,
  body        text,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz,
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)                        -- 重複取り込み防止 (SignalStore.insert の null 返し)
);
CREATE INDEX ON nav_signals(user_id, fetched_at DESC);
CREATE INDEX ON nav_signals USING hnsw (embedding vector_cosine_ops);  -- findRelated

-- verdict 判定結果
CREATE TABLE nav_context (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  signal_id           uuid NOT NULL REFERENCES nav_signals(id) ON DELETE CASCADE,
  related_signal_ids  uuid[] NOT NULL DEFAULT '{}',
  importance_score    int NOT NULL CHECK (importance_score BETWEEN 0 AND 100),
  verdict             text NOT NULL CHECK (verdict IN ('big_deal','worth_watching','meh')),
  rationale           text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, signal_id)
);

-- 仮説カード
CREATE TABLE nav_cards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  trigger_source        text NOT NULL CHECK (trigger_source IN ('signal','stack','manual')),
  trigger_signal_id     uuid REFERENCES nav_signals(id) ON DELETE SET NULL,
  trigger_stack_id      uuid,
  title                 text NOT NULL,
  summary               text NOT NULL,
  card_data             jsonb NOT NULL,       -- UseCaseCard
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','testing','validated','invalidated','rejected')),
  hypothesis            text,
  assumption            text,
  test_plan             text,
  invalidation_criteria text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- カードのアクション履歴
CREATE TABLE nav_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  card_id      uuid NOT NULL REFERENCES nav_cards(id) ON DELETE CASCADE,
  action_type  text NOT NULL CHECK (action_type IN ('issue','social_draft','reject','saved_for_later')),
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 学び
CREATE TABLE nav_card_learnings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     uuid NOT NULL REFERENCES nav_cards(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  learning    text NOT NULL,
  outcome     text NOT NULL DEFAULT 'neutral' CHECK (outcome IN ('validated','invalidated','neutral')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Stack Advisor 用カタログ
CREATE TABLE nav_stacks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  category     text NOT NULL,
  name         text NOT NULL,
  vendor       text NOT NULL,
  description  text NOT NULL,
  pricing_url  text NOT NULL,
  docs_url     text NOT NULL,
  pros         text[] NOT NULL DEFAULT '{}',
  cons         text[] NOT NULL DEFAULT '{}',
  typical_cost_usd_per_month jsonb,
  embedding    vector(1536),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON nav_stacks USING hnsw (embedding vector_cosine_ops);  -- matchByEmbedding

-- 失敗パターン (warning)
CREATE TABLE nav_failure_patterns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stack_id    uuid REFERENCES nav_stacks(id) ON DELETE SET NULL,
  title       text NOT NULL,
  summary     text NOT NULL,
  root_cause  text,
  mitigation  text,
  source_url  text,
  severity    text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

元実装ではすべてのテーブルに RLS（`auth.uid() = user_id` ＋ service_role バイパス）を張っていた。マルチテナントで使う場合は同様の行レベル分離を推奨。

## 落としたもの

- **HTTP ルーティング / 認証**（`server/routes/navigator/index.ts` の `routeNavigator`、`checkAuth` / `getUserIdUuid` / `getTenantId` / feature flag ガード）— ロジックのみ移植し、HTTP 配線・認証はアプリ責務。ルートハンドラの Response 生成は discriminated union（`ServiceResult`）に置換。
- **Supabase 依存**（`supabaseGet` / `supabaseInsertReturning` / PostgREST クエリ組み立て / `match_nav_signals_by_embedding` RPC）— Store インターフェイス＋インメモリ実装に置換。SQL スキーマは上記に記載。
- **Nango プロキシ経由の Exa / Perplexity 呼び出し**（`proxyRequest` + `EXA_PROXY_ENABLED` 等の env フラグ）— API キー・fetch 注入の直接呼び出しに一般化。有効/無効の切り替えは「ソース配列に入れるかどうか」で表現。
- **GitHub API 直接呼び出し**（`GH_TOKEN` / `GITHUB_REPO` env 参照、issue 起票・open issue 取得）— `IssueProvider` ポートに一般化。契約: `listOpenIssues()` は PR を除いた open issue を返す、`createIssue()` は成功時 `{ url }`・失敗時 null。
- **`dashboard_team_members` からの全ユーザー走査**（ジョブが admin 全員をループする部分）— キットは「1 ユーザー分」の `ingestSignals` / `reevaluateSignals` を提供。ユーザー列挙とループはアプリ側スケジューラの責務。
- **hypothesis-f2 ルートの DB 直書き**（`handleDraftHypothesisFromWarning` の tenant_id 付き insert。`impact` / `rejection_criteria` / `tags` 列は本体スキーマに存在しないドリフトがあった）— プロンプト組み立て `buildWarningToHypothesisPrompt` のみ移植。生成後の保存は `CardStore` で行う。
- **フロント向け薄いハンドラ**（`handleGetSignals` の PostgREST inner join クエリ、`handleFetchSignals` の fire-and-forget 起動）— ストア呼び出しで代替可能なため省略。
- **X (Twitter) 固有表現** — `generateXDraft` → `generateSocialDraft`、action_type `x_draft` → `social_draft`、`github_issue` → `issue` に一般化。
- **Folia 固有の 26 スタックカテゴリ union** — `category: string` に一般化。
- **元実装のバグは非移植**: nav-signals-ingest が context の importance (0-100) をカード meta.importanceScore (0-1 スキーマ) にそのまま入れていた点は、正規化 (`/100`) して修正。verdict-engine の `generateJson` 引数順ずれも `LlmClient` ポート化で解消。

## テスト

```bash
npx tsc --noEmit -p packages/kit-research-navigator/tsconfig.json
npx vitest run packages/kit-research-navigator   # 11 files / 68 tests
```

パイプラインはモック LLM（`stubLlm` / `queueLlm`）と決定的な埋め込みフィクスチャで検証。クラスタ昇格の代表選出は importance 降順 → signalId 昇順の決定的タイブレークで、入力順に依存しない。

## 出典

- `実運用SaaS/server/lib/navigator/` — stack-advisor / nav-stacks-db / brief-service / hypothesis-drafter / verdict-engine / card-generator / signal-detail / action-executor / github-subissue-matcher / ingestion/{index,exa-proxy,hackernews,perplexity}
- `実運用SaaS/server/routes/navigator/` — cards / hypothesis / hypothesis-f2 / learnings / subissues / advisor（ロジックのみ、HTTP 配線は除く）
- `実運用SaaS/server/jobs/` — nav-signals-ingest / nav-weekly-reevaluate
- `実運用SaaS/shared/` — types/navigator.ts / types/navigator-signals.ts / schemas/navigator.ts
- `実運用SaaS/supabase/migrations/` — 202604180004 / 202604260002 / 20260423_001（SQL スキーマの出典）
