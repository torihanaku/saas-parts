# @torihanaku/benchmark-aggregator

クロステナント（他社比較）の業界ベンチマーク集計。k-匿名性ガード（k未満は結果全体を抑制）とオプトイン同意レジストリ、テナントIDの不可逆ハッシュ匿名化を提供。

## 主要API例

```ts
import {
  BenchmarkService,
  InMemoryBenchmarkStore,
  aggregateIndustryKPIs,
  percentile,
  BENCHMARK_K_ANON_MIN, // 業界集計の k = 10
  applyKAnonymity,
  anonymizeTenantRows,
  hashTenantId,
  MIN_K_ANONYMITY,      // 他社比較レスポンス層の k = 5
} from "@torihanaku/benchmark-aggregator";

const service = new BenchmarkService({
  store: new InMemoryBenchmarkStore(), // 本番は DB 実装の BenchmarkStore を注入
});

// 集計（k-匿名性ガード: サンプル数 < 10 なら null — 部分結果を保存してはいけない）
const snapshot = aggregateIndustryKPIs("saas", "open_rate", "2026-Q2", samples);
// → { percentile_5/25/50/75/95（NumPy linear 補間）, sample_size, computed_at } | null

// 同意レジストリ（none < kpi_only < patterns < full）
await service.setTenantConsent("tenant-1", "kpi_only"); // opt-in（opted_in_at 記録）
await service.setTenantConsent("tenant-1", "none");     // opt-out（opted_out_at 記録）
await service.getTenantConsent("tenant-1");             // 未登録なら合成 'none' 行
const ids = await service.listOptedInTenantIds("kpi_only"); // 集計cronはこのIDのみ使う

// 読み出し（safe view 相当: sample_size >= k の行のみをストアが返す前提）
await service.getIndustryBenchmark("saas", "open_rate", "2026-Q2");

// レスポンス層の匿名化（anonymizer を同梱）
const safe = applyKAnonymity(anonymizeTenantRows(rows)); // k未満なら { insufficient_data: true, rows: [] }
```

## 依存
- peerDependencies: なし（`node:crypto` の sha256 のみ使用）

## 注入ポイント
- `BenchmarkStore` — dd_industry_benchmarks_safe / dd_tenant_benchmark_consent 相当の読み書き（元クエリ形状を型付きメソッドで写像）
- `now` — 時刻注入（computed_at / 同意タイムスタンプの決定性用）

## 元実装からの変更点
- Supabase 直接呼び出し → `BenchmarkStore` 注入。k-匿名性ロジック（ガード・閾値・同意ランク）は無改変
- `server/lib/benchmark/anonymizer.ts`（hashTenantId / anonymizeTenantRows / applyKAnonymity, k=5）を同一システムとして同梱
- 元実装の `aggregateIndustryKPIs` は percentile_5/95 を未設定のまま返していた（IndustryBenchmark 型は必須）。本パッケージでは同じ percentile 関数で 5/95 も計算して返す

## 残課題
- `server/lib/benchmark/aggregator.ts`（cockpit_clients/projects を読む24hクロン本体）は feature-flag・固有テーブル結合が強いため未移植。本パッケージの `aggregate` + `listOptedInTenantIds` で置き換え可能
