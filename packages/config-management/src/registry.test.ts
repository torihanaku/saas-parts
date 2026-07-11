/**
 * Tests for registry.ts — 移植元 config-registry.ts の振る舞いを注入版で検証。
 */
import { describe, it, expect } from "vitest";
import {
  type ConfigVar,
  type GetConfigValue,
  EXAMPLE_CONFIG_REGISTRY,
  validateConfig,
  getConfigStatus,
  isConfigured,
  generateEnvTemplate,
  maskValue,
} from "./registry";

const REGISTRY: ConfigVar[] = [
  { key: "APP_URL", category: "core", required: true, description: "Application base URL", descriptionJa: "アプリのURL", sensitive: false },
  { key: "SESSION_SECRET", category: "core", required: true, description: "Session secret", descriptionJa: "セッション秘密鍵", sensitive: true },
  { key: "PORT", category: "core", required: false, description: "Server port", descriptionJa: "ポート", defaultValue: "8080", sensitive: false },
  { key: "MAIL_API_KEY", category: "integration", required: false, description: "Mail API key", descriptionJa: "メールAPIキー", featureFlag: "email", sensitive: true },
  { key: "MAIL_FROM", category: "integration", required: false, description: "Mail from", descriptionJa: "送信元", sensitive: false, dependsOn: ["MAIL_API_KEY"] },
];

function envOf(values: Record<string, string>): GetConfigValue {
  return (key) => values[key];
}

describe("validateConfig", () => {
  it("returns no errors when all required vars are set", () => {
    const errors = validateConfig(REGISTRY, envOf({
      APP_URL: "https://example.com",
      SESSION_SECRET: "s".repeat(32),
    }));
    expect(errors).toEqual([]);
  });

  it("reports missing required vars (defaults excuse them)", () => {
    const errors = validateConfig(REGISTRY, envOf({}));
    const keys = errors.map(e => e.key);
    expect(keys).toContain("APP_URL");
    expect(keys).toContain("SESSION_SECRET");
    expect(keys).not.toContain("PORT"); // has defaultValue
  });

  it("reports dependency violation when dependent var is set without its dependency", () => {
    const errors = validateConfig(REGISTRY, envOf({
      APP_URL: "https://example.com",
      SESSION_SECRET: "s".repeat(32),
      MAIL_FROM: "noreply@example.com",
    }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.key).toBe("MAIL_FROM");
    expect(errors[0]?.message).toContain("depends on MAIL_API_KEY");
  });

  it("no dependency error when the dependency is also set", () => {
    const errors = validateConfig(REGISTRY, envOf({
      APP_URL: "https://example.com",
      SESSION_SECRET: "s".repeat(32),
      MAIL_API_KEY: "key-123",
      MAIL_FROM: "noreply@example.com",
    }));
    expect(errors).toEqual([]);
  });
});

describe("getConfigStatus", () => {
  it("groups statuses by category and masks sensitive values", () => {
    const status = getConfigStatus(REGISTRY, envOf({
      APP_URL: "https://example.com",
      SESSION_SECRET: "super-secret-value-1234",
    }));
    expect(Object.keys(status).sort()).toEqual(["core", "integration"]);
    expect(status.core).toHaveLength(3);

    const appUrl = status.core!.find(s => s.key === "APP_URL");
    expect(appUrl?.configured).toBe(true);
    expect(appUrl?.maskedValue).toBe("https://example.com"); // non-sensitive: plain

    const secret = status.core!.find(s => s.key === "SESSION_SECRET");
    expect(secret?.configured).toBe(true);
    expect(secret?.maskedValue).toBe("supe****1234"); // sensitive: masked
    expect(secret?.maskedValue).not.toContain("secret-value");
  });

  it("treats defaultValue as configured", () => {
    const status = getConfigStatus(REGISTRY, envOf({}));
    const port = status.core!.find(s => s.key === "PORT");
    expect(port?.configured).toBe(true);
    expect(port?.maskedValue).toBe("8080");
  });

  it("marks unset vars as not configured", () => {
    const status = getConfigStatus(REGISTRY, envOf({}));
    const mail = status.integration!.find(s => s.key === "MAIL_API_KEY");
    expect(mail?.configured).toBe(false);
    expect(mail?.maskedValue).toBeUndefined();
  });
});

describe("isConfigured", () => {
  it("returns true when a feature flag var is set", () => {
    expect(isConfigured(REGISTRY, envOf({ MAIL_API_KEY: "key" }), "email")).toBe(true);
  });

  it("returns false when the feature flag vars are unset", () => {
    expect(isConfigured(REGISTRY, envOf({}), "email")).toBe(false);
  });

  it("returns false for unknown feature flags", () => {
    expect(isConfigured(REGISTRY, envOf({ MAIL_API_KEY: "key" }), "unknown-flag")).toBe(false);
  });
});

describe("generateEnvTemplate", () => {
  it("includes required tags, descriptions and feature flags", () => {
    const tpl = generateEnvTemplate(REGISTRY, { title: "My App — Environment" });
    expect(tpl).toContain("# My App — Environment");
    expect(tpl).toContain("# [REQUIRED] Application base URL");
    expect(tpl).toContain("# アプリのURL");
    expect(tpl).toContain("# [optional] Mail API key");
    expect(tpl).toContain("# Enables feature: email");
    expect(tpl).toContain("PORT=8080");
    expect(tpl).toContain("APP_URL=");
  });

  it("omits optional vars when includeOptional=false", () => {
    const tpl = generateEnvTemplate(REGISTRY, { includeOptional: false });
    expect(tpl).toContain("APP_URL=");
    expect(tpl).not.toContain("MAIL_API_KEY=");
    expect(tpl).not.toContain("PORT=");
    // integration category has no required vars → heading omitted entirely
    expect(tpl).not.toContain("# --- integration ---");
  });

  it("uses category labels and order when provided", () => {
    const tpl = generateEnvTemplate(REGISTRY, {
      categoryOrder: ["integration", "core"],
      categoryLabels: { core: "Core / Server", integration: "External Integrations" },
    });
    const integrationIdx = tpl.indexOf("# --- External Integrations ---");
    const coreIdx = tpl.indexOf("# --- Core / Server ---");
    expect(integrationIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThan(integrationIdx);
  });
});

describe("maskValue", () => {
  it("fully masks short values", () => {
    expect(maskValue("short")).toBe("****");
    expect(maskValue("12345678")).toBe("****");
  });

  it("keeps 4-char prefix/suffix for long values", () => {
    expect(maskValue("abcdefghijkl")).toBe("abcd****ijkl");
  });
});

describe("EXAMPLE_CONFIG_REGISTRY", () => {
  it("is a valid registry usable with the API", () => {
    expect(EXAMPLE_CONFIG_REGISTRY.length).toBeGreaterThanOrEqual(3);
    const errors = validateConfig(EXAMPLE_CONFIG_REGISTRY, envOf({
      APP_URL: "https://example.com",
      SESSION_SECRET: "s".repeat(32),
      DATABASE_URL: "postgres://localhost/db",
    }));
    expect(errors).toEqual([]);
  });
});
