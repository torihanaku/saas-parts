/**
 * Asset Debt Scorer.
 * 出典: dev-dashboard-v2 server/lib/marketing-debt-scorer.ts (#355 G10 Sprint 1)。
 *
 * 6 種類の asset を「放置すると ROI が下がる項目」として per-tenant でスコアリングする。
 * freshness decay と asset 固有メタデータを組み合わせて severity / recommendation を導出。
 * ロジックは原文そのまま (port; not rewrite)。
 */
import type {
  AssetType,
  DebtScoringInput,
  DebtScoringResult,
  DebtSeverity,
} from "./types";

const SEVERITY_THRESHOLDS = { high: 0.3, med: 0.6 } as const;

/** Asset 種別ごとの既定 decay rate (1 日あたりの freshnessScore 低下量)。 */
export const DEFAULT_DECAY_RATES: Record<string, number> = {
  content: 0.005,
  persona: 0.002,
  campaign: 0.01,
  link: 0.0,
  seo_article: 0.008,
  crm_data: 0.003,
};

const KNOWN_ASSET_TYPES: ReadonlySet<string> = new Set([
  "content",
  "persona",
  "campaign",
  "link",
  "seo_article",
  "crm_data",
]);

export function isKnownAssetType(value: unknown): value is AssetType {
  return typeof value === "string" && KNOWN_ASSET_TYPES.has(value);
}

export function deriveSeverity(freshnessScore: number): DebtSeverity {
  if (freshnessScore < SEVERITY_THRESHOLDS.high) return "high";
  if (freshnessScore < SEVERITY_THRESHOLDS.med) return "med";
  return "low";
}

export function daysSince(
  lastActiveAt: string | null | undefined,
  now: Date = new Date(),
): number {
  if (!lastActiveAt) return 0;
  const last = new Date(lastActiveAt);
  if (Number.isNaN(last.getTime())) return 0;
  const diffMs = now.getTime() - last.getTime();
  if (diffMs <= 0) return 0;
  return diffMs / (1000 * 60 * 60 * 24);
}

