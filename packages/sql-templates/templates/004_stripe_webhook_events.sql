-- Idempotency table for Stripe webhook events.
-- Prevents duplicate processing when Stripe retries an event.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on stripe_webhook_events"
  ON stripe_webhook_events FOR ALL
  USING (true) WITH CHECK (true);
