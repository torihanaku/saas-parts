/**
 * Digest feed 読み取りサービス
 * （元: server/routes/cos/feed.ts のロジック部。HTTP 配線は落とした）。
 *
 * digest を relevance_score DESC → ingested_at DESC で返す。
 * source type / 期間 / 件数のバリデーションはここで行う（HTTP 層は
 * クエリ文字列をそのまま渡せばよい）。
 */
import type { CosDigestItem, CosSourceType } from "./types";
import type { DigestStore } from "./stores";

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set(["slack", "email", "meeting"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface FeedFilters {
  /** 不正値は無視される */
  sourceType?: string;
  /** ingested_at >= sinceIso（不正な日付は無視） */
  sinceIso?: string;
  /** ingested_at <= untilIso（不正な日付は無視） */
  untilIso?: string;
  /** 既定 50・最大 200 */
  limit?: number;
}

export function clampFeedLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

export function isIsoDate(value: string | undefined): value is string {
  if (!value) return false;
  return !Number.isNaN(Date.parse(value));
}

export class FeedService {
  private readonly digestStore: DigestStore;

  constructor(deps: { digestStore: DigestStore }) {
    this.digestStore = deps.digestStore;
  }

  async list(tenantId: string, filters: FeedFilters = {}): Promise<CosDigestItem[]> {
    const sourceType =
      filters.sourceType && VALID_SOURCE_TYPES.has(filters.sourceType)
        ? (filters.sourceType as CosSourceType)
        : undefined;

    return this.digestStore.query(tenantId, {
      sourceType,
      sinceIso: isIsoDate(filters.sinceIso) ? filters.sinceIso : undefined,
      untilIso: isIsoDate(filters.untilIso) ? filters.untilIso : undefined,
      orderBy: "relevance",
      limit: clampFeedLimit(filters.limit),
    });
  }
}
