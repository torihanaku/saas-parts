# @torihanaku/kit-chief-of-staff

AI 経営アシスタント（Chief of Staff）キット — チームの仕事の流れ（会議 / メール / Slack）を取り込み、digest フィード → ブリーフィング → Q&A → タスク抽出・外部同期まで行う自己完結パッケージ。

## 機能説明

| モジュール | 機能 |
|---|---|
| `slack-ingest.ts` | Slack チャンネルの新着を LLM で関連度判定（閾値 0.4）して digest 化。Slack Web API 参考実装（fetch 注入）同梱 |
| `email-ingest.ts` | フィルタルール（from / subject / label）に合致するメールを LLM 要約して digest 化。Gmail/Outlook 検索クエリ構築・本文抽出ヘルパー付き |
| `meeting-ingest.ts` | 会議音声 → 書き起こし（Transcriber 注入）→ 400 字要約 + action item 構造化抽出 → `pending_review` タスク化 |
| `briefing-generator.ts` | digest + 承認待ちタスク + 追加コンテキスト（プラン / 分析 insight）を集約して日次 / 週次 / 上司向けレポートを生成。LLM 不在でも決定的フォールバックを必ず保存 |
| `qa-engine.ts` | 「Ask the Chief of Staff」。digest（30 日 / relevance ≥ 0.5）+ 意思決定ログ（埋め込み検索・任意）を根拠に引用付きで回答。根拠ゼロなら正直に「記録なし」 |
| `task-review.ts` | human-in-the-loop 状態機械（pending_review → confirmed / rejected → synced）。LLM 抽出は high-recall 設計なので人間確認を強制 |
| `task-sync.ts` / `linear-client.ts` | 外部バックログ同期。`TaskSyncTarget` 抽象 + GitHub Issues / Linear の参考実装（クレデンシャル未設定は fail-closed） |
| `feed.ts` | digest フィード読み取り（relevance 降順・フィルタ・limit clamp） |
| `settings.ts` | テナント設定（チャンネル / briefing 時刻）・メール取り込み設定のバリデーション + upsert |
| `stores.ts` | Store 注入インターフェース + インメモリ実装（テスト・プロトタイプ用） |
| `client/hooks.ts` | React hooks（feed / ask / briefings / tasks / ingest / settings）。HTTP クライアントは `CosApiClient` として注入 |

## アーキテクチャ

```
  Slack ──┐ SlackSource
  Email ──┤ EmailSource      ┌────────────┐   ┌──────────────┐
  会議音声─┘ Transcriber  ──▶ │ ingest ×3  │──▶│ DigestStore   │──▶ feed / QA / briefing
                             │ (同意ゲート │   └──────────────┘
                             │  + LLM判定) │   ┌──────────────┐    pending_review
                             └────────────┘──▶│ TaskStore     │──▶ 人間レビュー
                                               └──────────────┘        │ confirm
  BriefingGenerator ◀── digest + tasks + contextProvider               ▼
        │                                              TaskSyncTarget（GitHub / Linear / 任意）
        ▼                                                       │ 実 issue 作成成功時のみ
  BriefingStore（daily / weekly / status_report）                ▼ status=synced + external_id
```

設計上の不変条件（元実装のコンプライアンス契約を踏襲）:

- **同意ファースト**: 各 ingest は目的別同意（`slack_content_analysis` 等 — `COS_CONSENT_PURPOSES`）が無ければハードスキップ。個情法 18 条対応
- **PII 最小化**: 原文は先頭 200 文字（`COS_RAW_TEXT_PREVIEW_MAX`）+ LLM 要約のみ保存。会議のフル書き起こしは永続化しない
- **捏造禁止**: Q&A は根拠ゼロなら `hasAnswer=false`。briefing は LLM 不在でも決定的フォールバックを保存
- **fail-closed 同期**: 外部 issue が実在しない限りタスクを `synced` にしない

## コア API

