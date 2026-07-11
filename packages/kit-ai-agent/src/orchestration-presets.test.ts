/**
 * 協調チームプリセット層のテスト。
 * 出典: dev-dashboard-v2 server/routes/orchestration.ts のプリセット/解決ロジック。
 */
import { describe, expect, it, vi } from "vitest";
import { AGENT_ROLES, runOrchestration, type AgentRole } from "./orchestrator";
import {
  ORCHESTRATION_PRESETS,
  listOrchestrationPresets,
  getOrchestrationPreset,
  resolveTeam,
} from "./orchestration-presets";

describe("ORCHESTRATION_PRESETS", () => {
  it("every preset resolves to a non-empty AgentRole[] whose role ids all exist", () => {
    expect(ORCHESTRATION_PRESETS.length).toBeGreaterThan(0);
    for (const preset of ORCHESTRATION_PRESETS) {
      const agents = resolveTeam(preset.id);
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) {
        expect(AGENT_ROLES[agent.id]).toBeDefined();
        expect(agent.systemPrompt.length).toBeGreaterThan(0);
      }
    }
  });

  it("preserves the market-research team order", () => {
    const agents = resolveTeam("market-research");
    expect(agents.map((a) => a.id)).toEqual([
      "researcher",
      "strategist",
      "critic",
      "synthesizer",
    ]);
  });
});

describe("listOrchestrationPresets", () => {
  it("returns the presets and callers cannot mutate the source", () => {
    const list = listOrchestrationPresets();
    expect(list.map((p) => p.id)).toContain("market-research");
    list[0]!.agents.push("hacker");
    // mutation of the returned copy must not leak into the source
    expect(getOrchestrationPreset("market-research")!.agents).not.toContain("hacker");
  });
});

describe("resolveTeam", () => {
  it("accepts a preset id", () => {
    const agents = resolveTeam("content-team");
    expect(agents.map((a) => a.id)).toEqual(["researcher", "synthesizer"]);
  });

  it("accepts an explicit role-id list", () => {
    const agents = resolveTeam(["researcher", "critic"]);
    expect(agents.map((a) => a.id)).toEqual(["researcher", "critic"]);
    expect(agents[1]!.name).toBe(AGENT_ROLES.critic!.name);
  });

  it("accepts a ready-made AgentRole[] and passes it through", () => {
    const custom: AgentRole[] = [{ id: "x", name: "X", systemPrompt: "px" }];
    const agents = resolveTeam(custom);
    expect(agents).toEqual(custom);
  });

  it("appends custom agents after resolved roles, generating ids", () => {
    const agents = resolveTeam(["researcher"], [{ name: "編集者", systemPrompt: "編集して" }]);
    expect(agents).toHaveLength(2);
    expect(agents[0]!.id).toBe("researcher");
    expect(agents[1]!.name).toBe("編集者");
    expect(agents[1]!.id.length).toBeGreaterThan(0);
    expect(agents[1]!.id).not.toBe("researcher");
  });

  it("throws clearly on an unknown preset id", () => {
    expect(() => resolveTeam("no-such-preset")).toThrow(/未知のプリセットID "no-such-preset"/);
  });

  it("throws clearly on an unknown role id", () => {
    expect(() => resolveTeam(["researcher", "wizard"])).toThrow(/未知の役割ID "wizard"/);
  });

  it("throws when the resolved team is empty", () => {
    expect(() => resolveTeam([])).toThrow(/有効なエージェントが1つも/);
  });
});

describe("resolveTeam + runOrchestration (end-to-end with a mock LlmCaller)", () => {
  it("runs a resolved preset team and produces a synthesis", async () => {
    const complete = vi.fn(async (system: string, _prompt: string) => `out:${system}`);
    const agents = resolveTeam("market-research");

    const result = await runOrchestration(complete, {
      objective: "新規市場の参入可否を評価する",
      agents,
      max_rounds: 4,
    });

    // 4 agents; last is synthesizer so no extra synthesis pass
    expect(complete).toHaveBeenCalledTimes(4);
    expect(result.rounds).toBe(4);
    expect(result.agent_results.map((r) => r.agent_id)).toEqual([
      "researcher",
      "strategist",
      "critic",
      "synthesizer",
    ]);
    expect(result.final_synthesis.length).toBeGreaterThan(0);
    expect(result.objective).toBe("新規市場の参入可否を評価する");
  });
});
