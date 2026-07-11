import { describe, it, expect, vi } from "vitest";
import {
  validateAnthropic,
  validateSupabase,
  validateGitHub,
  validateNango,
  validateSlack,
  validateStripe,
  type FetchLike,
} from "./validators";
import { computeStatus, DEFAULT_SETUP_STEPS } from "./steps";
import { computeChecklist, type ChecklistDataProvider } from "./checklist";
import { SetupWizard } from "./wizard";

// Mock fetch factory returning a fixed status.
const mockFetch = (status: number): FetchLike => async () => ({ ok: status >= 200 && status < 300, status });
const throwFetch = (msg: string): FetchLike => async () => {
  throw new Error(msg);
};

// ─── validators (ported from setup-validators.test.ts) ─────────────────────────

describe("validateAnthropic", () => {
  it("invalid without key", async () => {
    const r = await validateAnthropic({});
    expect(r.valid).toBe(false);
    expect(r.message).toContain("ANTHROPIC_API_KEY");
  });
  it("valid on 200", async () => {
    const r = await validateAnthropic({ ANTHROPIC_API_KEY: "sk-ant" }, mockFetch(200));
    expect(r.valid).toBe(true);
    expect(r.message).toContain("接続確認済み");
  });
  it("invalid on 401", async () => {
    const r = await validateAnthropic({ ANTHROPIC_API_KEY: "bad" }, mockFetch(401));
    expect(r.valid).toBe(false);
    expect(r.message).toContain("401");
  });
  it("invalid on network error", async () => {
    const r = await validateAnthropic({ ANTHROPIC_API_KEY: "sk" }, throwFetch("network error"));
    expect(r.valid).toBe(false);
    expect(r.message).toContain("network error");
  });
});

