/**
 * @torihanaku/kit-ai-agent — AIエージェント基盤
 * 計画 → 承認ゲート → 実行 → ロールバック のライフサイクル + MCP サーバー雛形。
 *
 * 出典: dev-dashboard-v2 (server/lib/agent/* / server/services/agentPlanner.ts /
 *       server/lib/agent-orchestrator.ts / server/mcp/* / server/lib/chat-tools*)
 */

// Core domain types + injected store interfaces
export * from "./types";

// LLM injection interfaces (LlmCaller / LlmToolCaller)
export * from "./llm";

// Lifecycle: plan → approve → execute → rollback
export * from "./planner";
export * from "./approval";
export * from "./executor";
export * from "./rollback";

// Operations: monitor → auto-rollback / cost / report / evidence
export * from "./monitor";
export * from "./auto-rollback";
export * from "./cost-tracker";
export * from "./report";
export * from "./evidence";

// Multi-agent orchestration
export * from "./orchestrator";

// Collaboration-team presets (named teams of AGENT_ROLES + resolveTeam)
export * from "./orchestration-presets";

// Claude tool-use loop + registry
export * from "./tool-registry";
export * from "./tool-loop";

// In-memory reference stores
export * from "./stores";

// MCP server skeleton
export * from "./mcp/types";
export * from "./mcp/registry";
export * from "./mcp/auth";
export * from "./mcp/rpc";
