# @torihanaku/agency-access

複数クライアント委任（agency モード）のアクセス制御モジュール — 3層 role 型定義、role × テナント種別 × assigned_clients の 3 層アクセス制御ミドルウェア（拒否時監査ログ付き）、role/tenant コンテキスト解決、メンバー status 自動補正（#739）を提供する。

## 主要API

```ts
import {
  createRequireClientAccess,
  createGetAgencyContext,
  healMemberStatuses,
  isAgencyRole,
  type AgencyAccessStore,
} from "@torihanaku/agency-access";

const store: AgencyAccessStore = {
  // 元実装の Supabase クエリと 1:1 対応
  findMemberByEmail: (email) => /* team_members?email=eq&select=email,role,tenant_id,assigned_clients */ null,
  findTenantById: (id) => /* tenants?id=eq&select=id,name,type,managed_clients */ null,
};

// 1) 3層アクセス制御ミドルウェア
const requireClientAccess = createRequireClientAccess<Request>({
  store,
  getSessionEmail: (req) => mySession(req),
  getTenantId: (req) => myTenantResolver.getTenantId(req), // @torihanaku/tenant-resolver と組み合わせ可
  logAudit: (req, evt) => auditLogger.write(req, evt),      // 省略可（403 時のみ呼ばれる）
});

const forbidden = await requireClientAccess(req, targetClientId);
if (forbidden) return forbidden; // 401 or 403 Response。null なら許可

// 2) role/tenant コンテキスト解決（/api/agency/* 系ルート共通）
const getAgencyContext = createGetAgencyContext<Request>({ store, getTenantId });
const { role, userTenantId, member, agencyTenant } = await getAgencyContext(req, email);

// 3) メンバー status 自動補正（#739: SAML/OAuth ログインで "invited" のまま残る問題）
const { healed, staleIds } = healMemberStatuses(membersFromDb);
// staleIds を DB 側でも PATCH status=active すると self-heal 完了（永続化は呼び出し側の責務）
```

### 3層アクセス制御の評価順

1. セッション email 無し → 401
2. 自身の tenant_id === clientId → pass（direct role / client_viewer 共通）
3. agency role 評価:
   - `agency_admin`: 所属テナントが `type='agency'` かつ `managed_clients` に clientId → pass
   - `agency_member`: 自分の `assigned_clients` に clientId → pass
   - `client_viewer`: 手順 2 以外では常に拒否
4. それ以外 → 403 + 監査ログ（action: `access_denied`, risk_level: `medium`, 試行 clientId 含む）

## 依存

- peerDeps / 外部依存なし（`Response.json` を使うため Web 標準 Response が必要）

## 注入ポイント

| 注入先 | 元実装 |
|---|---|
| `store: AgencyAccessStore` | Supabase REST（dashboard_team_members / tenants） |
| `getSessionEmail(req)` / `getTenantId(req)` | `server/lib/auth.ts` |
| `logAudit(req, evt)` | `server/lib/audit.ts` の `logAudit`（任意。未注入なら監査記録なし） |

## 想定ランタイム

Node.js 18+ / Bun / Cloud Run 等のサーバーサイド（`Response.json` 静的メソッドが必要）。

## 出典

- `実運用SaaS/shared/types/agency.ts`（93 LOC: role 階層型）
- `実運用SaaS/server/middleware/require-client-access.ts`（115 LOC: #774 A-2）
- `実運用SaaS/server/routes/agency-context.ts`（54 LOC）
- `実運用SaaS/server/routes/team-members.ts`（#739 status healing → 純関数化）
- テスト移植元: `tests/agency-middleware.test.ts` / `tests/team-member-status.test.ts`

---

## 想定DBスキーマ（マイグレーションテンプレート）

このパッケージはストレージを注入で受けるためスキーマを強制しないが、元実装のスキーマをテンプレートとして残す。

### 1. マルチテナント基盤（`202603280001_multitenant_foundation.sql` 相当）

`tenants` テーブルは既存前提。`team_members`（元: `dashboard_team_members`）に status と tenant_id を追加してテナント分離を有効化する。

