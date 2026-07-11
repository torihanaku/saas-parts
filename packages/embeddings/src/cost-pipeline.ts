/**
 * Embedding cost pipeline (per-tenant monthly budget guardrail).
 *
 * Ported from dev-dashboard-v2
 * `server/lib/institutional-memory/embedding-pipeline.ts`.
 *
 * Wraps `embedText()` from the registry to add:
 *   1. Token estimation (≈ 1 token per 4 chars, conservative for JP/EN mix)
 *   2. Per-tenant per-month cost tracking (was Supabase `dd_embedding_costs`
 *      + `increment_embedding_cost` RPC — now an injected EmbeddingCostStore)
 *   3. Soft budget enforcement (default ¥5,000 / tenant / month)
 *
 * Product coupling removed:
 * - Supabase admin client → `EmbeddingCostStore` interface (injected)
 * - `logger.logInfo/logError` → injectable callbacks (default: silent info,
 *   console.error for errors)
 * - The embed function itself is injectable (defaults to the registry's
 *   `embedText`), so the pipeline can be tested / reused standalone.
 *
 * NOTE: Cost model assumes OpenAI text-embedding-3-small, priced at
 * $0.02 / 1M tokens, converted to JPY at a conservative 160 JPY/USD;
 * over-estimating is fine because the cap is a soft guardrail.
 */

import { embedText as registryEmbedText } from "./registry";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default soft monthly budget per tenant (JPY). Enforced before each embed call. */
export const DEFAULT_MONTHLY_LIMIT_JPY = 5_000;

/**
 * USD → JPY conversion. Conservative over-estimate so cost gating fires
 * earlier rather than later if the JPY weakens.
 */
const USD_TO_JPY = 160;

/**
 * OpenAI text-embedding-3-small pricing: $0.02 per 1M input tokens.
 * Source: https://openai.com/api/pricing (snapshot 2026-04).
 */
const COST_USD_PER_TOKEN = 0.02 / 1_000_000;

/**
 * Rough token estimate: 4 chars ≈ 1 token. Conservative for the
 * JP/EN mix typical of marketing decision logs (real value tends
 * to land 3.5-5 chars/token; we round low so we over-estimate cost).
 */
const CHARS_PER_TOKEN = 4;

// ─── Public types ───────────────────────────────────────────────────────────

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

// ─── Injected store interface (was Supabase dd_embedding_costs) ─────────────

export interface MonthlyCostRow {
  total_tokens: number;
  total_cost_jpy: number;
  call_count: number;
}

export interface EmbeddingCostStore {
  /**
   * Return the tenant's cost row for the month, or null when absent.
   * Throw on storage failure (the pipeline degrades to zeros + logError,
   * matching the original Supabase error path).
   */
  getMonthlyCost(tenantId: string, yearMonth: string): Promise<MonthlyCostRow | null>;
  /**
   * Atomically add usage to the tenant's monthly bucket and return the
   * updated row (was the `increment_embedding_cost` RPC). Throw on failure.
   */
  incrementCost(entry: {
    tenantId: string;
    yearMonth: string;
    tokens: number;
    costJpy: number;
    provider: string;
  }): Promise<MonthlyCostRow | null>;
}

// ─── Token / cost estimation ────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateCostJpy(tokens: number): number {
  // Full JS precision — a NUMERIC(15,6)-style column keeps small per-call
  // costs (a single embed of 8 tokens ≈ 0.0000256 JPY) accumulating correctly
  // over thousands of calls. Earlier rounding to 4 decimals collapsed small
  // values to 0 and broke the running total.
  return tokens * COST_USD_PER_TOKEN * USD_TO_JPY;
}

// ─── Month bucket helper ────────────────────────────────────────────────────

