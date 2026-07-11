-- Migration: Agency mode foundation（代理店が複数クライアント tenant を横断管理する機能の土台）
-- 設計判断（元プロダクトでの決定事項）:
--   - max clients 無制限
--   - 3層 role (agency_admin / agency_member / client_viewer)
--   - 監査ログ 1年 DB 保持 → GCS コールドアーカイブ (archived_to_gcs フラグ先置き)
--   - 一括操作は永続的に実装しない
-- Prerequisite: 001_multitenant_foundation.sql 適用済み。
--               audit_log テーブルが存在すること（tenant_id / occurred_at 列を含む。
--               005_audit_logs.sql の audit_logs とは別物 — README 参照）。

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

-- ─── 2) team_members.assigned_clients + 3層 role 拡張 ────────────────────────
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS assigned_clients uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN team_members.assigned_clients IS
  'agency_member が編集/閲覧できる client tenant id 配列。空配列 = 未割当 (agency_admin は無視、agency_member は完全拒否)';

-- 既存 CHECK (admin, editor, viewer, member) を drop して 3 層 role を追加
ALTER TABLE team_members
  DROP CONSTRAINT IF EXISTS team_members_role_check;

ALTER TABLE team_members
  ADD CONSTRAINT team_members_role_check CHECK (role IN (
    'admin', 'editor', 'viewer', 'member',
    'agency_admin', 'agency_member', 'client_viewer'
  ));

-- ─── 3) audit_log 拡張 (1年 DB 保持 → GCS archive) ──────────────────────────
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
  '危険操作の記録レベル。high/critical は 2FA-like 確認対象';
COMMENT ON COLUMN audit_log.archived_to_gcs IS
  '1年超の行は GCS コールドアーカイブ後に true（batch job で更新）';

-- ─── 4) v_agency_accessible_clients view ─────────────────────────────────
--  agency tenant から UNNEST(managed_clients) で JOIN した accessible client 一覧。
--  requireClientAccess middleware から使用。
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
  'agency tenant が管理する direct client tenant の一覧。requireClientAccess middleware で使用';
