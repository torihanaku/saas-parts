/**
 * Claude bias detector v1 (ported from dev-dashboard-v2, #1298 / #356).
 *
 * Per-bias prompt set — each bias category gets a focused detection rubric
 * (sourced from the registry) instead of a single multi-bias prompt. This
 * raises precision because the model no longer has to compare all biases
 * against each other in one shot.
 *
 * HiPPO weighting: when `decisionMakerRole` is `ceo` or `cmo`, the prompt
 * adds a soft instruction to raise the HiPPO confidence prior when the
 * `reason` field is short or appeals to authority. Local reinforcement bumps
 * the HiPPO prior even if the model underweights it.
 *
 * Version tag: every detection is tagged with `detectorVersion = "claude-v1"`.
 *
 * The LLM is injected (`BiasLlmClient`); no direct api-client / env import.
 */

import type {
  BiasType,
  DecisionContext,
  DecisionMakerRole,
  BiasLlmClient,
} from "./types.js";
import { BiasRegistry, defaultBiasRegistry } from "./registry.js";

export const CLAUDE_DETECTOR_VERSION = "claude-v1";

/** Confidence below this threshold is dropped from the result list. */
export const CLAUDE_DETECTOR_THRESHOLD = 0.6;

interface RawDetection {
  biasType?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  recommendation?: unknown;
}

export interface ClaudeBiasDetection {
  decisionId: string | null;
  biasType: BiasType;
  confidence: number;
  evidence: Record<string, unknown>;
  recommendation: string | null;
  detectorVersion: string;
  decisionMakerRole: DecisionMakerRole | null;
}

const PROMPT_PREAMBLE = `あなたはマーケティング意思決定の認知バイアス検出専門家です。
与えられた意思決定コンテキストを 6 種類の認知バイアス観点で 1 つずつ評価し、
それぞれの確信度 (0.0 - 1.0) を JSON 配列で出力してください。`;

function buildSystemPrompt(
  role: DecisionMakerRole | null,
  registry: BiasRegistry,
): string {
  const lines: string[] = [PROMPT_PREAMBLE, ""];
  for (const def of registry.definitions()) {
    lines.push(def.rubric);
    lines.push("");
  }
  lines.push("# 出力フォーマット (JSON のみ、説明文禁止)");
  lines.push(
    `[
  {
    "biasType": "sunk_cost" | "confirmation" | "recency" | "bandwagon" | "anchoring" | "hippo",
    "confidence": 0.0 から 1.0 の数値,
    "evidence": { "key": "値", ... },
    "recommendation": "代替の合理的判断材料"
  }
]`,
  );
  if (role === "ceo" || role === "cmo") {
    lines.push("");
    lines.push(
      `# 重み付けヒント
意思決定者が ${role.toUpperCase()} であり、reason が短い (< 50 字) または "経営判断 / トップ判断" 等の語を含む場合は hippo 確信度を 0.1 - 0.2 上げてください。`,
    );
  }
  lines.push("");
  lines.push("該当しないバイアスは配列に含めず、確信度の高いものだけ返してください。");
  return lines.join("\n");
}

function buildUserPrompt(ctx: DecisionContext): string {
  const lines: string[] = ["# 意思決定コンテキスト"];
  lines.push(`## 件名\n${ctx.subject}`);
  if (ctx.context) lines.push(`## 状況\n${ctx.context}`);
  lines.push(`## 判断理由 (字数: ${ctx.reason.length})\n${ctx.reason}`);
  if (ctx.alternativesConsidered) {
    lines.push(`## 検討した代替案\n${ctx.alternativesConsidered}`);
  } else {
    lines.push(`## 検討した代替案\n(記載なし — confirmation / hippo の証拠候補)`);
  }
  if (ctx.decisionMakerRole) {
    lines.push(`## 決定者役職\n${ctx.decisionMakerRole}`);
  }
  if (ctx.history && Object.keys(ctx.history).length > 0) {
    lines.push(`## 履歴シグナル\n${JSON.stringify(ctx.history, null, 2)}`);
  }
  lines.push(
    "\n# あなたのタスク\n上記コンテキストに対し、6 種別を 1 つずつ評価し、確信度の高いものだけ JSON 配列で出力してください。",
  );
  return lines.join("\n\n");
}

function isKnownBias(v: unknown, registry: BiasRegistry): v is BiasType {
  return typeof v === "string" && registry.has(v);
}

function sanitiseDetections(
  raw: unknown,
  ctx: DecisionContext,
  registry: BiasRegistry,
): ClaudeBiasDetection[] {
  if (!Array.isArray(raw)) return [];
  const role = ctx.decisionMakerRole ?? null;
  const result: ClaudeBiasDetection[] = [];
  for (const item of raw as RawDetection[]) {
    if (!item || typeof item !== "object") continue;
    if (!isKnownBias(item.biasType, registry)) continue;

    let confidence =
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : 0;

    // Local HiPPO weighting reinforcement: even if the model underweights,
    // when reason is short and role is C-level the prior is bumped. Capped at 1.
    if (item.biasType === "hippo" && (role === "ceo" || role === "cmo")) {
      const shortReason = ctx.reason.length < 50;
      if (shortReason) confidence = Math.min(1, confidence + 0.1);
    }

    if (confidence < CLAUDE_DETECTOR_THRESHOLD) continue;

    const evidence =
      item.evidence &&
      typeof item.evidence === "object" &&
      !Array.isArray(item.evidence)
        ? (item.evidence as Record<string, unknown>)
        : {};

    const recommendation =
      typeof item.recommendation === "string" && item.recommendation.length > 0
        ? item.recommendation
        : null;

    result.push({
      decisionId: ctx.decisionId ?? null,
      biasType: item.biasType,
      confidence,
      evidence,
      recommendation,
      detectorVersion: CLAUDE_DETECTOR_VERSION,
      decisionMakerRole: role,
    });
  }
  return result;
}

/**
 * Run the v1 Claude detector. Returns [] on any transport error (the injected
 * LLM must swallow errors and return the `[]` fallback).
 */
export async function detectBiasesClaudeV1(
  ctx: DecisionContext,
  llm: BiasLlmClient,
  registry: BiasRegistry = defaultBiasRegistry,
): Promise<ClaudeBiasDetection[]> {
  const role = ctx.decisionMakerRole ?? null;
  const system = buildSystemPrompt(role, registry);
  const user = buildUserPrompt(ctx);
  const raw = await llm.generateJson<unknown>(system, user, [], {
    maxTokens: 1500,
    timeout: 60_000,
  });
  return sanitiseDetections(raw, ctx, registry);
}

// Internal exports for testing only.
export const __testing = { sanitiseDetections, buildSystemPrompt, buildUserPrompt };
