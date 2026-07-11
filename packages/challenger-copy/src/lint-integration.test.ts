import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChallengerLint } from "./lint-integration.js";
import { InMemoryChallengerStore } from "./stores.js";
import type { LintCheck } from "./types.js";

const pass = { checkId: "c", riskScore: 0, violations: [], summary: "リスクなし" };
const fail = { checkId: "c", riskScore: 40, violations: [{ ruleId: "r" }], summary: "error" };

describe("runChallengerLint", () => {
  let store: InMemoryChallengerStore;
  beforeEach(() => {
    store = new InMemoryChallengerStore();
  });

  it("lints original and all challengers, persists results", async () => {
    const lintCheck: LintCheck = vi.fn(async () => ({ ...pass }));
    const result = await runChallengerLint(
      {
        tenantId: "tenant-1",
        originalContent: "Original content",
        proposals: [
          { id: "prop-1", content: "Challenger A" },
          { id: "prop-2", content: "Challenger B" },
        ],
      },
      { store, lintCheck },
    );

    expect(lintCheck).toHaveBeenCalledTimes(3);
    expect(lintCheck).toHaveBeenNthCalledWith(1, { tenantId: "tenant-1", contentText: "Original content" });
    expect(lintCheck).toHaveBeenNthCalledWith(2, { tenantId: "tenant-1", contentText: "Challenger A" });
    expect(result.original.riskScore).toBe(0);
    expect(result.challengers).toHaveLength(2);
    expect(result.challengers[0]!.passed).toBe(true);
    // 永続化された（both passed → passed_at set）。
    expect(store.savedProposals.length).toBe(0); // proposals not created here
  });

  it("sets onlyChallengerPassed when original fails but challenger passes", async () => {
    let n = 0;
    const lintCheck: LintCheck = vi.fn(async () => (++n === 1 ? { ...fail } : { ...pass }));
    const result = await runChallengerLint(
      { tenantId: "t", originalContent: "bad", proposals: [{ id: "p1", content: "clean" }] },
      { store, lintCheck },
    );
    expect(result.original.riskScore).toBe(40);
    expect(result.challengers[0]!.passed).toBe(true);
    expect(result.onlyChallengerPassed).toBe(true);
  });

  it("onlyChallengerPassed is false when both pass", async () => {
    const lintCheck: LintCheck = vi.fn(async () => ({ ...pass }));
    const result = await runChallengerLint(
      { tenantId: "t", originalContent: "ok", proposals: [{ id: "p1", content: "ok" }] },
      { store, lintCheck },
    );
    expect(result.onlyChallengerPassed).toBe(false);
  });

  it("onlyChallengerPassed is false when original passes but challenger fails", async () => {
    let n = 0;
    const lintCheck: LintCheck = vi.fn(async () => (++n === 1 ? { ...pass } : { ...fail }));
    const result = await runChallengerLint(
      { tenantId: "t", originalContent: "ok", proposals: [{ id: "p1", content: "risky" }] },
      { store, lintCheck },
    );
    expect(result.challengers[0]!.passed).toBe(false);
    expect(result.onlyChallengerPassed).toBe(false);
  });

  it("onlyChallengerPassed is false when both fail", async () => {
    const lintCheck: LintCheck = vi.fn(async () => ({ ...fail }));
    const result = await runChallengerLint(
      { tenantId: "t", originalContent: "bad", proposals: [{ id: "p1", content: "bad" }] },
      { store, lintCheck },
    );
    expect(result.onlyChallengerPassed).toBe(false);
  });

  it("survives a single challenger lint failure", async () => {
    let n = 0;
    const lintCheck: LintCheck = vi.fn(async () => {
      n++;
      if (n === 1) return { ...pass };
      if (n === 2) throw new Error("Lint service down");
      return { ...pass };
    });
    const result = await runChallengerLint(
      {
        tenantId: "t",
        originalContent: "orig",
        proposals: [
          { id: "p1", content: "A (fails)" },
          { id: "p2", content: "B (passes)" },
        ],
      },
      { store, lintCheck },
    );
    expect(result.challengers).toHaveLength(1);
    expect(result.challengers[0]!.id).toBe("p2");
    expect(result.onlyChallengerPassed).toBe(false);
  });

  it("persists lint result for each challenger", async () => {
    const lintCheck: LintCheck = vi.fn(async () => ({ ...pass }));
    const updateSpy = vi.spyOn(store, "updateProposalLint");
    await runChallengerLint(
      { tenantId: "t", originalContent: "orig", proposals: [{ id: "p1", content: "c" }] },
      { store, lintCheck },
    );
    expect(updateSpy).toHaveBeenCalledWith("p1", expect.objectContaining({ riskScore: 0 }), expect.any(String));
  });
});
