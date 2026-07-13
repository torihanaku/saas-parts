# @torihanaku/slack-reports

定期レポートを **Slack Block Kit** として組み立てる 4 種のビルダーと、それらを名前で束ねる registry。実運用SaaS の週次 Slack レポート実装から「ペイロードの型」だけを抽出したものです。

- **データ取得 → provider に注入** (`ReportDefinition.provider`)
- **文言・書式 → config に集約** (`*Copy`。省略時は原文どおりのデフォルト)
- **送信 → sender に注入** (`SlackReportSender`)。`@torihanaku/slack-harness` の `postSlackDm` などがシグネチャを充足しますが、本パッケージは import しません（依存ゼロ）。

## 収録ビルダー

| ビルダー | 用途 | Copy |
|---|---|---|
| `buildWeeklyReportPayload` | 週次レポート（本文 2900 字） | `DEFAULT_WEEKLY_REPORT_COPY` |
| `buildExecutiveStatusPayload` | 経営ステータス（本文 1500 字） | `DEFAULT_EXECUTIVE_STATUS_COPY` |
| `buildScenarioSummaryPayload` | シナリオ予測サマリー（PV/CV 等） | `DEFAULT_SCENARIO_SUMMARY_COPY` |
| `buildFirewallEvalPayload` | 週次精度サマリー（F1/Precision 等） | `DEFAULT_FIREWALL_EVAL_COPY` |

補助として ISO 8601 週文字列 `isoWeek()` と、比率→%変換 `pct()` を同梱。

## registry で複数レポートを回す

```ts
import {
  ReportRegistry,
  buildWeeklyReportPayload,
  buildFirewallEvalPayload,
} from "@torihanaku/slack-reports";

const registry = new ReportRegistry()
  .register({
    name: "weekly-report",
    // provider: そのテナントのレポート素材を返す。null を返すとスキップ
    provider: async (tenant) => await generateWeeklyReport(tenant.id),
    build: (tenant, content) =>
      buildWeeklyReportPayload(tenant.name, isoWeek(), content),
  })
  .register({
    name: "firewall-eval",
    provider: async (tenant) => await fetchLatestEvalRun(tenant.id), // null 可
    build: (tenant, run) => buildFirewallEvalPayload(tenant.name, run),
  });

const results = await registry.runAll({
  tenants: await listTenants(),
  // sender: @torihanaku/slack-harness の postSlackDm 等でも可
  sender: async (payload) => {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  onError: (tenant, err) => console.error(tenant.name, err),
});
// results: [{ name, posted, skipped, failed }, ...]
```

**失敗の分離:** 1 テナントで `provider` / `build` / `sender` が throw しても、そのテナントを `failed` に数えて次へ進みます（原文のループ挙動を維持）。`provider` が `null` を返したテナントは `skipped`。

## 文言の差し替え

すべての `*Copy` は関数群＋定数で構成されます。ドメイン用語（例: Brand Firewall）はマーケ由来のためデフォルトで残していますが、config を渡せば全文差し替え可能です。

```ts
buildFirewallEvalPayload(tenant.name, run, {
  ...DEFAULT_FIREWALL_EVAL_COPY,
  heading: (emoji, name, at) => `${emoji} Quality Report — ${name} (${at})`,
});
```

## 出典

- `server/services/weeklyReportSlack.ts` (#1024)
- `server/services/executiveStatusSlack.ts` (#1034)
- `server/services/slackScenarioSummary.ts`
- `server/services/firewallEvalWeeklySlack.ts` (#1040)

DB アクセス（Supabase）・env 読み取り・feature flag 判定はアプリ側の責務として除外し、純粋なペイロード組み立てと実行ハーネスのみを収録しています。
