/**
 * Marketplace pattern extractor.
 *
 * Ported from dev-dashboard-v2 `server/lib/marketplace/extractor.ts`.
 * The Claude call (generateJson + API key resolution via tenant secrets / env)
 * is replaced with an injected {@link JsonGenerator} callback; persistence via
 * the supabase-admin client is replaced with the shared {@link MarketplaceStore}.
 *
 * Pipeline:
 *   1. Take a campaign list with at minimum CTR / CVR per campaign
 *   2. Filter to top decile by `weight = ctr * 0.5 + cvr * 0.5` (no hard
 *      cutoff — fewer than 10 campaigns falls back to top 1)
 *   3. Send the top decile to the LLM with a strict system prompt that asks
 *      for *structural* patterns only — never product names, numbers, or URLs.
 *   4. Run every LLM string through scrubText so a leak from the model is
 *      still removed
 *   5. Dedup: hash (subjectPattern + channels.sorted + tone) and look up
 *      existing rows for the same tenant; update if hit, insert otherwise.
 */

import { createHash } from "node:crypto";

import { scrubText, extractAnonymizedPattern } from "./anonymize";
import type { MarketplaceStore } from "./marketplace";
import type { AnonymizedPattern, MarketplaceCampaignType, MarketplaceGoal } from "./types";

/** LLM JSON generation callback (replaces the original claude-api-client.generateJson). */
export type JsonGenerator = <T>(
  system: string,
  prompt: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

export interface CampaignSnapshot {
  id: string;
  /** Free-form name; will be scrubbed before sent to the LLM. */
  name?: string;
  campaignType?: MarketplaceCampaignType;
  goal?: MarketplaceGoal;
  industry?: string;
  /** 0-1 click-through rate */
  ctr: number;
  /** 0-1 conversion rate */
  cvr: number;
  /** Optional structural fields the heuristic extractor can also use. */
  raw?: Record<string, unknown>;
}

export interface ExtractorOptions {
  /** LLM callback. Without it extraction cannot run and [] is returned. */
  generateJson?: JsonGenerator;
  /** How many top-decile campaigns to feed the LLM. */
  maxTopDecile?: number;
}

export interface ExtractedPattern {
  pattern_hash: string;
  anonymized_pattern: AnonymizedPattern;
  source_campaign_count: number;
  campaignType: MarketplaceCampaignType;
  goal: MarketplaceGoal | null;
  industry: string | null;
}

const DEFAULTS: Required<Pick<ExtractorOptions, "maxTopDecile">> = {
  maxTopDecile: 5,
};

/**
 * Filter campaigns to the top decile by combined CTR/CVR weight. Returns
 * up to `options.maxTopDecile` rows, always including the single best
 * campaign even when the input is small.
 */
export function selectTopDecile(
  campaigns: CampaignSnapshot[],
  options: { maxTopDecile?: number } = {},
): CampaignSnapshot[] {
  const max = options.maxTopDecile ?? DEFAULTS.maxTopDecile;
  if (campaigns.length === 0) return [];
  const ranked = [...campaigns].sort(
    (a, b) => weight(b) - weight(a),
  );
  const decileCount = Math.max(1, Math.ceil(campaigns.length * 0.1));
  return ranked.slice(0, Math.min(decileCount, max));
}

function weight(c: CampaignSnapshot): number {
  return c.ctr * 0.5 + c.cvr * 0.5;
}

/**
 * Stable hash of the structural identity of a pattern. Used for dedup —
 * two patterns with the same subjectPattern, channel set, and tone are
 * considered the same template.
 */
export function patternHash(pattern: AnonymizedPattern): string {
  const channels = (pattern.channels ?? []).slice().sort().join(",");
  const key = `${pattern.subjectPattern ?? ""}|${channels}|${pattern.tone ?? ""}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export const EXTRACTOR_SYSTEM_PROMPT = `You extract reusable marketing patterns from high-performing campaigns.

CRITICAL RULES:
1. NEVER include product names, company names, person names, URLs, emails.
2. NEVER include absolute numbers (件, 円, %, x). Use placeholders like
   {n}, {benefit}, {timeframe} instead.
3. Output structural patterns only — subject template, channel mix,
   timing relative to launch, components (CTA / social proof / etc.),
   tone keywords.

Output JSON shape:
{
  "patterns": [
    {
      "subjectPattern": "string with {placeholders}",
      "channels": ["email", "retargeting", ...],
      "timing": ["launch+0d", "launch+3d", ...],
      "components": ["primary_cta_above_fold", "social_proof_count", ...],
      "tone": "calm | urgent | playful | authoritative"
    }
  ]
}`;

/**
 * Run extraction over a campaign list and return the deduped, anonymized
 * patterns. Does not persist — call persistPatterns separately so the
 * caller can review or filter.
 */
export async function extractPatterns(
  campaigns: CampaignSnapshot[],
  options: ExtractorOptions = {},
): Promise<ExtractedPattern[]> {
  if (campaigns.length === 0) return [];
  const top = selectTopDecile(campaigns, { maxTopDecile: options.maxTopDecile });
  if (top.length === 0) return [];

  const generateJson = options.generateJson;
  if (!generateJson) {
    console.warn("[template-marketplace/extractor] generateJson callback not configured");
    return [];
  }

  // Build a strictly anonymized prompt: campaign names are scrubbed before
  // they hit the model. Numeric fields are presented as relative buckets.
  const userPrompt = [
    "以下の高パフォーマンスキャンペーンから再利用可能な構造パターンを抽出してください。",
    "JSON形式で patterns 配列を返してください。",
    "",
    ...top.map((c, i) =>
      [
        `Campaign ${i + 1}:`,
        `  type: ${c.campaignType ?? "unknown"}`,
        `  goal: ${c.goal ?? "unknown"}`,
        `  ctr_bucket: ${ctrBucket(c.ctr)}`,
        `  cvr_bucket: ${cvrBucket(c.cvr)}`,
        c.name ? `  name (scrubbed): ${scrubText(c.name)}` : null,
        c.raw?.subject ? `  subject (scrubbed): ${scrubText(String(c.raw.subject))}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");

  const fallback = { patterns: [] as Array<Record<string, unknown>> };
  const result = await generateJson<{
    patterns: Array<Record<string, unknown>>;
  }>(EXTRACTOR_SYSTEM_PROMPT, userPrompt, fallback, { maxTokens: 1500 });

  if (!result.patterns || result.patterns.length === 0) return [];

  // Defense in depth: re-run scrubText through the heuristic extractor so
  // anything the model leaked is stripped out before persistence.
  const dominantType = top[0]?.campaignType ?? "other";
  const dominantGoal = top[0]?.goal ?? null;
  const dominantIndustry = top[0]?.industry ?? null;

  const seen = new Set<string>();
  const out: ExtractedPattern[] = [];
  for (const raw of result.patterns) {
    const cleaned = extractAnonymizedPattern(raw);
    if (!cleaned.subjectPattern && !cleaned.channels?.length) continue;
    const hash = patternHash(cleaned);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      pattern_hash: hash,
      anonymized_pattern: cleaned,
      source_campaign_count: top.length,
      campaignType: dominantType,
      goal: dominantGoal,
      industry: dominantIndustry,
    });
  }
  return out;
}

