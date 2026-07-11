# @torihanaku/analytics-normalizer

GA4 / GSC / Google Ads / Meta 等の異種メトリクスを統一形式に正規化し、集計・ROI・トレンドを算出するパッケージ。dev-dashboard-v2（マーケ運用ダッシュボード製品）のアナリティクス集約層を移植・自己完結化したものです。

## これは何か（正直な適用範囲）

**マーケ計測データの正規化に特化した製品固有** のロジックです。汎用の ETL ではありません。前提とするソース（GA4 / GSC / Google Ads / Meta Ads / LinkedIn / TikTok）のフィールド名・意味に強く依存しています。他ドメインのメトリクスをそのまま流し込むものではありません。

提供機能：

- `normalizeGa4` / `normalizeGsc` / `normalizeGoogleAds` / `normalizeMetaAds` — 各ソースの生データを `NormalizedMetric` に変換（純関数）
- `aggregateByPeriod` — 期間内スナップショットをソース別に集約
- `computeRoi` / `computeTrends` — ディメンション別 ROI と前期比トレンド
- データソースレジストリ（BigQuery 風 / ad-insights 風の実装例を注入可能な形で同梱）
- 広告インサイト同期コネクタ（LinkedIn / TikTok の実装例。両者は元コードで完全同一だったため 1 本に統合）

## 移植にあたっての切り離し（依存の注入化）

| 元の依存 | 本パッケージでの扱い |
| --- | --- |
| Supabase (`dd_analytics_snapshots`) | `aggregateByPeriod` に `SnapshotLoader` を注入 |
| `@google-cloud/bigquery` SDK | `BigQueryDataSource` に `QueryExecutor` を注入（SQL 構築のみ移植） |
| Supabase (`ad_insights`) | `AdInsightsDataSource` に `AdInsightLoader` を注入 |
| Nango `listConnections` / `listRecords` | コネクタに `ConnectorClient` を注入 |
| `supabaseInsert` | コネクタに `InsertFn` を注入 |
| zod スキーマ検証 | 依存を持たない軽量な必須チェックに置換 |

`@torihanaku/*` への依存・`process.env`・DB・秘匿情報は持ちません。ソース／コネクタは「注入可能な実装例（registry の登録候補）」として提供します。

## 使い方（概略）

```ts
import { DataSourceRegistry, bigQueryFactory, adInsightsFactory, computeRoi } from "@torihanaku/analytics-normalizer";

const registry = new DataSourceRegistry()
  .register("bigquery", bigQueryFactory(myBqExecutor))
  .register("supabase_ad_insights", adInsightsFactory(myRowLoader));

const src = registry.create("bigquery", bqConfig);
const series = await src.fetchDailySeries({ tenantId, from, to });
```

## 残課題

- BigQuery ソースはカラム名を SQL に直接展開する（元コードと同じ）。カラム名は信頼できる設定由来である前提で、任意ユーザー入力を渡してはいけない。
- コネクタは 1 ページ（limit 100）のみ取得。ページネーション未対応（元コードと同じ制約）。
