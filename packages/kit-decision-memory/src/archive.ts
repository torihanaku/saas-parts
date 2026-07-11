/**
 * archive.ts — 失敗博物館 / 成功レシピのアーカイブ閲覧（MEM-6）。
 *
 * 出典: dev-dashboard-v2 server/lib/institutional-memory/archive-helpers.ts
 * + server/routes/memory-archive.ts。
 * タグはマイグレーション不要のインライン方式（`[channel:meta]` 名前空間タグ +
 * `#hashtag`）を subject / content / source から抽出時に取り出す。
 * Supabase クエリは MemoryStore 注入に置き換えた。
 */

import type { MemoryStore } from "./stores.js";
import { NOOP_LOGGER, type KitLogger, type MemoryItem } from "./types.js";

// ── 公開型 ──────────────────────────────────────────────────────────────────
export type ArchiveType = "failure" | "success";

export interface ArchiveItem extends MemoryItem {
  /** subject/content/source から抽出した小文字タグ（重複排除・ソート済み）。 */
  tags: string[];
  /** ファセット。存在しなければ ""。 */
  channel: string;
  segment: string;
  season: string;
}

export interface ArchiveListOptions {
  type: ArchiveType;
  /** 自由文検索（subject + content の部分一致・大小無視）。 */
  q?: string;
  /** タグフィルタ（すべて含む場合のみマッチ）。小文字化して比較。 */
  tags?: string[];
  /** `[ns:value]` 名前空間タグ由来のファセットフィルタ。 */
  channel?: string;
  segment?: string;
  season?: string;
  /** 1..200（デフォルト 50）。 */
  limit?: number;
}

export interface ArchiveListResponse {
  items: ArchiveItem[];
  /** フィルタ前スライス全体の distinct タグ（ファセット UI 向け）。 */
  facets: {
    channels: string[];
    segments: string[];
    seasons: string[];
    tags: string[];
  };
  total: number;
}

// ── マッピング ──────────────────────────────────────────────────────────────
export const DEFAULT_ARCHIVE_MEM_TYPES: Record<ArchiveType, string> = {
  failure: "failure_recipe",
  success: "success_recipe",
};

export function isArchiveType(value: unknown): value is ArchiveType {
  return value === "failure" || value === "success";
}

// ── タグ抽出 ────────────────────────────────────────────────────────────────
const TAG_PATTERN = /\[([a-z0-9_-]+):([a-z0-9_/-]+)\]/gi;
const HASHTAG_PATTERN = /(?:^|\s)#([a-z0-9_-]{2,40})/gi;

/**
 * 自由文から `[ns:value]` と `#hashtag` トークンを抽出する。
 * 名前空間トークンは channel / segment / season ファセットへ写像し、
 * 裸のハッシュタグはルーズタグとして扱う。すべて小文字化 + 重複排除。
 */
export function extractTagFacets(text: string): {
  tags: string[];
  channel: string;
  segment: string;
  season: string;
} {
  const tags = new Set<string>();
  let channel = "";
  let segment = "";
  let season = "";

  if (!text) return { tags: [], channel, segment, season };

  for (const m of text.matchAll(TAG_PATTERN)) {
    const ns = (m[1] ?? "").toLowerCase();
    const val = (m[2] ?? "").toLowerCase();
    tags.add(`${ns}:${val}`);
    if (ns === "channel" && !channel) channel = val;
    else if (ns === "segment" && !segment) segment = val;
    else if (ns === "season" && !season) season = val;
  }

  for (const m of text.matchAll(HASHTAG_PATTERN)) {
    tags.add((m[1] ?? "").toLowerCase());
  }

  return { tags: Array.from(tags).sort(), channel, segment, season };
}

function toArchiveItem(item: MemoryItem): ArchiveItem {
  const blob = `${item.subject ?? ""} ${item.content ?? ""} ${item.source ?? ""}`;
  const facets = extractTagFacets(blob);
  return {
    ...item,
    tags: facets.tags,
    channel: facets.channel,
    segment: facets.segment,
    season: facets.season,
  };
}

