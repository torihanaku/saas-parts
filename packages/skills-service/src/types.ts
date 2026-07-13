/**
 * Skills domain types.
 * Ported from 実運用SaaS `server/routes/skills/`.
 *
 * Storage note: the original uses `cockpit_project_sources` with
 * source_type='skill' to avoid a new migration; skill-specific fields live in
 * the metadata JSONB. This package models the logical Skill directly and lets
 * the store map to whatever backing table the host prefers.
 */

export type SkillType = "analysis" | "generation" | "review" | "research" | "custom";
export type SkillCategory = "marketing" | "pr" | "development" | "design" | "custom";

export const VALID_SKILL_TYPES: SkillType[] = ["analysis", "generation", "review", "research", "custom"];
export const VALID_CATEGORIES: SkillCategory[] = ["marketing", "pr", "development", "design", "custom"];

export interface SkillExample {
  input?: string;
  output?: string;
}

/** Metadata JSONB shape (as stored on the source row). */
export interface SkillMetadata {
  skill_type: string;
  category: string;
  definition: string;
  examples: unknown[];
  triggers: unknown[];
  version: number;
}

/** Logical skill row (source_type='skill'). */
export interface SkillRow {
  id: string;
  /** project_id in the underlying table (client scope). */
  client_id: string | null;
  name: string;
  description: string;
  metadata: SkillMetadata;
  created_at: string;
  updated_at: string;
}

/** Flattened skill view returned by list/get (matches the original response). */
export interface SkillView {
  id: string;
  client_id: string | null;
  name: string;
  description: string;
  source_type: string;
  metadata: SkillMetadata;
  category: string;
  skill_type: string;
  definition: string;
  examples: unknown[];
  triggers: unknown[];
  version: number;
  created_at: string;
  updated_at: string;
}

/** AI-generated / template skill payload (pre-save). */
export interface GeneratedSkill {
  name: string;
  skill_type: string;
  category: string;
  definition: string;
  examples: unknown[];
  triggers: unknown[];
  version: number;
}

export const SOURCE_TYPE = "skill";

export function isValidUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Flatten a stored SkillRow into the API response shape (ported). */
export function toSkillView(row: SkillRow): SkillView {
  const meta = row.metadata || ({} as SkillMetadata);
  return {
    id: row.id,
    client_id: row.client_id || null,
    name: row.name || "",
    description: row.description || "",
    source_type: SOURCE_TYPE,
    metadata: meta,
    category: meta.category || "custom",
    skill_type: meta.skill_type || "custom",
    definition: meta.definition || "",
    examples: meta.examples || [],
    triggers: meta.triggers || [],
    version: meta.version || 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Prompt builders + template fallbacks (ported verbatim) ────────────────────

export function buildGeneratePrompt(description: string, sourceMaterials: string): string {
  return `以下のソース資料から、AIアシスタントが再現可能なスキル定義を作成してください。

スキルの目的: ${description}

${sourceMaterials ? `ソース資料:\n${sourceMaterials}` : "（ソース資料なし — 目的の説明のみから生成してください）"}

出力形式（JSON）:
{
  "name": "スキル名",
  "skill_type": "analysis|generation|review|research|custom のいずれか",
  "category": "marketing|pr|development|design|custom のいずれか",
  "definition": "詳細な手順定義（マークダウン形式）",
  "examples": [{"input": "入力例", "output": "出力例"}],
  "triggers": ["このスキルを使うべき場面の説明"]
}

JSONのみを出力してください。`;
}

export function buildQuestionsPrompt(name: string, description: string, currentDefinition: string): string {
  return `以下のスキル定義をより正確にするために、作成者に聞くべき質問を5つ生成してください。

スキル名: ${name}
説明: ${description}
現在の定義:
${currentDefinition}

質問は具体的で、回答がスキル定義の改善に直結するものにしてください。
JSON配列で出力してください: ["質問1", "質問2", ...]`;
}

export function buildRefinePrompt(currentDefinition: string, question: string): string {
  return `以下のスキル定義を、ユーザーの回答を踏まえて改善してください。

現在のスキル定義:
${currentDefinition}

ユーザーへの質問と回答:
${question}

改善されたスキル定義をマークダウン形式で出力してください。定義のみを出力し、余計な説明は不要です。`;
}

/** Template skill used when no LLM is configured (ported). */
export function templateSkill(description: string): GeneratedSkill {
  return {
    name: `スキル: ${description.substring(0, 50)}`,
    skill_type: "custom",
    category: "custom",
    definition: `## 目的\n${description}\n\n## 手順\n1. \n2. \n3. \n\n## 判断基準\n- \n\n## 出力例\n（ここに出力例を記述）`,
    examples: [],
    triggers: [],
    version: 1,
  };
}

/** Standard clarifying questions used when no LLM is configured (ported). */
export const STANDARD_QUESTIONS: string[] = [
  "このスキルの対象読者（ペルソナ）は誰ですか？",
  "出力のトーン（フォーマル/カジュアル）はどちらが適切ですか？",
  "このスキルで最も重要な判断基準は何ですか？",
  "良い出力と悪い出力の具体例を教えてください。",
  "このスキルを使うべきでない場面はありますか？",
];

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractJsonArray(text: string): unknown[] | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
