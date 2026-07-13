/**
 * AI Bias Detection service (ported from 実運用SaaS, Epic G10 MOAT #356).
 *
 * Detects cognitive biases (sunk_cost / confirmation / recency / bandwagon /
 * anchoring / hippo) on a marketing decision context. Production delegates to
 * the Claude v1 per-bias prompt set (`claude-detector.ts`) and keeps this
 * module's legacy single-shot path for backward-compatible tests.
 *
 * The LLM is injected (`BiasLlmClient`) — no direct api-client / env import.
 */

import type {
  BiasType,
  BiasDetection,
  DecisionContext,
  BiasLlmClient,
} from "./types.js";
import { BIAS_TYPES } from "./types.js";
import { BiasRegistry, defaultBiasRegistry } from "./registry.js";
import {
  detectBiasesClaudeV1,
  CLAUDE_DETECTOR_VERSION,
} from "./claude-detector.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Confidence below this threshold is dropped from the result list.
 * Shared default is 0.6; future detectors may tune per bias type.
 */
export const BIAS_CONFIDENCE_THRESHOLD = 0.6;

const SYSTEM_PROMPT = `あなたはマーケティング意思決定の認知バイアス検出専門家です。
与えられた意思決定コンテキストを分析し、以下の 6 種類のバイアスのうち、
証拠が確認できるものを JSON 配列で返してください。

検出対象:
- sunk_cost: サンクコストバイアス（既投資を理由に継続）
- confirmation: 確証バイアス（成功事例だけ引用、反証データを無視）
- recency: 直近偏重（短期スパイクで判断、長期トレンド無視）
- bandwagon: バンドワゴン（競合がやっているから / みんなやっているから）
- anchoring: アンカリング（前年比など 1 つの基準値に固定）
- hippo: HiPPO（データではなく上位者の意見で決定）

# 出力フォーマット (JSON のみ、説明文禁止)
[
  {
    "biasType": "sunk_cost",
    "confidence": 0.0 から 1.0 の数値,
    "evidence": { "key": "値", ... },
    "recommendation": "代替の合理的判断材料"
  }
]

証拠が薄い、または該当しない場合は空配列 [] を返してください。`;

// ─── Public Service Interface ───────────────────────────────────────────────

/**
 * Lean, mockable surface for bias detection.
 * Detection items are not yet persisted — caller decides whether to store.
 */
export interface BiasDetectorService {
  detectBiases(
    decisionContext: DecisionContext,
  ): Promise<Omit<BiasDetection, "id" | "tenantId" | "detectedAt">[]>;
}

// ─── Prompt builder (legacy single-shot) ─────────────────────────────────────

function buildUserPrompt(ctx: DecisionContext): string {
  const lines: string[] = ["# 意思決定コンテキスト"];
  lines.push(`## 件名\n${ctx.subject}`);
  if (ctx.context) lines.push(`## 状況\n${ctx.context}`);
  lines.push(`## 判断理由\n${ctx.reason}`);
  if (ctx.alternativesConsidered) {
    lines.push(`## 検討した代替案\n${ctx.alternativesConsidered}`);
  }
  if (ctx.history && Object.keys(ctx.history).length > 0) {
    lines.push(`## 履歴シグナル\n${JSON.stringify(ctx.history, null, 2)}`);
  }
  lines.push(
    "\n# あなたのタスク\n上記コンテキストに対し、検出された認知バイアスを JSON 配列で出力してください。",
  );
  return lines.join("\n\n");
}

// ─── Response sanitisation ──────────────────────────────────────────────────

interface RawDetection {
  biasType?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  recommendation?: unknown;
}

function isBiasType(v: unknown): v is BiasType {
  return typeof v === "string" && (BIAS_TYPES as readonly string[]).includes(v);
}

function sanitiseDetections(
  raw: unknown,
): Omit<BiasDetection, "id" | "tenantId" | "detectedAt">[] {
  if (!Array.isArray(raw)) return [];
  const result: Omit<BiasDetection, "id" | "tenantId" | "detectedAt">[] = [];
  for (const item of raw as RawDetection[]) {
    if (!item || typeof item !== "object") continue;
    if (!isBiasType(item.biasType)) continue;

    const confidence =
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : 0;
    if (confidence < BIAS_CONFIDENCE_THRESHOLD) continue;

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
      decisionId: null,
      biasType: item.biasType,
      confidence,
      evidence,
      recommendation,
    });
  }
  return result;
}

// ─── Factory bindings ─────────────────────────────────────────────────────────

/**
 * Production binding. Delegates to the v1 Claude detector for per-bias prompts
 * + HiPPO role weighting + version tagging. Returns [] on transport failure or
 * unparsable model output — never throws (relies on the injected LLM's
 * fallback contract).
 */
export function createBiasDetectorService(
  llm: BiasLlmClient,
  registry: BiasRegistry = defaultBiasRegistry,
): BiasDetectorService {
  return {
    async detectBiases(decisionContext) {
      const detections = await detectBiasesClaudeV1(
        decisionContext,
        llm,
        registry,
      );
      return detections.map((d) => ({
        decisionId: d.decisionId,
        biasType: d.biasType,
        confidence: d.confidence,
        evidence: d.evidence,
        recommendation: d.recommendation,
        detectorVersion: d.detectorVersion,
        decisionMakerRole: d.decisionMakerRole,
      }));
    },
  };
}

/**
 * Legacy single-shot detector kept for callers/tests that want a deterministic
 * single LLM call. Production callers should prefer the v1 detector.
 */
export function createLegacySingleShotDetector(
  llm: BiasLlmClient,
): BiasDetectorService {
  return {
    async detectBiases(decisionContext) {
      const userPrompt = buildUserPrompt(decisionContext);
      const raw = await llm.generateJson<unknown>(SYSTEM_PROMPT, userPrompt, [], {
        maxTokens: 1500,
        timeout: 60_000,
      });
      const sanitised = sanitiseDetections(raw);
      if (decisionContext.decisionId) {
        for (const d of sanitised) d.decisionId = decisionContext.decisionId;
      }
      return sanitised;
    },
  };
}

export { CLAUDE_DETECTOR_VERSION };

// Internal exports for testing only.
export const __testing = { sanitiseDetections, buildUserPrompt };
