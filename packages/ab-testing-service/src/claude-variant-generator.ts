/**
 * Claude variant generator for A/B Testing (ported from 実運用SaaS #1304).
 *
 * Produces up to 50 variant seeds per experiment, parameterised by target
 * metric, variation axes (tone / length / cta-style), and optional brand voice.
 *
 * Cost guard: enforces a per-experiment ceiling (50 variants) and a per-tenant
 * monthly cap (default ¥10,000). Spend tracking is delegated to an injected
 * cost ledger so this module has no direct DB / secret dependency. The LLM is
 * injected too (`VariantLlmClient`).
 */

import type {
  ExperimentSurface,
  VariantPayload,
} from "./types.js";
import type { VariantSeed } from "./ab-testing-service.js";

export const VARIANT_COUNT_CEILING = 50;
export const MONTHLY_COST_CAP_JPY = 10_000;
export const COST_PER_VARIANT_JPY = 5; // ~$0.03 per variant at Claude Sonnet pricing

export type VariantTone =
  | "professional"
  | "casual"
  | "urgent"
  | "playful"
  | "authoritative";
export type VariantLength = "short" | "medium" | "long";
export type CtaStyle =
  | "imperative"
  | "question"
  | "benefit"
  | "scarcity"
  | "social_proof";

export interface VariantAxes {
  tones?: VariantTone[];
  lengths?: VariantLength[];
  ctaStyles?: CtaStyle[];
}

export interface ClaudeVariantInput {
  tenantId: string;
  experimentId: string;
  surface: ExperimentSurface;
  /** What the variant should optimise for (e.g. "メール開封率", "LP CTR"). */
  targetMetric: string;
  /** Number of variants requested. Capped at VARIANT_COUNT_CEILING. */
  count: number;
  brandVoice?: string;
  axes?: VariantAxes;
}

export interface CostCapError extends Error {
  code: "cost_cap_exceeded";
  spentJpy: number;
  limitJpy: number;
}

export class VariantCostCapError extends Error implements CostCapError {
  readonly code = "cost_cap_exceeded" as const;
  constructor(
    message: string,
    readonly spentJpy: number,
    readonly limitJpy: number,
  ) {
    super(message);
    this.name = "VariantCostCapError";
  }
}

/**
 * Injected LLM surface. The system prompt instructs the model to return valid
 * JSON; the implementation returns `fallback` on any error.
 */
export interface VariantLlmClient {
  generateJson<T>(
    system: string,
    userPrompt: string,
    fallback: T,
    options?: { maxTokens?: number; timeout?: number },
  ): Promise<T>;
}

/**
 * Injected cost ledger. `getMonthlySpendJpy` returns the rolling 30-day spend
 * for a tenant (best-effort — return 0 when unavailable). `recordSpend` appends
 * a spend row (best-effort — swallow write failures).
 */
export interface VariantCostLedger {
  getMonthlySpendJpy(tenantId: string): Promise<number>;
  recordSpend(input: {
    tenantId: string;
    experimentId: string;
    variantCount: number;
    amountJpy: number;
  }): Promise<void>;
}

interface RawVariant {
  label?: unknown;
  subject?: unknown;
  body?: unknown;
  cta?: unknown;
  tone?: unknown;
}

const SYSTEM_PROMPT = `あなたは優秀なマーケティングコピーライターです。
A/B テスト用のバリアント案を JSON 配列で出力します。
必ず JSON のみを返し、説明文を一切含めないでください。

# 出力フォーマット
[
  { "label": "短い識別子", "subject": "件名", "body": "本文(任意)", "cta": "CTAボタン文言", "tone": "tone名" }
]`;

function buildUserPrompt(input: ClaudeVariantInput): string {
  const axes = input.axes ?? {};
  const lines: string[] = [
    `# バリアント生成依頼`,
    `## 配信面 (surface): ${input.surface}`,
    `## 目的指標: ${input.targetMetric}`,
    `## 生成数: ${input.count} 件`,
  ];
  if (input.brandVoice) {
    lines.push(`## ブランドボイス\n${input.brandVoice}`);
  }
  if (axes.tones?.length) {
    lines.push(`## 試したいトーン: ${axes.tones.join(", ")}`);
  }
  if (axes.lengths?.length) {
    lines.push(`## 試したい長さ: ${axes.lengths.join(", ")}`);
  }
  if (axes.ctaStyles?.length) {
    lines.push(`## 試したい CTA スタイル: ${axes.ctaStyles.join(", ")}`);
  }
  lines.push(
    "",
    "上記の制約に従い、トーン×長さ×CTA を組み合わせて多様なバリアントを生成してください。",
    "label は短く識別可能な文字列、subject は必須、body と cta は surface に応じて適切に。",
  );
  return lines.join("\n\n");
}

function sanitiseSeeds(raw: unknown, count: number): VariantSeed[] {
  if (!Array.isArray(raw)) return [];
  const seeds: VariantSeed[] = [];
  for (const item of raw as RawVariant[]) {
    if (!item || typeof item !== "object") continue;
    const label =
      typeof item.label === "string" && item.label.trim().length > 0
        ? item.label.trim().slice(0, 64)
        : `variant_${seeds.length + 1}`;
    const subject = typeof item.subject === "string" ? item.subject.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : undefined;
    const cta = typeof item.cta === "string" ? item.cta.trim() : undefined;
    if (!subject) continue;
    const payload: VariantPayload = {
      subject,
      ...(body ? { body } : {}),
      ...(cta ? { cta } : {}),
    };
    seeds.push({ label, payload, source: "ai" });
    if (seeds.length >= count) break;
  }
  return seeds;
}

/**
 * Build a `VariantGenerator`-compatible closure over the injected LLM + ledger.
 * Enforces the count ceiling and monthly cost cap before calling the model.
 */
export async function generateClaudeVariants(
  input: ClaudeVariantInput,
  deps: { llm: VariantLlmClient; ledger: VariantCostLedger },
): Promise<VariantSeed[]> {
  const requested = Math.max(
    2,
    Math.min(VARIANT_COUNT_CEILING, Math.floor(input.count)),
  );
  const projectedCost = requested * COST_PER_VARIANT_JPY;
  const spent = await deps.ledger.getMonthlySpendJpy(input.tenantId);
  if (spent + projectedCost > MONTHLY_COST_CAP_JPY) {
    throw new VariantCostCapError(
      `monthly_variant_cost_cap_exceeded: spent=${spent} projected=${projectedCost} limit=${MONTHLY_COST_CAP_JPY}`,
      spent,
      MONTHLY_COST_CAP_JPY,
    );
  }

  const userPrompt = buildUserPrompt({ ...input, count: requested });
  const raw = await deps.llm.generateJson<unknown>(
    SYSTEM_PROMPT,
    userPrompt,
    [],
    { maxTokens: 4000, timeout: 120_000 },
  );
  const seeds = sanitiseSeeds(raw, requested);
  if (seeds.length === 0) {
    throw new Error("claude_returned_no_variants");
  }

  // Best-effort cost tracking. Write errors are swallowed.
  try {
    await deps.ledger.recordSpend({
      tenantId: input.tenantId,
      experimentId: input.experimentId,
      variantCount: seeds.length,
      amountJpy: seeds.length * COST_PER_VARIANT_JPY,
    });
  } catch {
    /* swallow */
  }

  return seeds;
}

// Internal exports for testing only.
export const __testing = {
  buildUserPrompt,
  sanitiseSeeds,
  COST_PER_VARIANT_JPY,
};
