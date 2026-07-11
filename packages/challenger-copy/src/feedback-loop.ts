/**
 * Hard Negatives フィードバックループ。
 *
 * challenger 提案が却下されたとき:
 *   1. hard negative 行を挿入
 *   2. content_text を embedding
 *   3. embedding を後付けして将来の類似度検索に備える
 *
 * lint 側は lint 時に hard negative を pgvector cosine 類似度で照会し、
 * 0.85 超のマッチを lint アラートにする。
 *
 * 原実装は feature flag（activeLearningChallenger）でゲートしていたが、
 * ここでは `enabled` を注入（既定 true）にして疎結合化。
 */
import type { EmbedText } from "./types.js";
import type { ChallengerStore, HardNegativeMatchRow } from "./stores.js";

export const HARD_NEGATIVE_SIMILARITY_THRESHOLD = 0.85;

export interface RecordHardNegativeInput {
  tenantId: string;
  proposalId: string;
  contentText: string;
  rejectionReasonCode?: string | null;
  rejectionReasonText?: string | null;
  source?: string;
}

export interface HardNegativeRecord {
  id: string;
  tenantId: string;
  proposalId: string;
  contentText: string;
  embeddingStored: boolean;
}

export interface FeedbackLoopDeps {
  store: ChallengerStore;
  embedText: EmbedText;
  /** 機能フラグ相当。false なら何もしない（既定 true）。 */
  enabled?: boolean;
  logger?: { info?: (msg: string) => void; error?: (err: unknown) => void };
}

/** 却下された challenger を hard negative として記録し、embedding を後付けする。 */
export async function recordHardNegative(
  input: RecordHardNegativeInput,
  deps: FeedbackLoopDeps,
): Promise<HardNegativeRecord | null> {
  if (deps.enabled === false) return null;

  const hardNegativeId = await deps.store.insertHardNegative({
    tenant_id: input.tenantId,
    submission_id: input.proposalId,
    content_text: input.contentText,
    rejection_reason_code: input.rejectionReasonCode ?? null,
    rejection_reason_text: input.rejectionReasonText ?? null,
    source: input.source ?? "challenger_reject",
  });

  if (!hardNegativeId) {
    deps.logger?.error?.(new Error("dd_hard_negatives insert failed"));
    return null;
  }

  let embeddingStored = false;
  try {
    const embedding = await deps.embedText(input.contentText);
    embeddingStored = await deps.store.patchHardNegativeEmbedding(hardNegativeId, embedding);
    if (embeddingStored) {
      deps.logger?.info?.(`hard_negative recorded id=${hardNegativeId} tenant=${input.tenantId}`);
    }
  } catch (err) {
    deps.logger?.error?.(err);
  }

  return {
    id: hardNegativeId,
    tenantId: input.tenantId,
    proposalId: input.proposalId,
    contentText: input.contentText,
    embeddingStored,
  };
}

export interface HardNegativeMatch {
  hardNegativeId: string;
  similarity: number;
  rejectionReasonText: string | null;
  source: string | null;
}

export interface HardNegativeSimilarityResult {
  matched: boolean;
  matches: HardNegativeMatch[];
}

export interface CheckSimilarityDeps {
  store: ChallengerStore;
  embedText: EmbedText;
  enabled?: boolean;
  /** 類似度しきい値（既定 0.85）。 */
  threshold?: number;
  count?: number;
}

/**
 * 与えられたコンテンツが過去の hard negative と類似しているか判定する。
 */
export async function checkHardNegativeSimilarity(
  tenantId: string,
  content: string,
  deps: CheckSimilarityDeps,
): Promise<HardNegativeSimilarityResult> {
  if (deps.enabled === false) {
    return { matched: false, matches: [] };
  }

  const threshold = deps.threshold ?? HARD_NEGATIVE_SIMILARITY_THRESHOLD;
  try {
    const embedding = await deps.embedText(content);
    const rows: HardNegativeMatchRow[] = await deps.store.matchHardNegatives(
      tenantId,
      embedding,
      threshold,
      deps.count ?? 5,
    );

    const matches: HardNegativeMatch[] = rows.map((r) => ({
      hardNegativeId: r.id,
      similarity: r.similarity,
      rejectionReasonText: r.rejection_reason_text ?? null,
      source: r.source ?? null,
    }));

    return { matched: matches.length > 0, matches };
  } catch {
    return { matched: false, matches: [] };
  }
}