```sql
-- Migration: Multi-tenant foundation — status + tenant_id on team members
-- Note: tenants table is assumed to already exist. This migration adds the missing
--       columns to the team-members table to enable tenant isolation.

-- Add status column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dashboard_team_members' AND column_name = 'status'
  ) THEN
    ALTER TABLE dashboard_team_members
      ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'invited', 'suspended'));
  END IF;
END $$;

-- Add tenant_id (FK to tenants, nullable for backward compat)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dashboard_team_members' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE dashboard_team_members
      ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_team_members_tenant_id ON dashboard_team_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_team_members_status ON dashboard_team_members(status);

-- RLS: service_role has full access (API always uses service_role key)
ALTER TABLE dashboard_team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_service_role ON dashboard_team_members;
CREATE POLICY team_members_service_role ON dashboard_team_members
  USING (current_setting('role', true) = 'service_role');
```

### 2. Agency モード基盤（`202604240001_001_agency_mode_foundation.sql` 相当）

```sql
-- Agency mode foundation (cross-client management)
--   - 3層 role (agency_admin / agency_member / client_viewer)
--   - max clients 無制限 / 監査ログは risk_level + GCS アーカイブフラグ先置き

-- ─── 1) tenants.type + tenants.managed_clients ─────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'direct';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'tenants' AND constraint_name = 'tenants_type_check'
    ) THEN
        ALTER TABLE tenants
          ADD CONSTRAINT tenants_type_check CHECK (type IN ('direct', 'agency'));
    END IF;
END
$$;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS managed_clients uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tenants_type ON tenants(type);

COMMENT ON COLUMN tenants.type IS
  'direct = 通常 tenant / agency = 複数 managed_clients を束ねる代理店 tenant';
COMMENT ON COLUMN tenants.managed_clients IS
  'agency tenant 配下の client tenant id 配列。無制限。direct tenant では常に空配列';

-- ─── 2) team members: assigned_clients + 3層 role 拡張 ─────────────────────
ALTER TABLE dashboard_team_members
  ADD COLUMN IF NOT EXISTS assigned_clients uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN dashboard_team_members.assigned_clients IS
  'agency_member が編集/閲覧できる client tenant id 配列。空配列 = 未割当 (agency_admin は無視、agency_member は完全拒否)';

-- 既存 CHECK (admin, editor, viewer, member) を drop して 3 層 role を追加
ALTER TABLE dashboard_team_members
  DROP CONSTRAINT IF EXISTS dashboard_team_members_role_check;

ALTER TABLE dashboard_team_members
  ADD CONSTRAINT dashboard_team_members_role_check CHECK (role IN (
    'admin', 'editor', 'viewer', 'member',
    'agency_admin', 'agency_member', 'client_viewer'
  ));

-- ─── 3) audit_log 拡張 (risk_level + コールドアーカイブ先置き) ─────────────
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'audit_log' AND constraint_name = 'audit_log_risk_level_check'
    ) THEN
        ALTER TABLE audit_log
          ADD CONSTRAINT audit_log_risk_level_check
          CHECK (risk_level IN ('low', 'medium', 'high', 'critical'));
    END IF;
END
$$;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS archived_to_gcs boolean NOT NULL DEFAULT false;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS gcs_archive_path text;

CREATE INDEX IF NOT EXISTS idx_audit_log_risk_level ON audit_log(risk_level);
CREATE INDEX IF NOT EXISTS idx_audit_log_archive ON audit_log(archived_to_gcs, occurred_at)
  WHERE archived_to_gcs = false;

COMMENT ON COLUMN audit_log.risk_level IS
  '危険操作の記録レベル。high/critical は追加確認の対象';
COMMENT ON COLUMN audit_log.archived_to_gcs IS
  '保持期限超過の行はコールドアーカイブ後に true';

-- ─── 4) v_agency_accessible_clients view ─────────────────────────────────
--  agency tenant から UNNEST(managed_clients) で JOIN した accessible client 一覧。
--  requireClientAccess ミドルウェアの管理画面系クエリから使用。
CREATE OR REPLACE VIEW v_agency_accessible_clients AS
SELECT
  agency.id                   AS agency_tenant_id,
  agency.name                 AS agency_tenant_name,
  client.id                   AS client_tenant_id,
  client.name                 AS client_tenant_name,
  client.created_at           AS client_created_at
FROM tenants agency
CROSS JOIN UNNEST(agency.managed_clients) AS managed_client_id
JOIN tenants client ON client.id = managed_client_id
WHERE agency.type = 'agency'
  AND client.type = 'direct';

COMMENT ON VIEW v_agency_accessible_clients IS
  'agency tenant が管理する direct client tenant の一覧';
```
