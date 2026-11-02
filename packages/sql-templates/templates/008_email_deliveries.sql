-- email_deliveries: per-tenant email send/bounce log so a realtime monitor
-- can compute today's bounce rate against a rolling 7-day baseline and fire
-- `email_delivery_drop` anomaly events.
--
-- Rows are written by the email webhook ingestion path (sendgrid / ses) —
-- this migration only declares the schema and indexes the monitor needs.
-- Prerequisite: tenants テーブル（元実装は teams(id) を参照 — README 参照）と、
--               RLS 用の current_tenant_id() 関数、ロール authenticated / service_role
--               が存在すること（anon は任意）。

CREATE TABLE IF NOT EXISTS email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'bounced', 'dropped', 'deferred', 'spam')),
  recipient_email TEXT,
  message_id TEXT,
  provider TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 書き込み権限（多層防御）: 配信ログを書くのは webhook 取り込み（service_role）だけ。
-- Supabase 既定の GRANT ALL から anon/authenticated の SELECT 以外の全権限
-- （INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES、PG17 以上なら MAINTAIN も）を外す。
-- anon はロールがある時だけ外す。
DO $$
DECLARE
  privs text := 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES';
  r text;
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    privs := privs || ', MAINTAIN';
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE %s ON email_deliveries FROM %I', privs, r);
    END IF;
  END LOOP;
END $$;

-- TRUNCATE には RLS が効かないので、テーブルオーナー（とそのメンバー・スーパーユーザー）以外の
-- TRUNCATE をトリガーで拒否する（GRANT ALL を戻されても配信ログを消させない）。
-- 003 と同じ関数。CREATE OR REPLACE なので 008 単独でも・何度流しても通る。
-- search_path を固定し pg_catalog を完全修飾する: 呼び出し側が pg_temp に一時表 pg_class を
-- 作ってオーナーを偽装しても、判定は本物のカタログを見る（AC-65）。
CREATE OR REPLACE FUNCTION deny_truncate_unless_owner() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user,
                     (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RAISE EXCEPTION 'TRUNCATE on % is not allowed for role %', TG_TABLE_NAME, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS email_deliveries_deny_truncate ON email_deliveries;
CREATE TRIGGER email_deliveries_deny_truncate
  BEFORE TRUNCATE ON email_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate_unless_owner();

ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;

-- authenticated は自テナントの行を読むだけ（FOR ALL だと配信ログを偽造・削除でき、
-- bounce 率監視を欺ける。SA-0001）。旧版のポリシーも含めて DROP IF EXISTS してから作るので、
-- ON_ERROR_STOP=1 で何度流しても通る。
DROP POLICY IF EXISTS email_deliveries_tenant ON email_deliveries;
DROP POLICY IF EXISTS email_deliveries_tenant_select ON email_deliveries;
CREATE POLICY email_deliveries_tenant_select ON email_deliveries
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT current_tenant_id()));

DROP POLICY IF EXISTS email_deliveries_service ON email_deliveries;
CREATE POLICY email_deliveries_service ON email_deliveries
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_tenant_sent
  ON email_deliveries(tenant_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_status
  ON email_deliveries(tenant_id, status, sent_at DESC);

COMMENT ON TABLE email_deliveries IS
  'Email delivery log per tenant. Used by a realtime anomaly monitor cron to compute bounce rate drift vs 7-day baseline.';
