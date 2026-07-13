/**
 * 元テスト出典: 実運用SaaS tests/agent-orchestrator.test.ts
 * （Anthropic fetch モック → AgentCompleter 注入に置換）
 */
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ROLES,
  buildAgentPrompt,
  runOrchestration,
  type AgentRole,
} from "./orchestrator";

const researcher: AgentRole = { id: "researcher", name: "リサーチャー", systemPrompt: "R" };
const strategist: AgentRole = { id: "strategist", name: "ストラテジスト", systemPrompt: "S" };
const synthesizer: AgentRole = { id: "synthesizer", name: "シンセサイザー", systemPrompt: "Z" };

describe("AGENT_ROLES", () => {
  it("contains researcher, strategist, critic, synthesizer with prompts", () => {
    for (const key of ["researcher", "strategist", "critic", "synthesizer"]) {
      const role = AGENT_ROLES[key];
      expect(role).toBeDefined();
      expect(role!.name.length).toBeGreaterThan(0);
      expect(role!.systemPrompt.length).toBeGreaterThan(0);
    }
  });
});

describe("buildAgentPrompt", () => {
  it("includes objective and prior outputs", () => {
    const prompt = buildAgentPrompt(
      "市場調査",
      [{ agent_id: "researcher", agent_name: "リサーチャー", output: "調査結果A", round: 1 }],
      strategist,
    );
    expect(prompt).toContain("市場調査");
    expect(prompt).toContain("調査結果A");
    expect(prompt).toContain("ストラテジスト");
  });
});

describe("runOrchestration", () => {
  it("runs agents sequentially, feeding prior output forward, then synthesizes", async () => {
    const complete = vi.fn(async (system: string, _prompt: string) => `out:${system}`);
    const result = await runOrchestration(complete, {
      objective: "obj",
      agents: [researcher, strategist],
      synthesizer,
    });

    // 2 agents + 1 synthesis pass
    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.rounds).toBe(2);
    expect(result.agent_results.map((r) => r.agent_id)).toEqual(["researcher", "strategist"]);
    // strategist の prompt に researcher の出力が入っている
    const strategistPrompt = complete.mock.calls[1]![1];
    expect(strategistPrompt).toContain("out:R");
    expect(result.final_synthesis).toBe("out:Z");
  });

  it("skips the synthesis pass when the last agent is the synthesizer", async () => {
    const complete = vi.fn(async () => "final");
    const result = await runOrchestration(complete, {
      objective: "obj",
      agents: [researcher, synthesizer],
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.final_synthesis).toBe("final");
  });

  it("caps agents at max_rounds", async () => {
    const complete = vi.fn(async () => "x");
    const result = await runOrchestration(complete, {
      objective: "obj",
      agents: [researcher, strategist, synthesizer],
      max_rounds: 1,
    });
    expect(result.rounds).toBe(1);
    expect(result.agent_results[0]!.agent_id).toBe("researcher");
  });
});
