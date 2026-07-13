/**
 * PR Ops Center — AI-powered PR operations service.
 *
 * 配信タイミング提案と戦略サマリを LLM で生成する。generateJson は注入式。
 *
 * 出典: 実運用SaaS server/lib/pr-ops-service.ts
 */

import type { GenerateJson } from "./llm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PREvent {
  id: string;
  title: string;
  event_type: "press_release" | "interview" | "conference" | "webinar" | "media_appearance";
  scheduled_at: string;
  status: "planned" | "confirmed" | "completed" | "cancelled";
  description?: string;
  venue?: string;
  contacts?: unknown[];
  notes?: string;
}

export interface IndustryEvent {
  id: string;
  event_name: string;
  organizer?: string;
  date_from: string;
  date_to?: string;
  industry?: string;
  relevance_score: number;
}

export interface TimingSuggestion {
  suggestedDate: string;
  reasoning: string;
  avoidDates: string[];
  confidence: number;
}

export interface StrategySummary {
  summary: string;
  keyThemes: string[];
  recommendations: string[];
  upcomingOpportunities: string[];
}

// ─── Timing Suggestion ───────────────────────────────────────────────────────

const TIMING_SYSTEM = `You are a PR timing strategist. Analyze upcoming PR events, industry events, and past performance to suggest the optimal date for the next press release.

Rules:
- Avoid dates that clash with major industry events or existing PR events
- Consider media attention cycles (avoid Mondays and Fridays for general releases)
- Factor in seasonal patterns and news cycles
- Return a single JSON object with the exact schema requested`;

function timingFallback(): TimingSuggestion {
  return {
    suggestedDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0] as string,
    reasoning: "Default suggestion: 1 week from now",
    avoidDates: [],
    confidence: 0.3,
  };
}

export async function suggestTiming(
  generateJson: GenerateJson,
  apiKey: string,
  params: {
    upcomingEvents: PREvent[];
    industryEvents: IndustryEvent[];
    pastPerformance?: string;
  },
): Promise<TimingSuggestion> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Today is ${today}.

Upcoming PR Events:
${params.upcomingEvents.length > 0 ? params.upcomingEvents.map((e) => `- ${e.title} (${e.event_type}) on ${e.scheduled_at} [${e.status}]`).join("\n") : "None scheduled"}

Industry Events:
${params.industryEvents.length > 0 ? params.industryEvents.map((e) => `- ${e.event_name} (${e.date_from}${e.date_to ? ` to ${e.date_to}` : ""}) relevance: ${e.relevance_score}/100`).join("\n") : "None known"}

${params.pastPerformance ? `Past Performance Notes:\n${params.pastPerformance}` : ""}

Suggest the optimal date for the next press release. Return JSON:
{
  "suggestedDate": "YYYY-MM-DD",
  "reasoning": "why this date is optimal",
  "avoidDates": ["YYYY-MM-DD", ...],
  "confidence": 0.0-1.0
}`;

  const result = await generateJson<TimingSuggestion>(apiKey, TIMING_SYSTEM, prompt, timingFallback());

  // NOTE: Clamp confidence to 0-1 range for UI consistency
  return {
    ...result,
    confidence: Math.max(0, Math.min(1, result.confidence)),
  };
}

// ─── Strategy Summary ────────────────────────────────────────────────────────

const STRATEGY_SYSTEM = `You are a PR strategy advisor. Analyze the PR event calendar and industry landscape to provide a strategic summary with actionable recommendations.

Return a JSON object with the exact schema requested. Keep recommendations concise and actionable.`;

const STRATEGY_FALLBACK: StrategySummary = {
  summary: "Insufficient data to generate strategy summary.",
  keyThemes: [],
  recommendations: [],
  upcomingOpportunities: [],
};

export async function generateStrategySummary(
  generateJson: GenerateJson,
  apiKey: string,
  params: {
    events: PREvent[];
    industryEvents: IndustryEvent[];
  },
): Promise<StrategySummary> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Today is ${today}.

PR Events:
${params.events.length > 0 ? params.events.map((e) => `- ${e.title} (${e.event_type}) on ${e.scheduled_at} [${e.status}]${e.description ? `: ${e.description}` : ""}`).join("\n") : "No PR events"}

Industry Events:
${params.industryEvents.length > 0 ? params.industryEvents.map((e) => `- ${e.event_name} by ${e.organizer ?? "unknown"} (${e.date_from}${e.date_to ? ` to ${e.date_to}` : ""}) industry: ${e.industry ?? "general"}, relevance: ${e.relevance_score}/100`).join("\n") : "No industry events"}

Generate a PR strategy overview. Return JSON:
{
  "summary": "1-2 paragraph strategic overview",
  "keyThemes": ["theme1", "theme2", ...],
  "recommendations": ["action1", "action2", ...],
  "upcomingOpportunities": ["opportunity1", "opportunity2", ...]
}`;

  return generateJson<StrategySummary>(apiKey, STRATEGY_SYSTEM, prompt, STRATEGY_FALLBACK);
}
