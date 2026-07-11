import { describe, it, expect } from "vitest";
import { verifyKintoneSignature } from "./kintone";
import { signPayload } from "./signing";

describe("verifyKintoneSignature", () => {
  const SECRET = "test-kintone-secret";
  const BODY = JSON.stringify({ record: { $id: { value: "42" } }, type: "ADD_RECORD" });

  it("accepts a valid HMAC-SHA256 signature of the raw body", () => {
    const signature = signPayload(BODY, SECRET);
    expect(verifyKintoneSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a signature produced with a different secret", () => {
    const signature = signPayload(BODY, "other-secret");
    expect(verifyKintoneSignature(BODY, signature, SECRET)).toBe(false);
  });

  it("rejects when the body was tampered", () => {
    const signature = signPayload(BODY, SECRET);
    expect(verifyKintoneSignature(BODY + "x", signature, SECRET)).toBe(false);
  });

  it("fails closed on empty body / signature / secret", () => {
    const signature = signPayload(BODY, SECRET);
    expect(verifyKintoneSignature("", signature, SECRET)).toBe(false);
    expect(verifyKintoneSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyKintoneSignature(BODY, signature, "")).toBe(false);
  });
});
