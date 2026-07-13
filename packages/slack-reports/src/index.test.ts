import { describe, it, expect, vi } from "vitest";
import {
  buildWeeklyReportPayload,
  buildExecutiveStatusPayload,
  buildScenarioSummaryPayload,
  buildFirewallEvalPayload,
  isoWeek,
  runReport,
  ReportRegistry,
  type EvalRun,
} from "./index";

// ── firewall eval (ported from 実運用SaaS firewall-eval-weekly-slack.test.ts) ──
const baseRun: EvalRun = {
  lint_f1: 0.83,
  lint_precision: 0.85,
  lint_recall: 0.81,
  lint_sample_size: 100,
  repeat_catch_rate: 0.72,
  override_retention_rate: 0.04,
  threshold_violations: [],
  generated_at: "2026-05-02T00:00:00Z",
};

describe("buildFirewallEvalPayload", () => {
  it("renders headline with check emoji when no violations", () => {
    const payload = buildFirewallEvalPayload("Acme", baseRun);
    expect(payload.text).toContain("F1=83.0%");
    expect(payload.text).not.toContain("閾値違反");
    const headerBlock = payload.blocks[0] as { text: { text: string } };
    expect(headerBlock.text.text).toContain("✅");
    expect(headerBlock.text.text).toContain("Acme");
  });

  it("renders siren emoji + violation block when violations exist", () => {
    const run: EvalRun = {
      ...baseRun,
      lint_f1: 0.6,
      threshold_violations: [
        { metric: "lint_f1", value: 0.6, threshold: 0.75, direction: "below_min" },
      ],
    };
    const payload = buildFirewallEvalPayload("Acme", run);
    expect(payload.text).toContain("⚠ 閾値違反あり");
    const headerBlock = payload.blocks[0] as { text: { text: string } };
    expect(headerBlock.text.text).toContain("🚨");
    const violationBlock = payload.blocks.find(
      (b) =>
        typeof (b as { text?: { text?: string } }).text?.text === "string" &&
        (b as { text: { text: string } }).text.text.includes("閾値違反 1 件"),
    );
    expect(violationBlock).toBeDefined();
  });

  it("renders fields section with all 6 metrics", () => {
    const payload = buildFirewallEvalPayload("Acme", baseRun);
    const fieldsBlock = payload.blocks.find(
      (b) => Array.isArray((b as { fields?: unknown[] }).fields),
    ) as { fields: { text: string }[] };
    expect(fieldsBlock.fields).toHaveLength(6);
    const allText = fieldsBlock.fields.map((f) => f.text).join(" ");
    expect(allText).toContain("Lint F1");
    expect(allText).toContain("Sample size");
  });

  it("formats null metrics as em-dash", () => {
    const run: EvalRun = { ...baseRun, lint_f1: null, lint_precision: null };
    const payload = buildFirewallEvalPayload("Acme", run);
    const fieldsBlock = payload.blocks.find(
      (b) => Array.isArray((b as { fields?: unknown[] }).fields),
    ) as { fields: { text: string }[] };
    expect(fieldsBlock.fields[0]?.text).toContain("—");
    expect(fieldsBlock.fields[1]?.text).toContain("—");
  });
});

describe("buildWeeklyReportPayload", () => {
  it("includes heading, divider and body", () => {
    const p = buildWeeklyReportPayload("Acme", "2026-W18", "hello");
    expect(p.text).toContain("週次レポート (Acme) — 2026-W18");
    expect((p.blocks[0] as { text: { text: string } }).text.text).toContain("📊");
    expect(p.blocks[1]).toEqual({ type: "divider" });
    expect((p.blocks[2] as { text: { text: string } }).text.text).toBe("hello");
  });

  it("truncates long body with ellipsis", () => {
    const long = "x".repeat(3000);
    const p = buildWeeklyReportPayload("Acme", "2026-W18", long);
    const body = (p.blocks[2] as { text: { text: string } }).text.text;
    expect(body.length).toBe(2901); // 2900 + ellipsis
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("buildExecutiveStatusPayload", () => {
  it("uses shorter body limit and exec heading", () => {
    const p = buildExecutiveStatusPayload("Acme", "2026-W18", "y".repeat(2000));
    expect((p.blocks[0] as { text: { text: string } }).text.text).toContain("🎯");
    const body = (p.blocks[2] as { text: { text: string } }).text.text;
    expect(body.length).toBe(1501);
  });
});

describe("buildScenarioSummaryPayload", () => {
  it("renders scenario lines with PV/CV metrics", () => {
    const p = buildScenarioSummaryPayload("Acme", {
      scenarios: [
        { name: "Realistic", predictedOutputs: { pv: { mean: 1200 }, cv: { mean: 34 } } },
        { name: "Optimistic", predictedOutputs: { pv: { mean: 5000 }, cv: {} } },
      ],
    });
    expect(p.text).toContain("Acme");
    const section = (p.blocks[1] as { text: { text: string } }).text.text;
    expect(section).toContain("*Realistic*");
    expect(section).toContain("PV 1,200");
    expect(section).toContain("CV 34");
    expect(section).toContain("CV 0"); // missing mean → 0
  });
});

describe("isoWeek", () => {
  it("produces YYYY-WNN", () => {
    expect(isoWeek(new Date("2026-05-01T00:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("runReport / ReportRegistry", () => {
  const tenants = [
    { id: "t1", name: "Acme" },
    { id: "t2", name: "Beta" },
    { id: "t3", name: "Gamma" },
  ];

  it("skips null provider results, sends the rest, isolates failures", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const result = await runReport(
      {
        name: "weekly-report",
        provider: async (t) => (t.id === "t2" ? null : `content-${t.id}`),
        build: (t, data) => buildWeeklyReportPayload(t.name, "2026-W18", data),
      },
      { tenants, sender, onError },
    );
    expect(result).toEqual({ name: "weekly-report", posted: 2, skipped: 1, failed: 0 });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("continues loop when sender throws for one tenant", async () => {
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new Error("slack down"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const result = await runReport(
      {
        name: "x",
        provider: async (t) => t.id,
        build: (t) => ({ text: t.name, blocks: [] }),
      },
      { tenants, sender, onError },
    );
    expect(result.posted).toBe(2);
    expect(result.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("registry runs all registered reports", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const reg = new ReportRegistry()
      .register({ name: "a", provider: async () => 1, build: (t) => ({ text: t.name, blocks: [] }) })
      .register({ name: "b", provider: async () => null, build: (t) => ({ text: t.name, blocks: [] }) });
    expect(reg.list()).toEqual(["a", "b"]);
    const results = await reg.runAll({ tenants, sender });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: "a", posted: 3 });
    expect(results[1]).toMatchObject({ name: "b", skipped: 3 });
  });
});
