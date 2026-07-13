/**
 * シグナルソースの集約。個々のソースが失敗しても他のソースの結果は返す。
 * 出典: 実運用SaaS server/lib/navigator/ingestion/index.ts
 */
import type { NewSignal } from "../types";
import type { SignalSource, SignalSourceContext } from "../ports";

export interface FetchAllOptions {
  /** ソース単位の失敗を通知するフック (省略時は黙って続行)。 */
  onSourceError?: (sourceName: string, error: unknown) => void;
}

export async function fetchAllSignals(
  sources: SignalSource[],
  ctx: SignalSourceContext,
  opts: FetchAllOptions = {},
): Promise<NewSignal[]> {
  const results = await Promise.allSettled(sources.map((s) => s.fetch(ctx)));
  const signals: NewSignal[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      signals.push(...result.value);
    } else {
      opts.onSourceError?.(sources[i]?.name ?? `source-${i}`, result.reason);
    }
  });
  return signals;
}

export { createHackerNewsSource } from "./hackernews";
export type { HackerNewsSourceOptions } from "./hackernews";
export { createExaSearchSource } from "./exa";
export type { ExaSearchSourceOptions } from "./exa";
export { createPerplexityNewsSource } from "./perplexity";
export type { PerplexityNewsSourceOptions } from "./perplexity";
