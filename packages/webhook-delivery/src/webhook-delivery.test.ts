import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  WebhookDeliverer,
  type WebhookEndpoint,
  type DeliveryLogStore,
  type EndpointSource,
} from "./index";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENDPOINT: WebhookEndpoint = {
  id: "ep-1",
  user_id: "user-1",
  url: "https://example.com/webhook",
  secret: "test-secret",
  events: ["content.created"],
  enabled: true,
};

// Injected replacements for the original supabase mocks
const listEnabledEndpoints = vi.fn<EndpointSource["listEnabledEndpoints"]>();
const logDelivery = vi.fn<DeliveryLogStore["logDelivery"]>();

function makeDeliverer(overrides: ConstructorParameters<typeof WebhookDeliverer>[0] = {}) {
  return new WebhookDeliverer({
    endpointSource: { listEnabledEndpoints },
    logStore: { logDelivery },
    ...overrides,
  });
}

describe("webhook-delivery", () => {
  beforeEach(() => {
    listEnabledEndpoints.mockReset();
    logDelivery.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("trigger", () => {
    it("returns early when no endpoints exist", async () => {
      listEnabledEndpoints.mockResolvedValue([]);
      await makeDeliverer().trigger("user-1", "content.created", { foo: "bar" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips endpoints that don't match the event", async () => {
      listEnabledEndpoints.mockResolvedValue([{ ...ENDPOINT, events: ["user.invited"] }]);
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });
      await makeDeliverer().trigger("user-1", "content.created", { foo: "bar" });
      // allow microtask queue
      await new Promise((r) => setImmediate(r));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("delivers when event matches wildcard '*'", async () => {
      listEnabledEndpoints.mockResolvedValue([{ ...ENDPOINT, events: ["*"] }]);
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });
      await makeDeliverer().trigger("user-1", "any.event", { foo: "bar" });
      await new Promise((r) => setImmediate(r));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles endpoint lookup failure gracefully", async () => {
      listEnabledEndpoints.mockRejectedValue(new Error("DB down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await makeDeliverer().trigger("user-1", "content.created", { foo: "bar" });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("deliver", () => {
    it("POSTs to endpoint URL with signature header", async () => {
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });

      await makeDeliverer().deliver(ENDPOINT, "content.created", { id: 1 });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Folia-Signature": expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      );
    });

    it("logs delivery status 200", async () => {
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });

      await makeDeliverer().deliver(ENDPOINT, "content.created", {});

      expect(logDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint_id: "ep-1",
          event_type: "content.created",
          status_code: 200,
          attempt: 1,
        }),
      );
    });

    it("records status_code=0 on network failure", async () => {
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      await makeDeliverer().deliver(ENDPOINT, "content.created", {});

      expect(logDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          status_code: 0,
          response_body: "ECONNREFUSED",
        }),
      );
    });

    it("truncates long response bodies to 2000 chars", async () => {
      logDelivery.mockResolvedValue(undefined);
      const longResponse = "x".repeat(5000);
      mockFetch.mockResolvedValue({ status: 500, text: async () => longResponse });

      await makeDeliverer().deliver(ENDPOINT, "content.created", {});

      const call = logDelivery.mock.calls[0]!;
      expect(call[0].response_body.length).toBe(2000);
    });

    it("handles log store failure without throwing", async () => {
      logDelivery.mockRejectedValue(new Error("DB error"));
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        makeDeliverer().deliver(ENDPOINT, "content.created", {}),
      ).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("deliverWithRetry", () => {
    it("retries with exponential backoff (2s -> 4s) until success", async () => {
      vi.useFakeTimers();
      logDelivery.mockResolvedValue(undefined);
      mockFetch
        .mockResolvedValueOnce({ status: 500, text: async () => "boom" })
        .mockResolvedValueOnce({ status: 500, text: async () => "boom" })
        .mockResolvedValueOnce({ status: 200, text: async () => "ok" });

      const promise = makeDeliverer().deliverWithRetry(ENDPOINT, "content.created", {});

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // first backoff: 2000ms
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // second backoff: 4000ms
      await vi.advanceTimersByTimeAsync(3999);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toEqual({ ok: true, attempts: 3, lastStatusCode: 200 });

      // every attempt is audit-logged with its attempt number
      expect(logDelivery).toHaveBeenCalledTimes(3);
      expect(logDelivery.mock.calls.map((c) => c[0].attempt)).toEqual([1, 2, 3]);
    });

    it("gives up after maxRetries and reports failure", async () => {
      vi.useFakeTimers();
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const promise = makeDeliverer({ maxRetries: 2, backoffBaseMs: 1000 }).deliverWithRetry(
        ENDPOINT,
        "content.created",
        {},
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      // 1 initial attempt + 2 retries
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ ok: false, attempts: 3, lastStatusCode: 0 });
    });

    it("succeeds immediately without sleeping on first 200", async () => {
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });

      const result = await makeDeliverer().deliverWithRetry(ENDPOINT, "content.created", {});

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, attempts: 1, lastStatusCode: 200 });
    });
  });

  describe("config injection", () => {
    it("uses custom signature header, user agent, and truncation length", async () => {
      logDelivery.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({ status: 200, text: async () => "y".repeat(100) });

      const deliverer = makeDeliverer({
        signatureHeader: "X-Custom-Sig",
        userAgent: "Acme-Hooks/2.0",
        maxResponseBodyLength: 10,
      });
      await deliverer.deliver(ENDPOINT, "content.created", {});

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Custom-Sig": expect.stringMatching(/^[a-f0-9]{64}$/),
            "User-Agent": "Acme-Hooks/2.0",
          }),
        }),
      );
      expect(logDelivery.mock.calls[0]![0].response_body).toBe("y".repeat(10));
    });

    it("defaults to no-op stores and does not throw without injection", async () => {
      mockFetch.mockResolvedValue({ status: 200, text: async () => "ok" });
      const deliverer = new WebhookDeliverer();
      await expect(deliverer.deliver(ENDPOINT, "content.created", {})).resolves.toBeUndefined();
      // default endpoint source yields nothing
      await deliverer.trigger("user-1", "content.created", {});
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