// ── フィルタパイプライン ────────────────────────────────────────────────────
function applyClientSideFilters(items: ArchiveItem[], opts: ArchiveListOptions): ArchiveItem[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const wantedTags = (opts.tags ?? []).map((t) => t.toLowerCase()).filter(Boolean);
  const channel = (opts.channel ?? "").toLowerCase();
  const segment = (opts.segment ?? "").toLowerCase();
  const season = (opts.season ?? "").toLowerCase();

  return items.filter((it) => {
    if (q) {
      const hay = `${it.subject} ${it.content}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (channel && it.channel !== channel) return false;
    if (segment && it.segment !== segment) return false;
    if (season && it.season !== season) return false;
    if (wantedTags.length > 0) {
      const has = wantedTags.every((t) => it.tags.includes(t));
      if (!has) return false;
    }
    return true;
  });
}

function buildFacets(items: ArchiveItem[]): ArchiveListResponse["facets"] {
  const channels = new Set<string>();
  const segments = new Set<string>();
  const seasons = new Set<string>();
  const tags = new Set<string>();
  for (const it of items) {
    if (it.channel) channels.add(it.channel);
    if (it.segment) segments.add(it.segment);
    if (it.season) seasons.add(it.season);
    for (const t of it.tags) tags.add(t);
  }
  return {
    channels: Array.from(channels).sort(),
    segments: Array.from(segments).sort(),
    seasons: Array.from(seasons).sort(),
    tags: Array.from(tags).sort(),
  };
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), 200);
}

// ── サービス ────────────────────────────────────────────────────────────────
export interface MemoryArchiveServiceDeps {
  store: MemoryStore;
  /** ArchiveType → mem_type の写像（デフォルト: failure_recipe / success_recipe）。 */
  memTypeMap?: Record<ArchiveType, string>;
  logger?: KitLogger;
}

export class MemoryArchiveService {
  private readonly store: MemoryStore;
  private readonly memTypeMap: Record<ArchiveType, string>;
  private readonly logger: KitLogger;

  constructor(deps: MemoryArchiveServiceDeps) {
    this.store = deps.store;
    this.memTypeMap = deps.memTypeMap ?? DEFAULT_ARCHIVE_MEM_TYPES;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  archiveTypeToMemType(type: ArchiveType): string {
    return this.memTypeMap[type];
  }

  /**
   * テナントのアーカイブ項目をファセット付きで取得する。
   * DB からは tenant + mem_type + decided_at 降順のスーパーセットを引き、
   * タグ / q / ファセットのフィルタはメモリ内で適用する（本家と同じ方針）。
   */
  async listArchive(tenantId: string, options: ArchiveListOptions): Promise<ArchiveListResponse> {
    const limit = clampLimit(options.limit);
    const memType = this.archiveTypeToMemType(options.type);

    const rows = await this.store.listByType(tenantId, memType, limit);
    const all = rows.map(toArchiveItem);
    const facets = buildFacets(all);
    const filtered = applyClientSideFilters(all, options);

    this.logger.info(
      "decision-memory.archive.list",
      `type=${options.type} tenant=${tenantId} total=${filtered.length}`,
    );
    return { items: filtered, facets, total: filtered.length };
  }

  /**
   * 単一アーカイブ項目を id で取得する（テナントスコープ）。
   * 見つからない・failure/success レシピでない場合は null
   * （decision_log 行はこのビューから意図的に除外）。
   */
  async getArchiveItem(tenantId: string, id: string): Promise<ArchiveItem | null> {
    if (!id || typeof id !== "string") return null;
    const item = await this.store.getById(tenantId, id);
    if (!item) return null;
    const archiveTypes = new Set(Object.values(this.memTypeMap));
    if (!archiveTypes.has(item.memType)) return null;
    return toArchiveItem(item);
  }
}
