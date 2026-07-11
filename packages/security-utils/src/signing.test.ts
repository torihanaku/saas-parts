import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "./signing";

describe("webhook-signing", () => {
  const SECRET = "test-secret-key";
  const PAYLOAD = JSON.stringify({ event: "content.created", id: "abc123" });

  describe("signPayload", () => {
    it("returns deterministic HMAC-SHA256 hex for same payload+secret", () => {
      const sig1 = signPayload(PAYLOAD, SECRET);
      const sig2 = signPayload(PAYLOAD, SECRET);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("returns different signatures for different payloads", () => {
      const sig1 = signPayload("payload-a", SECRET);
      const sig2 = signPayload("payload-b", SECRET);
      expect(sig1).not.toBe(sig2);
    });

    it("returns different signatures for different secrets", () => {
      const sig1 = signPayload(PAYLOAD, "secret-1");
      const sig2 = signPayload(PAYLOAD, "secret-2");
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("verifySignature", () => {
    it("returns true for valid signature", () => {
      const signature = signPayload(PAYLOAD, SECRET);
      expect(verifySignature(PAYLOAD, signature, SECRET)).toBe(true);
    });

    it("returns false for tampered payload", () => {
      const signature = signPayload(PAYLOAD, SECRET);
      expect(verifySignature("tampered", signature, SECRET)).toBe(false);
    });

    it("returns false for wrong secret", () => {
      const signature = signPayload(PAYLOAD, SECRET);
      expect(verifySignature(PAYLOAD, signature, "wrong-secret")).toBe(false);
    });

    it("returns false for mismatched signature length", () => {
      expect(verifySignature(PAYLOAD, "abc", SECRET)).toBe(false);
    });

    it("returns false for malformed hex signature without throwing", () => {
      const badSignature = "x".repeat(64);
      expect(() => verifySignature(PAYLOAD, badSignature, SECRET)).not.toThrow();
      expect(verifySignature(PAYLOAD, badSignature, SECRET)).toBe(false);
    });

    it("returns false for empty signature", () => {
      expect(verifySignature(PAYLOAD, "", SECRET)).toBe(false);
    });
  });
});
