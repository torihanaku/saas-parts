/**
 * Run cost tracker: accumulates LLM token usage / external API calls / saved
 * operator hours per step, and persists a per-step cost record with a
 * baseline comparison ("agent 1 run = ¥X vs 人手 = ¥Y").
 *
 * 出典: 実運用SaaS server/lib/agent/cost-tracker.ts
 * 変更点: setClaudeUsageHook (グローバル単一フック) → recordLlmUsage() 明示呼び /
 *         dd_deploy_costs upsert → CostStore 注入 / Nango 単価表 → pricing 設定。
 *         単価はデフォルト値ごと差し替え可能（通貨も任意）。
 */

export interface CostPricing {
  /** LLM input tokens per 1K. */
  llmInputPer1k: number;
  /** LLM output tokens per 1K. */
  llmOutputPer1k: number;
  /** Per-call rate by platform key. */
  apiCallByPlatform: Record<string, number>;
  /** Fallback per-call rate. */
  apiCallDefault: number;
  /** Operator hourly rate (labor-equivalent). */
  laborHourly: number;
  /** Baseline cost per run for the comparison (元: 代理店1配信 ¥45,000). */
  baselinePerRun: number;
}

/** 元実装の JPY 概算単価。実請求データが出たら見直す前提の保守的な値。 */
export const DEFAULT_PRICING_JPY: CostPricing = {
  llmInputPer1k: 0.45,
  llmOutputPer1k: 2.25,
  apiCallByPlatform: {},
  apiCallDefault: 0.5,
  laborHourly: 6_000,
  baselinePerRun: 45_000,
};

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostSnapshot {
  llmCost: number;
  apiCost: number;
  laborEquivalent: number;
  totalCost: number;
}

export interface CostRecord {
  tenantId: string;
  runId: string;
  stepId: string;
  cost: number;
  llmCost: number;
  apiCost: number;
  laborEquivalent: number;
  details: Record<string, unknown>;
}

/** Persistence hook (元: dd_deploy_costs へ (run, step) UNIQUE で upsert). */
export interface CostStore {
  upsert(record: CostRecord): Promise<void>;
}

export interface CostTrackerConfig {
  runId: string;
  tenantId: string;
  pricing?: Partial<CostPricing>;
  store?: CostStore;
}

export class CostTracker {
  private readonly runId: string;
  private readonly tenantId: string;
  private readonly pricing: CostPricing;
  private readonly store?: CostStore;
  private llm = { inputTokens: 0, outputTokens: 0, callCount: 0 };
  private apiCalls: Array<{ platform: string }> = [];

  constructor(config: CostTrackerConfig) {
    this.runId = config.runId;
    this.tenantId = config.tenantId;
    this.pricing = { ...DEFAULT_PRICING_JPY, ...config.pricing };
    if (config.store) this.store = config.store;
  }

  /** Reset accumulators (useful when reusing a tracker between steps). */
  reset(): void {
    this.llm = { inputTokens: 0, outputTokens: 0, callCount: 0 };
    this.apiCalls = [];
  }

  /**
   * Record one LLM call's usage. LlmCaller 実装側の usage フック
   * （@torihanaku/claude-api の setClaudeUsageHook 等）から呼ぶ。
   */
  recordLlmUsage(usage: LlmUsage): void {
    this.llm.inputTokens += usage.inputTokens;
    this.llm.outputTokens += usage.outputTokens;
    this.llm.callCount += 1;
  }

  recordApiCall(platform: string): void {
    this.apiCalls.push({ platform });
  }

  /** Compute the in-memory subtotals for the current step without persisting. */
  snapshot(args: { laborHours?: number } = {}): CostSnapshot {
    const llmCost =
      (this.llm.inputTokens / 1000) * this.pricing.llmInputPer1k +
      (this.llm.outputTokens / 1000) * this.pricing.llmOutputPer1k;
    const apiCost = this.apiCalls.reduce(
      (acc, c) => acc + (this.pricing.apiCallByPlatform[c.platform] ?? this.pricing.apiCallDefault),
      0,
    );
    const laborEquivalent = (args.laborHours ?? 0) * this.pricing.laborHourly;
    return { llmCost, apiCost, laborEquivalent, totalCost: llmCost + apiCost + laborEquivalent };
  }

  /**
   * Persist the current step's cost (idempotent on (runId, stepId) —
   * CostStore 実装側で UNIQUE upsert を想定) and return the record.
   */
  async persist(args: {
    stepId: string;
    laborHours?: number;
    baselineOverride?: number;
  }): Promise<CostRecord> {
    const laborArg = args.laborHours !== undefined ? { laborHours: args.laborHours } : {};
    const snap = this.snapshot(laborArg);
    const baseline = args.baselineOverride ?? this.pricing.baselinePerRun;
    const record: CostRecord = {
      tenantId: this.tenantId,
      runId: this.runId,
      stepId: args.stepId,
      cost: round2(snap.totalCost),
      llmCost: round2(snap.llmCost),
      apiCost: round2(snap.apiCost),
      laborEquivalent: round2(snap.laborEquivalent),
      details: {
        llm: { ...this.llm },
        api_calls: [...this.apiCalls],
        cost_comparison: {
          agent: round2(snap.totalCost),
          baseline,
          savings: round2(baseline - snap.totalCost),
        },
      },
    };
    await this.store?.upsert(record);
    return record;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
