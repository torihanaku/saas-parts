# @torihanaku/cpa-guardrail

CPA 閾値監視 → 広告自動停止「提案」パッケージ。実運用SaaS（マーケ運用ダッシュボード製品）の CPA ガードレールを移植・自己完結化したものです。

## これは何か（正直な適用範囲）

**有料広告運用に特化したマーケ製品固有** のロジックです。日次の広告インサイト（`spend` / `conversions`）から CPA を算出し、`目標CPA × 1.5`（既定）を超えたキャンペーンについて **一時停止の提案** を作成します。

重要な設計方針（元コードの "Lesson 3"）：**このパッケージは決して自動停止しません。** 提案は必ず人手承認を経てから、注入された `pause` コールバック経由でプラットフォーム API に反映されます。

## 移植にあたっての切り離し（依存の注入化）

| 元の依存 | 本パッケージでの扱い |
| --- | --- |
| Supabase (`dd_ad_insights` / `dd_guardrail_proposals` / `teams`) | `GuardrailStore` インターフェース（`InMemoryGuardrailStore` 同梱） |
| Slack `chat.postMessage`（`SLACK_BOT_TOKEN`） | `NotifyFn` として注入。秘匿トークンは持たない |
| 広告停止の実行（Nango `proxyRequest`） | `decideGuardrailProposal` の `pause` コールバックとして注入 |
| ハードコードの `TARGET_CPA = 50` | `GuardrailConfig.targetCpa` / `thresholdMultiplier` |

`process.env`・DB・秘匿情報は一切持ちません。

## 使い方（概略）

```ts
import { runCpaGuardrailCheck, decideGuardrailProposal, InMemoryGuardrailStore } from "@torihanaku/cpa-guardrail";

const store = new InMemoryGuardrailStore({ tenantIds, insights });
await runCpaGuardrailCheck({
  store,
  config: { targetCpa: 50, thresholdMultiplier: 1.5 },
  notify: (tenantId, msg) => slack.post(tenantId, msg),
});

// 人手承認後にのみ停止を実行
await decideGuardrailProposal(proposal, "approved", {
  pause: (p) => adsApi.pauseCampaign(p.campaign_id),
});
```

## 残課題

- 目標 CPA はテナント共通の固定値。キャンペーン別・広告グループ別の目標 CPA には未対応（元コードと同じ制約）。
- 監視対象メトリクスは CPA のみ。ROAS 等への拡張は未実装。