function ctrBucket(ctr: number): string {
  if (ctr >= 0.1) return "very_high";
  if (ctr >= 0.05) return "high";
  if (ctr >= 0.02) return "medium";
  return "low";
}

function cvrBucket(cvr: number): string {
  if (cvr >= 0.1) return "very_high";
  if (cvr >= 0.05) return "high";
  if (cvr >= 0.02) return "medium";
  return "low";
}

/**
 * Upsert extracted patterns into the template store. Dedup is by
 * (tenant_id, pattern_hash) — second extraction with the same shape
 * updates the existing row's `success_signals.source_campaign_count` and
 * `updated_at` instead of inserting a duplicate.
 */
export async function persistPatterns(
  store: MarketplaceStore,
  tenantId: string,
  patterns: ExtractedPattern[],
  submittedBy: string | null = null,
  now: () => Date = () => new Date(),
): Promise<{ inserted: number; updated: number }> {
  if (patterns.length === 0) return { inserted: 0, updated: 0 };
  let inserted = 0;
  let updated = 0;

  for (const p of patterns) {
    // Find existing row with the same hash for this tenant.
    const existingId = await store.findTemplateIdByPatternHash(tenantId, p.pattern_hash);

    if (existingId) {
      const ok = await store.patchTemplate(existingId, {
        anonymized_pattern: p.anonymized_pattern,
        success_signals: {
          source_campaign_count: p.source_campaign_count,
          extracted_via: "claude-v1",
        },
        updated_at: now().toISOString(),
      });
      if (ok) updated += 1;
      continue;
    }
    const row = await store.insertTemplateReturning({
      tenant_id: tenantId,
      submitted_by: submittedBy,
      title: synthesizeTitle(p),
      description: null,
      industry: p.industry,
      campaign_type: p.campaignType,
      goal: p.goal,
      anonymized_pattern: p.anonymized_pattern,
      success_signals: {
        source_campaign_count: p.source_campaign_count,
        extracted_via: "claude-v1",
      },
      pattern_hash: p.pattern_hash,
      status: "draft",
      published: false,
    });
    if (row) inserted += 1;
  }

  return { inserted, updated };
}

function synthesizeTitle(p: ExtractedPattern): string {
  const stem = p.anonymized_pattern.subjectPattern?.slice(0, 40) ?? "Pattern";
  return `${stem} (${p.campaignType}/${p.goal ?? "n/a"})`;
}
