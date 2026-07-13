/**
 * Embedding pipeline for institutional memory (ported from 実運用SaaS
 * institutional-memory/embedding-pipeline, Memory-2 / #1326).
 *
 * Wraps an injected `embed()` to add:
 *   1. Token estimation (≈ 1 token per 4 chars, conservative for JP/EN mix)
 *   2. Per-tenant per-month cost tracking (injected cost ledger)
 *   3. Soft budget enforcement (¥5,000 / tenant / month)
 *
 * The embedder and cost ledger are injected, so there is no direct OpenAI /
 * Supabase dependency.
 */

import type { MemoryLogger } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

/** Soft monthly budget per tenant (JPY). Enforced before each embed call. */
export const MONTHLY_LIMIT_JPY = 5_000;

/** USD → JPY conversion (conservative over-estimate). */
const USD_TO_JPY = 160;

/** OpenAI text-embedding-3-small pricing: $0.02 per 1M input tokens. */
const COST_USD_PER_TOKEN = 0.02 / 1_000_000;

/** Rough token estimate: 4 chars ≈ 1 token (conservative for JP/EN mix). */
const CHARS_PER_TOKEN = 4;

export interface EmbeddingPipelineResult {
  embedding: number[];
  tokensUsed: number;
  costJpy: number;
  monthlyTotalJpy: number;
}

export class EmbeddingBudgetExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly yearMonth: string,
    public readonly currentJpy: number,
    public readonly limitJpy: number,
  ) {
    super(
      `Embedding budget exceeded for tenant ${tenantId} in ${yearMonth}: ` +
        `¥${currentJpy.toFixed(2)} / ¥${limitJpy} cap`,
    );
    this.name = "EmbeddingBudgetExceededError";
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateCostJpy(tokens: number): number {
  return tokens * COST_USD_PER_TOKEN * USD_TO_JPY;
}

export function currentYearMonth(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * Injected embedder. Returns the embedding vector for `text`. Throws on
 * provider failure (propagated untouched by the pipeline).
 */
export type Embedder = (text: string, provider?: string) => Promise<number[]>;

/**
 * Injected monthly cost ledger. `getMonthly` returns the current spend for a
 * tenant/month; `charge` atomically adds a call and returns the new running
 * total (JPY). `charge` may throw — the pipeline logs and continues.
 */
export interface EmbeddingCostLedger {
  getMonthly(
    tenantId: string,
    yearMonth: string,
  ): Promise<{ tokens: number; jpy: number; calls: number }>;
  charge(input: {
    tenantId: string;
    yearMonth: string;
    tokens: number;
    costJpy: number;
    provider: string;
  }): Promise<number>;
}

export interface EmbeddingPipelineDeps {
  embed: Embedder;
  ledger: EmbeddingCostLedger;
  logger?: MemoryLogger;
}

export async function getMonthlyCost(
  tenantId: string,
  ledger: EmbeddingCostLedger,
  yearMonth: string = currentYearMonth(),
): Promise<{ tokens: number; jpy: number; calls: number }> {
  return ledger.getMonthly(tenantId, yearMonth);
}

export async function assertWithinBudget(
  tenantId: string,
  projectedJpy: number,
  ledger: EmbeddingCostLedger,
  yearMonth: string = currentYearMonth(),
): Promise<{ remainingJpy: number; currentJpy: number }> {
  const { jpy: currentJpy } = await ledger.getMonthly(tenantId, yearMonth);
  const projectedTotal = currentJpy + projectedJpy;
  if (projectedTotal > MONTHLY_LIMIT_JPY) {
    throw new EmbeddingBudgetExceededError(
      tenantId,
      yearMonth,
      projectedTotal,
      MONTHLY_LIMIT_JPY,
    );
  }
  return { currentJpy, remainingJpy: MONTHLY_LIMIT_JPY - projectedTotal };
}

export interface PipelineOptions {
  /** Embedding provider slug override. */
  provider?: string;
  /** Skip the budget check. Use only for system / migration paths. */
  skipBudgetCheck?: boolean;
  /** Override Date.now() for deterministic tests. */
  now?: Date;
}

/**
 * Embed a memory-bound text and charge the tenant's monthly bucket.
 *
 * Throws `EmbeddingBudgetExceededError` when the call would exceed the soft
 * ¥5,000 cap. Provider / ledger read errors propagate; a ledger *charge*
 * failure is logged and swallowed (the embedding result stays usable).
 */
export async function embedMemoryText(
  tenantId: string,
  text: string,
  deps: EmbeddingPipelineDeps,
  options: PipelineOptions = {},
): Promise<EmbeddingPipelineResult> {
  const logger = deps.logger ?? NOOP_LOGGER;
  if (!tenantId) throw new Error("tenantId is required for embedMemoryText");
  if (!text || !text.trim()) {
    throw new Error("text is required for embedMemoryText");
  }

  const tokens = estimateTokens(text);
  const costJpy = estimateCostJpy(tokens);
  const yearMonth = currentYearMonth(options.now);

  if (!options.skipBudgetCheck) {
    await assertWithinBudget(tenantId, costJpy, deps.ledger, yearMonth);
  }

  const embedding = await deps.embed(text, options.provider);

  let monthlyTotalJpy = 0;
  try {
    monthlyTotalJpy = await deps.ledger.charge({
      tenantId,
      yearMonth,
      tokens,
      costJpy,
      provider: options.provider ?? "openai-3-small",
    });
  } catch (err) {
    logger.error("embedding-pipeline.charge", err);
  }

  logger.info(
    "embedding-pipeline.embedMemoryText",
    `tenant=${tenantId} tokens=${tokens} cost=¥${costJpy.toFixed(4)} ` +
      `month=${yearMonth} monthlyTotal=¥${monthlyTotalJpy.toFixed(2)}`,
  );

  return { embedding, tokensUsed: tokens, costJpy, monthlyTotalJpy };
}
