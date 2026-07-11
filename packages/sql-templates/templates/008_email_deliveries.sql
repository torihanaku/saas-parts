-- email_deliveries: per-tenant email send/bounce log so a realtime monitor
-- can compute today's bounce rate against a rolling 7-day baseline and fire
-- `email_delivery_drop` anomaly events.
--
-- Rows are written by the email webhook ingestion path (sendgrid / ses) —
-- this migration only declares the schema and indexes the monitor needs.
-- Prerequisite: tenants テーブル（元実装は teams(id) を参照 — README 参照）と、
--               RLS 用の current_tenant_id() 関数が存在すること。

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

ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_deliveries_tenant ON email_deliveries
  FOR ALL TO authenticated
  USING (tenant_id = (SELECT current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT current_tenant_id()));

CREATE POLICY email_deliveries_service ON email_deliveries
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_tenant_sent
  ON email_deliveries(tenant_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_status
  ON email_deliveries(tenant_id, status, sent_at DESC);

COMMENT ON TABLE email_deliveries IS
  'Email delivery log per tenant. Used by a realtime anomaly monitor cron to compute bounce rate drift vs 7-day baseline.';
