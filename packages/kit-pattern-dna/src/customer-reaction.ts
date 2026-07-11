/**
 * customer-reaction.ts — 相手（顧客・読者）の反応パターン学習。
 *
 * (messageVariant × segment) → engagement の per-tenant マトリクスと、
 * セグメントごとのベストメッセージ推薦。
 *
 * ストレージは foundation の DNA テーブルを再利用する:
 *   dnaType = "customer_reaction"
 *   key     = `${messageVariant}::${segment}`（複合キー = 一意性）
 *   value   = { messageVariant, segment, engagement, sampleSize, lastReactedAt }
 *
 * engagement はサンプル加重の逐次平均 — 同じ (variant, segment) への
 * record() 呼び出しの繰り返しで平均が更新される。
 *
 * 出典: dev-dashboard-v2 `server/lib/company-dna/customer-reaction.ts`
 * （Supabase 直結 → DnaStore 注入）。
 */

import type { PatternDnaRow } from "./types.js";
import type { DnaStore } from "./stores.js";
import { ingestDna } from "./foundation.js";

export const REACTION_DNA_TYPE = "customer_reaction" as const;
export const KEY_SEPARATOR = "::";
export const DEFAULT_MIN_SAMPLE_SIZE = 3;

// ─── Public types ───────────────────────────────────────────────────────────

export interface ReactionMatrixEntry {
  tenantId: string;
  messageVariant: string;
  segment: string;
  /** [0, 1] の平均エンゲージメント。 */
  engagement: number;
  /** 逐次平均の背後にある累積サンプル数。 */
  sampleSize: number;
  /** 直近の record() 呼び出しの ISO タイムスタンプ。 */
  lastReactedAt: string;
}

export interface RecordReactionInput {
  tenantId: string;
  messageVariant: string;
  segment: string;
  /** 新サンプルのエンゲージメント（[0, 1] にクランプ）。 */
  engagement: number;
  /** バッチ取り込み用のサンプル重み。デフォルト 1、正の値のみ。 */
  sample?: number;
}

export interface RecommendBestMessageInput {
  tenantId: string;
  segment: string;
  /** 推薦に必要な最小累積サンプル数。デフォルト 3。 */
  minSampleSize?: number;
  /** 任意の候補フィルタ — これらの variant のみスコアリング。 */
  candidateVariants?: string[];
}

export interface RecommendBestMessageOutput {
  segment: string;
  /** 勝者エントリ — 適格な候補が無ければ null。 */
  entry: ReactionMatrixEntry | null;
  /** engagement 降順の全候補（UI テーブル用）。 */
  candidates: ReactionMatrixEntry[];
  reason: string;
}

export type ReactionValidationError =
  | "tenant_required"
  | "message_variant_required"
  | "segment_required"
  | "engagement_out_of_range"
  | "sample_must_be_positive";

// ─── Helpers ────────────────────────────────────────────────────────────────

export function reactionKey(messageVariant: string, segment: string): string {
  return `${messageVariant}${KEY_SEPARATOR}${segment}`;
}

export function parseReactionKey(
  key: string,
): { messageVariant: string; segment: string } | null {
  const idx = key.indexOf(KEY_SEPARATOR);
  if (idx <= 0 || idx >= key.length - KEY_SEPARATOR.length) return null;
  return {
    messageVariant: key.slice(0, idx),
    segment: key.slice(idx + KEY_SEPARATOR.length),
  };
}

