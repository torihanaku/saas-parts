# @torihanaku/kit-approval-workflow

承認ワークフロー（申請 → リスク評価 → 承認 → 監査）の汎用コア。
dev-dashboard-v2 の「ブランドファイアウォール／稟議（ringi）」システムから、プロダクト固有ロジックを剥がして抽出したもの。

## 機能説明

- **申請ライフサイクル**: 申請（submit）→ 注入されたリスク評価器で自動チェック → `riskScore > 0` なら差し戻し（`lint_running`）、`0` なら人間の承認待ち（`under_review`）→ 承認 / 却下 / 例外申請（override）/ デプロイ。
- **クイック修正・再申請（reapply）**: 起案者本人のみが指摘箇所を置換して再評価にかけられる（状態ガード付き）。
- **例外申請（稟議 / ringi）**: 却下された申請に対する構造化された不服申し立て。上位承認者が判断し、結果は元申請へカスケードする。
- **Slack 承認**: 署名検証（HMAC + タイムスタンプ 5 分許容の timing-safe 比較）、Block Kit の承認ボタン / 却下理由モーダル（Dynamic Triage: 上位 3 候補+「その他」）のペイロード解釈と dispatch。Slack の 3 秒 ACK 制約に合わせ、不正ペイロードでも 200 を返してリトライストームを防ぐ。
- **リスク 3 段階分類（riskTier)**: low（自動実行可）/ medium（単独承認）/ high（複数承認必須）。アクション種別と支出閾値で判定、設定注入可能。
- **複数承認者の集約（aggregator)**: `single` / `and`（全員一致）/ `or`（誰か 1 人）モードの純粋関数。
- **タイムアウト・エスカレーション**: 一定時間（既定 24h）未決の申請を次位承認者へ自動再割当するジョブ。監査ログ・新担当への通知付き。
- **監査**: すべての決定（承認 / 却下 / 再申請 / 稟議 / エスカレーション）を注入された `AuditLogger` に記録。人間の決定後のフックは best-effort（失敗しても決定はロールバックしない）。

## コア API

```ts
import {
  ApprovalWorkflow,            // 申請〜決定〜稟議のライフサイクル本体
  InMemorySubmissionStore,     // 参照実装（テスト / プロトタイプ用）
  InMemoryExceptionRequestStore,
  runEscalationJob,            // タイムアウト・エスカレーションジョブ
  classifyRisk,                // 3 段階リスク分類
  aggregate,                   // 複数承認者の and/or/single 集約
  verifySlackSignature,        // Slack 署名検証
  handleSlackInteractionRequest, // Slack interactions HTTP エントリポイント
  buildRejectModalView,        // 却下理由モーダル (Block Kit)
  createApprovalHttpAdapter,   // 薄い HTTP ルートアダプタ例
} from "@torihanaku/kit-approval-workflow";

const workflow = new ApprovalWorkflow({
  submissions: new InMemorySubmissionStore(),
  exceptions: new InMemoryExceptionRequestStore(),
  evaluate: async ({ tenantId, contentText }) => ({
    checkId: "…", riskScore: 0, violations: [],
  }),
  notifyApprover: async (submission, evaluation) => { /* Slack DM 等 */ },
  audit: (entry) => { /* 監査テーブルへ insert */ },
  onApproved: async (s) => { /* デプロイ連携等（best-effort） */ },
});

// 申請 → 評価 → under_review / lint_running
const { submission } = await workflow.submit({
  tenantId, submitterId, title, contentText,
});

// 承認者の決定（reject は理由コード必須）
await workflow.decide(submission.id, tenantId, {
  action: "approve", approverId,
});

// 稟議: 却下への不服申し立て → 上位承認者が判断 → 元申請へカスケード
const ex = await workflow.submitException({ tenantId, submitterId, rejectedContent, rejectionReason, submitterOverrideArgument });
await workflow.decideException(ex.id, tenantId, { action: "approved", deciderId });

// エスカレーション（cron 等から定期実行）
await runEscalationJob({
  submissions, getPolicy: async (tenantId) => ({ enabled: true, timeout_hours: 24, next_approver_id: "…" }),
});
```

主要な状態遷移（原典 #1018 のセマンティクスを保存）:

```
draft → submitted → (評価)
  riskScore > 0  → lint_running   … 起案者が reapply で修正・再評価
  riskScore == 0 → under_review   … 人間の承認待ち
under_review → approved | rejected | override(稟議提出)
稟議 approved → 元申請 approved / 稟議 rejected → 元申請 rejected
approved → deployed（任意の後続アクション）
```

## 注入ポイント（すべて DI・env 参照なし）

