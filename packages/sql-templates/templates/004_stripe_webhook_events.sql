-- Idempotency table for Stripe webhook events.
-- Prevents duplicate processing when Stripe retries an event.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- ⚠ このポリシーは TO service_role で明示的にロールを絞る。TO を省くと PUBLIC 扱いになり、
--    anon/authenticated にテーブル権限が付いていれば全 webhook イベントを読み書きできてしまう
--    （008 の all-access ポリシーも同様に TO service_role で絞っている）。
CREATE POLICY "Service role full access on stripe_webhook_events"
  ON stripe_webhook_events FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
