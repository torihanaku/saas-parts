/**
 * タスクにマッチする AI社員を推薦する（BM25 ベース）。
 *
 * 元実装（server/routes/character-templates/match.ts）は Supabase の
 * skill_idf / character_skill_count / pgvector RPC に直結した BM25 + セマンティック
 * ハイブリッド（RRF）だった。このキットでは外部埋め込み基盤なしで自己完結する
 * よう、純粋な BM25 パスを注入ストア上に再実装した。IDF はスキル全走査から
 * その場で計算する（小規模テナント前提の参照実装）。LLM クエリ展開は任意注入。
 *
 * 出典: server/routes/character-templates/match.ts + shared.ts（extractKeywords /
 *       expandQueryWithLLM / deriveGroupKey は verbatim）。
 */
import {
  computeBm25Scores,
  computeAvgSkillCount,
  type MatchedSkill,
} from "./bm25";
import type { Character, CharacterStore, LlmCaller, SkillStore } from "./types";

// ─── キーワード抽出（元 shared.ts の extractKeywords を verbatim） ────────────

/**
 * テキストからキーワードを抽出する。
 * 最大10キーワードに絞る（DBクエリのORが長くなりすぎないように）
 */
export function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    "the", "a", "an", "in", "on", "at", "for", "of", "to", "and", "or", "is", "are", "was", "with",
    "this", "that", "it", "we", "you", "he", "she", "they", "be", "do", "have",
    "する", "した", "して", "している", "します", "です", "ます", "ある", "いる", "の", "を", "に", "は", "が", "で", "と",
    "お願い", "ください", "お", "ご",
  ]);

  const tokens = text.split(/[\s,、。！？「」【】()（）/-]+/).filter(Boolean);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < 2) continue;
    if (STOP_WORDS.has(lower)) continue;
    if (/^[a-z]+$/.test(lower) && lower.length < 3) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    keywords.push(token);
    if (keywords.length >= 10) break;
  }

  return keywords;
}

/**
 * Jr/Sr/Normalバリアントのサフィックスを除去してグループキーを返す。
 * （元 shared.ts の deriveGroupKey を verbatim）
 */
export function deriveGroupKey(name: string): string {
  return name.replace(/\s+(Jr|Sr|初級|上級|シニア|ジュニア)$/i, "").trim();
}

/**
 * LLM でクエリを関連スキル名に展開する（任意）。llm 未注入なら [] を返す。
 * 元実装は OpenAI 直叩きだったが、ここでは注入 LlmCaller 経由に一般化した。
 */
export async function expandQueryWithLLM(
  llm: LlmCaller | undefined,
  text: string,
  vocabulary: string[] = [],
): Promise<string[]> {
  if (!llm) return [];
  const vocabHint =
    vocabulary.length > 0
      ? `\n\n【参考: 実際のシステムに登録されているスキル名の例】\n${vocabulary
          .slice(0, 40)
          .join("、")}\n\nこれらと同じか類似した表現のスキル名を優先してください。`
      : "";
  const system = "You are a skill taxonomy assistant. Output ONLY a JSON array of strings.";
  const prompt = `以下のタスク説明に関連する専門スキル名を8個以内で列挙してください。実際のスキル名を日本語で。JSON配列形式のみで出力:${vocabHint}\n\n${text}`;
  const arr = await llm.generateJson<string[]>(system, prompt, []);
  if (!Array.isArray(arr)) return [];
  return arr.filter((s): s is string => typeof s === "string" && s.length >= 2).slice(0, 8);
}

// ─── マッチング本体 ─────────────────────────────────────────────────────────

export interface MatchOptions {
  taskTitle?: string;
  taskDescription?: string;
  limit?: number;
  clientId?: string;
  /** LLM クエリ展開に使う語彙（任意）。 */
  vocabulary?: string[];
}

export interface CharacterMatch {
  character: Character;
  score: number;
  matchedSkills: string[];
}

