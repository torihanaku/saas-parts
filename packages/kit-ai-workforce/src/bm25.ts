/**
 * bm25.ts — BM25スコアリング（キット内プライベートコピー）
 *
 * BM25はTF-IDFの改良版。Elasticsearchのデフォルトランキング関数。
 * 教師データ不要の純粋な統計モデル。
 *
 * スコア計算式:
 *   score = Σ IDF(skill) × TF_norm(skill, char) × ProficiencyWeight(skill)
 *
 *   TF_norm = TF × (k1 + 1) / (TF + k1 × (1 - b + b × |D|/avgdl))
 *
 * 本実装での簡略化:
 *   - UNIQUE(character_id, name)制約により TF は常に 0 or 1
 *   - TF=1 の場合: TF_norm = (k1+1) / (1 + k1×(1-b+b×|D|/avgdl))
 *
 * ProficiencyWeight:
 *   - expert: 1.25（希少な高度専門スキルを強調）
 *   - advanced: 1.0
 *   - intermediate: 0.85
 *   - beginner: 0.6
 *
 * 出典: dev-dashboard-v2 server/lib/bm25.ts をクロスインポートせず自己完結の
 *       プライベートコピーとして内包（ロジックは verbatim）。
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
  /** キャラクターIDとそのキャラが持つマッチしたスキル一覧 */
  matchedSkillsByChar: Map<string, MatchedSkill[]>;
  /** キャラクターIDとそのキャラの総スキル数 */
  skillCountByChar: Map<string, number>;
  /** スキル名 → IDF値 */
  idfBySkill: Map<string, number>;
  /** 全キャラの平均スキル数 */
  avgSkillCount: number;
}

export interface Bm25Result {
  characterId: string;
  score: number;
  matchedSkills: string[];
}

/**
 * BM25スコアを計算してキャラクターをランキング
 * proficiencyに応じたIDF重みを掛けることで専門家を上位に評価する
 */
export function computeBm25Scores(input: Bm25Input): Bm25Result[] {
  const { matchedSkillsByChar, skillCountByChar, idfBySkill, avgSkillCount } = input;
  const results: Bm25Result[] = [];

  for (const [charId, skills] of matchedSkillsByChar) {
    const docLen = skillCountByChar.get(charId) ?? avgSkillCount;
    let score = 0;

    for (const skill of skills) {
      const idf = idfBySkill.get(skill.name) ?? 1.0;
      // TF=1（UNIQUE制約により各スキルは最大1件）
      const tfNorm = (BM25_K1 + 1) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgSkillCount)));
      const profWeight = PROFICIENCY_WEIGHT[skill.proficiency] ?? 1.0;
      score += idf * tfNorm * profWeight;
    }

    results.push({ characterId: charId, score, matchedSkills: skills.map((s) => s.name) });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * IDF マップを skill_idf テーブルのレコードから構築
 */
export function buildIdfMap(rows: { skill_name: string; idf: number }[]): Map<string, number> {
  return new Map(rows.map((r) => [r.skill_name, r.idf]));
}

/**
 * スキル数マップを character_skill_count テーブルのレコードから構築
 */
export function buildSkillCountMap(
  rows: { character_id: string; skill_count: number }[],
): Map<string, number> {
  return new Map(rows.map((r) => [r.character_id, r.skill_count]));
}

/**
 * 平均スキル数を計算
 */
export function computeAvgSkillCount(skillCountMap: Map<string, number>): number {
  if (skillCountMap.size === 0) return 90; // フォールバック
  let total = 0;
  for (const count of skillCountMap.values()) total += count;
  return total / skillCountMap.size;
}
