/**
 * Webhook delivery service — handles outbound HTTP POST requests to configured endpoints.
 *
 * Ported from 実運用SaaS/server/lib/webhook-delivery.ts.
 * Supabase persistence is replaced by injected `EndpointSource` / `DeliveryLogStore`
 * interfaces, and all behavior knobs (timeout, header names, retry policy) are
 * constructor-injected with defaults preserving the original behavior.
 */
import { signPayload } from "./signing";

export interface WebhookEndpoint {
  id: string;
  user_id: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
}

/** One delivery-attempt audit record (mirrors the original `dd_webhook_deliveries` row). */
export interface WebhookDeliveryRecord {
  endpoint_id: string;
  event_type: string;
  payload: unknown;
  status_code: number;
  response_body: string;
  delivered_at: string;
  attempt: number;
}

/** Injected audit-trail sink (replaces `supabaseInsert("dd_webhook_deliveries", ...)`). */
export interface DeliveryLogStore {
  logDelivery(record: WebhookDeliveryRecord): Promise<void>;
}

/** Injected endpoint lookup (replaces `supabaseGet("dd_webhook_endpoints", ...)`).
 * Must return only enabled endpoints for the given user. */
export interface EndpointSource {
  listEnabledEndpoints(userId: string): Promise<WebhookEndpoint[]>;
}

/** Default log store: discards records. */
export const noopDeliveryLogStore: DeliveryLogStore = {
  async logDelivery(): Promise<void> {
    /* no-op */
  },
};

/** Default endpoint source: no endpoints. */
export const emptyEndpointSource: EndpointSource = {
  async listEnabledEndpoints(): Promise<WebhookEndpoint[]> {
    return [];
  },
};

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  lastStatusCode: number;
}

export interface WebhookDelivererConfig {
  /** Where to look up endpoints for `trigger()`. Default: empty source. */
  endpointSource?: EndpointSource;
  /** Where delivery attempts are logged. Default: no-op. */
  logStore?: DeliveryLogStore;
  /** Per-request timeout in ms. Default: 10000 (original hard-coded value). */
  timeoutMs?: number;
  /** Signature header name. Default: "X-Folia-Signature" (original value). */
  signatureHeader?: string;
  /** User-Agent header. Default: "Folia-Webhook-Delivery/1.0" (original value). */
  userAgent?: string;
  /** Response body truncation length for the audit log. Default: 2000 (original value). */
  maxResponseBodyLength?: number;
  /** Max retries after the first attempt, for `deliverWithRetry()`. Default: 5. */
  maxRetries?: number;
  /** Exponential backoff base in ms for `deliverWithRetry()` (2s -> 4s -> 8s ...). Default: 2000. */
  backoffBaseMs?: number;
  /** Error reporter. Default: console.error (original behavior). */
  onError?: (message: string, err: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebhookDeliverer {
  private readonly endpointSource: EndpointSource;
  private readonly logStore: DeliveryLogStore;
  private readonly timeoutMs: number;
  private readonly signatureHeader: string;
  private readonly userAgent: string;
  private readonly maxResponseBodyLength: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly onError: (message: string, err: unknown) => void;

  constructor(config: WebhookDelivererConfig = {}) {
    this.endpointSource = config.endpointSource ?? emptyEndpointSource;
    this.logStore = config.logStore ?? noopDeliveryLogStore;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.signatureHeader = config.signatureHeader ?? "X-Folia-Signature";
    this.userAgent = config.userAgent ?? "Folia-Webhook-Delivery/1.0";
    this.maxResponseBodyLength = config.maxResponseBodyLength ?? 2000;
    this.maxRetries = config.maxRetries ?? 5;
    this.backoffBaseMs = config.backoffBaseMs ?? 2000;
    this.onError = config.onError ?? ((message, err) => console.error(message, err));
  }

  /**
   * Delivers a webhook event to all matching endpoints for a user.
   * (Port of `triggerWebhooks` — fire-and-forget per endpoint.)
   */
  async trigger(userId: string, eventType: string, payload: unknown): Promise<void> {
    try {
      // 1. Find matching endpoints
      const endpoints = await this.endpointSource.listEnabledEndpoints(userId);
      if (!endpoints || endpoints.length === 0) return;

      for (const endpoint of endpoints) {
        // 2. Check if endpoint is interested in this event (or all events "*")
        if (!endpoint.events.includes("*") && !endpoint.events.includes(eventType)) continue;

        // 3. Deliver asynchronously (don't await individual deliveries)
        this.deliver(endpoint, eventType, payload).catch((err) => {
          this.onError(`[Webhook] Delivery failed for endpoint ${endpoint.id}:`, err);
        });
      }
    } catch (err) {
      this.onError("[Webhook] Failed to fetch endpoints:", err);
    }
  }

  /**
   * Performs the actual HTTP POST to a specific endpoint and logs the result.
   * (Port of `deliverToEndpoint` — single attempt; `attempt` is only recorded
   * in the audit trail, exactly like the original.)
   */
  async deliver(
    endpoint: WebhookEndpoint,
    eventType: string,
    payload: unknown,
    attempt = 1,
  ): Promise<void> {
    await this.deliverOnce(endpoint, eventType, payload, attempt);
  }

  /**
   * Delivers with in-process exponential backoff (2s -> 4s -> 8s ... by default).
   * First attempt + up to `maxRetries` retries. Every attempt is logged to the
   * audit trail. Success = HTTP 200/201 (the statuses the original retry job
   * treated as terminal).
   *
   * NOTE: the original project retried via an external cron job; this method is
   * the in-process equivalent added for reusability.
   */
  async deliverWithRetry(
    endpoint: WebhookEndpoint,
    eventType: string,
    payload: unknown,
  ): Promise<DeliveryResult> {
    let attempt = 1;
    for (;;) {
      const statusCode = await this.deliverOnce(endpoint, eventType, payload, attempt);
      if (statusCode === 200 || statusCode === 201) {
        return { ok: true, attempts: attempt, lastStatusCode: statusCode };
      }
      if (attempt > this.maxRetries) {
        return { ok: false, attempts: attempt, lastStatusCode: statusCode };
      }
      await sleep(this.backoffBaseMs * 2 ** (attempt - 1));
      attempt++;
    }
  }

  private async deliverOnce(
    endpoint: WebhookEndpoint,
    eventType: string,
    payload: unknown,
    attempt: number,
  ): Promise<number> {
    const body = JSON.stringify({
      id: crypto.randomUUID(),
      event: eventType,
      created: new Date().toISOString(),
      data: payload,
    });

    const signature = signPayload(body, endpoint.secret);

    let statusCode: number;
    let responseBody: string;

    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [this.signatureHeader]: signature,
          "User-Agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      statusCode = res.status;
      responseBody = await res.text();
    } catch (err: unknown) {
      responseBody = err instanceof Error ? err.message : String(err);
      statusCode = 0; // Connection error
    }

    // Log delivery attempt
    try {
      await this.logStore.logDelivery({
        endpoint_id: endpoint.id,
        event_type: eventType,
        payload,
        status_code: statusCode,
        response_body: responseBody.substring(0, this.maxResponseBodyLength), // Truncate long responses
        delivered_at: new Date().toISOString(),
        attempt,
      });
    } catch (err) {
      this.onError("[Webhook] Failed to log delivery:", err);
    }

    return statusCode;
  }
}