export function clampEngagement(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function rowToEntry(row: PatternDnaRow): ReactionMatrixEntry | null {
  if (row.dnaType !== REACTION_DNA_TYPE) return null;
  const v = (row.value ?? {}) as Record<string, unknown>;
  let messageVariant = typeof v.messageVariant === "string" ? v.messageVariant : null;
  let segment = typeof v.segment === "string" ? v.segment : null;
  if (!messageVariant || !segment) {
    const parsed = parseReactionKey(row.key);
    if (!parsed) return null;
    messageVariant = parsed.messageVariant;
    segment = parsed.segment;
  }
  return {
    tenantId: row.tenantId,
    messageVariant,
    segment,
    engagement: clampEngagement(v.engagement),
    sampleSize: Math.max(0, Math.floor(Number(v.sampleSize ?? 0))),
    lastReactedAt: typeof v.lastReactedAt === "string" ? v.lastReactedAt : row.updatedAt,
  };
}

export function validateRecordInput(
  input: Partial<RecordReactionInput>,
): { ok: true; value: RecordReactionInput } | { ok: false; error: ReactionValidationError } {
  if (typeof input.tenantId !== "string" || input.tenantId.trim().length === 0) {
    return { ok: false, error: "tenant_required" };
  }
  if (typeof input.messageVariant !== "string" || input.messageVariant.trim().length === 0) {
    return { ok: false, error: "message_variant_required" };
  }
  if (typeof input.segment !== "string" || input.segment.trim().length === 0) {
    return { ok: false, error: "segment_required" };
  }
  const engagementNum = Number(input.engagement);
  if (!Number.isFinite(engagementNum) || engagementNum < 0 || engagementNum > 1) {
    return { ok: false, error: "engagement_out_of_range" };
  }
  let sample = 1;
  if (input.sample !== undefined) {
    const s = Number(input.sample);
    if (!Number.isFinite(s) || s <= 0) {
      return { ok: false, error: "sample_must_be_positive" };
    }
    sample = Math.floor(s);
  }
  return {
    ok: true,
    value: {
      tenantId: input.tenantId.trim(),
      messageVariant: input.messageVariant.trim(),
      segment: input.segment.trim(),
      engagement: engagementNum,
      sample,
    },
  };
}

// ─── recordReaction — 逐次平均で upsert ─────────────────────────────────────

/**
 * 新しいサンプルを既存集計に合成する:
 *   newMean = (oldMean × oldN + sample × newScore) / (oldN + sample)
 * 複合キーにより (tenant, variant, segment) ごとに 1 行が保証される。
 */
export async function recordReaction(
  store: DnaStore,
  input: RecordReactionInput,
): Promise<ReactionMatrixEntry | null> {
  const sample = Math.max(1, Math.floor(input.sample ?? 1));
  const key = reactionKey(input.messageVariant, input.segment);

  const existingRow = await store.get(input.tenantId, REACTION_DNA_TYPE, key);
  const existing = existingRow ? rowToEntry(existingRow) : null;
  const oldN = existing?.sampleSize ?? 0;
  const oldMean = existing?.engagement ?? 0;
  const newN = oldN + sample;
  const newMean =
    newN === 0 ? 0 : (oldMean * oldN + clampEngagement(input.engagement) * sample) / newN;

  const value = {
    messageVariant: input.messageVariant,
    segment: input.segment,
    engagement: clampEngagement(newMean),
    sampleSize: newN,
    lastReactedAt: new Date().toISOString(),
  };

  // confidence はサンプル数とともに上昇（1.0 に漸近）。ベイズ事後分布の
  // 安価な代替であり、Foundation の recommend 層には十分。
  const confidence = newN === 0 ? 0 : Math.min(1, newN / (newN + 5));

  const row = await ingestDna(store, {
    tenantId: input.tenantId,
    dnaType: REACTION_DNA_TYPE,
    key,
    value,
    source: "reaction:record",
    confidence,
  });
  return row ? rowToEntry(row) : null;
}

// ─── getReactionMatrix — リスト（フィルタ可） ───────────────────────────────

export interface GetReactionMatrixArgs {
  tenantId: string;
  segment?: string;
  messageVariant?: string;
}

export async function getReactionMatrix(
  store: DnaStore,
  args: GetReactionMatrixArgs,
): Promise<ReactionMatrixEntry[]> {
  let rows: PatternDnaRow[];
  try {
    rows = await store.list(args.tenantId, { dnaType: REACTION_DNA_TYPE });
  } catch {
    return [];
  }
  const entries = rows
    .map((r) => rowToEntry(r))
    .filter((e): e is ReactionMatrixEntry => e !== null);
  return entries.filter((e) => {
    if (args.segment && e.segment !== args.segment) return false;
    if (args.messageVariant && e.messageVariant !== args.messageVariant) return false;
    return true;
  });
}

// ─── recommendBestMessage — サンプル数の下限を満たすエンゲージメント勝者 ────

export async function recommendBestMessage(
  store: DnaStore,
  input: RecommendBestMessageInput,
): Promise<RecommendBestMessageOutput> {
  const minSampleSize = Math.max(1, Math.floor(input.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE));
  const matrix = await getReactionMatrix(store, {
    tenantId: input.tenantId,
    segment: input.segment,
  });

  const candidatePool =
    input.candidateVariants && input.candidateVariants.length > 0
      ? matrix.filter((e) => input.candidateVariants!.includes(e.messageVariant))
      : matrix;

  const sorted = [...candidatePool].sort(
    (a, b) => b.engagement - a.engagement || b.sampleSize - a.sampleSize,
  );
  const eligible = sorted.find((e) => e.sampleSize >= minSampleSize) ?? null;

  let reason: string;
  if (matrix.length === 0) {
    reason = `no reactions recorded for segment "${input.segment}"`;
  } else if (candidatePool.length === 0) {
    reason = `no candidate variants found for segment "${input.segment}"`;
  } else if (!eligible) {
    reason = `top variant has fewer than ${minSampleSize} samples — recommendation suppressed`;
  } else {
    reason = `top engagement ${eligible.engagement.toFixed(2)} over ${eligible.sampleSize} samples`;
  }
  return { segment: input.segment, entry: eligible, candidates: sorted, reason };
}
