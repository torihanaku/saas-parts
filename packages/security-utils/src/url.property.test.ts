/**
 * Property-based tests (fast-check) for the SSRF surface.
 *
 * These encode INVARIANTS that must hold for ALL inputs — the class of bug the
 * manual audit found by hand (a crafted host slipping through). fast-check
 * generates thousands of adversarial strings so a future regression is caught
 * automatically instead of relying on someone thinking of the exact payload.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isPrivateIp, validateWebhookUrl } from "./url";

describe("isPrivateIp — properties", () => {
  it("never throws on arbitrary input (malformed = unsafe, not a crash)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof isPrivateIp(s)).toBe("boolean");
      })
    );
  });

  it("always flags every address in the RFC1918 / loopback / link-local ranges", () => {
    const privateV4 = fc.oneof(
      fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(192), fc.constant(168), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(169), fc.constant(254), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.nat(255), fc.nat(255))
    );
    fc.assert(
      fc.property(privateV4, (octets) => {
        expect(isPrivateIp(octets.join("."))).toBe(true);
      })
    );
  });
});

describe("validateWebhookUrl — properties", () => {
  it("never throws; result is always null or a string reason", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = validateWebhookUrl(s);
        expect(r === null || typeof r === "string").toBe(true);
      })
    );
  });

  it("never accepts a non-https scheme", () => {
    const nonHttps = fc.oneof(
      fc.constant("http"),
      fc.constant("ftp"),
      fc.constant("file"),
      fc.constant("gopher"),
      fc.constant("ws")
    );
    fc.assert(
      fc.property(nonHttps, fc.domain(), (scheme, host) => {
        expect(validateWebhookUrl(`${scheme}://${host}/hook`)).not.toBeNull();
      })
    );
  });
});
