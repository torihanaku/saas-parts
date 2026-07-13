/**
 * foundation.ts — 組織パターン DNA の蓄積基盤。
 *
 * 5 つの dnaType カテゴリの per-tenant 蓄積を扱う最小限ロジック:
 *   - ingestDna(store, input)     — upsert（複合キー: tenant, dnaType, key）
 *   - getDnaByType(store, args)   — ページング付きリスト + 総数
 *   - getDnaStats(store, tenant)  — 総数 + タイプ別内訳 + 平均 confidence
 *
 * 出典: 実運用SaaS `server/lib/company-dna.ts`（Supabase 直結 → DnaStore 注入）。
 */

import type { DnaListResponse, DnaStats, IngestDnaRequest, PatternDnaType } from "./types.js";
import { PATTERN_DNA_TYPES, isPatternDnaType } from "./types.js";
import type { PatternDnaRow } from "./types.js";
import type { DnaStore } from "./stores.js";

// ─── Validation primitives（ルート層のエラーマッピングでも使う） ────────────

export function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export interface ValidatedIngest {
  dnaType: PatternDnaType;
  key: string;
  value: Record<string, unknown>;
  source: string;
  confidence: number;
}

export type ValidationError =
  | "invalid_dna_type"
  | "key_required"
  | "value_required"
  | "source_required"
  | "confidence_out_of_range";

/**
 * ingest ペイロードを検証する。成功時は正規化済みオブジェクト、失敗時は
 * 呼び出し層が 400 として返せる具体的なエラーコードを返す。
 */
export function validateIngestRequest(
  input: Partial<IngestDnaRequest>,
): { ok: true; value: ValidatedIngest } | { ok: false; error: ValidationError } {
  if (!input.dna_type || !isPatternDnaType(input.dna_type)) {
    return { ok: false, error: "invalid_dna_type" };
  }
  if (typeof input.key !== "string" || input.key.trim().length === 0) {
    return { ok: false, error: "key_required" };
  }
  if (input.value === undefined || input.value === null || typeof input.value !== "object") {
    return { ok: false, error: "value_required" };
  }
  if (typeof input.source !== "string" || input.source.trim().length === 0) {
    return { ok: false, error: "source_required" };
  }
  // confidence は任意 — ただし与えられた場合は有限数でなければならない。
  if (input.confidence !== undefined) {
    const c = Number(input.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      return { ok: false, error: "confidence_out_of_range" };
    }
  }
  return {
    ok: true,
    value: {
      dnaType: input.dna_type,
      key: input.key.trim(),
      value: input.value as Record<string, unknown>,
      source: input.source.trim(),
      confidence: input.confidence === undefined ? 1 : clampConfidence(input.confidence),
    },
  };
}

// ─── ingestDna — 複合キーで upsert ──────────────────────────────────────────

export interface IngestDnaInput extends ValidatedIngest {
  tenantId: string;
}

/**
 * DNA 行を挿入または更新する。同一 (tenant, dnaType, key) の既存行は
 * 上書き更新、それ以外は新規挿入（実際の upsert 動作はストア実装が担う）。
 *
 * 成功時は結果の PatternDnaRow、永続化失敗時は null を返す
 * （呼び出し層が 500 + `upsert_failed` にマップする）。
 */
export async function ingestDna(
  store: DnaStore,
  input: IngestDnaInput,
): Promise<PatternDnaRow | null> {
  try {
    return await store.upsert({
      tenantId: input.tenantId,
      dnaType: input.dnaType,
      key: input.key,
      value: input.value,
      source: input.source,
      confidence: input.confidence,
    });
  } catch {
    return null;
  }
}

// ─── getDnaByType — テナント × dnaType のページング付きリスト ───────────────

export interface GetDnaByTypeArgs {
  tenantId: string;
  dnaType: PatternDnaType;
  limit?: number;
  offset?: number;
}

/**
 * 指定タイプの DNA 行をページングと総数付きで返す。
 * デフォルト: limit=100（最大 500）、offset=0。
 */
export async function getDnaByType(
  store: DnaStore,
  args: GetDnaByTypeArgs,
): Promise<DnaListResponse> {
  const limit = clampInt(args.limit, 1, 500, 100);
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  try {
    const total = await store.count(args.tenantId, args.dnaType);
    const rows = await store.list(args.tenantId, { dnaType: args.dnaType, limit, offset });
    return { rows, total, limit, offset };
  } catch {
    return { rows: [], total: 0, limit, offset };
  }
}

// ─── getDnaStats — ダッシュボード用の集計 ───────────────────────────────────

export async function getDnaStats(store: DnaStore, tenantId: string): Promise<DnaStats> {
  let list: PatternDnaRow[];
  try {
    list = await store.list(tenantId);
  } catch {
    list = [];
  }

  const byType = PATTERN_DNA_TYPES.reduce<Record<PatternDnaType, number>>(
    (acc, t) => ({ ...acc, [t]: 0 }),
    {} as Record<PatternDnaType, number>,
  );

  let confidenceSum = 0;
  for (const row of list) {
    if (isPatternDnaType(row.dnaType)) byType[row.dnaType] += 1;
    confidenceSum += clampConfidence(row.confidence);
  }
  const total = list.length;
  return {
    total,
    byType,
    meanConfidence: total === 0 ? 0 : confidenceSum / total,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
