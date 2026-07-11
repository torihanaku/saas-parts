/**
 * voice-profile.ts — 組織の声（文体・トーン規範）の学習。
 *
 * 承認 / 却下された文章のスタイル特徴量（語彙・文長・トーン）を抽出し、
 * LLM で組織ボイスプロファイルを合成、DNA ストア（dnaType=brand_voice）に
 * upsert する（source=brand_voice:train、デフォルト key=default）。
 *
 * Pipeline: extractStyleFeatures → aggregateFeatures → buildVoicePrompt
 * → synthesizeVoiceProfile → trainVoiceProfile（ingestDna で永続化）。
 *
 * 出典: dev-dashboard-v2 `server/lib/company-dna/brand-voice.ts`
 * （Claude API 直呼び → LlmCaller 注入、Supabase → DnaStore 注入）。
 * 「brand voice」→「組織の声」に汎用化（プロンプト原文はデフォルトとして維持）。
 */

import type { LlmCaller, PatternDnaRow } from "./types.js";
import type { DnaStore } from "./stores.js";
import { ingestDna } from "./foundation.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToneSignals {
  questions: number;
  exclamations: number;
  politeJa: number;
  casualJa: number;
}

export interface StyleFeatures {
  charCount: number;
  wordCount: number;
  sentenceCount: number;
  meanSentenceLength: number;
  uniqueTokens: number;
  typeTokenRatio: number;
  /** 頻度上位 8 トークン（小文字化、長さ ≥ 2、降順）。 */
  topTokens: string[];
  tone: ToneSignals;
}

export interface AggregatedFeatures {
  sampleCount: number;
  meanCharCount: number;
  meanWordCount: number;
  meanSentenceLength: number;
  meanTypeTokenRatio: number;
  topTokens: string[];
  meanTone: ToneSignals;
}

export interface VoiceProfile {
  tone: string;
  preferred: string[];
  avoid: string[];
  sentenceLength: string;
  vocabulary: string;
  notes?: string;
}

export interface TrainVoiceProfileResult {
  row: PatternDnaRow;
  profile: VoiceProfile;
  features: { approved: AggregatedFeatures; rejected: AggregatedFeatures };
}

// ─── 1. サンプルごとの特徴量抽出（純粋関数） ────────────────────────────────

const SENTENCE_SPLIT = /[.!?。！？]+/u;
const WORD_SPLIT = /\s+/u;

function emptyTone(): ToneSignals {
  return { questions: 0, exclamations: 0, politeJa: 0, casualJa: 0 };
}

export function extractStyleFeatures(textIn: unknown): StyleFeatures {
  const text = typeof textIn === "string" ? textIn.trim() : "";
  if (text.length === 0) {
    return {
      charCount: 0, wordCount: 0, sentenceCount: 0, meanSentenceLength: 0,
      uniqueTokens: 0, typeTokenRatio: 0, topTokens: [], tone: emptyTone(),
    };
  }
  const sentences = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
  const words = text.split(WORD_SPLIT).filter((w) => w.length > 0);
  const tokens = words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const topTokens = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);
  const meanSentenceLength =
    sentences.length === 0 ? 0 : sentences.reduce((a, s) => a + s.length, 0) / sentences.length;
  return {
    charCount: text.length,
    wordCount: words.length,
    sentenceCount: sentences.length,
    meanSentenceLength,
    uniqueTokens: freq.size,
    typeTokenRatio: words.length === 0 ? 0 : freq.size / words.length,
    topTokens,
    tone: {
      questions: countMatches(text, /[?？]/gu),
      exclamations: countMatches(text, /[!！]/gu),
      politeJa: countMatches(text, /(です|ます|ございます)/gu),
      casualJa: countMatches(text, /(だね|だよ|だぜ|じゃん)/gu),
    },
  };
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

// ─── 2. 複数サンプルの集約（純粋関数） ──────────────────────────────────────

