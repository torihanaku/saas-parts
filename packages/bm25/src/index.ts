/**
 * @torihanaku/bm25 — BM25スコアリング
 *
 * BM25はTF-IDFの改良版。Elasticsearchのデフォルトランキング関数。
 * 教師データ不要の純粋な統計モデル。
 *
 * スコア計算式:
 *   score = Σ IDF(skill) × TF_norm(skill, doc) × ProficiencyWeight(skill)
 *
 *   TF_norm = TF × (k1 + 1) / (TF + k1 × (1 - b + b × |D|/avgdl))
 *
 * 本実装での簡略化:
 *   - (doc, term) の組がユニークである前提により TF は常に 0 or 1
 *   - TF=1 の場合: TF_norm = (k1+1) / (1 + k1×(1-b+b×|D|/avgdl))
 *
 * ProficiencyWeight:
 *   - expert: 1.25（希少な高度専門スキルを強調）
 *   - advanced: 1.0
 *   - intermediate: 0.85
 *   - beginner: 0.6
 *
 * Ported from dev-dashboard-v2 server/lib/bm25.ts (zero-dep faithful port).
 */

export const BM25_K1 = 1.5; // 単語頻度の飽和度（標準値）
export const BM25_B = 0.75; // 文書長正規化の強さ（標準値）

/** proficiency → スコア倍率 */
export const PROFICIENCY_WEIGHT: Record<string, number> = {
  expert: 1.25,
  advanced: 1.0,
  intermediate: 0.85,
  beginner: 0.6,
};

export interface MatchedSkill {
  name: string;
  proficiency: string;
}

export interface Bm25Input {
  /** ドキュメントID（例: キャラクターID）とそのドキュメントにマッチした項目一覧 */
  matchedSkillsByChar: Map<string, MatchedSkill[]>;
  /** ドキュメントIDとそのドキュメントの総項目数（文書長 |D|） */
  skillCountByChar: Map<string, number>;
  /** 項目名 → IDF値 */
  idfBySkill: Map<string, number>;
  /** 全ドキュメントの平均項目数（avgdl） */
  avgSkillCount: number;
}

export interface Bm25Result {
  characterId: string;
  score: number;
  matchedSkills: string[];
}

/**
 * BM25スコアを計算してドキュメントをランキング
 * proficiencyに応じたIDF重みを掛けることで専門家を上位に評価する
 */
export function computeBm25Scores(input: Bm25Input): Bm25Result[] {
  const { matchedSkillsByChar, skillCountByChar, idfBySkill } = input;
  const results: Bm25Result[] = [];

  // Guard against a zero/invalid avgdl (e.g. all-zero skill counts, or a caller
  // passing avgSkillCount: 0). Dividing docLen by 0 yields NaN, which poisons
  // every score and makes the ranking meaningless. Fall back to 1 so length
  // normalization degrades to "no normalization" rather than producing NaN.
  const avgSkillCount =
    Number.isFinite(input.avgSkillCount) && input.avgSkillCount > 0 ? input.avgSkillCount : 1;

  for (const [charId, skills] of matchedSkillsByChar) {
    const docLen = skillCountByChar.get(charId) ?? avgSkillCount;
    let score = 0;

    for (const skill of skills) {
      const idf = idfBySkill.get(skill.name) ?? 1.0;
      // TF=1（各項目はドキュメントあたり最大1件の前提）
      const tfNorm = (BM25_K1 + 1) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgSkillCount)));
      const profWeight = PROFICIENCY_WEIGHT[skill.proficiency] ?? 1.0;
      score += idf * tfNorm * profWeight;
    }

    results.push({ characterId: charId, score, matchedSkills: skills.map(s => s.name) });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * IDF マップを {skill_name, idf} レコード配列から構築
 */
export function buildIdfMap(rows: { skill_name: string; idf: number }[]): Map<string, number> {
  return new Map(rows.map(r => [r.skill_name, r.idf]));
}

/**
 * 項目数マップを {character_id, skill_count} レコード配列から構築
 */
export function buildSkillCountMap(rows: { character_id: string; skill_count: number }[]): Map<string, number> {
  return new Map(rows.map(r => [r.character_id, r.skill_count]));
}

/**
 * 平均項目数を計算
 */
export function computeAvgSkillCount(skillCountMap: Map<string, number>): number {
  if (skillCountMap.size === 0) return 90; // フォールバック
  let total = 0;
  for (const count of skillCountMap.values()) total += count;
  return total / skillCountMap.size;
}