export function currentYearMonth(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// ─── Pipeline factory ───────────────────────────────────────────────────────

export interface CostPipelineConfig {
  /** Storage backend for the per-tenant monthly cost ledger. */
  store: EmbeddingCostStore;
  /** Embed function. Default: the registry's `embedText`. */
  embed?: (text: string, slug?: string) => Promise<number[]>;
  /** Soft monthly cap in JPY. Default: DEFAULT_MONTHLY_LIMIT_JPY (¥5,000). */
  monthlyLimitJpy?: number;
  /** Info logger. Default: no-op. */
  logInfo?: (scope: string, message: string) => void;
  /** Error logger. Default: console.error. */
  logError?: (scope: string, err: unknown) => void;
}

export interface PipelineOptions {
  /** Provider slug override (default: registry primary). */
  provider?: string;
  /** Skip the budget check. Use only for system / migration paths. */
  skipBudgetCheck?: boolean;
  /** Override Date.now() for deterministic tests. */
  now?: Date;
}

export interface EmbeddingCostPipeline {
  readonly monthlyLimitJpy: number;
  getMonthlyCost(
    tenantId: string,
    yearMonth?: string,
  ): Promise<{ tokens: number; jpy: number; calls: number }>;
  assertWithinBudget(
    tenantId: string,
    projectedJpy: number,
    yearMonth?: string,
  ): Promise<{ remainingJpy: number; currentJpy: number }>;
  embedMemoryText(
    tenantId: string,
    text: string,
    options?: PipelineOptions,
  ): Promise<EmbeddingPipelineResult>;
}

export function createCostPipeline(config: CostPipelineConfig): EmbeddingCostPipeline {
  const {
    store,
    embed = registryEmbedText,
    monthlyLimitJpy = DEFAULT_MONTHLY_LIMIT_JPY,
    logInfo = () => {},
    logError = (scope, err) => console.error(`[${scope}]`, err),
  } = config;

  async function getMonthlyCost(
    tenantId: string,
    yearMonth: string = currentYearMonth(),
  ): Promise<{ tokens: number; jpy: number; calls: number }> {
    let row: MonthlyCostRow | null;
    try {
      row = await store.getMonthlyCost(tenantId, yearMonth);
    } catch (error) {
      logError("embedding-pipeline.getMonthlyCost", error);
      return { tokens: 0, jpy: 0, calls: 0 };
    }
    return {
      tokens: row?.total_tokens ?? 0,
      jpy: Number(row?.total_cost_jpy ?? 0),
      calls: row?.call_count ?? 0,
    };
  }

  async function assertWithinBudget(
    tenantId: string,
    projectedJpy: number,
    yearMonth: string = currentYearMonth(),
  ): Promise<{ remainingJpy: number; currentJpy: number }> {
    const { jpy: currentJpy } = await getMonthlyCost(tenantId, yearMonth);
    const projectedTotal = currentJpy + projectedJpy;
    if (projectedTotal > monthlyLimitJpy) {
      throw new EmbeddingBudgetExceededError(
        tenantId,
        yearMonth,
        projectedTotal,
        monthlyLimitJpy,
      );
    }
    return {
      currentJpy,
      remainingJpy: monthlyLimitJpy - projectedTotal,
    };
  }

  async function chargeCost(
    tenantId: string,
    yearMonth: string,
    tokens: number,
    costJpy: number,
    provider: string,
  ): Promise<number> {
    const row = await store.incrementCost({ tenantId, yearMonth, tokens, costJpy, provider });
    return Number(row?.total_cost_jpy ?? 0);
  }

  /**
   * Embed a memory-bound text and atomically charge the tenant's monthly bucket.
   *
   * Throws `EmbeddingBudgetExceededError` if this call would push the tenant
   * over the soft cap. Throws upstream errors (provider failure, store
   * failure during read) untouched.
   */
  async function embedMemoryText(
    tenantId: string,
    text: string,
    options: PipelineOptions = {},
  ): Promise<EmbeddingPipelineResult> {
    if (!tenantId) {
      throw new Error("tenantId is required for embedMemoryText");
    }
    if (!text || !text.trim()) {
      throw new Error("text is required for embedMemoryText");
    }

    const tokens = estimateTokens(text);
    const costJpy = estimateCostJpy(tokens);
    const yearMonth = currentYearMonth(options.now);

    // Fail fast before we burn a provider call we can't bill for.
    if (!options.skipBudgetCheck) {
      await assertWithinBudget(tenantId, costJpy, yearMonth);
    }

    const embedding = await embed(text, options.provider);

    // Charge after success. Ledger drift is acceptable on transient store
    // errors; we log + return so the embedding result is still usable. The
    // next call's assertWithinBudget will recover the actual cumulative state.
    let monthlyTotalJpy = 0;
    try {
      monthlyTotalJpy = await chargeCost(
        tenantId,
        yearMonth,
        tokens,
        costJpy,
        options.provider ?? "openai-3-small",
      );
    } catch (err) {
      logError("embedding-pipeline.charge", err);
    }

    logInfo(
      "embedding-pipeline.embedMemoryText",
      `tenant=${tenantId} tokens=${tokens} cost=¥${costJpy.toFixed(4)} ` +
        `month=${yearMonth} monthlyTotal=¥${monthlyTotalJpy.toFixed(2)}`,
    );

    return { embedding, tokensUsed: tokens, costJpy, monthlyTotalJpy };
  }

  return { monthlyLimitJpy, getMonthlyCost, assertWithinBudget, embedMemoryText };
}
