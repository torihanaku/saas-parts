export {
  BENCHMARK_K_ANON_MIN,
  SHARE_LEVELS,
  type ShareLevel,
  type IndustryBenchmark,
  type BenchmarkConsent,
  type BenchmarkConsentUpdate,
} from "./types";

export {
  percentile,
  aggregateIndustryKPIs,
  BenchmarkService,
  InMemoryBenchmarkStore,
  type BenchmarkStore,
  type BenchmarkServiceOptions,
  type StoreResult,
} from "./benchmark-aggregator";

export {
  MIN_K_ANONYMITY,
  hashTenantId,
  anonymizeTenantRows,
  applyKAnonymity,
  type OpaqueRow,
  type KAnonymousResult,
} from "./anonymizer";