export interface MatchResult {
  matches: CharacterMatch[];
  keywords: string[];
}

/**
 * IDF を全スキルから計算: idf(s) = ln(1 + N / df(s))。
 * 元実装は事前計算済みの skill_idf テーブルを引いていたが、ここでは
 * SkillStore.all() からその場で導出する。
 */
function buildIdf(allSkills: { name: string; character_id: string }[]): Map<string, number> {
  const charsBySkill = new Map<string, Set<string>>();
  const allChars = new Set<string>();
  for (const s of allSkills) {
    allChars.add(s.character_id);
    const set = charsBySkill.get(s.name) ?? new Set<string>();
    set.add(s.character_id);
    charsBySkill.set(s.name, set);
  }
  const n = Math.max(allChars.size, 1);
  const idf = new Map<string, number>();
  for (const [name, chars] of charsBySkill) {
    idf.set(name, Math.log(1 + n / chars.size));
  }
  return idf;
}

/**
 * タスクにマッチする AI社員を BM25 で推薦する。
 */
export async function matchCharacters(
  characterStore: CharacterStore,
  skillStore: SkillStore,
  opts: MatchOptions,
  llm?: LlmCaller,
): Promise<MatchResult> {
  const taskText = [opts.taskTitle, opts.taskDescription].filter(Boolean).join(" ");
  if (!taskText.trim()) return { matches: [], keywords: [] };

  const limit = Math.min(opts.limit ?? 5, 20);

  // ---- クエリ展開 + キーワード抽出（並列）----
  const [expandedKws, baseKeywords] = await Promise.all([
    expandQueryWithLLM(llm, taskText, opts.vocabulary),
    Promise.resolve(extractKeywords(taskText)),
  ]);
  const keywords = [...new Set([...baseKeywords, ...expandedKws])].slice(0, 15);
  if (keywords.length === 0) return { matches: [], keywords: [] };

  const allSkills = await skillStore.all();
  const idfBySkill = buildIdf(allSkills);

  // 全キャラのスキル数
  const skillCountByChar = new Map<string, number>();
  for (const s of allSkills) {
    skillCountByChar.set(s.character_id, (skillCountByChar.get(s.character_id) ?? 0) + 1);
  }
  const avgSkillCount = computeAvgSkillCount(skillCountByChar);

  // ---- キーワード部分一致でマッチしたスキルをキャラごとに集約 ----
  const lowerKws = keywords.map((k) => k.toLowerCase());
  const matchedSkillsByChar = new Map<string, MatchedSkill[]>();
  for (const s of allSkills) {
    const nameLower = s.name.toLowerCase();
    if (!lowerKws.some((kw) => nameLower.includes(kw))) continue;
    const list = matchedSkillsByChar.get(s.character_id) ?? [];
    list.push({ name: s.name, proficiency: String(s.proficiency ?? "") });
    matchedSkillsByChar.set(s.character_id, list);
  }

  if (matchedSkillsByChar.size === 0) return { matches: [], keywords };

  const bm25Results = computeBm25Scores({
    matchedSkillsByChar,
    skillCountByChar,
    idfBySkill,
    avgSkillCount,
  });

  // ---- キャラ本体を引いて client_id フィルタ + Jr/Sr 重複排除 ----
  const characters = await characterStore.list();
  const charMap = new Map(characters.map((c) => [c.id, c]));

  const deduped = new Map<string, (typeof bm25Results)[number]>();
  for (const r of bm25Results) {
    const char = charMap.get(r.characterId);
    if (!char) continue;
    if (opts.clientId && char.clientId && char.clientId !== opts.clientId) continue;
    const groupKey = deriveGroupKey(char.name);
    if (!deduped.has(groupKey)) deduped.set(groupKey, r);
  }

  const matches = [...deduped.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      character: charMap.get(r.characterId)!,
      score: r.score,
      matchedSkills: r.matchedSkills,
    }));

  return { matches, keywords };
}