| ポート | 型 | 原典での実装 |
|---|---|---|
| `SubmissionStore` | interface | Supabase `dd_submissions` |
| `ExceptionRequestStore` | interface | Supabase `dd_exception_requests` |
| `RiskEvaluator` | `(input) => Promise<RiskEvaluation>` | コンプライアンス lint チェッカー (`lib/compliance/checker-service`) |
| `ApproverNotifier` | `(submission, evaluation) => Promise<void>` | Slack DM (Block Kit) 通知 |
| `AuditLogger` | `(entry) => void \| Promise<void>` | `dd_decision_log` insert |
| `onApproved` / `onRejected` / `onExceptionApproved` | best-effort フック | デプロイゲート / Hard Negatives 学習データ / DNA 昇格 |
| `EscalationPolicyResolver` | `(tenantId) => Promise<EscalationPolicy \| null>` | `tenants.escalation_policy` → `teams` フォールバック |
| `SlackViewOpener` | `(triggerId, view) => Promise<void>` | `views.open` HTTP 呼び出し（`createHttpSlackViewOpener` にトークンを明示注入） |
| `RiskTierConfig` | 設定オブジェクト | ハードコードされていたアクション種別名を既定値として保存 |
| `now` / `newId` | クロック / ID 生成 | `new Date()` / DB の `gen_random_uuid()` |

## SQL スキーマ（原典の migrations より・参考）

コアはストレージ非依存だが、原典のテーブル構造を再現する場合の参考として要約する
（プロダクト固有カラムは除外。RLS は `tenant_id = current_tenant_id()` のテナント分離 + service_role 全許可の 2 段構え）。

```sql
-- 申請 (原典: dd_submissions / 20260421100000_g9_s3_firewall_foundation.sql)
create table submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  submitter_id uuid not null,          -- 起案者
  approver_id uuid,                    -- 承認者（エスカレーションで書き換わる）
  title text not null,
  content_text text not null,
  creative_urls jsonb default '[]',
  status text not null default 'draft',
  check_id uuid,                       -- リスク評価レコードへの緩い参照 (原典: firewall_check_id)
  submitted_at timestamptz,
  decided_at timestamptz,
  rejection_reason_code text,          -- Dynamic Triage 選択コード
  rejection_reason_text text,
  override_exception_id uuid,          -- 稟議参照 (原典: override_ringi_id)
  metadata jsonb default '{}',         -- 例: {"escalated": true}
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on submissions (tenant_id, status);
create index on submissions (submitter_id);
create index on submissions (approver_id);

-- 稟議 / 例外申請 (原典: dd_exception_requests / 202604210002_g9_s4_active_learning_foundation.sql)
create table exception_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  original_submission_id uuid,         -- 意図的な緩い FK（独立性のため）
  rejected_content text not null,
  rejection_reason text not null,
  submitter_override_argument text not null,
  decision text check (decision in ('approved','rejected')),  -- 原典: cmo_decision
  decision_at timestamptz,
  decision_reasoning text,             -- 承認/却下時の上位承認者コメント
  created_at timestamptz not null default now()
);

-- 監査ログ (原典: dd_decision_log / 202604200009_g9_s1_why_foundation.sql)
create table decision_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  decision_type text not null,         -- start/stop/change/approval/rejection
  subject text not null,
  context text not null,
  reason text,
  decided_by uuid,
  decided_at timestamptz not null default now(),
  source text not null default 'manual',  -- manual/slack/system/ai_suggestion
  resource_type text,
  resource_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- エスカレーションポリシー (原典: 202604300002_add_tenant_escalation_policy.sql)
alter table tenants add column escalation_policy jsonb default '{}'::jsonb;
-- 例: {"enabled": true, "timeout_hours": 24, "next_approver_id": "<uuid>"}
```

## アダプタ使用法（`src/adapters/http.ts`）

Web 標準の `Request` / `Response` だけで書かれた薄いルートアダプタ例。Hono / Bun.serve / Cloud Run functions 等にそのままマウントできる。認証（`AuthedUser` の解決）は呼び出し側の責務（原典は Supabase JWT の `app_metadata.tenant_id`）。

```ts
const adapter = createApprovalHttpAdapter({
  workflow,
  slack: {
    signingSecret: /* Secret Manager 等から注入 */,
    openView: createHttpSlackViewOpener({ token: /* bot token 注入 */ }),
    triageOptions: [{ code: "tone", label: "トーン不一致" }],
  },
});

// 例: Hono へのマウント
app.post("/submissions", (c) => adapter.submit(c.req.raw, getUser(c)));
app.post("/submissions/:id/decision", (c) => adapter.decide(c.req.raw, getUser(c), c.req.param("id")));
app.post("/submissions/:id/reapply", (c) => adapter.reapply(c.req.raw, getUser(c), c.req.param("id")));
app.post("/exceptions", (c) => adapter.submitException(c.req.raw, getUser(c)));
app.post("/exceptions/:id/decision", (c) => adapter.decideException(c.req.raw, getUser(c), c.req.param("id")));
app.post("/slack/interactions", (c) => adapter.slackInteractions(c.req.raw));  // 認証不要（署名検証）
```

