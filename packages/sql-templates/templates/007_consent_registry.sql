-- Consent registry — GDPR 対応の同意台帳（tenant × user × purpose 単位で同意/撤回を記録）
CREATE TABLE IF NOT EXISTS consent_registry (
  id UUID DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL, -- e.g., 'slack_ingestion', 'ai_learning'
  basis TEXT NOT NULL,   -- e.g., 'explicit_consent', 'contract'
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, user_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_consent_active ON consent_registry (tenant_id, user_id)
  WHERE revoked_at IS NULL;

-- 退職者フラグは既存 auth.users に追加（Supabase 前提。他基盤なら自前 users テーブルに変更）
DO $$
BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_member_flag BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping auth.users.deleted_member_flag: insufficient privileges in local Supabase bootstrap';
END $$;
