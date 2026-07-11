import { describe, it, expect } from "vitest";
import { hashEmail, hashPii } from "./pii";

describe("hashEmail", () => {
  it("returns a 64-char SHA-256 hex digest", () => {
    const out = hashEmail("user@example.com");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashEmail("a@b.com")).toBe(hashEmail("a@b.com"));
  });

  it("normalizes whitespace and case", () => {
    expect(hashEmail("  USER@Example.COM  ")).toBe(hashEmail("user@example.com"));
  });

  it("differs for different inputs", () => {
    expect(hashEmail("a@b.com")).not.toBe(hashEmail("c@d.com"));
  });

  it("matches the canonical sha256 of the lowercased email", () => {
    // sha256("user@example.com")
    expect(hashEmail("user@example.com")).toBe(
      "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514"
    );
  });
});

describe("hashPii", () => {
  it("does not lowercase non-email values", () => {
    expect(hashPii("ABC")).not.toBe(hashPii("abc"));
  });

  it("returns 64-char hex", () => {
    expect(hashPii("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
