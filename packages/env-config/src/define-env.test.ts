/**
 * Behaviors ported from 実運用SaaS tests/env.test.ts.
 * The source parsed at module load and needed vi.resetModules + process.exit
 * stubs; the harness takes an injectable source/exit, so tests pass fake env
 * objects directly. The example schema mirrors the README.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  defineEnv,
  optionalUrl,
  numericString,
  emptyToUndefined,
  getOptionalEnv,
  EnvValidationError,
} from "./define-env";

// ── README と同じ例スキーマ（必須2 + オプション3） ────────────────────────
const Required = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL は有効な URL である必要があります"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET は 32文字以上必要です"),
});
const Optional = z.object({
  APP_URL: optionalUrl,
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: numericString.optional(),
});

const VALID = {
  DATABASE_URL: "https://db.example.com",
  SESSION_SECRET: "a".repeat(32),
};

function defineThrowing(source: Record<string, string | undefined>) {
  return defineEnv({ required: Required, optional: Optional }, { source, onFail: "throw" });
}

describe("defineEnv", () => {
  it("parses a minimal valid env", () => {
    const env = defineThrowing({ ...VALID });
    expect(env.DATABASE_URL).toBe("https://db.example.com");
    expect(env.SESSION_SECRET).toBe("a".repeat(32));
  });

  it('defaults NODE_ENV to "development" when unset', () => {
    const env = defineThrowing({ ...VALID });
    expect(env.NODE_ENV).toBe("development");
  });

  it("accepts valid optional URL fields", () => {
    const env = defineThrowing({ ...VALID, APP_URL: "https://dash.example.com" });
    expect(env.APP_URL).toBe("https://dash.example.com");
  });

  it("fails when a required var is missing", () => {
    expect(() => defineThrowing({ SESSION_SECRET: "a".repeat(32) })).toThrow(EnvValidationError);
  });

  it("fails when SESSION_SECRET is shorter than 32 chars", () => {
    expect(() => defineThrowing({ ...VALID, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET は 32文字以上必要です/,
    );
  });

  it("fails when DATABASE_URL is set to a non-URL value", () => {
    expect(() => defineThrowing({ ...VALID, DATABASE_URL: "not-a-url" })).toThrow(EnvValidationError);
  });

  it("rejects invalid NODE_ENV values", () => {
    expect(() => defineThrowing({ ...VALID, NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });

  it("validates PORT is numeric-only", () => {
    expect(() => defineThrowing({ ...VALID, PORT: "abc" })).toThrow(EnvValidationError);
    const env = defineThrowing({ ...VALID, PORT: "8080" });
    expect(env.PORT).toBe("8080");
  });

  it('normalizes "" to undefined for optionalUrl (Cloud Run quirk)', () => {
    const env = defineThrowing({ ...VALID, APP_URL: "" });
    expect(env.APP_URL).toBeUndefined();
  });

  it("aggregates all issues into one bulleted message", () => {
    try {
      defineThrowing({ DATABASE_URL: "not-a-url", SESSION_SECRET: "short", PORT: "abc" });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as EnvValidationError;
      expect(err).toBeInstanceOf(EnvValidationError);
      expect(err.message).toContain("[env] 環境変数の検証に失敗しました。起動を中止します。");
      expect(err.message).toContain("  • DATABASE_URL:");
      expect(err.message).toContain("  • SESSION_SECRET: SESSION_SECRET は 32文字以上必要です");
      expect(err.message).toContain("  • PORT:");
      expect(err.issues).toHaveLength(3);
      expect(err.issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(["DATABASE_URL", "SESSION_SECRET", "PORT"]),
      );
    }
  });

  it('default onFail="exit" logs the aggregated message and exits with 1 (ported fail-fast)', () => {
    const logger = vi.fn();
    const exit = vi.fn();
    expect(() =>
      defineEnv(
        { required: Required, optional: Optional },
        { source: { SESSION_SECRET: "a".repeat(32) }, logger, exit },
      ),
    ).toThrow(EnvValidationError); // injected exit does not terminate → safety throw
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger).toHaveBeenCalledOnce();
    const logged = logger.mock.calls[0]![0] as string;
    expect(logged).toContain("DATABASE_URL");
    expect(logged).toContain("起動を中止します");
  });

  it("accepts a plain ZodObject schema (no required/optional split)", () => {
    const env = defineEnv(
      z.object({ API_KEY: z.string().min(1), REGION: z.string().default("asia-northeast1") }),
      { source: { API_KEY: "test-key" }, onFail: "throw" },
    );
    expect(env.API_KEY).toBe("test-key");
    expect(env.REGION).toBe("asia-northeast1");
  });

  it("accepts { required } without optional", () => {
    const env = defineEnv(
      { required: Required },
      { source: { ...VALID }, onFail: "throw" },
    );
    expect(env.DATABASE_URL).toBe("https://db.example.com");
  });

  it("strips keys not declared in the schema", () => {
    const env = defineThrowing({ ...VALID, UNRELATED: "x" });
    expect((env as Record<string, unknown>).UNRELATED).toBeUndefined();
  });
});

describe("emptyToUndefined", () => {
  it("converts empty string to undefined before validation", () => {
    const schema = emptyToUndefined(z.string().min(3).optional());
    expect(schema.parse("")).toBeUndefined();
    expect(schema.parse("abc")).toBe("abc");
    expect(schema.parse(undefined)).toBeUndefined();
  });
});

describe("getOptionalEnv", () => {
  it("reads a key from the given source", () => {
    expect(getOptionalEnv("FOO", { FOO: "bar" })).toBe("bar");
    expect(getOptionalEnv("MISSING", {})).toBeUndefined();
  });
});
