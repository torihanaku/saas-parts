/**
 * 協調チームプリセット層 — named teams of AGENT_ROLES + team-resolution helper.
 *
 * オーケストレーションの ENGINE（orchestrator.ts の runOrchestration / AGENT_ROLES /
 * synthesis）はそのまま。ここは「名前付きチーム（役割の並び）」を選べるようにする
 * プリセット層だけを追加する。
 *
 * 出典: dev-dashboard-v2 server/routes/orchestration.ts
 *   - ORCHESTRATION_PRESETS: そのまま EXAMPLE プリセットとして移植
 *   - RunOrchestrationBody（objective + agent_roles? + custom_agents?）の解決ロジックを
 *     `resolveTeam` として純粋関数化。HTTP/auth/Supabase/env 配線は除去。
 *
 * これらのプリセットは「例」です。呼び出し側は自分のチームを自由に定義できます。
 */
import { AGENT_ROLES, type AgentRole } from "./orchestrator";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A named team: an ordered list of role ids that must exist in AGENT_ROLES. */
export interface OrchestrationPreset {
  id: string;
  name: string;
  description: string;
  /** Role ids composing this team, in execution order. Must exist in AGENT_ROLES. */
  agents: string[];
}

/** Caller-supplied custom agent (no id — one is generated on resolve). */
export type CustomAgentInput = Omit<AgentRole, "id">;

// ─── Example Presets ───────────────────────────────────────────────────────────
// Ported verbatim from server/routes/orchestration.ts. These reference role ids
// (researcher / strategist / critic / synthesizer) that all exist in AGENT_ROLES.

export const ORCHESTRATION_PRESETS: OrchestrationPreset[] = [
  {
    id: "market-research",
    name: "市場調査チーム",
    description: "リサーチ → 戦略 → 批評 → 統合",
    agents: ["researcher", "strategist", "critic", "synthesizer"],
  },
  {
    id: "content-team",
    name: "コンテンツチーム",
    description: "アイデア → 執筆 → 編集 → 公開準備",
    agents: ["researcher", "synthesizer"],
  },
];

// ─── Preset Registry Helpers ──────────────────────────────────────────────────

/** List the example presets (shallow copies so callers cannot mutate the source). */
export function listOrchestrationPresets(): OrchestrationPreset[] {
  return ORCHESTRATION_PRESETS.map((p) => ({ ...p, agents: [...p.agents] }));
}

/** Look up an example preset by id. Returns undefined when unknown. */
export function getOrchestrationPreset(id: string): OrchestrationPreset | undefined {
  const preset = ORCHESTRATION_PRESETS.find((p) => p.id === id);
  return preset ? { ...preset, agents: [...preset.agents] } : undefined;
}

// ─── Team Resolution ──────────────────────────────────────────────────────────

/**
 * Turn a list of role ids into concrete AgentRole[] from AGENT_ROLES.
 * Unlike the original route (which silently skipped unknown roles), this throws
 * a clear error so misconfigured teams fail loudly.
 */
function rolesFromIds(roleIds: string[]): AgentRole[] {
  return roleIds.map((roleId) => {
    const role = AGENT_ROLES[roleId];
    if (!role) {
      throw new Error(
        `未知の役割ID "${roleId}" です。利用可能な役割: ${Object.keys(AGENT_ROLES).join(", ")}`,
      );
    }
    return { id: roleId, ...role };
  });
}

/** Append caller-supplied custom agents (generates an id for each). */
function customToAgents(customAgents: CustomAgentInput[]): AgentRole[] {
  return customAgents.map((ca) => ({
    id: crypto.randomUUID(),
    name: ca.name,
    systemPrompt: ca.systemPrompt,
    tools: ca.tools,
  }));
}

/**
 * Resolve a team into the AgentRole[] that runOrchestration accepts.
 *
 * `team` accepts three shapes (mirrors orchestration.ts's request handling):
 *   - a preset id string ("market-research")
 *   - an explicit list of role ids (["researcher", "critic"])
 *   - a ready-made AgentRole[] (passed through as-is)
 *
 * `customAgents` are appended after the resolved roles (as in the original route).
 *
 * Throws when the preset id is unknown, when any referenced role id is missing
 * from AGENT_ROLES, or when the resolved team ends up empty.
 */
export function resolveTeam(
  team: string | string[] | AgentRole[],
  customAgents: CustomAgentInput[] = [],
): AgentRole[] {
  let resolved: AgentRole[];

  if (typeof team === "string") {
    // Single string → treat as a preset id.
    const preset = getOrchestrationPreset(team);
    if (!preset) {
      throw new Error(
        `未知のプリセットID "${team}" です。利用可能なプリセット: ${ORCHESTRATION_PRESETS.map((p) => p.id).join(", ")}`,
      );
    }
    resolved = rolesFromIds(preset.agents);
  } else if (isAgentRoleArray(team)) {
    // Already-built AgentRole[] → pass through.
    resolved = [...team];
  } else {
    // string[] → explicit role ids.
    resolved = rolesFromIds(team);
  }

  resolved = [...resolved, ...customToAgents(customAgents)];

  if (resolved.length === 0) {
    throw new Error(
      "有効なエージェントが1つも指定されていません。プリセットID・役割IDリスト・custom_agents のいずれかを指定してください。",
    );
  }

  return resolved;
}

/** Narrow a list to AgentRole[] (vs a bare string[] of role ids). */
function isAgentRoleArray(value: string[] | AgentRole[]): value is AgentRole[] {
  return value.length > 0 && typeof value[0] === "object" && value[0] !== null;
}
