# @torihanaku/hiring

採用（Hiring）機能一式。求人票の CRUD、応募者トラッキング（ステータス遷移＋監査イベント）、公開キャリアページからの応募受付、応募者自身による GDPR（第17条）データ削除を提供します。

HTTP・認証・feature flag・レート制限といったルーティング層の関心事は含みません。各メソッドは `ServiceResult<T>`（`{ ok: true; data }` または `{ ok: false; status; error }`）を返すので、ホスト側で任意のトランスポートにマッピングできます。

## 用途

- 求人票（job posting）の作成・取得・更新・削除（テナントスコープ）
- 応募者一覧（管理者向け・`gdpr_deletion_token` と `ip_address` を除外）とステータス遷移
- 公開キャリアページの応募フォーム受付（掲載中判定・締切・履歴書必須・必須設問の検証）
- 応募者向け GDPR 削除ページ HTML の生成と、トークンによる削除実行

## API例

```ts
import { HiringService, InMemoryHiringStore, renderGdprDeletePage } from "@torihanaku/hiring";

const store = new InMemoryHiringStore(); // 本番は HiringStore を実装して注入
const hiring = new HiringService({
  store,
  notifier: {
    // 応募通知メール（元実装は RESEND）。省略可
    notifyAdmins: (posting, app, emails) => sendAdminMail(posting, app, emails),
    notifyApplicant: (posting, app) => sendApplicantMail(posting, app),
  },
});

// 管理: 求人票 CRUD
const created = await hiring.createJobPosting("tenant-1", { title: "エンジニア", status: "open" });
await hiring.updateJobPosting("tenant-1", id, { status: "closed" });
const postings = await hiring.listJobPostings("tenant-1");

// 管理: 応募者トラッキング
await hiring.updateApplication("tenant-1", appId, { status: "interview", notes_md: "一次通過" });
const applicants = await hiring.listApplications("tenant-1", postingId);

// 公開: 応募受付
const res = await hiring.submitApplication(
  "careers-slug",
  { job_posting_id: postingId, applicant_name: "山田太郎", applicant_email: "taro@example.com" },
  ipAddress,
);
// res.ok なら res.data.gdpr_deletion_token を応募者にのみ返す

// 公開: GDPR 削除
const html = renderGdprDeletePage(token); // 確認ページ
await hiring.applicantDeleteApplication(token); // 実削除
```

## 注入ポイント

- `HiringStore` — 永続化。元実装の Supabase REST 呼び出し（`dd_job_postings` / `dd_applications` / `dd_application_events` / `dd_landing_pages` / `dashboard_team_members`）を型付きメソッドに集約。`InMemoryHiringStore` を同梱
- `HiringNotifier`（任意）— 応募通知メール副作用。元実装の RESEND 送信を注入 IF 化。未指定なら送信スキップ
- `uuid` / `now` / `makeDeletionToken` / `retentionMs` — テスト決定性と保持期間（既定 2 年）の制御

## SQL スキーマ（出典: `202604240002_002_recruitment_builder_foundation.sql`）

```sql
-- dd_landing_pages に category ('landing' | 'recruit') を追加
ALTER TABLE dd_landing_pages ADD COLUMN category text NOT NULL DEFAULT 'landing';

CREATE TABLE dd_job_postings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  landing_page_id   uuid REFERENCES dd_landing_pages(id) ON DELETE SET NULL,
  title             text NOT NULL,
  department        text,
  location          text,
  employment_type   text NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time','part_time','contract','intern')),
  salary_range      text,
  description_md    text NOT NULL DEFAULT '',
  resume_required   boolean NOT NULL DEFAULT true,
  custom_questions  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 最大10件 (API で enforce)
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  apply_deadline    date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dd_applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_posting_id        uuid NOT NULL REFERENCES dd_job_postings(id) ON DELETE CASCADE,
  applicant_name        text NOT NULL,
  applicant_email       text NOT NULL,
  resume_asset_id       uuid REFERENCES dd_assets(id) ON DELETE SET NULL,
  answers               jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','reviewing','interview','offered','rejected')),
  notes_md              text NOT NULL DEFAULT '',
  ip_address            text,
  retention_expires_at  timestamptz NOT NULL DEFAULT (now() + interval '2 years'),
  gdpr_deletion_token   text NOT NULL DEFAULT encode(gen_random_bytes(24), 'base64'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_applications_gdpr_token ON dd_applications (gdpr_deletion_token);

CREATE TABLE dd_application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES dd_applications(id) ON DELETE CASCADE,
  event_type     text NOT NULL CHECK (event_type IN
                   ('submitted','status_changed','note_added','deleted_by_applicant','deleted_by_retention')),
  by_user_id     uuid,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
```

## 元実装からの変更点

- Supabase REST 直呼び（supabaseGet/Insert/Patch/Delete）→ `HiringStore` 注入
- RESEND メール送信 → `HiringNotifier` 注入 IF（任意）
- HTTP `Response` 生成 → `ServiceResult<T>`。ルート層のステータス/エラーメッセージはそのまま保持
- feature flag / `requireRole` / レート制限 / `getTenantId` はホスト側の責務として除外
- GDPR 削除ページの fetch 先はデフォルトで元ルート（`/api/careers/applications/:token`）、`deleteUrl` で上書き可

## 出典

- `実運用SaaS/server/routes/recruitment/{index,postings,applications,public,gdpr-delete-page,shared}.ts`
- `実運用SaaS/shared/types/recruitment.ts`
- `実運用SaaS/supabase/migrations/202604240002_002_recruitment_builder_foundation.sql`
```
