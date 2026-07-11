/**
 * Elasticity extraction from MMM results + causal-experiment overrides
 * (Twin #1307 / #1324).
 *
 * Elasticity model: each MMM channel is a marketing input (e.g. "google_ads",
 * "blog", "email"). The fitted `beta` is the linear-on-saturated-spend
 * coefficient — i.e. the marginal contribution of one extra unit of
 * (saturated, adstocked) spend to outcome `y`. We surface that as the
 * elasticity for the corresponding scenario input.
 *
 * Outputs map: `inputKey -> { outputMetric -> elasticityCoefficient }`.
 *
 * Non-linearity: when `saturation_form` is 'hill' or 'weibull', the underlying
 * MMM is already non-linear in spend; the linear `beta` is the local slope at
 * the historical operating point. We surface this as a `formHint` field so the
 * simulator can warn callers about extrapolation accuracy.
 *
 * Ported from dev-dashboard-v2 server/lib/twin/elasticity-extractor.ts +
 * the pure parts of server/lib/twin/causal-link.ts.
 * 変更点: Supabase取得を撤去し、MMM結果行・因果リンクは引数で受け取る純粋関数に。
 * 型（SaturationForm / MmmChannelResult / CausalToTwinLink）は最小限をローカル定義。
 */

// ── Local minimal types (inlined from shared/types/causal-mmm & causal-link) ─

export type SaturationForm = "hill" | "weibull";

/** Minimal slice of the MMM per-channel fit used by the extractor. */
export interface MmmChannelResult {
  channel: string;
  /** Linear coefficient on the transformed (saturated, adstocked) series. */
  beta: number;
}

/** Latest MMM result row (shape of `dd_causal_mmm_results`). */
export interface MmmResultRow {
  channels: MmmChannelResult[];
  saturation_form: SaturationForm;
  computed_at?: string;
}

/** Causal experiment → twin link (pure DTO; persistence is the caller's job). */
export interface CausalToTwinLink {
  experimentId: string;
  channel: string;
  outputMetric: string;
  effectSize: number;
  /** True when the estimate is older than the caller's staleness policy. */
  stale?: boolean;
  /** Whole days since computed_at (used only in stale warnings). */
  ageDays?: number;
}

// ── Fallback + result types ──────────────────────────────────────────────────

export const FALLBACK_ELASTICITIES: Record<string, Record<string, number>> = {
  blog_count: { pv: 150, cv: 3 },
  ad_budget: { pv: 0.1, cv: 0.0001 },
  email_frequency: { pv: 50, cv: 1 },
};

export interface ElasticityExtractResult {
  /** inputKey -> { outputMetric -> coefficient } */
  table: Record<string, Record<string, number>>;
  /** Non-empty when fallback values were used (e.g. no MMM available). */
  warnings: string[];
  /** Saturation form of the upstream MMM, when available. */
  formHint: SaturationForm | null;
  /** True when at least one channel was sourced from real MMM data. */
  fromMmm: boolean;
}

/**
 * Default outputs that elasticities map onto. Mirrors baseline.metrics keys
 * the simulator iterates over.
 */
const DEFAULT_OUTPUTS = ["pv", "cv", "revenue"] as const;

/**
 * Map MMM channel name to scenario-input key. The simulator's UI uses these
 * keys (`blog_count`, `ad_budget`, `email_frequency`) but MMM channels may
 * carry display names like "google_ads" or "blog". We normalise.
 */
export function channelToInputKey(channel: string): string {
  const lower = channel.toLowerCase();
  if (lower.includes("blog") || lower.includes("content")) return "blog_count";
  if (lower.includes("ad") || lower.includes("google") || lower.includes("meta") || lower.includes("facebook")) {
    return "ad_budget";
  }
  if (lower.includes("email") || lower.includes("newsletter")) return "email_frequency";
  // Pass-through: any other channel shows up under its own name.
  return lower.replace(/[^a-z0-9_]+/g, "_");
}

/**
 * Extract the elasticity table from the latest MMM result row.
 * Pass `null` when no MMM result is available — the fallback table is used.
 */
export function extractElasticitiesFromMmm(row: MmmResultRow | null): ElasticityExtractResult {
  if (!row) {
    return {
      table: { ...FALLBACK_ELASTICITIES },
      warnings: ["mmm_not_available_using_fallback_elasticities"],
      formHint: null,
      fromMmm: false,
    };
  }

  const channels = Array.isArray(row.channels) ? row.channels : [];
  if (channels.length === 0) {
    return {
      table: { ...FALLBACK_ELASTICITIES },
      warnings: ["mmm_result_has_no_channels_using_fallback"],
      formHint: row.saturation_form ?? null,
      fromMmm: false,
    };
  }

  const table: Record<string, Record<string, number>> = {};
  const warnings: string[] = [];

  for (const ch of channels) {
    if (!Number.isFinite(ch.beta)) {
      warnings.push(`channel_${ch.channel}_invalid_beta`);
      continue;
    }
    const inputKey = channelToInputKey(ch.channel);
    // Project the same beta across the canonical output metrics so the
    // simulator can iterate without per-output MMM fits.
    const perOutput: Record<string, number> = {};
    for (const out of DEFAULT_OUTPUTS) {
      perOutput[out] = ch.beta;
    }
    // Keep last-write-wins so the most recent / strongest channel of a key
    // dominates if MMM has split it (rare).
    table[inputKey] = perOutput;
  }

  if (Object.keys(table).length === 0) {
    return {
      table: { ...FALLBACK_ELASTICITIES },
      warnings: ["mmm_channels_unusable_using_fallback", ...warnings],
      formHint: row.saturation_form ?? null,
      fromMmm: false,
    };
  }

  if (row.saturation_form === "hill" || row.saturation_form === "weibull") {
    warnings.push("mmm_nonlinear_local_slope_only");
  }

  return {
    table,
    warnings,
    formHint: row.saturation_form ?? null,
    fromMmm: true,
  };
}

