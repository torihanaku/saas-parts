/**
 * Multi-agent orchestration engine.
 * Coordinates multiple AI agents sequentially, feeding each agent's output
 * as context into the next, then synthesizes all results.
 *
 * 出典: 実運用SaaS server/lib/agent-orchestrator.ts
 * 変更点: Anthropic API 直 fetch → `complete` コールバック注入（LlmCaller.generateText
 *         がそのまま使える）。役割プリセット AGENT_ROLES は汎用なので温存しつつ上書き可。
 */

export interface AgentRole {
  id: string;
  name: string;
  systemPrompt: string;
  tools?: string[]; // reserved for future tool-scoped agents
}

export interface OrchestrationTask {
  objective: string;
  agents: AgentRole[];
  max_rounds?: number; // default: 3
  /** Synthesizer role for the final pass (default: AGENT_ROLES.synthesizer). */
  synthesizer?: AgentRole;
}

export interface AgentResult {
  agent_id: string;
  agent_name: string;
  output: string;
  round: number;
}

export interface OrchestrationResult {
  task_id: string;
  objective: string;
  rounds: number;
  agent_results: AgentResult[];
  final_synthesis: string;
  completed_at: string;
}

/** One agent turn: system prompt + user message → text. */
export type AgentCompleter = (systemPrompt: string, userMessage: string) => Promise<string>;

// ─── Pre-defined Agent Roles ─────────────────────────────────────────────────

export const AGENT_ROLES: Record<string, Omit<AgentRole, "id">> = {
  researcher: {
    name: "リサーチャー",
    systemPrompt:
      "あなたは情報収集・分析の専門家です。与えられたテーマについて詳細な調査結果を提供します。事実に基づいて分析し、根拠のある情報のみを提示してください。",
  },
  strategist: {
    name: "ストラテジスト",
    systemPrompt:
      "あなたは戦略立案の専門家です。リサーチ結果をもとに実行可能な戦略を提案します。具体的なアクションプランと優先順位を明示してください。",
  },
  critic: {
    name: "クリティック",
    systemPrompt:
      "あなたは批判的思考の専門家です。提案された戦略の弱点・リスク・改善点を指摘します。建設的な批判と代替案を合わせて提示してください。",
  },
  synthesizer: {
    name: "シンセサイザー",
    systemPrompt:
      "あなたは統合・要約の専門家です。複数の視点をまとめて最終的な結論を出します。各エージェントの知見を統合し、実行可能な最終提案を日本語でまとめてください。",
  },
};

// ─── Core Engine ─────────────────────────────────────────────────────────────

/**
 * Build the prompt handed to each subsequent agent.
 * Includes the original objective and all prior agent outputs.
 */
export function buildAgentPrompt(
  objective: string,
  priorResults: AgentResult[],
  currentAgent: AgentRole,
): string {
  const parts: string[] = [`# タスク目標\n${objective}`];

  if (priorResults.length > 0) {
    parts.push("# これまでのエージェントの出力");
    for (const r of priorResults) {
      parts.push(`## ${r.agent_name} の出力\n${r.output}`);
    }
    parts.push(
      `# あなたのタスク\n上記の情報を踏まえて、${currentAgent.name} として分析・提案を行ってください。`,
    );
  } else {
    parts.push(
      `# あなたのタスク\n${currentAgent.name} として、上記の目標に対して分析・調査を行ってください。`,
    );
  }

  return parts.join("\n\n");
}

/**
 * Run a multi-agent orchestration task.
 * Each agent processes the objective sequentially, building on prior outputs.
 * A final synthesizer pass produces the unified result (skipped when the last
 * agent already carries the synthesizer's id).
 */
export async function runOrchestration(
  complete: AgentCompleter,
  task: OrchestrationTask,
): Promise<OrchestrationResult> {
  const task_id = crypto.randomUUID();
  const maxRounds = task.max_rounds ?? 3;
  const agentResults: AgentResult[] = [];

  const synthesizerRole: AgentRole =
    task.synthesizer ?? { id: "synthesizer", ...AGENT_ROLES.synthesizer! };

  // NOTE: agents run sequentially (not in parallel) so each can read prior context.
  // Limit to max_rounds to prevent runaway costs.
  const agents = task.agents.slice(0, maxRounds);

  for (let round = 0; round < agents.length; round++) {
    const agent = agents[round]!;
    const prompt = buildAgentPrompt(task.objective, agentResults, agent);
    const output = await complete(agent.systemPrompt, prompt);

    agentResults.push({
      agent_id: agent.id,
      agent_name: agent.name,
      output,
      round: round + 1,
    });
  }

  // Final synthesis: if the last agent was already a synthesizer, reuse its
  // output; otherwise run a dedicated synthesis pass.
  let finalSynthesis: string;
  const lastAgent = agents[agents.length - 1];
  if (lastAgent?.id === synthesizerRole.id) {
    finalSynthesis = agentResults[agentResults.length - 1]?.output ?? "";
  } else {
    const synthPrompt = buildAgentPrompt(task.objective, agentResults, synthesizerRole);
    finalSynthesis = await complete(synthesizerRole.systemPrompt, synthPrompt);
  }

  return {
    task_id,
    objective: task.objective,
    rounds: agentResults.length,
    agent_results: agentResults,
    final_synthesis: finalSynthesis,
    completed_at: new Date().toISOString(),
  };
}