export function aggregateFeatures(samples: StyleFeatures[]): AggregatedFeatures {
  const n = samples.length;
  if (n === 0) {
    return {
      sampleCount: 0, meanCharCount: 0, meanWordCount: 0, meanSentenceLength: 0,
      meanTypeTokenRatio: 0, topTokens: [], meanTone: emptyTone(),
    };
  }
  const sum = samples.reduce(
    (acc, s) => ({
      char: acc.char + s.charCount,
      word: acc.word + s.wordCount,
      sent: acc.sent + s.meanSentenceLength,
      ttr: acc.ttr + s.typeTokenRatio,
      q: acc.q + s.tone.questions,
      e: acc.e + s.tone.exclamations,
      p: acc.p + s.tone.politeJa,
      c: acc.c + s.tone.casualJa,
    }),
    { char: 0, word: 0, sent: 0, ttr: 0, q: 0, e: 0, p: 0, c: 0 },
  );
  const merged = new Map<string, number>();
  for (const s of samples) for (const t of s.topTokens) merged.set(t, (merged.get(t) ?? 0) + 1);
  const topTokens = Array.from(merged.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([t]) => t);
  return {
    sampleCount: n,
    meanCharCount: sum.char / n,
    meanWordCount: sum.word / n,
    meanSentenceLength: sum.sent / n,
    meanTypeTokenRatio: sum.ttr / n,
    topTokens,
    meanTone: {
      questions: sum.q / n,
      exclamations: sum.e / n,
      politeJa: sum.p / n,
      casualJa: sum.c / n,
    },
  };
}

// ─── 3. プロンプトビルダー（純粋関数） ──────────────────────────────────────

export interface BuildPromptArgs {
  approvedAgg: AggregatedFeatures;
  rejectedAgg: AggregatedFeatures;
  approvedSnippets: string[];
  rejectedSnippets: string[];
  /** system プロンプトの差し替え（省略時は本家原文）。 */
  systemPrompt?: string;
}
export interface VoicePrompt {
  system: string;
  user: string;
}

/** 本家原文の system プロンプト（デフォルト値として維持）。 */
export const DEFAULT_VOICE_SYSTEM_PROMPT =
  "You are a brand voice analyst. Compare APPROVED vs REJECTED writing samples " +
  "and emit a strict JSON brand voice profile. Output JSON only — no markdown, " +
  "no commentary. Schema: " +
  `{"tone":string,"preferred":string[],"avoid":string[],` +
  `"sentenceLength":string,"vocabulary":string,"notes":string}.`;

export function buildVoicePrompt(args: BuildPromptArgs): VoicePrompt {
  const system = args.systemPrompt ?? DEFAULT_VOICE_SYSTEM_PROMPT;
  const user = [
    "## APPROVED corpus",
    summariseAgg(args.approvedAgg),
    "Snippets (verbatim, truncated):",
    truncSnippets(args.approvedSnippets).join("\n---\n") || "(none)",
    "",
    "## REJECTED corpus",
    summariseAgg(args.rejectedAgg),
    "Snippets (verbatim, truncated):",
    truncSnippets(args.rejectedSnippets).join("\n---\n") || "(none)",
    "",
    "Synthesize a brand voice profile that explains what the approved corpus does",
    "that the rejected corpus does not. Return JSON only.",
  ].join("\n");
  return { system, user };
}

function summariseAgg(a: AggregatedFeatures): string {
  return [
    `samples=${a.sampleCount}`,
    `meanChars=${a.meanCharCount.toFixed(1)}`,
    `meanWords=${a.meanWordCount.toFixed(1)}`,
    `meanSentenceLen=${a.meanSentenceLength.toFixed(1)}`,
    `typeTokenRatio=${a.meanTypeTokenRatio.toFixed(3)}`,
    `topTokens=${a.topTokens.join(",") || "(none)"}`,
    `tone(q/e/polite/casual)=${a.meanTone.questions.toFixed(2)}/${a.meanTone.exclamations.toFixed(2)}/${a.meanTone.politeJa.toFixed(2)}/${a.meanTone.casualJa.toFixed(2)}`,
  ].join(" | ");
}

function truncSnippets(snippets: string[], maxLen = 240, maxCount = 3): string[] {
  return snippets.slice(0, maxCount).map((s) => (s.length > maxLen ? `${s.slice(0, maxLen)}…` : s));
}

// ─── 4. LLM 合成 ────────────────────────────────────────────────────────────

const FALLBACK_PROFILE: VoiceProfile = {
  tone: "", preferred: [], avoid: [], sentenceLength: "", vocabulary: "",
};

