import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./slackSignature.js";

const FAKE_SECRET = "test-signing-secret-not-a-real-one";
const NOW = 1_750_000_000; // fixed epoch seconds

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const ts = String(NOW);

  it("accepts a correctly signed request", () => {
    expect(verifySlackSignature(FAKE_SECRET, body, ts, sign(FAKE_SECRET, ts, body), NOW)).toBe(true);
  });

  it("rejects when the body was tampered with", () => {
    const sig = sign(FAKE_SECRET, ts, body);
    expect(verifySlackSignature(FAKE_SECRET, body + "&x=1", ts, sig, NOW)).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    const sig = sign("some-other-secret", ts, body);
    expect(verifySlackSignature(FAKE_SECRET, body, ts, sig, NOW)).toBe(false);
  });

  it("rejects missing timestamp or signature", () => {
    expect(verifySlackSignature(FAKE_SECRET, body, null, sign(FAKE_SECRET, ts, body), NOW)).toBe(false);
    expect(verifySlackSignature(FAKE_SECRET, body, ts, null, NOW)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifySlackSignature(FAKE_SECRET, body, "not-a-number", sign(FAKE_SECRET, "not-a-number", body), NOW)).toBe(false);
  });

  it("rejects a stale timestamp outside the 5-minute window (replay protection)", () => {
    const staleTs = String(NOW - 5 * 60 - 1);
    const sig = sign(FAKE_SECRET, staleTs, body);
    expect(verifySlackSignature(FAKE_SECRET, body, staleTs, sig, NOW)).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance edge", () => {
    const edgeTs = String(NOW - 5 * 60);
    const sig = sign(FAKE_SECRET, edgeTs, body);
    expect(verifySlackSignature(FAKE_SECRET, body, edgeTs, sig, NOW)).toBe(true);
  });

  it("rejects signatures of a different length without throwing", () => {
    expect(verifySlackSignature(FAKE_SECRET, body, ts, "v0=short", NOW)).toBe(false);
  });
});
