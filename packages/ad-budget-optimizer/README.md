# @torihanaku/ad-budget-optimizer

広告予算の最適化・リアルタイム再配分パッケージ。実運用SaaS（マーケ運用ダッシュボード製品）の広告予算まわりのロジックを移植・自己完結化したものです。

## これは何か（正直な適用範囲）

このパッケージは **有料広告運用（Meta / Google / TikTok / LinkedIn）に特化したマーケ製品固有** のドメインロジックです。汎用の「予算管理」ではありません。前提として、日次の広告インサイト（`spend_jpy` / `revenue_jpy` / `conversions` / `daily_budget_jpy`）が手元にあり、CPA・ROAS を基準に予算を動かす運用を想定しています。次のような用途向けです。

- CPA スパイク / ROAS ドロップの検知 → 予算再配分の**提案**（既定は propose-only。自動実行は多重ガードを全て満たしたときだけ）
- 安全チェック（日次シフト上限%・絶対額上限・クールダウン）付きの実行
- 各広告プラットフォーム API への入札・予算変更の反映
- ROI 予測・コスト予測・エグゼクティブレポート生成（LLM 経由）

## 移植にあたっての切り離し（依存の注入化）

元コードは Supabase / Nango / 社内 Claude クライアント / feature-flags / `process.env` に直結していました。本パッケージではこれらを **すべて注入** に変え、`@torihanaku/*` への依存・`process.env`・DB を持ちません。

| 元の依存 | 本パッケージでの扱い |
| --- | --- |
| Nango `proxyRequest` | `ProxyFn` として注入。3プラットフォームのアダプタ実装同梱 |
| Supabase | `ReallocationStore` インターフェース（`InMemoryReallocationStore` 同梱） |
| `isEnabled(flag)` | `FeatureGate` / `isEnabled()` として注入 |
| Claude API クライアント | `LlmClient`（`generateJson` / `generateText`）として注入 |
| `env.*_DRY_RUN` | executor config の `dryRun` フラグ |
| React `api` クライアント | `ApiClient` として注入（`src/client/`） |

秘匿情報は含みません。テストのプロキシ・ストア・LLM はすべてインメモリのフェイクです。

## 構成

- `adapters/` — `AdPlatformAdapter` インターフェースと Google / Meta / TikTok の予算アダプタ、予算・入札の低レベル executor
- `reallocator.ts` — トリガー検知・安全チェック・提案・記録・実行のコア
- `detection-cron.ts` — 全テナント走査での定期検知（idempotency 付き）
- `suggest-allocation.ts` — ROAS ベースの貪欲な予算配分ヒューリスティック
- `roi-predictor.ts` / `optimizer.ts` — LLM 注入による ROI 予測・コスト予測・レポート生成
- `store.ts` — 永続化境界（インメモリ実装同梱）
- `client/useBudgetReallocations.ts` — React フック（`ApiClient` 注入）

## 使い方（概略）

```ts
import {
  detectReallocationTriggers,
  proposeReallocation,
  executeReallocation,
  InMemoryReallocationStore,
  createMetaAdsAdapter,
} from "@torihanaku/ad-budget-optimizer";

const store = new InMemoryReallocationStore({ adInsights, safetyLimits });
const triggers = await detectReallocationTriggers(store, tenantId);
// proposal → 人手承認 → 実行（安全チェックが全て green のときのみ）
```

## 残課題

- 予算再配分の 2 レグ（source 減額 / target 増額）はアトミックではなく、source レグのみ実行して target は propose-only のまま（元コード同様）。補償トランザクションは未実装。
- LLM プロンプトは元の GCP コスト最適化文言を汎用寄りに調整済みだが、広告コスト特化への再チューニング余地あり。
