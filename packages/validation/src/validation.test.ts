import { describe, it, expect } from "vitest";
import {
  isValidUUID,
  isValidEmail,
  parseBodyWithLimit,
  validationError,
  dbError,
} from "./index";

describe("isValidUUID", () => {
  it("accepts a valid UUID v4", () => {
    expect(isValidUUID("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
  });

  it("accepts uppercase hex (case-insensitive)", () => {
    expect(isValidUUID("123E4567-E89B-42D3-A456-426614174000")).toBe(true);
  });

  it("accepts any UUID-shaped hex string (source regex does not pin version/variant digits)", () => {
    // Faithful port: despite the "v4" doc comment, the source regex only
    // checks the 8-4-4-4-12 hex shape.
    expect(isValidUUID("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isValidUUID("123e4567-e89b-42d3-c456-426614174000")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("")).toBe(false);
    expect(isValidUUID("123e4567e89b42d3a456426614174000")).toBe(false);
  });
});

describe("isValidEmail", () => {
  it("accepts a simple valid email", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("rejects missing @ or domain dot", () => {
    expect(isValidEmail("userexample.com")).toBe(false);
    expect(isValidEmail("user@examplecom")).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(isValidEmail("us er@example.com")).toBe(false);
  });

  it("rejects emails longer than 254 chars", () => {
    const local = "a".repeat(250);
    expect(isValidEmail(`${local}@ex.com`)).toBe(false);
  });
});

describe("parseBodyWithLimit", () => {
  const makeReq = (body: string, headers?: Record<string, string>) =>
    new Request("http://localhost/test", { method: "POST", body, headers });

  it("parses a valid JSON body", async () => {
    const req = makeReq(JSON.stringify({ hello: "world" }));
    expect(await parseBodyWithLimit(req)).toEqual({ hello: "world" });
  });

  it("returns null when Content-Length header exceeds the limit", async () => {
    const req = makeReq("{}", { "Content-Length": "2048" });
    expect(await parseBodyWithLimit(req, 1024)).toBeNull();
  });

  it("returns null when actual body text exceeds the limit", async () => {
    const big = JSON.stringify({ data: "x".repeat(100) });
    expect(await parseBodyWithLimit(makeReq(big), 50)).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    expect(await parseBodyWithLimit(makeReq("{not json"))).toBeNull();
  });

  it("enforces the limit in BYTES, not UTF-16 code units (multibyte bypass)", async () => {
    // 50 emoji: each is 2 UTF-16 code units but 4 UTF-8 bytes. The JSON string
    // is ~111 code units / ~211 bytes. A byte-correct limiter must reject it
    // when maxBytes sits between the two (regression for the code-unit bypass).
    const payload = JSON.stringify({ data: "\u{1F600}".repeat(50) });
    const codeUnits = payload.length;
    const bytes = new TextEncoder().encode(payload).length;
    expect(bytes).toBeGreaterThan(codeUnits); // sanity: multibyte payload
    // maxBytes above code-unit count but below true byte size → must reject.
    expect(await parseBodyWithLimit(makeReq(payload), codeUnits + 5)).toBeNull();
    // And when the byte budget genuinely fits, it still parses.
    expect(await parseBodyWithLimit(makeReq(payload), bytes + 5)).toEqual({
      data: "\u{1F600}".repeat(50),
    });
  });
});

describe("error envelopes", () => {
  it("validationError returns 400 with VALIDATION_ERROR code", async () => {
    const res = validationError("bad input");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad input", code: "VALIDATION_ERROR" });
  });

  it("dbError returns 500 with DB_ERROR code", async () => {
    const res = dbError("db down");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db down", code: "DB_ERROR" });
  });

  it("dbError includes details when provided", async () => {
    const res = dbError("db down", "timeout after 5s");
    expect(await res.json()).toEqual({
      error: "db down",
      code: "DB_ERROR",
      details: "timeout after 5s",
    });
  });
});
