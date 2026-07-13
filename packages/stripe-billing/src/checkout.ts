/**
 * Stripe Checkout / Customer Portal session helpers.
 *
 * Ported from 実運用SaaS `server/routes/billing.ts`
 * (handleBillingCheckout / handleBillingPortal), with route/auth/env coupling
 * removed. Stripe SDK instance, URLs and trial days are all injected via config.
 */
import type Stripe from "stripe";

export interface CheckoutConfig {
  /** Injected Stripe SDK instance. */
  stripe: Stripe;
  /** Redirect after successful checkout (source: `${APP_URL}/settings?tab=billing&checkout=success`). */
  successUrl: string;
  /** Redirect after cancelled checkout (source: `${APP_URL}/pricing`). */
  cancelUrl: string;
  /**
   * Free-trial length in days. Source default was 14 (env STRIPE_TRIAL_DAYS,
   * gated by a feature flag); here it is plain config — set 0 to disable trials.
   * @default 14
   */
  trialDays?: number;
}

/**
 * Get or create a Stripe customer for an email
 * (search by email to avoid duplicates — same strategy as source).
 */
export async function getOrCreateCustomer(stripe: Stripe, email: string): Promise<string> {
  const existing = await stripe.customers.search({ query: `email:"${email}"`, limit: 1 });
  let customerId = existing.data[0]?.id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { user_email: email },
    });
    customerId = customer.id;
  }
  return customerId;
}

export interface CreateCheckoutParams {
  email: string;
  /** Stripe Price ID for the subscription line item. */
  priceId: string;
  /** Extra metadata merged into the session (source set product_key / plan_key here). */
  metadata?: Record<string, string>;
  /** Per-call override of config.trialDays. */
  trialDays?: number;
}

export interface CheckoutSessionResult {
  url: string | null;
  sessionId: string;
  customerId: string;
}

/** Create a subscription-mode Checkout session (with optional free trial). */
export async function createCheckoutSession(
  config: CheckoutConfig,
  params: CreateCheckoutParams,
): Promise<CheckoutSessionResult> {
  const customerId = await getOrCreateCustomer(config.stripe, params.email);

  const trialDays = params.trialDays ?? config.trialDays ?? 14;
  const isTrialEnabled = trialDays > 0;

  const session = await config.stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: config.successUrl,
    cancel_url: config.cancelUrl,
    metadata: { user_email: params.email, ...params.metadata },
    ...(isTrialEnabled ? { subscription_data: { trial_period_days: trialDays } } : {}),
  });

  return { url: session.url, sessionId: session.id, customerId };
}

export interface CreatePortalParams {
  email: string;
  /** Where the portal's "back" link returns to (source: `${APP_URL}/settings?tab=billing`). */
  returnUrl: string;
}

/**
 * Create a Customer Portal session for an existing customer.
 * Returns null when no Stripe customer exists for the email
 * (source responded 404 "No billing account found" — HTTP mapping is the caller's job).
 */
export async function createPortalSession(
  stripe: Stripe,
  params: CreatePortalParams,
): Promise<{ url: string } | null> {
  const existing = await stripe.customers.search({
    query: `email:"${params.email}"`,
    limit: 1,
  });
  const customerId = existing.data[0]?.id;
  if (!customerId) return null;

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: params.returnUrl,
  });
  return { url: session.url };
}
