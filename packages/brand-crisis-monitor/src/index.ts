/**
 * @torihanaku/brand-crisis-monitor — SNS 炎上監視・深刻度判定・アラート
 *
 * 監視ソース（CrisisSource）から言及を取得し、LLM で感情分類、24h スパイクを
 * 検知して閾値超過でアラートを発報する。Reddit 実装を `CrisisSource` 注入 IF の
 * 一例として同梱する。
 *
 * 全依存（ソース / ストア / LLM / API キー解決 / アラート通知）は注入式。
 * `process.env` に触れず、シークレットも同梱しない。
 */

export type {
  CrisisMention,
  CrisisSearchOptions,
  CrisisSource,
  BrandMention,
  MonitoredKeyword,
  BrandCrisisAlert,
  CrisisStore,
  GenerateJson,
  ResolveApiKey,
  Alerter,
  Logger,
  BrandCrisisConfig,
} from "./types";
export {
  DEFAULT_THRESHOLD,
  DEFAULT_SEARCH_OPTIONS,
  DEFAULT_SENTIMENT_MODEL,
} from "./types";

export { runBrandCrisisMonitor } from "./monitor";
export { InMemoryCrisisStore } from "./store";
export { createRedditSource } from "./reddit-source";
export type { RedditSourceConfig, FetchFn } from "./reddit-source";
