/**
 * Stripe webhook processing — signature verification, idempotency, event routing.
 *
 * Ported from dev-dashboard-v2 `server/routes/billing.ts` (handleBillingWebhook).
 * Coupling removed:
 * - Stripe SDK instance is injected (no env reads, no singleton).
 * - Idempotency storage (was: supabase `stripe_webhook_events` table) is an
 *   injected `WebhookEventStore`; an in-memory implementation is provided.
 * - Plan-update side effects (was: supabase `dd_user_config` / `tenants` PATCH)
 *   are caller-registered event handlers.
 */
import type Stripe from "stripe";

// ─── Idempotency store ────────────────────────────────────────────────────────

/** Replaces the `stripe_webhook_events` supabase table from the source. */
export interface WebhookEventStore {
  /** Returns true if this event ID has already been processed. */
  hasProcessed(eventId: string): Promise<boolean>;
  /** Record the event before processing (best-effort; failures must not block). */
  markProcessed(eventId: string, eventType: string): Promise<void>;
}

/** In-memory implementation — suitable for tests and single-process dev. */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly seen = new Map<string, string>();

  async hasProcessed(eventId: string): Promise<boolean> {
    return this.seen.has(eventId);
  }

  async markProcessed(eventId: string, eventType: string): Promise<void> {
    this.seen.set(eventId, eventType);
  }

  /** Test helper: number of recorded events. */
  get size(): number {
    return this.seen.size;
  }
}

// ─── Stripe 2025 period extraction ────────────────────────────────────────────

export interface SubscriptionPeriod {
  start: string | null;
  end: string | null;
}

/** Extract subscription period timestamps.
 *  Stripe API 2025+ moved current_period_start/end from Subscription to Subscription Item. */
export function getPeriod(sub: Record<string, unknown>): SubscriptionPeriod {
  let start = sub.current_period_start as number | undefined;
  let end = sub.current_period_end as number | undefined;

  if (!start || !end) {
    const items = sub.items as { data?: Array<Record<string, unknown>> } | undefined;
    const firstItem = items?.data?.[0];
    if (firstItem) {
      start = firstItem.current_period_start as number | undefined;
      end = firstItem.current_period_end as number | undefined;
    }
  }

  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  };
}

// ─── Event routing ────────────────────────────────────────────────────────────

/**
 * Caller-registered handler for a Stripe event type
 * (e.g. "checkout.session.completed", "customer.subscription.deleted",
 * "customer.subscription.trial_will_end").
 * Throwing (or rejecting) makes the processor return HTTP 400 so Stripe retries.
 */
export type StripeEventHandler = (event: Stripe.Event) => void | Promise<void>;

export interface WebhookProcessorOptions {
  /** Injected Stripe SDK instance. */
  stripe: Stripe;
  /** Webhook signing secret (e.g. from Secret Manager — never read from env here). */
  webhookSecret: string;
  /** Idempotency store. Omit to disable idempotency (source behavior without DB). */
  eventStore?: WebhookEventStore;
  /** Event-type → handler map. Unhandled event types are acknowledged with 200. */
  handlers?: Record<string, StripeEventHandler>;
  /** Error sink for handler failures (default: console.error). */
  onError?: (message: string, eventId: string) => void;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export class StripeWebhookProcessor {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly eventStore?: WebhookEventStore;
  private readonly handlers: Record<string, StripeEventHandler>;
  private readonly onError: (message: string, eventId: string) => void;

  constructor(options: WebhookProcessorOptions) {
    this.stripe = options.stripe;
    this.webhookSecret = options.webhookSecret;
    this.eventStore = options.eventStore;
    this.handlers = { ...options.handlers };
    this.onError =
      options.onError ??
      ((message, eventId) =>
        console.error(`[webhook] handler failed for event ${eventId}: ${message}`));
  }

  /** Register (or replace) a handler for a Stripe event type. Chainable. */
  on(eventType: string, handler: StripeEventHandler): this {
    this.handlers[eventType] = handler;
    return this;
  }

  /**
   * Process a raw webhook payload.
   * Mirrors the source flow: verify signature → idempotency check →
   * mark processed (best-effort) → dispatch handler → 400 on handler error
   * so Stripe retries.
   */
  async process(rawBody: string, signature: string | null): Promise<WebhookResult> {
    if (!signature) {
      return { status: 400, body: { error: "Missing signature" } };
    }

    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch {
      return { status: 400, body: { error: "Invalid signature" } };
    }

    // Idempotency check — skip if already processed
    if (this.eventStore) {
      if (await this.eventStore.hasProcessed(event.id)) {
        return { status: 200, body: { received: true, skipped: true } };
      }
      // Record this event before processing (best-effort; failures don't block processing)
      await this.eventStore.markProcessed(event.id, event.type).catch(() => {});
    }

    try {
      const handler = this.handlers[event.type];
      if (handler) await handler(event);
    } catch (err: unknown) {
      // Return 400 so Stripe retries the event
      const message = err instanceof Error ? err.message : "Unknown error";
      this.onError(message, event.id);
      return { status: 400, body: { error: "Plan update failed, will retry" } };
    }

    return { status: 200, body: { received: true } };
  }

  /** Fetch-API convenience wrapper: Request in → Response out. */
  async handleRequest(req: Request): Promise<Response> {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");
    const result = await this.process(body, signature);
    return Response.json(result.body, { status: result.status });
  }
}

// ─── Handler helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a customer's email from a customer ID.
 * Extracted from the source's customer.subscription.deleted / trial_will_end
 * branches (customers.retrieve → email). Returns null for deleted customers.
 */
export async function getCustomerEmail(
  stripe: Stripe,
  customerId: string,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId);
  if ((customer as Stripe.DeletedCustomer).deleted) return null;
  return (customer as Stripe.Customer).email ?? null;
}
