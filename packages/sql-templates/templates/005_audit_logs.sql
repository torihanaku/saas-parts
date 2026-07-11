-- Audit log table for immutable operation tracking
-- Record all data mutations with user attribution.
-- NOTE: これはシンプルな append-only 監査ログ (audit_logs)。
--       002 / 006 が拡張する audit_log（tenant_id 付き）とは別物 — README 参照。

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  user_role TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'create', 'update', 'delete', 'login', 'invite'
  resource_type TEXT NOT NULL,    -- table or resource name
  resource_id TEXT,               -- ID of affected record
  changes JSONB,                  -- operation details / diff
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_email ON audit_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC);

-- Make table append-only via RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_insert_only ON audit_logs
  FOR INSERT WITH CHECK (true);

CREATE POLICY audit_logs_select_all ON audit_logs
  FOR SELECT USING (true);

-- No UPDATE or DELETE policies = effectively immutable
