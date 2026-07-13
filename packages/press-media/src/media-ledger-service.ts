/**
 * Media Strategy Ledger (記者CRM) — business logic layer.
 *
 * 関係スコアリング、AI ピッチメール生成、メール仕分けルール提案を提供する。
 * LLM 呼び出し（generateText）は注入式。関係スコアはピュア関数（LLM不要）。
 *
 * 出典: 実運用SaaS server/lib/media-ledger-service.ts
 */
import type { GenerateText } from "./llm";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MediaContact {
  id: string;
  tenant_id: string;
  /** PII — stored as-is for MVP; column name signals pgcrypto intent for Phase 2 */
  name_encrypted: string;
  email_encrypted?: string;
  phone_encrypted?: string;
  outlet: string;
  beat?: string;
  notes?: string;
  consent_status: "pending" | "granted" | "revoked";
  consent_granted_at?: string;
  last_interaction_at?: string;
  relationship_score: number;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface MediaInteraction {
  id: string;
  contact_id: string;
  tenant_id: string;
  interaction_type:
    | "email_sent"
    | "email_received"
    | "meeting"
    | "call"
    | "pitch_sent"
    | "article_published";
  subject?: string;
  notes?: string;
  outcome?: "positive" | "neutral" | "negative";
  occurred_at: string;
  created_by?: string;
}

export interface RelationshipScoreBreakdown {
  /** 0-30 — how recently the last interaction occurred */
  recency: number;
  /** 0-30 — count of interactions in last 6 months (1pt each, cap 30) */
  frequency: number;
  /** 0-20 — positive outcomes / total outreach * 20 */
  responseRate: number;
  /** 0-20 — article_published count * 4 (cap 5 articles = 20) */
  coverage: number;
  /** 0-100 — sum of all dimensions */
  total: number;
}

// ─── Relationship Score ─────────────────────────────────────────────────────

/**
 * Calculate relationship score breakdown from interaction history.
 *
 * Dimensions:
 *   Recency (30):  last interaction within 30d→30, 60d→20, 90d→10, else 0
 *   Frequency (30): interactions in last 6 months, 1pt each up to 30
 *   ResponseRate (20): (positive outcomes / outreach count) * 20
 *   Coverage (20): article_published count * 4, cap at 5 articles (20 pts)
 */
export function calculateRelationshipScore(
  interactions: MediaInteraction[],
): RelationshipScoreBreakdown {
  if (interactions.length === 0) {
    return { recency: 0, frequency: 0, responseRate: 0, coverage: 0, total: 0 };
  }

  const now = Date.now();
  const MS_PER_DAY = 86_400_000;
  const SIX_MONTHS_MS = 180 * MS_PER_DAY;

  // --- Recency ---
  let latestMs = 0;
  for (const ix of interactions) {
    const ts = new Date(ix.occurred_at).getTime();
    if (ts > latestMs) latestMs = ts;
  }
  const daysSinceLast = (now - latestMs) / MS_PER_DAY;
  let recency = 0;
  if (daysSinceLast <= 30) recency = 30;
  else if (daysSinceLast <= 60) recency = 20;
  else if (daysSinceLast <= 90) recency = 10;

  // --- Frequency (last 6 months) ---
  const sixMonthsAgo = now - SIX_MONTHS_MS;
  let recentCount = 0;
  for (const ix of interactions) {
    if (new Date(ix.occurred_at).getTime() >= sixMonthsAgo) recentCount++;
  }
  const frequency = Math.min(recentCount, 30);

  // --- Response Rate ---
  const outreachTypes = new Set(["email_sent", "pitch_sent"]);
  let outreachCount = 0;
  let positiveCount = 0;
  for (const ix of interactions) {
    if (outreachTypes.has(ix.interaction_type)) {
      outreachCount++;
      if (ix.outcome === "positive") positiveCount++;
    }
  }
  const responseRate =
    outreachCount > 0 ? Math.round((positiveCount / outreachCount) * 20) : 0;

  // --- Coverage ---
  let articleCount = 0;
  for (const ix of interactions) {
    if (ix.interaction_type === "article_published") articleCount++;
  }
  const coverage = Math.min(articleCount, 5) * 4;

  const total = recency + frequency + responseRate + coverage;
  return { recency, frequency, responseRate, coverage, total };
}

// ─── AI Pitch Generation ────────────────────────────────────────────────────

interface PitchParams {
  contactName: string;
  outlet: string;
  beat: string;
  pastInteractions: string;
  topic: string;
  brandVoicePrompt?: string;
}

/**
 * Generate a personalized pitch email via the injected LLM.
 * Returns subject + body as structured output.
 */
export async function generatePitchEmail(
  generateText: GenerateText,
  apiKey: string,
  params: PitchParams,
): Promise<{ subject: string; body: string }> {
  const system = [
    "You are a PR specialist who writes personalized, concise pitch emails to journalists.",
    "Output JSON with two fields: \"subject\" (email subject line) and \"body\" (email body text).",
    "Keep the tone professional yet warm. Reference past interactions naturally.",
    "Write in the journalist's language — if the outlet or beat contains Japanese, write in Japanese.",
    params.brandVoicePrompt ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Journalist: ${params.contactName}`,
    `Outlet: ${params.outlet}`,
    `Beat: ${params.beat}`,
    `Past interactions: ${params.pastInteractions || "None yet"}`,
    `Topic to pitch: ${params.topic}`,
    "",
    "Return valid JSON: { \"subject\": \"...\", \"body\": \"...\" }",
  ].join("\n");

  const raw = await generateText(apiKey, system, prompt);
  try {
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };
    return {
      subject: parsed.subject ?? "Pitch",
      body: parsed.body ?? "",
    };
  } catch {
    return { subject: "Pitch", body: raw };
  }
}

// ─── Sort Rule Suggestion ───────────────────────────────────────────────────

/**
 * Suggest a mail sort rule based on email domain.
 * Returns null if the email is invalid or missing.
 */
export function suggestSortRule(
  email: string,
): { ruleType: "email_domain"; pattern: string } | null {
  if (!email || !email.includes("@")) return null;
  const domain = email.split("@")[1];
  if (!domain) return null;
  return { ruleType: "email_domain", pattern: `@${domain}` };
}
