# @torihanaku/anomaly-detection

閾値ベースのメトリクス異常検出器（単価スパイク / 配信失敗率悪化 / ランキング下落 — ローリングベースライン比較）と、全テナント走査のリアルタイム監視オーケストレータ。

移植元: dev-dashboard-v2 `server/lib/anomaly-detection.ts` + `server/jobs/realtime-monitor.ts`

## 検出器（レジストリに並べる `Detector` 群）

すべて「直近の観測値 vs 過去7日ベースライン」の比率/差分で warning / critical を判定。**例外を投げない**（データ欠如・テーブル欠如・fetch 失敗はすべて null = スキップ）。数式は移植元と同一で、名前だけ汎用リネーム:

| 本パッケージ | 移植元 | 判定 |
|---|---|---|
| `createMetricSpikeDetector` (metric_spike) | detectCpaSpike (cpa_spike) | 今日の spend/conversions ÷ ベースライン ≥ 1.5x warning / 2.0x critical |
| `createDeliveryDropDetector` (delivery_drop) | detectEmailDeliveryDrop | 今日の失敗率(bounced/dropped/spam) ÷ ベースライン ≥ 1.5x / 2.0x（今日10件未満はノイズ床でスキップ） |
| `createRankDropDetector` (rank_drop) | detectSeoRankDrop | キーワード別の平均順位悪化 delta ≥ +5 warning / +10 critical（worst-first 上位5件を details に） |

データ取得は `fetchRows(tenantId, {start, end})` を注入（`null` 返却 = ソース欠如）。閾値・ベースライン日数・metricType 名・`now`（テスト用固定時刻）はオプションで上書き可能。

```ts
import { createMetricSpikeDetector } from "@torihanaku/anomaly-detection";

const detectCpaSpike = createMetricSpikeDetector(
  async (tenantId, { start, end }) => {
    const { data, error } = await db.from("ad_insights")
      .select("date,spend,conversions").eq("tenant_id", tenantId)
      .gte("date", start).lte("date", end);
    if (error) return null; // ソース欠如 → スキップ
    return data;
  },
  { metricType: "cpa_spike" }, // 元実装の名前に戻す場合
);
```

## オーケストレータ（cron ハンドラ本体）

全テナント × 全検出器を走査し、検出ごとに「アクション発火 → 永続化 → 報告」。1テナント/1検出器の失敗はスイープ全体を止めない（移植元と同一のセマンティクス）。

```ts
import { runRealtimeMonitor } from "@torihanaku/anomaly-detection";

const summary = await runRealtimeMonitor({
  listTenantIds: async () => (await db.from("teams").select("id")).data.map(t => t.id),
  detectors: [detectCpaSpike, detectDeliveryDrop, detectRankDrop], // レジストリ
  persistAnomaly: async (tenantId, result, action) => {           // 永続化は注入
    await db.from("anomaly_events").insert({ tenant_id: tenantId, ...toRow(result), actions: action ? [action] : [] });
  },
  dispatchAction: async (tenantId, result) =>                     // 自動対応も注入（省略可）
    slackNotify(tenantId, result).then(() => ({ actionType: "notify" })),
  logger: { error: (ctx, err) => sentryLog(ctx, err), info: (ctx, msg) => console.log(ctx, msg) },
});
// summary = { tenants, anomalies }
```

## 変更点（移植元との差分）

- Supabase クエリ（dd_ad_insights / dd_email_deliveries / dd_seo_rankings / teams / dd_anomaly_events）→ `fetchRows` / `listTenantIds` / `persistAnomaly` 注入
- `dispatchAnomalyAction`（Slack notify-only）→ `dispatchAction` 注入（省略時は action なし）
- logger.ts（Sentry フォールバック付き logError/logInfo）→ `logger` 注入（default: console）
- 検出器名を汎用リネーム（`metricType` オプションで元の名前も再現可能）。閾値定数をオプション化（デフォルト値は移植元と同値）
- `runRealtimeMonitor` が `{ tenants, anomalies }` を返すようにした（移植元は void + ログのみ）

参考: `server/lib/agent/detectors/*` には σ（標準偏差）ベースの別系統の検出器があるが、本パッケージは cron 監視で実運用されている比率/差分閾値方式（anomaly-detection.ts）を採用した。

## ランタイム要件

- 依存パッケージなし（純 TypeScript）。Node / Bun / edge どこでも動作。