```ts
import {
  SlackIngestService, createSlackWebApiSource,
  EmailIngestService, MeetingIngestService,
  BriefingGenerator, QaEngine,
  TaskReviewService, createGithubSyncTarget, createLinearSyncTarget,
  FeedService, TenantSettingsService, EmailSettingsService,
  InMemoryDigestStore, InMemoryTaskStore, InMemoryBriefingStore,
  InMemoryTenantSettingsStore, InMemoryEmailSettingsStore,
} from "@torihanaku/kit-chief-of-staff";

const digestStore = new InMemoryDigestStore();
const taskStore = new InMemoryTaskStore();

// ── ingest（Slack の例）
const slack = new SlackIngestService({
  source: createSlackWebApiSource(botToken),   // または独自 SlackSource
  digestStore,
  consent: hasConsent,                          // (userId, tenantId, purpose) => Promise<boolean>
  llm,                                          // LlmCaller（下記）
});
await slack.ingest({ tenantId, ownerUserId, channels: ["C123"], sinceIso });

// ── 会議 → タスク抽出
const meeting = new MeetingIngestService({ transcriber, digestStore, taskStore, consent, llm });
const { digestId, tasksExtracted } = await meeting.ingest({
  tenantId, userId, audioUrl, meetingTitle, meetingDate,
});

// ── ブリーフィング（daily / weekly / status_report）
const generator = new BriefingGenerator({
  digestStore, taskStore, briefingStore: new InMemoryBriefingStore(), llm,
  contextProvider: async () => ({ plan, insights }),  // 任意
});
const briefing = await generator.generate(tenantId, "daily");

// ── Q&A
const qa = new QaEngine({ digestStore, llm, embedder, decisionSearcher });
const { answer, citations, hasAnswer } = await qa.ask({ tenantId, question: "TV予算はなぜ減った？" });

// ── タスクレビュー → 外部同期
const review = new TaskReviewService({
  taskStore,
  syncTargets: {
    github: createGithubSyncTarget({ token, repo: "acme/backlog" }),
    linear: createLinearSyncTarget({ apiKey, teamId }),
  },
});
await review.confirm(tenantId, taskId);
await review.sync(tenantId, taskId, "github");
```

React hooks（`CosApiClient` を注入。パス契約は `/cos/...`）:

```ts
const api = useMemo<CosApiClient>(() => ({ get, post, patch }), []);
const { items } = useCosFeed(api, { sourceType: "slack" });
const { ask, result } = useCosAsk(api);
const { items: tasks } = useCosTasks(api);
```

## 注入ポイント

| インターフェース | 役割 | 満たせる部品 / 実装例 |
|---|---|---|
| `LlmCaller` | 関連度判定・要約・action 抽出・briefing・Q&A | `@torihanaku/claude-api`（generateText / generateJson） |
| `ConsentChecker` | 目的ベース同意ゲート | `@torihanaku/consent` の `hasConsent` |
| `DigestStore` / `TaskStore` / `BriefingStore` / `TenantSettingsStore` / `EmailSettingsStore` | 永続化 | 同梱の `InMemory*`（本番は下記 SQL 相当のテーブルに実装） |
| `SlackSource` | Slack 読み取り | 同梱 `createSlackWebApiSource(botToken, fetch?)` |
| `EmailSource` | メール読み取り（1 ルール → 封筒配列） | `buildEmailQuery` + `extractPlainText` で Gmail/Outlook 実装を組める（元実装は Nango proxy 経由） |
| `Transcriber` | 音声 → テキスト | AssemblyAI 等（元実装は diarized 日本語書き起こし） |
| `TaskSyncTarget` | 外部バックログ | 同梱 GitHub / Linear（fetch 注入）。Jira 等は自作可 |
| `Embedder` + `DecisionSearcher` | Q&A の意思決定ログ検索（任意） | pgvector RPC / `@torihanaku/embeddings` 系。未注入なら digest のみで回答 |
| `CosLogger` | 構造化ログ（任意） | 未注入は no-op |
| プロンプトのパラメータ | `topic` / `domainLabel` / `askHint` / `productName` | 元実装のマーケティング特化文言・プロダクト名を差し替え |

## SQL スキーマ（本番ストア実装の参考）

元実装（Supabase / PostgreSQL）。RLS はテナント分離 + service_role の dual policy、retention は expires_at ベース。

