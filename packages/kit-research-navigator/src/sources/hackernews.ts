/**
 * Hacker News トップストーリーをシグナルとして取り込むソース実装例。
 * fetch を注入できるためテスト・プロキシ経由運用が可能。
 * 出典: 実運用SaaS server/lib/navigator/ingestion/hackernews.ts
 */
import type { NewSignal } from "../types";
import type { SignalSource } from "../ports";

export interface HackerNewsSourceOptions {
  fetchFn?: typeof fetch;
  /** 既定: https://hacker-news.firebaseio.com/v0 */
  baseUrl?: string;
  /** 取り込むトップストーリー数。既定 30。 */
  limit?: number;
  /** シグナルの source ラベル。既定 "hackernews"。 */
  sourceLabel?: string;
  now?: () => Date;
}

export function createHackerNewsSource(
  opts: HackerNewsSourceOptions = {},
): SignalSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://hacker-news.firebaseio.com/v0").replace(/\/$/, "");
  const limit = opts.limit ?? 30;
  const sourceLabel = opts.sourceLabel ?? "hackernews";
  const now = opts.now ?? (() => new Date());

  return {
    name: sourceLabel,
    async fetch(): Promise<NewSignal[]> {
      const res = await fetchFn(`${baseUrl}/topstories.json`);
      if (!res.ok) return [];

      const storyIds = (await res.json()) as number[];
      const topIds = storyIds.slice(0, limit);
      const signals: NewSignal[] = [];

      for (const id of topIds) {
        const itemRes = await fetchFn(`${baseUrl}/item/${id}.json`);
        if (!itemRes.ok) continue;

        const item = (await itemRes.json()) as {
          title?: string;
          url?: string;
          text?: string;
        } | null;
        if (!item || !item.title) continue;

        signals.push({
          source: sourceLabel,
          url: item.url || `https://news.ycombinator.com/item?id=${id}`,
          title: item.title,
          body: item.text || null,
          fetchedAt: now().toISOString(),
        });
      }
      return signals;
    },
  };
}