## 落としたもの＋理由

| 落としたもの | 原典 | 理由 |
|---|---|---|
| ブランド DNA 連携（承認コンテンツの DNA 取り込み、稟議承認の DNA 昇格 3x 重み付け） | decision.ts / exception.ts / ringiDnaWriteback | ブランド／マーケ領域のプロダクト固有評価ロジック。`onApproved` / `onExceptionApproved` フックとして注入点だけ残した |
| チャレンジャー案自動生成（`dd_challenger_proposals`） | submit.ts | マーケコピー固有の AI 生成機能 |
| Hard Negatives 学習パイプライン（`dd_hard_negatives`） | slack-actions.ts | Active Learning の学習データ収集はプロダクト固有。`onRejected` フックで代替 |
| デプロイゲート／自律デプロイ（`dispatchDeployGate` / `runAutonomousDeploy`） | slack-actions.ts / exception.ts | 広告配信インフラ固有。`onApproved` フックで代替 |
| コンプライアンス lint チェッカー本体（ブランドルール評価） | lib/compliance/checker-service | プロダクト固有の評価規則（brand/marketing ドメイン）。`RiskEvaluator` インターフェイスに置換 |
| AI 法務一次見解・類似成功事例 RAG・稟議書 PDF 生成 | exception.ts / ringi/gather-evidence.ts / ringi/render-pdf.ts | LLM / embedding / PDF 依存のプロダクト固有機能 |
| CAUSAL 予測（`causal_prediction`）・CPA シミュレーション | dd_submissions / dd_exception_requests のカラム | 因果推論はプロダクト固有（→ kit-causal-inference） |
| Slack 通知メッセージの組み立て（notifyApprover の Block Kit 本文） | lib/firewall/slack-notifier.ts | 文面がプロダクト固有。却下モーダル（汎用）だけ移植し、通知は `ApproverNotifier` 注入に |
| 一覧・メトリクス・履歴ルート（list.ts / metrics.ts / triage-history.ts / cross-tenant.ts） | routes/firewall/ | 表示用クエリの寄せ集めで、`SubmissionStore.list` で十分代替可能 |
| Supabase / Hono / zod / env 依存 | 全ファイル | Kit 要件（decoupled core）。ストア interface + Web 標準 Request/Response + 手書きバリデーションに置換 |

原典との意図的な差分（バグ修正）: 原典のエスカレーションジョブは `metadata.escalated` を**チェックするが設定していなかった**ため毎回再エスカレーションされ得た。本 Kit では再割当時に `metadata.escalated = true` を設定する（escalation.ts 冒頭コメント参照）。

## 出典

dev-dashboard-v2（READ-ONLY）:

- `server/routes/firewall/` — submit.ts / decision.ts / reapply.ts / exception.ts / slack-signature.ts / slack-dispatch.ts / slack-interactions.ts / slack-actions.ts
- `server/routes/ringi/` — submit.ts / approve.ts
- `server/services/` — approvalAggregator.ts / escalationPolicy.ts / riskTier.ts
- `server/jobs/approval-escalation.ts`
- `supabase/migrations/` — 20260421100000_g9_s3_firewall_foundation.sql（dd_submissions）/ 202604210002_g9_s4_active_learning_foundation.sql（dd_exception_requests）/ 202604200009_g9_s1_why_foundation.sql（dd_decision_log）/ 202604300002_add_tenant_escalation_policy.sql

## テスト

```bash
npx tsc --noEmit -p packages/kit-approval-workflow/tsconfig.json
npx vitest run packages/kit-approval-workflow
```

- リスク分類の境界値（閾値 1000 ちょうど / 直下、既定 medium）
- 集約 and / or / single（全員一致・拒否権・全員却下・pending）
- Slack 署名検証（フェイクシークレット、改ざん・別鍵・リプレイ・許容境界）
- submit → approve ライフサイクル、reject 理由必須、テナント分離、フック best-effort
- reapply（置換→再評価、起案者ガード、状態ガード、before 不在）
- 稟議（override 遷移、承認/却下カスケード、監査 change/stop マッピング）
- エスカレーション遷移（タイムアウト境界、二重エスカレーション防止、ポリシー無効、エラー継続）
- HTTP アダプタ経由の一気通貫（エラーコード→ステータス写像含む）
