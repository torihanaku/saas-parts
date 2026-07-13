/**
 * Generic multi-touch attribution primitives.
 *
 * Ported from 実運用SaaS `server/lib/marketing-roi/attribution.ts`.
 * Product plumbing (DB row mapping `toTouchpoint`, `id` / `tenantId` fields)
 * was stripped; the pure journey-building and rule-based attribution logic
 * (first-touch / last-click / linear) is preserved verbatim.
 */

/**
 * Expected input data shape: one row per user event.
 * A touchpoint counts as a *conversion* when `valueJpy > 0`,
 * `channel === "conversion"`, `metadata.event_type === "conversion"`,
 * or `metadata.conversion === true`.
 */
export interface Touchpoint {
  /** Anonymized stable user identifier (journeys are grouped by this). */
  userHash: string;
  /** Marketing channel, e.g. "meta" / "google" / "email". */
  channel: string;
  /** Campaign id; falls back to channel when null. */
  campaignId: string | null;
  /** ISO 8601 timestamp — journeys are sorted by this. */
  touchedAt: string;
  /** Conversion value (currency units); > 0 marks a conversion event. */
  valueJpy: number;
  /** Free-form metadata (recognized keys: event_type, type, conversion, campaign_name, spend_jpy, spend). */
  metadata: Record<string, unknown>;
}

export interface ConversionPath {
  userHash: string;
  touchpoints: Touchpoint[];
  converted: boolean;
  valueJpy: number;
}

export interface AttributionRow {
  campaignId: string;
  campaignName: string;
  platform: string;
  spend: number;
  conversionsFirstTouch: number;
  conversionsLastClick: number;
  conversionsLinear: number;
  conversionsShapley: number;
  conversionsMarkov: number;
}

export function isConversionTouchpoint(touchpoint: Touchpoint): boolean {
  const eventType = String(touchpoint.metadata.event_type ?? touchpoint.metadata.type ?? "").toLowerCase();
  return touchpoint.valueJpy > 0
    || touchpoint.channel === "conversion"
    || eventType === "conversion"
    || touchpoint.metadata.conversion === true;
}

function touchpointTime(touchpoint: Touchpoint): number {
  const t = new Date(touchpoint.touchedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function buildConversionPaths(touchpoints: Touchpoint[]): ConversionPath[] {
  const byUser = new Map<string, Touchpoint[]>();
  for (const touchpoint of touchpoints) {
    if (!touchpoint.userHash) continue;
    const arr = byUser.get(touchpoint.userHash) ?? [];
    arr.push(touchpoint);
    byUser.set(touchpoint.userHash, arr);
  }

  return Array.from(byUser.entries()).map(([userHash, points]) => {
    const sorted = [...points].sort((a, b) => touchpointTime(a) - touchpointTime(b));
    const conversions = sorted.filter(isConversionTouchpoint);
    return {
      userHash,
      touchpoints: sorted,
      converted: conversions.length > 0,
      valueJpy: conversions.reduce((sum, p) => sum + Math.max(0, p.valueJpy), 0),
    };
  });
}

function attributionKey(touchpoint: Touchpoint): string {
  const campaignId = touchpoint.campaignId ?? touchpoint.channel;
  return `${touchpoint.channel}::${campaignId}`;
}

function ensureRow(rows: Map<string, AttributionRow>, touchpoint: Touchpoint): AttributionRow {
  const key = attributionKey(touchpoint);
  const existing = rows.get(key);
  if (existing) return existing;
  const campaignId = touchpoint.campaignId ?? touchpoint.channel;
  const campaignName =
    typeof touchpoint.metadata.campaign_name === "string"
      ? touchpoint.metadata.campaign_name
      : campaignId;
  const row: AttributionRow = {
    campaignId,
    campaignName,
    platform: touchpoint.channel,
    spend: 0,
    conversionsFirstTouch: 0,
    conversionsLastClick: 0,
    conversionsLinear: 0,
    conversionsShapley: 0,
    conversionsMarkov: 0,
  };
  rows.set(key, row);
  return row;
}

function attributableTouchpoints(path: ConversionPath): Touchpoint[] {
  return path.touchpoints.filter((p) => !isConversionTouchpoint(p));
}

export function baseAttributionRows(paths: ConversionPath[]): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  for (const path of paths) {
    const touches = attributableTouchpoints(path);
    for (const touchpoint of touches) {
      const row = ensureRow(rows, touchpoint);
      row.spend += Math.max(0, Number(touchpoint.metadata.spend_jpy ?? touchpoint.metadata.spend ?? 0));
    }
    if (!path.converted || touches.length === 0) continue;

    ensureRow(rows, touches[0]!).conversionsFirstTouch += 1;
    ensureRow(rows, touches[touches.length - 1]!).conversionsLastClick += 1;
    const linearCredit = 1 / touches.length;
    for (const touchpoint of touches) {
      ensureRow(rows, touchpoint).conversionsLinear += linearCredit;
    }
  }
  return Array.from(rows.values()).sort((a, b) => b.conversionsLinear - a.conversionsLinear);
}

export function mergeModelCredits(
  rows: AttributionRow[],
  field: "conversionsShapley" | "conversionsMarkov",
  credits: Map<string, number>,
): AttributionRow[] {
  const byKey = new Map(rows.map((row) => [`${row.platform}::${row.campaignId}`, row]));
  for (const [key, value] of credits) {
    const row = byKey.get(key);
    if (row) row[field] = value;
  }
  return rows;
}

export function touchpointKeyForModel(touchpoint: Touchpoint): string {
  return attributionKey(touchpoint);
}
