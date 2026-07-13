/**
 * Exa 検索 API をシグナルソースにする実装例。
 * 元実装は Nango プロキシ経由だったが、API キー注入の直接呼び出しに一般化。
 * 出典: 実運用SaaS server/lib/navigator/ingestion/exa-proxy.ts
 */
import type { NewSignal } from "../types";
import type { SignalSource } from "../ports";

export interface ExaSearchSourceOptions {
  /** API キー (値は呼び出し側の設定機構から渡す。ハードコード禁止)。 */
  apiKey: string;
  fetchFn?: typeof fetch;
  /** 既定: https://api.exa.ai */
  baseUrl?: string;
  /** 検索クエリ。既定は汎用のテックニュース検索。 */
  query?: string;
  /** 既定 10。 */
  numResults?: number;
  /** シグナルの source ラベル。既定 "exa_search"。 */
  sourceLabel?: string;
  now?: () => Date;
}

export function createExaSearchSource(
  opts: ExaSearchSourceOptions,
): SignalSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.exa.ai").replace(/\/$/, "");
  const query =
    opts.query ?? "latest tech news hackernews producthunt github trending";
  const numResults = opts.numResults ?? 10;
  const sourceLabel = opts.sourceLabel ?? "exa_search";
  const now = opts.now ?? (() => new Date());

  return {
    name: sourceLabel,
    async fetch(): Promise<NewSignal[]> {
      const res = await fetchFn(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
        },
        body: JSON.stringify({ query, numResults, useAutoprompt: true }),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        results?: { title: string; url: string; text?: string }[];
      };
      if (!Array.isArray(data.results)) return [];

      return data.results.map((item) => ({
        source: sourceLabel,
        url: item.url,
        title: item.title,
        body: item.text || null,
        fetchedAt: now().toISOString(),
      }));
    },
  };
}
