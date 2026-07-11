import type { BrandViolation, SimilarityMatch } from "./types.js";
import type { BrandLintStore } from "./stores.js";

export const SIMILARITY_THRESHOLD = 0.85;

/**
 * 過去却下案件との類似度チェック。
 * 新しい投稿の embedding を、過去に却下された案件と比較する。
 * cosine 類似度が {@link SIMILARITY_THRESHOLD} 以上なら warning を発する。
 */
export async function checkSimilarity(
  tenantId: string,
  embedding: number[],
  store: BrandLintStore,
): Promise<BrandViolation[]> {
  try {
    const matches: SimilarityMatch[] = await store.matchRejected(
      tenantId,
      embedding,
      SIMILARITY_THRESHOLD,
      3,
    );

    const violations: BrandViolation[] = [];
    for (const match of matches) {
      violations.push({
        type: "tone_mismatch",
        severity: "warning",
        message: `過去の却下案件と類似しています（類似度: ${Math.round(match.similarity * 100)}%）。却下理由: ${match.rejection_reason || "不明"}`,
        suggestion: "過去のフィードバックを参考に、表現を見直してください。",
      });
    }
    return violations;
  } catch (e) {
    console.error("[SimilarityCheck] Failed to check similarity:", e);
    return [];
  }
}