export function computeFreshness(
  lastActiveAt: string | null | undefined,
  decayRate: number,
  now: Date = new Date(),
): number {
  const days = daysSince(lastActiveAt, now);
  const freshness = 1 - decayRate * days;
  if (freshness < 0) return 0;
  if (freshness > 1) return 1;
  return freshness;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function numberMeta(input: DebtScoringInput, key: string): number | null {
  const value = input.metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function boolMeta(input: DebtScoringInput, key: string): boolean | null {
  const value = input.metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function applyPenalty(baseFreshness: number, penalty: number): number {
  return clamp01(baseFreshness - penalty);
}

function result(
  freshnessScore: number,
  decayRate: number,
  reasons: string[],
): DebtScoringResult {
  return {
    freshnessScore,
    decayRate,
    severity: deriveSeverity(freshnessScore),
    recommendation:
      reasons.length > 0
        ? reasons.join(" ")
        : "Review freshness and performance before the next campaign cycle.",
  };
}

function negativeDeltaPenalty(value: number | null, threshold: number, scale: number): number {
  if (value === null || value >= -threshold) return 0;
  return Math.min(0.35, Math.abs(value) * scale);
}

export function scoreContent(input: DebtScoringInput, now: Date = new Date()): DebtScoringResult {
  const decayRate = DEFAULT_DECAY_RATES.content!;
  const freshness = computeFreshness(input.lastActiveAt, decayRate, now);
  const trafficDelta = numberMeta(input, "trafficDeltaPct");
  const conversionDelta = numberMeta(input, "conversionDeltaPct");
  const accuracyIssues = numberMeta(input, "accuracyIssues") ?? 0;
  const penalty =
    negativeDeltaPenalty(trafficDelta, 0.15, 0.8) +
    negativeDeltaPenalty(conversionDelta, 0.1, 1.0) +
    Math.min(0.3, accuracyIssues * 0.08);
  const reasons = [
    trafficDelta !== null && trafficDelta < -0.15
      ? "Traffic is materially down; refresh distribution and search intent."
      : null,
    conversionDelta !== null && conversionDelta < -0.1
      ? "Conversion rate has deteriorated; re-check CTA and offer fit."
      : null,
    accuracyIssues > 0
      ? "Content has flagged accuracy issues; update claims and references."
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return result(applyPenalty(freshness, penalty), decayRate, reasons);
}

export function scorePersona(input: DebtScoringInput, now: Date = new Date()): DebtScoringResult {
  const decayRate = DEFAULT_DECAY_RATES.persona!;
  const freshness = computeFreshness(input.lastActiveAt, decayRate, now);
  const marketShiftScore = clamp01(numberMeta(input, "marketShiftScore") ?? 0);
  const interviewCount = numberMeta(input, "interviewCount");
  const confidenceScore = numberMeta(input, "confidenceScore");
  const penalty =
    marketShiftScore * 0.35 +
    (interviewCount !== null && interviewCount < 5 ? 0.15 : 0) +
    (confidenceScore !== null ? Math.max(0, 0.7 - confidenceScore) * 0.3 : 0);
  const reasons = [
    marketShiftScore >= 0.4 ? "Market-shift signals are high; revalidate ICP assumptions." : null,
    interviewCount !== null && interviewCount < 5
      ? "Persona evidence is thin; schedule fresh customer interviews."
      : null,
    confidenceScore !== null && confidenceScore < 0.7
      ? "Persona confidence is low; update segmentation evidence."
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return result(applyPenalty(freshness, penalty), decayRate, reasons);
}

export function scoreCampaign(input: DebtScoringInput, now: Date = new Date()): DebtScoringResult {
  const decayRate = DEFAULT_DECAY_RATES.campaign!;
  const freshness = computeFreshness(input.lastActiveAt, decayRate, now);
  const conversionsLast30 = numberMeta(input, "conversionsLast30");
  const spendWithoutConversion = numberMeta(input, "spendWithoutConversion") ?? 0;
  const openRateDelta = numberMeta(input, "openRateDeltaPct");
  const cvrDelta = numberMeta(input, "cvrDeltaPct");
  const penalty =
    (conversionsLast30 === 0 ? 0.35 : 0) +
    Math.min(0.3, spendWithoutConversion / 100_000) +
    negativeDeltaPenalty(openRateDelta, 0.1, 0.7) +
    negativeDeltaPenalty(cvrDelta, 0.08, 1.2);
  const reasons = [
    conversionsLast30 === 0
      ? "Campaign has no recent conversions; pause or rebuild the offer path."
      : null,
    spendWithoutConversion > 0
      ? "Spend is continuing without conversion evidence; cap budget until fixed."
      : null,
    openRateDelta !== null && openRateDelta < -0.1
      ? "Open rate is down; refresh subject and audience fit."
      : null,
    cvrDelta !== null && cvrDelta < -0.08
      ? "Conversion rate is down; inspect landing page and targeting."
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return result(applyPenalty(freshness, penalty), decayRate, reasons);
}

export function scoreLink(input: DebtScoringInput, now: Date = new Date()): DebtScoringResult {
  const alive = boolMeta(input, "alive");
  const statusCode = numberMeta(input, "statusCode");
  const isBroken = alive === false || (statusCode !== null && statusCode >= 400);
  const checkedFreshness = computeFreshness(input.lastActiveAt, 0.002, now);
  const freshness = isBroken ? 0 : checkedFreshness;
  const decayRate = DEFAULT_DECAY_RATES.link!;
  const reasons = [
    isBroken
      ? `Link check failed${statusCode ? ` with HTTP ${statusCode}` : ""}; replace or remove the URL.`
      : null,
    !isBroken && checkedFreshness < 0.8
      ? "Link has not been checked recently; refresh crawler evidence."
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return {
    ...result(freshness, decayRate, reasons),
    severity: isBroken ? "high" : deriveSeverity(freshness),
  };
}

export function scoreSeoArticle(input: DebtScoringInput, now: Date = new Date()): DebtScoringResult {
  const decayRate = DEFAULT_DECAY_RATES.seo_article!;
  const freshness = computeFreshness(input.lastActiveAt, decayRate, now);
  const currentRank = numberMeta(input, "currentRank");
  const previousRank = numberMeta(input, "previousRank");
  const clicksDelta = numberMeta(input, "clicksDeltaPct");
  const impressionsDelta = numberMeta(input, "impressionsDeltaPct");
  const rankDrop = currentRank !== null && previousRank !== null ? currentRank - previousRank : 0;
  const penalty =
    Math.min(0.35, Math.max(0, rankDrop) * 0.015) +
    negativeDeltaPenalty(clicksDelta, 0.15, 0.9) +
    negativeDeltaPenalty(impressionsDelta, 0.2, 0.5);
  const reasons = [
    rankDrop >= 5
      ? `Search rank dropped by ${rankDrop} positions; refresh intent coverage and internal links.`
      : null,
    clicksDelta !== null && clicksDelta < -0.15
      ? "Organic clicks are down; update title, snippet, and content freshness."
      : null,
    impressionsDelta !== null && impressionsDelta < -0.2
      ? "Search impressions are down; inspect indexing and keyword coverage."
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return result(applyPenalty(freshness, penalty), decayRate, reasons);
}

export function scoreCrmData(input: DebtScoringInput, now: Date = new Date()): DebtScoringResult {
  const decayRate = DEFAULT_DECAY_RATES.crm_data!;
  const freshness = computeFreshness(input.lastActiveAt, decayRate, now);
  const bounceRate = clamp01(numberMeta(input, "bounceRate") ?? 0);
  const duplicateRate = clamp01(numberMeta(input, "duplicateRate") ?? 0);
  const missingFieldRate = clamp01(numberMeta(input, "missingFieldRate") ?? 0);
  const staleContactRate = clamp01(numberMeta(input, "staleContactRate") ?? 0);
  const penalty =
    Math.max(0, bounceRate - 0.03) * 3 +
    Math.max(0, duplicateRate - 0.05) * 2 +
    Math.max(0, missingFieldRate - 0.1) * 1.4 +
    Math.max(0, staleContactRate - 0.2);
  const reasons = [
    bounceRate > 0.03
      ? "Bounce rate is above tolerance; clean invalid emails before the next send."
      : null,
    duplicateRate > 0.05
      ? "Duplicate CRM records are high; run merge and dedupe workflows."
      : null,
    missingFieldRate > 0.1
      ? "Important fields are missing; enrich records before segmentation."
      : null,
    staleContactRate > 0.2
      ? "Many contacts are stale; re-permission or suppress inactive records."
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return result(applyPenalty(freshness, Math.min(0.6, penalty)), decayRate, reasons);
}

/** AssetType に応じて 6 種別 scorer をディスパッチ。不正な assetType は throw。 */
export function scoreDebtItem(
  input: DebtScoringInput,
  now: Date = new Date(),
): DebtScoringResult {
  if (!isKnownAssetType(input.assetType)) {
    throw new Error(`Unknown assetType: ${String(input.assetType)}`);
  }
  switch (input.assetType) {
    case "content":
      return scoreContent(input, now);
    case "persona":
      return scorePersona(input, now);
    case "campaign":
      return scoreCampaign(input, now);
    case "link":
      return scoreLink(input, now);
    case "seo_article":
      return scoreSeoArticle(input, now);
    case "crm_data":
      return scoreCrmData(input, now);
    default:
      throw new Error(`Unknown assetType: ${String(input.assetType)}`);
  }
}
