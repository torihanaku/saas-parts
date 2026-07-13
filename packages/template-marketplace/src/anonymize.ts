/**
 * Anonymization primitives — ported verbatim from 実運用SaaS
 * `server/lib/template-marketplace.ts`.
 *
 * 匿名化原則: 企業名・人名・絶対数値 (件数/円/%) は除去し、 構成要素 (subject pattern、
 * channel mix、 timing 相対表現、 components) のみ残す。
 */

import type { AnonymizedPattern, SuccessSignals } from "./types";

const COMPANY_TOKEN = "{company}";
const NUMBER_TOKEN = "{n}";
// Latin: "Acme Inc." / "Big Corp." — capture word(s) preceding the suffix together with the suffix.
const COMPANY_LATIN_RE = /(?:[A-Z][A-Za-z0-9'&-]*\s+)+(?:Inc\.?|Corp\.?|Ltd\.?|LLC|GmbH|S\.A\.)/g;
// Japanese: 株式会社サンプル / サンプル株式会社 — strip both forms with the surrounding token(s).
const COMPANY_JP_PREFIX_RE = /(?:株式会社|有限会社|合同会社)\s*\S+/g;
const COMPANY_JP_SUFFIX_RE = /\S+\s*(?:株式会社|有限会社|合同会社)/g;
// Standalone suffix safety net (in case the prefix didn't match a Capitalized form).
const COMPANY_SUFFIX_ONLY_RE = /\b(?:Inc\.?|Corp\.?|Ltd\.?|LLC|GmbH|S\.A\.)\b/g;
// NOTE: no trailing `\b`. The units 件/円/%/％/倍/名 are CJK / punctuation
// characters that never form a JS regex word-boundary with the following char,
// so a trailing `\b` made this pattern match *nothing* for the most common
// Japanese KPI units — leaking absolute numbers like "8%" / "3倍" / "3件" /
// "5,000円" straight into the "anonymized" pattern. (Multi-digit runs happened
// to be caught by BARE_DIGITS_RE, which is why the leak went unnoticed, but
// single-digit values and the unit itself survived.)
const ABSOLUTE_NUMBER_RE = /\b\d[\d,.]*\s*(?:件|円|%|％|JPY|USD|EUR|x|×|倍|名)/gi;
const BARE_DIGITS_RE = /(?<!\d)\d{2,}(?!\d)/g;
const URL_RE = /https?:\/\/\S+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;

/**
 * 文字列から企業名・絶対数値・URL・メールを除去する。
 * 内部 utility (export しているのは unit test のため)。
 */
export function scrubText(input: string): string {
  if (!input) return "";
  return input
    .replace(EMAIL_RE, "{email}")
    .replace(URL_RE, "{url}")
    .replace(COMPANY_LATIN_RE, COMPANY_TOKEN)
    .replace(COMPANY_JP_PREFIX_RE, COMPANY_TOKEN)
    .replace(COMPANY_JP_SUFFIX_RE, COMPANY_TOKEN)
    .replace(COMPANY_SUFFIX_ONLY_RE, COMPANY_TOKEN)
    .replace(ABSOLUTE_NUMBER_RE, NUMBER_TOKEN)
    .replace(BARE_DIGITS_RE, NUMBER_TOKEN)
    .trim();
}

/**
 * 生キャンペーンデータから匿名化済みの構成パターンを抽出する。
 * 入力に含まれる可能性のある field を緩く受け取り、 出力は構成のみ。
 */
export function extractAnonymizedPattern(raw: Record<string, unknown>): AnonymizedPattern {
  const out: AnonymizedPattern = {};
  if (typeof raw.subject === "string") out.subjectPattern = scrubText(raw.subject);
  if (typeof raw.subjectPattern === "string") out.subjectPattern = scrubText(raw.subjectPattern);

  if (Array.isArray(raw.channels)) {
    out.channels = raw.channels.filter((c): c is string => typeof c === "string").map((s) => s.toLowerCase());
  }
  if (Array.isArray(raw.timing)) {
    out.timing = raw.timing.filter((t): t is string => typeof t === "string").map(scrubText);
  }
  if (Array.isArray(raw.components)) {
    out.components = raw.components.filter((c): c is string => typeof c === "string").map(scrubText);
  }
  if (typeof raw.tone === "string") out.tone = scrubText(raw.tone);

  if (raw.extras && typeof raw.extras === "object") {
    out.extras = scrubObject(raw.extras as Record<string, unknown>);
  }
  return out;
}

/** 任意 object を recursive に scrub する (深さ 3 まで)。 */
export function scrubObject(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") out[key] = scrubText(value);
    else if (typeof value === "number") out[key] = NUMBER_TOKEN;
    else if (Array.isArray(value)) {
      out[key] = value.map((v) =>
        typeof v === "string" ? scrubText(v) : typeof v === "number" ? NUMBER_TOKEN : v,
      );
    } else if (value && typeof value === "object") {
      out[key] = scrubObject(value as Record<string, unknown>, depth + 1);
    } else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * 成功シグナルを相対表現に丸める。 絶対値は除去し、 相対 lift / range の質的表現のみ残す。
 */
export function extractSuccessSignals(raw: Record<string, unknown>): SuccessSignals {
  const out: SuccessSignals = {};
  if (typeof raw.ctrLift === "string") out.ctrLift = scrubText(raw.ctrLift);
  if (typeof raw.cvrRange === "string") out.cvrRange = scrubText(raw.cvrRange);
  if (typeof raw.engagementShape === "string") out.engagementShape = scrubText(raw.engagementShape);
  if (typeof raw.durabilityDays === "number" && raw.durabilityDays > 0) {
    // durability は日数なので残してよい (相対の time 軸)
    out.durabilityDays = Math.round(raw.durabilityDays);
  }
  if (typeof raw.notes === "string") out.notes = scrubText(raw.notes);
  return out;
}
