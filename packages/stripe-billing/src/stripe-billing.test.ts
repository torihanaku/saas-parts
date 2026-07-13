/**
 * Tests for @torihanaku/stripe-billing.
 * Stripe SDK is mocked; behaviors ported from dev-dashboard-v2
 * tests/billing-routes.test.ts plus new coverage for the extracted library.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import {
  StripeWebhookProcessor,
  InMemoryWebhookEventStore,
  getPeriod,
  getCustomerEmail,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
} from "./index.js";

// ─── Stripe SDK mock ──────────────────────────────────────────────────────────

function makeStripeMock() {
  const mock = {
    webhooks: { constructEventAsync: vi.fn() },
    customers: { search: vi.fn(), create: vi.fn(), retrieve: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
  };
  return { mock, stripe: mock as unknown as Stripe };
}

const WEBHOOK_SECRET = "whsec_test_fake";

function makeEvent(type: string, obj: Record<string, unknown> = {}, id = "evt_test_1"): Stripe.Event {
  return { id, type, data: { object: obj } } as unknown as Stripe.Event;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getPeriod (Stripe 2025 API compat) ───────────────────────────────────────

describe("getPeriod", () => {
  it("reads period from top-level fields (pre-2025 shape)", () => {
    const period = getPeriod({
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    });
    expect(period.start).toBe(new Date(1700000000 * 1000).toISOString());
    expect(period.end).toBe(new Date(1702592000 * 1000).toISOString());
  });

  it("falls back to first Subscription Item (2025+ shape)", () => {
    const period = getPeriod({
      items: {
        data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }],
      },
    });
    expect(period.start).toBe(new Date(1700000000 * 1000).toISOString());
    expect(period.end).toBe(new Date(1702592000 * 1000).toISOString());
  });

  it("returns nulls when no period info exists", () => {
    expect(getPeriod({})).toEqual({ start: null, end: null });
  });
});

// ─── Webhook processing ───────────────────────────────────────────────────────

describe("StripeWebhookProcessor", () => {
  it("returns 400 when signature header is missing", async () => {
    const { stripe } = makeStripeMock();
    const processor = new StripeWebhookProcessor({ stripe, webhookSecret: WEBHOOK_SECRET });
    const result = await processor.process("{}", null);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Missing signature");
  });

  it("returns 400 when signature verification fails", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockRejectedValue(new Error("bad sig"));
    const processor = new StripeWebhookProcessor({ stripe, webhookSecret: WEBHOOK_SECRET });
    const result = await processor.process("{}", "t=1,v1=deadbeef");
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Invalid signature");
  });

  it("verifies via constructEventAsync with the injected secret", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("checkout.session.completed"));
    const processor = new StripeWebhookProcessor({ stripe, webhookSecret: WEBHOOK_SECRET });
    await processor.process("raw-body", "sig-header");
    expect(mock.webhooks.constructEventAsync).toHaveBeenCalledWith(
      "raw-body",
      "sig-header",
      WEBHOOK_SECRET,
    );
  });

  it("routes events to caller-registered handlers", async () => {
    const { mock, stripe } = makeStripeMock();
    const obj = { metadata: { user_email: "user@test.com" } };
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("checkout.session.completed", obj));

    const onCompleted = vi.fn();
    const processor = new StripeWebhookProcessor({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      handlers: { "checkout.session.completed": onCompleted },
    });

    const result = await processor.process("{}", "sig");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(onCompleted).toHaveBeenCalledOnce();
    const event = onCompleted.mock.calls[0]![0] as Stripe.Event;
    expect(event.type).toBe("checkout.session.completed");
    expect((event.data.object as unknown as Record<string, unknown>).metadata).toEqual({
      user_email: "user@test.com",
    });
  });

  it("acknowledges unhandled event types with 200 (no handler called)", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("invoice.paid"));
    const onDeleted = vi.fn();
    const processor = new StripeWebhookProcessor({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      handlers: { "customer.subscription.deleted": onDeleted },
    });
    const result = await processor.process("{}", "sig");
    expect(result.status).toBe(200);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("supports chainable .on() registration", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(
      makeEvent("customer.subscription.trial_will_end", { customer: "cus_1" }),
    );
    const onTrialEnd = vi.fn();
    const processor = new StripeWebhookProcessor({ stripe, webhookSecret: WEBHOOK_SECRET })
      .on("customer.subscription.trial_will_end", onTrialEnd);
    await processor.process("{}", "sig");
    expect(onTrialEnd).toHaveBeenCalledOnce();
  });

  it("returns 400 when a handler throws, so Stripe retries", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("customer.subscription.deleted"));
    const onError = vi.fn();
    const processor = new StripeWebhookProcessor({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      handlers: {
        "customer.subscription.deleted": () => {
          throw new Error("plan update failed");
        },
      },
      onError,
    });
    const result = await processor.process("{}", "sig");
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Plan update failed, will retry");
    expect(onError).toHaveBeenCalledWith("plan update failed", "evt_test_1");
  });

  it("does NOT mark a failed event processed, so Stripe's retry re-runs it", async () => {
    // Regression: marking-before-processing dropped failed events on retry.
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("checkout.session.completed"));
    const store = new InMemoryWebhookEventStore();
    let attempts = 0;
    const handler = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient failure");
    });
    const processor = new StripeWebhookProcessor({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      eventStore: store,
      handlers: { "checkout.session.completed": handler },
      onError: () => {},
    });

    // First delivery fails → 400, event must NOT be recorded.
    const first = await processor.process("{}", "sig");
    expect(first.status).toBe(400);
    expect(store.size).toBe(0);

    // Stripe retries the same event → handler runs again and succeeds.
    const retry = await processor.process("{}", "sig");
    expect(retry.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(1);
  });

  it("skips already-processed events via the event store (idempotency)", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("checkout.session.completed"));
    const handler = vi.fn();
    const store = new InMemoryWebhookEventStore();
    const processor = new StripeWebhookProcessor({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      eventStore: store,
      handlers: { "checkout.session.completed": handler },
    });

    const first = await processor.process("{}", "sig");
    expect(first.body).toEqual({ received: true });

    const second = await processor.process("{}", "sig");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, skipped: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.size).toBe(1);
  });

  it("continues processing when markProcessed fails (best-effort)", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("checkout.session.completed"));
    const handler = vi.fn();
    const flakyStore = {
      hasProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const processor = new StripeWebhookProcessor({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      eventStore: flakyStore,
      handlers: { "checkout.session.completed": handler },
    });
    const result = await processor.process("{}", "sig");
    expect(result.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("handleRequest maps a fetch Request to a Response", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.webhooks.constructEventAsync.mockResolvedValue(makeEvent("checkout.session.completed"));
    const processor = new StripeWebhookProcessor({ stripe, webhookSecret: WEBHOOK_SECRET });

    const req = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      body: "payload",
      headers: { "stripe-signature": "sig" },
    });
    const res = await processor.handleRequest(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("handleRequest returns 400 when stripe-signature header is absent", async () => {
    const { stripe } = makeStripeMock();
    const processor = new StripeWebhookProcessor({ stripe, webhookSecret: WEBHOOK_SECRET });
    const req = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      body: "payload",
    });
    const res = await processor.handleRequest(req);
    expect(res.status).toBe(400);
  });
});

// ─── getCustomerEmail ─────────────────────────────────────────────────────────

describe("getCustomerEmail", () => {
  it("returns the customer's email", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.retrieve.mockResolvedValue({ id: "cus_1", email: "user@test.com" });
    expect(await getCustomerEmail(stripe, "cus_1")).toBe("user@test.com");
  });

  it("returns null for deleted customers", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.retrieve.mockResolvedValue({ id: "cus_1", deleted: true });
    expect(await getCustomerEmail(stripe, "cus_1")).toBeNull();
  });

  it("returns null when email is missing", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.retrieve.mockResolvedValue({ id: "cus_1", email: null });
    expect(await getCustomerEmail(stripe, "cus_1")).toBeNull();
  });
});

// ─── Checkout session ─────────────────────────────────────────────────────────

describe("createCheckoutSession", () => {
  const baseConfig = {
    successUrl: "https://app.example.com/settings?tab=billing&checkout=success",
    cancelUrl: "https://app.example.com/pricing",
  };

  it("reuses an existing customer found by email search", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [{ id: "cus_existing" }] });
    mock.checkout.sessions.create.mockResolvedValue({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/pay/cs_1",
    });

    const result = await createCheckoutSession(
      { stripe, ...baseConfig },
      { email: "user@test.com", priceId: "price_pro" },
    );

    expect(mock.customers.search).toHaveBeenCalledWith({
      query: 'email:"user@test.com"',
      limit: 1,
    });
    expect(mock.customers.create).not.toHaveBeenCalled();
    expect(result.customerId).toBe("cus_existing");
    expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(result.sessionId).toBe("cs_1");
  });

  it("creates a customer when none exists", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [] });
    mock.customers.create.mockResolvedValue({ id: "cus_new" });
    mock.checkout.sessions.create.mockResolvedValue({ id: "cs_2", url: "https://x" });

    const result = await createCheckoutSession(
      { stripe, ...baseConfig },
      { email: "new@test.com", priceId: "price_pro" },
    );

    expect(mock.customers.create).toHaveBeenCalledWith({
      email: "new@test.com",
      metadata: { user_email: "new@test.com" },
    });
    expect(result.customerId).toBe("cus_new");
  });

  it("applies the default 14-day trial and merges metadata", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [{ id: "cus_1" }] });
    mock.checkout.sessions.create.mockResolvedValue({ id: "cs_3", url: "https://x" });

    await createCheckoutSession(
      { stripe, ...baseConfig },
      {
        email: "user@test.com",
        priceId: "price_pro",
        metadata: { product_key: "cos", plan_key: "pro" },
      },
    );

    expect(mock.checkout.sessions.create).toHaveBeenCalledWith({
      customer: "cus_1",
      mode: "subscription",
      line_items: [{ price: "price_pro", quantity: 1 }],
      success_url: baseConfig.successUrl,
      cancel_url: baseConfig.cancelUrl,
      metadata: { user_email: "user@test.com", product_key: "cos", plan_key: "pro" },
      subscription_data: { trial_period_days: 14 },
    });
  });

  it("omits trial when trialDays is 0", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [{ id: "cus_1" }] });
    mock.checkout.sessions.create.mockResolvedValue({ id: "cs_4", url: "https://x" });

    await createCheckoutSession(
      { stripe, ...baseConfig, trialDays: 0 },
      { email: "user@test.com", priceId: "price_pro" },
    );

    const args = mock.checkout.sessions.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.subscription_data).toBeUndefined();
  });

  it("per-call trialDays overrides config", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [{ id: "cus_1" }] });
    mock.checkout.sessions.create.mockResolvedValue({ id: "cs_5", url: "https://x" });

    await createCheckoutSession(
      { stripe, ...baseConfig, trialDays: 14 },
      { email: "user@test.com", priceId: "price_pro", trialDays: 7 },
    );

    const args = mock.checkout.sessions.create.mock.calls[0]![0] as {
      subscription_data?: { trial_period_days: number };
    };
    expect(args.subscription_data?.trial_period_days).toBe(7);
  });
});

// ─── Portal session ───────────────────────────────────────────────────────────

describe("createPortalSession", () => {
  it("creates a portal session for an existing customer", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [{ id: "cus_1" }] });
    mock.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/p/session_1",
    });

    const result = await createPortalSession(stripe, {
      email: "user@test.com",
      returnUrl: "https://app.example.com/settings?tab=billing",
    });

    expect(mock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_1",
      return_url: "https://app.example.com/settings?tab=billing",
    });
    expect(result).toEqual({ url: "https://billing.stripe.com/p/session_1" });
  });

  it("returns null when no customer exists (source: 404 No billing account)", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [] });
    const result = await createPortalSession(stripe, {
      email: "nobody@test.com",
      returnUrl: "https://app.example.com/settings",
    });
    expect(result).toBeNull();
    expect(mock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});

// ─── getOrCreateCustomer ──────────────────────────────────────────────────────

describe("getOrCreateCustomer", () => {
  it("returns existing customer id without creating", async () => {
    const { mock, stripe } = makeStripeMock();
    mock.customers.search.mockResolvedValue({ data: [{ id: "cus_hit" }] });
    expect(await getOrCreateCustomer(stripe, "a@b.com")).toBe("cus_hit");
    expect(mock.customers.create).not.toHaveBeenCalled();
  });
});