```sql
-- digest（Slack/Email/Meeting から抽出）
CREATE TABLE cos_digest_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('slack','email','meeting')),
  source_permalink TEXT NOT NULL,
  source_actor TEXT,                    -- "slack:<user_id>" / "email:<addr>"（表示名は保存しない）
  raw_text_preview TEXT NOT NULL CHECK (char_length(raw_text_preview) <= 200),  -- PII 最小化
  raw_text_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  summary TEXT NOT NULL,                -- LLM 要約
  tags TEXT[] NOT NULL DEFAULT '{}',
  relevance_score NUMERIC(3,2) CHECK (relevance_score BETWEEN 0 AND 1),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);
CREATE INDEX ON cos_digest_items(tenant_id, source_type, ingested_at DESC);

-- 抽出タスク（human-in-the-loop）
CREATE TABLE cos_extracted_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  digest_item_id UUID REFERENCES cos_digest_items(id) ON DELETE CASCADE,
  task_text TEXT NOT NULL,
  assignee_hint TEXT,                   -- "@田中" 等（resolve は後続）
  due_hint TEXT,                        -- "来週金曜" 等
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','confirmed','rejected','synced')),
  synced_to TEXT,                       -- 'github_issue' / 'linear' / 任意
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);
CREATE INDEX ON cos_extracted_tasks(tenant_id, status);

-- ブリーフィング
CREATE TABLE cos_briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  briefing_type TEXT NOT NULL CHECK (briefing_type IN ('daily','weekly','status_report')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  summary_text TEXT NOT NULL,
  key_items_json JSONB NOT NULL DEFAULT '[]',   -- 上位 5 digest の ID
  delivered_to TEXT[] NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '180 days')
);
CREATE INDEX ON cos_briefings(tenant_id, briefing_type, period_end DESC);

-- テナント設定（cron 走査 + ウォーターマーク）
CREATE TABLE cos_tenant_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,          -- 同意チェックはこのユーザーを見る
  slack_channels TEXT[] NOT NULL DEFAULT '{}',
  email_filter_rules JSONB NOT NULL DEFAULT '[]',
  meeting_sources TEXT[] NOT NULL DEFAULT '{}',
  daily_briefing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  daily_briefing_time TEXT NOT NULL DEFAULT '08:00',   -- "HH:MM"
  last_slack_ingested_at TIMESTAMPTZ,
  last_email_ingested_at TIMESTAMPTZ,
  last_meeting_ingested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- メール取り込み設定（1 tenant = 1 row）
CREATE TABLE cos_email_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  integration TEXT NOT NULL DEFAULT 'google-mail' CHECK (integration IN ('google-mail','outlook')),
  connection_id TEXT,                   -- OAuth 接続 ID
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  filter_rules JSONB NOT NULL DEFAULT '[]',   -- [{fromDomain?, subjectContains?, labelIncludes?}]
  lookback_hours INTEGER NOT NULL DEFAULT 24 CHECK (lookback_hours BETWEEN 1 AND 168),
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 落としたもの

- **HTTP ルート配線**（`server/routes/cos/` の Request/Response・feature flag・requireRole・getTenantId）— ロジック部（状態機械・バリデーション・クエリ構築）はサービスとして移植済み。認可とルーティングはホスト側の責務
- **Nango proxy 経由の Gmail/Outlook 取得** — `EmailSource` 抽象に置換。`buildEmailQuery` / `extractPlainText` は部品として残したので、任意の OAuth ゲートウェイで再構成できる
- **AssemblyAI transcribe-client** — `Transcriber` インターフェースに置換（契約: `transcribe({url, language, speakerLabels}) → {text}`、失敗時 throw）
- **BYOK（tenant-secrets の ANTHROPIC_API_KEY / env フォールバック）** — LlmCaller 注入に一本化。テナント別キーはホスト側で LlmCaller を組み立てる際に解決する
- **pgvector RPC `match_decisions_by_embedding`** — `Embedder` + `DecisionSearcher` 注入に置換（kit-decision-memory と組み合わせ可能）
- **useCosConsent フック** — プロジェクトの `/consent` ルートと ApiError 型に密結合のため。`@torihanaku/consent` 導入時に再構築する方が自然
- **Zoom webhook スタブ（501 fail-closed）**・feature flag（`chiefOfStaff`）— QaEngine のみ `isEnabled` 述語として注入可能な形で残した
- **マーケティング特化のプロンプト文言** — `topic` / `domainLabel` / `productName` / `askHint` パラメータで一般化（既定値は元の文言を維持）

## 出典

失敗プロダクト dev-dashboard-v2（G9 Sprint 4, COS-1〜COS-7 / #361 / #1208）から抽出:

- `server/lib/cos/{briefing-generator,email-ingest,meeting-ingest,qa-engine,slack-ingest,task-sync,linear-client}.ts`
- `server/routes/cos/{ask,briefing,email-settings,feed,meeting-ingest,settings,slack-ingest,status-report,task-review}.ts`（ロジック部のみ）
- `shared/types/cos.ts`
- `src/hooks/cos/*.ts`（useCosConsent を除く 7 hooks）
- `supabase/migrations/202604200015_g9_s4_cos_foundation.sql`・`202604200016_..._cos_tenant_settings.sql`・`202605030010_..._cos_email_settings.sql`（README の SQL に反映）

runtime: node/bun（`extractPlainText` が Buffer 使用）、client hooks は browser + react(peer)。deps: なし（react は client 使用時のみ peer）。