export async function synthesizeVoiceProfile(
  llm: LlmCaller,
  args: BuildPromptArgs,
): Promise<VoiceProfile> {
  const { system, user } = buildVoicePrompt(args);
  const raw = await llm.generateJson<VoiceProfile>(system, user, FALLBACK_PROFILE, {
    maxTokens: 1500,
  });
  return normalizeProfile(raw);
}

export function normalizeProfile(p: Partial<VoiceProfile> | null | undefined): VoiceProfile {
  const safe = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(safe).filter((s) => s.length > 0).slice(0, 12) : [];
  const result: VoiceProfile = {
    tone: safe(p?.tone),
    preferred: arr(p?.preferred),
    avoid: arr(p?.avoid),
    sentenceLength: safe(p?.sentenceLength),
    vocabulary: safe(p?.vocabulary),
  };
  const notes = safe(p?.notes);
  if (notes) result.notes = notes;
  return result;
}

// ─── 5. オーケストレータ — 抽出 → 合成 → 永続化 ─────────────────────────────

export interface TrainVoiceProfileArgs {
  tenantId: string;
  approved: string[];
  rejected: string[];
  /** (tenant, brand_voice) 内の key。デフォルト "default"。 */
  key?: string;
  source?: string;
  /** system プロンプトの差し替え（省略時は本家原文）。 */
  systemPrompt?: string;
}

export type TrainVoiceProfileError =
  | "approved_required"
  | "rejected_required"
  | "synthesis_empty"
  | "ingest_failed";

export interface TrainVoiceProfileDeps {
  llm: LlmCaller;
  store: DnaStore;
}

export async function trainVoiceProfile(
  deps: TrainVoiceProfileDeps,
  args: TrainVoiceProfileArgs,
): Promise<
  { ok: true; value: TrainVoiceProfileResult } | { ok: false; error: TrainVoiceProfileError }
> {
  const isText = (t: unknown): t is string => typeof t === "string" && t.trim().length > 0;
  const approvedTexts = (args.approved ?? []).filter(isText);
  const rejectedTexts = (args.rejected ?? []).filter(isText);
  if (approvedTexts.length === 0) return { ok: false, error: "approved_required" };
  if (rejectedTexts.length === 0) return { ok: false, error: "rejected_required" };

  const approvedAgg = aggregateFeatures(approvedTexts.map(extractStyleFeatures));
  const rejectedAgg = aggregateFeatures(rejectedTexts.map(extractStyleFeatures));

  const profile = await synthesizeVoiceProfile(deps.llm, {
    approvedAgg,
    rejectedAgg,
    approvedSnippets: approvedTexts,
    rejectedSnippets: rejectedTexts,
    systemPrompt: args.systemPrompt,
  });
  if (!profile.tone && profile.preferred.length === 0 && profile.avoid.length === 0) {
    return { ok: false, error: "synthesis_empty" };
  }

  const row = await ingestDna(deps.store, {
    tenantId: args.tenantId,
    dnaType: "brand_voice",
    key: (args.key ?? "default").trim() || "default",
    value: {
      profile: profile as unknown as Record<string, unknown>,
      features: { approved: approvedAgg, rejected: rejectedAgg } as unknown as Record<
        string,
        unknown
      >,
      sampleCounts: { approved: approvedTexts.length, rejected: rejectedTexts.length },
    },
    source: (args.source ?? "brand_voice:train").trim() || "brand_voice:train",
    confidence: confidenceFromSamples(approvedTexts.length, rejectedTexts.length),
  });
  if (!row) return { ok: false, error: "ingest_failed" };
  return {
    ok: true,
    value: { row, profile, features: { approved: approvedAgg, rejected: rejectedAgg } },
  };
}

/** ヒューリスティック — サンプルが均衡かつ多いほど confidence 上昇。[0.3, 0.95]。純粋関数。 */
export function confidenceFromSamples(approvedN: number, rejectedN: number): number {
  if (approvedN <= 0 || rejectedN <= 0) return 0.3;
  const total = approvedN + rejectedN;
  const balance = Math.min(approvedN, rejectedN) / Math.max(approvedN, rejectedN);
  const size = Math.min(1, total / 20);
  const score = 0.3 + 0.65 * (0.5 * size + 0.5 * balance);
  return Math.max(0.3, Math.min(0.95, Number(score.toFixed(3))));
}
