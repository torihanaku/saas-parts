/**
 * Causal → Twin elasticity bridge (ported from dev-dashboard-v2 twin/causal-link).
 *
 * A causal experiment's effect-size is the most trustworthy elasticity estimate
 * available (causally identified, not merely correlational). This module maps
 * causal links into the `{ inputKey -> { outputMetric -> elasticity } }` table
 * the simulator consumes, and flags stale links (> 90 days).
 *
 * The pure orchestration parts (channel mapping, DTO shaping, elasticity-table
 * building) are self-contained. Persistence (upsert / list) is injected via
 * `CausalLinkStore`.
 */

const STALE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CausalToTwinLink {
  id: string;
  tenantId: string;
  experimentId: string;
  channel: string;
  outputMetric: string;
  effectSize: number;
  ciLower: number | null;
  ciUpper: number | null;
  method: string | null;
  computedAt: string;
  /** True when computed_at is older than 90 days. */
  stale: boolean;
  /** Whole days since computed_at. */
  ageDays: number;
}

export interface SaveCausalLinkInput {
  tenantId: string;
  experimentId: string;
  channel: string;
  outputMetric?: string;
  effectSize: number;
  ciLower?: number | null;
  ciUpper?: number | null;
  method?: string | null;
}

/** Raw persisted row shape. */
export interface CausalLinkRow {
  id: string;
  tenant_id: string;
  experiment_id: string;
  channel: string;
  output_metric: string;
  effect_size: number | string;
  ci_lower: number | string | null;
  ci_upper: number | string | null;
  method: string | null;
  computed_at: string;
}

/** Injected persistence surface for causal links. */
export interface CausalLinkStore {
  upsertCausalLink(payload: {
    tenantId: string;
    experimentId: string;
    channel: string;
    outputMetric: string;
    effectSize: number;
    ciLower: number | null;
    ciUpper: number | null;
    method: string | null;
    computedAt: string;
  }): Promise<CausalLinkRow>;
  /** All links for a tenant, newest first. */
  listCausalLinks(tenantId: string): Promise<CausalLinkRow[]>;
}

export function rowToDto(row: CausalLinkRow, now: Date = new Date()): CausalToTwinLink {
  const computedMs = Date.parse(row.computed_at);
  const ageDays = Number.isFinite(computedMs)
    ? Math.floor((now.getTime() - computedMs) / MS_PER_DAY)
    : 0;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    experimentId: row.experiment_id,
    channel: row.channel,
    outputMetric: row.output_metric,
    effectSize: Number(row.effect_size),
    ciLower: row.ci_lower == null ? null : Number(row.ci_lower),
    ciUpper: row.ci_upper == null ? null : Number(row.ci_upper),
    method: row.method,
    computedAt: row.computed_at,
    ageDays,
    stale: ageDays > STALE_DAYS,
  };
}

/**
 * UPSERT a causal link. Unique key is (tenant, experiment, channel, output).
 */
export async function saveCausalToTwinLink(
  input: SaveCausalLinkInput,
  store: CausalLinkStore,
): Promise<CausalToTwinLink> {
  if (!input.tenantId) throw new Error("tenantId is required");
  if (!input.experimentId) throw new Error("experimentId is required");
  if (!input.channel) throw new Error("channel is required");
  if (!Number.isFinite(input.effectSize)) {
    throw new Error("effectSize must be a finite number");
  }

  const row = await store.upsertCausalLink({
    tenantId: input.tenantId,
    experimentId: input.experimentId,
    channel: input.channel,
    outputMetric: input.outputMetric ?? "revenue",
    effectSize: input.effectSize,
    ciLower: input.ciLower ?? null,
    ciUpper: input.ciUpper ?? null,
    method: input.method ?? null,
    computedAt: new Date().toISOString(),
  });
  return rowToDto(row);
}

/**
 * Latest link per (channel, output_metric) for a tenant. Stale entries are
 * included with `stale: true` so the caller can decide whether to apply them.
 */
export async function getTenantCausalLinks(
  tenantId: string,
  store: CausalLinkStore,
  options: { now?: Date } = {},
): Promise<CausalToTwinLink[]> {
  if (!tenantId) throw new Error("tenantId is required");

  const rows = await store.listCausalLinks(tenantId);
  const seen = new Set<string>();
  const out: CausalToTwinLink[] = [];
  for (const row of rows) {
    const key = `${row.channel}::${row.output_metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rowToDto(row, options.now));
  }
  return out;
}

export interface CausalElasticityResult {
  /** inputKey (e.g. blog_count, ad_budget) -> outputMetric -> coefficient */
  table: Record<string, Record<string, number>>;
  /** experiment_id per (inputKey, outputMetric) for UI provenance */
  provenance: Record<string, Record<string, string>>;
  /** human-readable warnings (e.g. stale links) */
  warnings: string[];
}

export function channelToInputKey(channel: string): string {
  const lower = channel.toLowerCase();
  if (lower.includes("blog") || lower.includes("content")) return "blog_count";
  if (
    lower.includes("ad") ||
    lower.includes("google") ||
    lower.includes("meta") ||
    lower.includes("facebook")
  ) {
    return "ad_budget";
  }
  if (lower.includes("email") || lower.includes("newsletter")) {
    return "email_frequency";
  }
  return lower.replace(/[^a-z0-9_]+/g, "_");
}

export function buildCausalElasticityTable(
  links: CausalToTwinLink[],
): CausalElasticityResult {
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
          `from experiment ${link.experimentId} is ${link.ageDays} days old`,
      );
    }
  }

  return { table, provenance, warnings };
}

export const __testing = { STALE_DAYS };
