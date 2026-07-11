/**
 * ROI predictor (ported from dev-dashboard-v2 marketing/roi-predictor.ts).
 *
 * Given a campaign brief, ask an injected LLM for a ROI multiple + revenue
 * forecast with a 90% confidence interval, then always sanitize the output.
 *
 * Sanitization rules (always applied):
 *   - NaN / non-finite → 0
 *   - predictedRoi clamped to [0, 10]
 *   - revenue / confidence values clamped to ≥ 0
 *   - confidenceLow ≤ confidenceHigh (swap if inverted)
 */

import type { LlmClient } from "./llm";

export interface RoiPredictionInput {
  campaignName: string;
  channel: string;
  budgetJpy: number;
  durationDays: number;
  targetAudience?: string;
  tenantId: string;
}

export interface RoiPredictionOutput {
  predictedRoi: number;
  predictedRevenueJpy: number;
  confidenceLow: number;
  confidenceHigh: number;
  reasoning: string;
}

const MAX_ROI = 10;
const SYSTEM_PROMPT = `You are a senior marketing analyst. Given a campaign brief
(channel, budget, duration, optional audience), produce a realistic ROI multiple
and revenue forecast (JPY) with a 90% confidence interval, plus a short
Japanese reasoning paragraph (2-4 sentences) explaining the key drivers and
assumptions. Be conservative and explicit when the brief is thin.

Return ONLY a JSON object matching exactly this schema, no prose, no markdown:
{
  "predictedRoi": number,
  "predictedRevenueJpy": number,
  "confidenceLow": number,
  "confidenceHigh": number,
  "reasoning": string
}`;

function buildFallback(input: RoiPredictionInput, reason: string): RoiPredictionOutput {
  return {
    predictedRoi: 1.0,
    predictedRevenueJpy: input.budgetJpy,
    confidenceLow: 0.5,
    confidenceHigh: 1.5,
    reasoning: reason,
  };
}

function safeNumber(v: unknown, fallback = 0): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return v;
}

export function sanitizeRoiPrediction(raw: Partial<RoiPredictionOutput>): RoiPredictionOutput {
  let roi = safeNumber(raw.predictedRoi);
  if (roi < 0) roi = 0;
  if (roi > MAX_ROI) roi = MAX_ROI;

  let revenue = safeNumber(raw.predictedRevenueJpy);
  if (revenue < 0) revenue = 0;

  let low = safeNumber(raw.confidenceLow);
  let high = safeNumber(raw.confidenceHigh);
  if (low < 0) low = 0;
  if (high < 0) high = 0;
  if (low > high) {
    const tmp = low;
    low = high;
    high = tmp;
  }
  if (high > MAX_ROI) high = MAX_ROI;
  if (low > MAX_ROI) low = MAX_ROI;

  const reasoning =
    typeof raw.reasoning === "string" && raw.reasoning.trim().length > 0
      ? raw.reasoning
      : "(reasoning unavailable)";

  return {
    predictedRoi: roi,
    predictedRevenueJpy: revenue,
    confidenceLow: low,
    confidenceHigh: high,
    reasoning,
  };
}

/**
 * Predict ROI for a campaign brief using the injected LLM client. Always
 * returns a sanitized result; the LLM client is responsible for its own
 * fallback on transport error.
 */
export async function predictRoi(
  llm: LlmClient,
  input: RoiPredictionInput,
): Promise<RoiPredictionOutput> {
  const userPrompt = [
    `# Campaign brief`,
    `- Name: ${input.campaignName}`,
    `- Channel: ${input.channel}`,
    `- Budget (JPY): ${input.budgetJpy}`,
    `- Duration (days): ${input.durationDays}`,
    input.targetAudience ? `- Target audience: ${input.targetAudience}` : "- Target audience: (not specified)",
    "",
    "Predict ROI and revenue per the schema in the system prompt.",
  ].join("\n");

  const fallback = buildFallback(input, "fallback (生成失敗)");
  const raw = await llm.generateJson<Partial<RoiPredictionOutput>>(
    SYSTEM_PROMPT,
    userPrompt,
    fallback,
    { maxTokens: 600 },
  );

  return sanitizeRoiPrediction(raw);
}
