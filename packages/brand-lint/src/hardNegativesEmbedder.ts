import type { EmbedBatch } from "./types.js";
import type { BrandLintStore, HardNegativeInsert } from "./stores.js";

export interface IngestDeps {
  store: BrandLintStore;
  embedBatch: EmbedBatch;
}

/**
 * 直近の却下投稿を Brand DNA スナップショットに hard negative として埋め込み、
 * 類似度検索・予測精度を向上させる。
 *
 * 1. 直近 N 日の却下投稿を取得
 * 2. 既に hard negative 化済みのものを重複排除
 * 3. 新規分をバッチ embedding
 * 4. hard negative として挿入
 */
export async function ingestRecentRejections(
  sinceDays: number,
  deps: IngestDeps,
): Promise<{ inserted: number }> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - sinceDays);

  const submissions = await deps.store.listRecentRejections(sinceDate.toISOString());
  if (submissions.length === 0) {
    return { inserted: 0 };
  }

  const submissionIds = submissions.map((s) => s.id);
  const existingIds = new Set(
    await deps.store.listExistingHardNegativeSourceIds(submissionIds),
  );
  const toEmbed = submissions.filter((s) => !existingIds.has(s.id));
  if (toEmbed.length === 0) {
    return { inserted: 0 };
  }

  const embeddings = await deps.embedBatch(toEmbed.map((s) => s.content_text));

  const insertData: HardNegativeInsert[] = toEmbed.map((s, index) => ({
    tenant_id: s.tenant_id,
    source_type: "content",
    source_id: s.id,
    content_text: s.content_text,
    embedding: embeddings[index] ?? [],
    approval_status: "rejected",
    rejection_reason: s.rejection_reason_text || "No reason provided",
  }));

  await deps.store.insertHardNegatives(insertData);
  return { inserted: insertData.length };
}
