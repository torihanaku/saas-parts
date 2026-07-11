import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateWebhookUrl, headCheck, filterReachableUrls } from "./url";

describe("validateWebhookUrl", () => {
  describe("valid URLs", () => {
    it("accepts a plain HTTPS public URL", () => {
      expect(validateWebhookUrl("https://example.com/hook")).toBeNull();
    });

    it("accepts HTTPS with a port and query string", () => {
      expect(validateWebhookUrl("https://api.example.com:8443/hook?sig=abc")).toBeNull();
    });

    it("accepts a subdomain on a public TLD", () => {
      expect(validateWebhookUrl("https://webhook.user-service.prod.example.org/x")).toBeNull();
    });
  });

  describe("length enforcement", () => {
    it("rejects URLs longer than 2048 characters", () => {
      const long = "https://example.com/" + "a".repeat(2100);
      expect(validateWebhookUrl(long)).toBe("URL exceeds maximum length");
    });

    it("accepts URLs exactly at the 2048 limit", () => {
      const suffix = "a".repeat(2048 - "https://example.com/".length);
      const url = "https://example.com/" + suffix;
      expect(url.length).toBe(2048);
      expect(validateWebhookUrl(url)).toBeNull();
    });
  });

  describe("URL format enforcement", () => {
    it("rejects garbage strings", () => {
      expect(validateWebhookUrl("not a url")).toBe("Invalid URL format");
    });

    it("rejects an empty string as invalid format", () => {
      expect(validateWebhookUrl("")).toBe("Invalid URL format");
    });

    it("rejects a bare hostname without scheme", () => {
      expect(validateWebhookUrl("example.com/hook")).toBe("Invalid URL format");
    });
  });

  describe("scheme enforcement", () => {
    it("rejects http://", () => {
      expect(validateWebhookUrl("http://example.com/hook")).toBe("Webhook URL must use HTTPS");
    });

    it("rejects ftp://", () => {
      expect(validateWebhookUrl("ftp://example.com/file")).toBe("Webhook URL must use HTTPS");
    });

    it("rejects file://", () => {
      expect(validateWebhookUrl("file:///etc/passwd")).toBe("Webhook URL must use HTTPS");
    });
  });

  describe("SSRF protection — private and internal ranges", () => {
    const privateHosts: Array<[string, string]> = [
      ["localhost", "https://localhost/hook"],
      ["127.0.0.1 loopback", "https://127.0.0.1/hook"],
      ["127.255.255.255 loopback upper", "https://127.255.255.255/hook"],
      ["RFC1918 10.x", "https://10.0.0.1/hook"],
      ["RFC1918 172.16.x", "https://172.16.5.10/hook"],
      ["RFC1918 172.31.x", "https://172.31.255.254/hook"],
      ["RFC1918 192.168.x", "https://192.168.1.1/hook"],
      ["0.0.0.0", "https://0.0.0.0/hook"],
      ["link-local 169.254.x", "https://169.254.169.254/latest/meta-data/"],
      ["GCP metadata", "https://metadata.google.internal/computeMetadata/v1/"],
      [".local mDNS", "https://printer.local/hook"],
      [".internal", "https://db.internal/hook"],
      [".localhost", "https://admin.localhost/hook"],
      ["IPv6 loopback", "https://[::1]/hook"],
      ["IPv6 unique-local fc00::", "https://[fc00::1]/hook"],
      ["IPv6 unique-local fd00::", "https://[fd00:abcd::1]/hook"],
      ["IPv6 link-local fe80::", "https://[fe80::1]/hook"],
    ];

    for (const [label, url] of privateHosts) {
      it(`rejects ${label}`, () => {
        expect(validateWebhookUrl(url)).toBe(
          "Webhook URL must not target private or internal addresses"
        );
      });
    }

    it("is case-insensitive on hostname match", () => {
      expect(validateWebhookUrl("https://LOCALHOST/hook")).toBe(
        "Webhook URL must not target private or internal addresses"
      );
    });

    it("checks length first, then format, then scheme, then SSRF", () => {
      // A private IP with http:// should fail on scheme, not SSRF,
      // because scheme is checked before the hostname loop.
      expect(validateWebhookUrl("http://10.0.0.1/hook")).toBe("Webhook URL must use HTTPS");
    });
  });
});

describe("headCheck / filterReachableUrls", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("headCheck", () => {
    it("rejects non-HTTPS URL via preflight", async () => {
      const result = await headCheck("http://example.com");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("HTTPS");
      // fetch must not be called when preflight rejects
    });

    it("rejects private IP via preflight", async () => {
      const result = await headCheck("https://127.0.0.1");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("private");
    });

    it("rejects localhost via preflight", async () => {
      const result = await headCheck("https://localhost/hook");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("private");
    });

    it("rejects malformed URL", async () => {
      const result = await headCheck("not a url");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Invalid");
    });

    it("returns ok=true for 200 response", async () => {
      global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
      const result = await headCheck("https://example.com");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    });

    it("returns ok=true for 301 redirect chain (redirect: follow)", async () => {
      global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
      const result = await headCheck("https://example.com");
      expect(result.ok).toBe(true);
    });

    it("returns ok=false for 404", async () => {
      global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
      const result = await headCheck("https://example.com");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.reason).toContain("non-success");
    });

    it("returns ok=false on timeout (AbortError)", async () => {
      global.fetch = vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }) as typeof fetch;
      const result = await headCheck("https://example.com", 10);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("timeout");
    });

    it("returns ok=false on network error with reason", async () => {
      global.fetch = vi.fn(async () => {
        throw new Error("econnrefused");
      }) as typeof fetch;
      const result = await headCheck("https://example.com");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("econnrefused");
    });
  });

  describe("filterReachableUrls", () => {
    it("keeps only reachable URLs and logs rejected ones", async () => {
      const urls = [
        "https://good.example.com",
        "http://insecure.example.com",
        "https://notfound.example.com",
      ];

      global.fetch = vi.fn(async (input: unknown) => {
        const url = input instanceof URL ? input.toString() : String(input);
        if (url.includes("good")) return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
      }) as typeof fetch;

      const onReject = vi.fn();
      const kept = await filterReachableUrls(urls, { onReject });

      expect(kept).toEqual(["https://good.example.com"]);
      expect(onReject).toHaveBeenCalledTimes(2);
      expect(onReject).toHaveBeenCalledWith(
        "http://insecure.example.com",
        expect.stringContaining("HTTPS")
      );
    });

    it("returns empty array when no URLs are reachable", async () => {
      global.fetch = vi.fn(async () => new Response(null, { status: 500 })) as typeof fetch;
      const kept = await filterReachableUrls(
        ["https://a.example.com", "https://b.example.com"],
        { onReject: () => {} }
      );
      expect(kept).toEqual([]);
    });

    it("uses default console.warn logger when onReject is not provided", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;

      await filterReachableUrls(["https://broken.example.com"]);

      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls[0]?.[0];
      expect(logged).toContain("url_rejected");
      warnSpy.mockRestore();
    });
  });
});