// Internal exports for testing.
export const __testing = { channelToInputKey, DEFAULT_OUTPUTS };

// ── Causal-link override (#1324, B5 batch) ──────────────────────────────────
//
// `extractElasticitiesFromMmm` returns regression-derived betas. Causal
// experiments (DID / synthetic control / RCT) are strictly stronger because
// they identify *causal* impact, not just correlation. The wrapper below:
//   1. Calls extractElasticitiesFromMmm (existing behavior, fallback)
//   2. Takes causal links (loaded by the caller from persistence)
//   3. For any (input_key, output) present in the causal links, overrides
//      the MMM beta with the causal effect_size.
//   4. Returns an extra `provenance` map so the UI can render
//      "出所: DID 実験 #XX" per overridden cell.
//
// Per-cell precedence: causal_link > MMM beta > FALLBACK_ELASTICITIES.

export interface CausalElasticityResult {
  /** inputKey (e.g. blog_count, ad_budget) -> outputMetric -> coefficient */
  table: Record<string, Record<string, number>>;
  /** experiment_id per (inputKey, outputMetric) for UI provenance */
  provenance: Record<string, Record<string, string>>;
  /** human-readable warnings (e.g. stale links) */
  warnings: string[];
}

/**
 * Build a `{ inputKey -> { outputMetric -> elasticity } }` table from the
 * causal links, in the same shape `extractElasticitiesFromMmm` returns.
 */
export function buildCausalElasticityTable(links: CausalToTwinLink[]): CausalElasticityResult {
  const table: Record<string, Record<string, number>> = {};
  const provenance: Record<string, Record<string, string>> = {};
  const warnings: string[] = [];

  for (const link of links) {
    const inputKey = channelToInputKey(link.channel);
    table[inputKey] = table[inputKey] ?? {};
    table[inputKey]![link.outputMetric] = link.effectSize;
    provenance[inputKey] = provenance[inputKey] ?? {};
    provenance[inputKey]![link.outputMetric] = link.experimentId;
    if (link.stale) {
      warnings.push(
        `causal_link_stale: ${link.channel}/${link.outputMetric} ` +
          `from experiment ${link.experimentId} is ${link.ageDays ?? "?"} days old`,
      );
    }
  }

  return { table, provenance, warnings };
}

export interface ElasticityWithCausalResult extends ElasticityExtractResult {
  /** {inputKey: {output: experiment_id}} for cells overridden by causal link */
  causalProvenance: Record<string, Record<string, string>>;
  /** True when at least one cell was overridden by a causal link */
  hasCausalOverride: boolean;
}

/**
 * MMM extraction + causal override merge.
 * `mmmRow` and `causalLinks` are loaded by the caller (persistence-agnostic).
 */
export function extractElasticitiesWithCausalPreference(
  mmmRow: MmmResultRow | null,
  causalLinks: CausalToTwinLink[],
): ElasticityWithCausalResult {
  // Step 1 — MMM extraction (existing behavior).
  const mmmResult = extractElasticitiesFromMmm(mmmRow);

  if (causalLinks.length === 0) {
    return {
      ...mmmResult,
      causalProvenance: {},
      hasCausalOverride: false,
    };
  }

  const causal = buildCausalElasticityTable(causalLinks);
  const merged: Record<string, Record<string, number>> = {};
  // Start from the MMM/fallback table so all keys are present.
  for (const [k, v] of Object.entries(mmmResult.table)) {
    merged[k] = { ...v };
  }
  // Causal overrides per (inputKey, output).
  let overrideCount = 0;
  for (const [inputKey, perOutput] of Object.entries(causal.table)) {
    merged[inputKey] = merged[inputKey] ?? {};
    for (const [output, coef] of Object.entries(perOutput)) {
      merged[inputKey]![output] = coef;
      overrideCount += 1;
    }
  }

  return {
    table: merged,
    warnings: [...mmmResult.warnings, ...causal.warnings],
    formHint: mmmResult.formHint,
    fromMmm: mmmResult.fromMmm,
    causalProvenance: causal.provenance,
    hasCausalOverride: overrideCount > 0,
  };
}