describe("validateSupabase", () => {
  it("invalid without url", async () => {
    expect((await validateSupabase({ SUPABASE_SERVICE_ROLE_KEY: "k" })).valid).toBe(false);
  });
  it("invalid without key", async () => {
    expect((await validateSupabase({ SUPABASE_URL: "https://x.supabase.co" })).valid).toBe(false);
  });
  it("valid on 200", async () => {
    const r = await validateSupabase({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, mockFetch(200));
    expect(r.valid).toBe(true);
  });
  it("valid on 406", async () => {
    const r = await validateSupabase({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, mockFetch(406));
    expect(r.valid).toBe(true);
  });
  it("invalid on 403", async () => {
    const r = await validateSupabase({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "bad" }, mockFetch(403));
    expect(r.valid).toBe(false);
    expect(r.message).toContain("403");
  });
  it("invalid on network error", async () => {
    const r = await validateSupabase({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, throwFetch("connect failed"));
    expect(r.valid).toBe(false);
    expect(r.message).toContain("connect failed");
  });
});

describe("validateGitHub", () => {
  it("invalid without token", async () => {
    expect((await validateGitHub({})).valid).toBe(false);
  });
  it("valid on 200", async () => {
    expect((await validateGitHub({ GH_TOKEN: "ghp" }, mockFetch(200))).valid).toBe(true);
  });
  it("invalid on 401", async () => {
    const r = await validateGitHub({ GH_TOKEN: "bad" }, mockFetch(401));
    expect(r.valid).toBe(false);
    expect(r.message).toContain("401");
  });
  it("invalid on network error", async () => {
    const r = await validateGitHub({ GH_TOKEN: "ghp" }, throwFetch("timeout"));
    expect(r.valid).toBe(false);
    expect(r.message).toContain("timeout");
  });
});

describe("validateNango", () => {
  it("invalid without key", () => expect(validateNango({}).valid).toBe(false));
  it("invalid when short", () => {
    const r = validateNango({ NANGO_SECRET_KEY: "short" });
    expect(r.valid).toBe(false);
    expect(r.message).toContain("20文字以上");
  });
  it("valid at 20+ chars", () => expect(validateNango({ NANGO_SECRET_KEY: "a".repeat(20) }).valid).toBe(true));
});

describe("validateSlack", () => {
  it("invalid without bot token", () => expect(validateSlack({ SLACK_SIGNING_SECRET: "s" }).valid).toBe(false));
  it("invalid without signing secret", () => expect(validateSlack({ SLACK_BOT_TOKEN: "xoxb-x" }).valid).toBe(false));
  it("invalid on bad prefix", () => {
    const r = validateSlack({ SLACK_BOT_TOKEN: "bad", SLACK_SIGNING_SECRET: "s" });
    expect(r.valid).toBe(false);
    expect(r.message).toContain("xoxb-");
  });
  it("valid with correct format", () =>
    expect(validateSlack({ SLACK_BOT_TOKEN: "xoxb-ok", SLACK_SIGNING_SECRET: "s" }).valid).toBe(true));
});

describe("validateStripe", () => {
  it("invalid without key", () => expect(validateStripe({}).valid).toBe(false));
  it("invalid on wrong format", () => {
    const r = validateStripe({ STRIPE_SECRET_KEY: "pk_test_x" });
    expect(r.valid).toBe(false);
    expect(r.message).toContain("sk_live_");
  });
  it("valid for sk_test_", () => expect(validateStripe({ STRIPE_SECRET_KEY: "sk_test_x" }).valid).toBe(true));
  it("valid for sk_live_", () => expect(validateStripe({ STRIPE_SECRET_KEY: "sk_live_x" }).valid).toBe(true));
});

// ─── computeStatus ─────────────────────────────────────────────────────────────

describe("computeStatus", () => {
  it("all unset → 0% and incomplete", async () => {
    const s = await computeStatus(DEFAULT_SETUP_STEPS, () => false);
    expect(s.completion_percentage).toBe(0);
    expect(s.setup_complete).toBe(false);
    expect(s.required_complete).toBe(false);
    expect(s.steps.length).toBe(6);
  });

  it("only required set → required_complete but not setup_complete", async () => {
    const required = new Set(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"]);
    const s = await computeStatus(DEFAULT_SETUP_STEPS, (k) => required.has(k));
    expect(s.required_complete).toBe(true);
    expect(s.setup_complete).toBe(false);
    // 2 of 6 steps configured → 33%
    expect(s.completion_percentage).toBe(33);
  });

  it("all set → 100% and complete", async () => {
    const s = await computeStatus(DEFAULT_SETUP_STEPS, () => true);
    expect(s.setup_complete).toBe(true);
    expect(s.completion_percentage).toBe(100);
  });

  it("partial multi-var step is not configured until all vars set", async () => {
    // slack needs 2 vars — only one set
    const s = await computeStatus(DEFAULT_SETUP_STEPS, (k) => k === "SLACK_BOT_TOKEN");
    const slack = s.steps.find((x) => x.key === "slack");
    expect(slack!.configured).toBe(false);
  });

  it("supports async resolver", async () => {
    const s = await computeStatus(DEFAULT_SETUP_STEPS, async () => true);
    expect(s.setup_complete).toBe(true);
  });
});

// ─── computeChecklist ─────────────────────────────────────────────────────────

describe("computeChecklist", () => {
  const provider = (over: Partial<ChecklistDataProvider> = {}): ChecklistDataProvider => ({
    isDatabaseConfigured: () => true,
    isAiConfigured: () => true,
    hasRows: () => false,
    ...over,
  });

  it("counts db + ai when configured and rows empty", async () => {
    const r = await computeChecklist(provider());
    expect(r.total_count).toBe(8);
    expect(r.completed_count).toBe(2); // db + ai
  });

  it("skips row checks when db not configured", async () => {
    const hasRows = vi.fn(() => true);
    const r = await computeChecklist(provider({ isDatabaseConfigured: () => false, isAiConfigured: () => false, hasRows }));
    expect(r.completed_count).toBe(0);
    expect(hasRows).not.toHaveBeenCalled();
  });

  it("counts datasets that have rows", async () => {
    const r = await computeChecklist(provider({ hasRows: (ds) => ds === "content" || ds === "crm" }));
    expect(r.completed_count).toBe(4); // db + ai + content + crm
  });
});

// ─── SetupWizard orchestrator ──────────────────────────────────────────────────

describe("SetupWizard", () => {
  it("status delegates to computeStatus", async () => {
    const w = new SetupWizard({ isConfigured: () => true });
    const s = await w.status();
    expect(s.setup_complete).toBe(true);
  });

  it("validate: bad service input → 400", async () => {
    const w = new SetupWizard({ isConfigured: () => false });
    expect((await w.validate("", {})).ok).toBe(false);
    expect((await w.validate(123, {})).ok).toBe(false);
  });

  it("validate: bad credentials → 400", async () => {
    const w = new SetupWizard({ isConfigured: () => false });
    const r = await w.validate("stripe", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("validate: unknown service → 400", async () => {
    const w = new SetupWizard({ isConfigured: () => false });
    const r = await w.validate("unknown", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不明なサービス");
  });

  it("validate: format validator returns 200/422 status", async () => {
    const w = new SetupWizard({ isConfigured: () => false });
    const good = await w.validate("stripe", { STRIPE_SECRET_KEY: "sk_test_x" });
    expect(good.ok && good.data.status).toBe(200);
    const bad = await w.validate("stripe", { STRIPE_SECRET_KEY: "pk_x" });
    expect(bad.ok && bad.data.status).toBe(422);
  });

  it("validate: network validator uses injected fetch", async () => {
    const w = new SetupWizard({ isConfigured: () => false, fetchImpl: mockFetch(200) });
    const r = await w.validate("anthropic", { ANTHROPIC_API_KEY: "sk" });
    expect(r.ok && r.data.status).toBe(200);
    expect(r.ok && r.data.result.valid).toBe(true);
  });

  it("validate: custom validator override wins", async () => {
    const w = new SetupWizard({
      isConfigured: () => false,
      validators: { github: () => ({ valid: true, service: "github", message: "custom ok" }) },
    });
    const r = await w.validate("github", { GH_TOKEN: "x" });
    expect(r.ok && r.data.result.message).toBe("custom ok");
  });

  it("checklist: 500 without provider", async () => {
    const w = new SetupWizard({ isConfigured: () => false });
    const r = await w.checklist();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });

  it("checklist: delegates to provider", async () => {
    const w = new SetupWizard({
      isConfigured: () => false,
      checklist: { isDatabaseConfigured: () => true, isAiConfigured: () => false, hasRows: () => false },
    });
    const r = await w.checklist();
    expect(r.ok && r.data.completed_count).toBe(1);
  });

  it("supports custom steps", async () => {
    const w = new SetupWizard({
      isConfigured: () => true,
      steps: [{ key: "only", label: "Only", required: true, env_vars: ["X"] }],
    });
    const s = await w.status();
    expect(s.steps.length).toBe(1);
    expect(s.completion_percentage).toBe(100);
  });
});
