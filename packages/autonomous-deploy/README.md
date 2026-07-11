# @torihanaku/autonomous-deploy

コンテンツ等の **自律デプロイオーケストレーション**。承認済み submission を複数チャネル（SEO / CMS / SNS / 広告…）へ順に段階実行し、各試行を構造化タイムラインに記録、後段が失敗したら完了済みステップを compensating rollback で巻き戻す。dev-dashboard-v2 `server/lib/autonomous-deploy/` の移植。

## 特徴

- **アダプタ→レジストリ注入**: チャネル実装は `DeployAdapter` を満たし、`AdapterRegistry`（target → adapter）に登録する。SEO アダプタ（`SeoAdapter`）を **実装例として同梱**。
- **ストア注入式（`DeployStore`）**: submission 取得と `deploy_log` 永続化を抽象化。`InMemoryDeployStore` を同梱。
- **承認ゲート注入**: 組込みゲートは `submission.status === "approved" && auto_deploy` を確認（`force: true` で回避）。実行可否の feature flag は `enabled` 述語で注入。
  - より本格的な多段承認ワークフローは **@torihanaku/kit-approval-workflow が充足** する。本パッケージは kit-approval-workflow を **import しない**（疎結合）。承認済み submission を渡す・`enabled` を承認状態に紐付ける、のいずれかで連携する。
- **監査・通知も注入式**: `audit`（監査ログ）、`notify`（Slack 等）。省略時 no-op。
- **`process.env` 非依存 / シークレット非同梱 / fetch も注入**。

## 使い方

```ts
import {
  runAutonomousDeploy,
  InMemoryDeployStore,
  SeoAdapter,
  type AutonomousDeployConfig,
} from "@torihanaku/autonomous-deploy";

const seo = new SeoAdapter({
  proxyRequest: myNangoProxy,          // (tenantId, platform, connId, method, endpoint, body) => Promise<obj|null>
  loadTargets: async (tenantId) => await readSeoTargets(tenantId),
  enabled: () => featureFlags.autonomousDeploy,
});

const config: AutonomousDeployConfig = {
  store: new InMemoryDeployStore(await loadSubmissions()),
  adapters: { seo /*, cms, sns, ad */ },
  enabled: () => featureFlags.autonomousDeploy,
  audit: (tenantId, entry) => writeAudit(tenantId, entry),
  notify: async ({ submissionId, status, steps, failureMessage }) => {
    await postSlack(`Autonomous deploy ${status} for ${submissionId}`);
  },
};

const result = await runAutonomousDeploy(config, submissionId, {
  targets: ["seo", "cms", "sns", "ad"],  // 省略時 = 全 4 チャネル
  triggeredBy: "approval-event",
  force: false,                          // true で承認/flag ゲートを回避（手動トリガー用）
});
// result.status: "success" | "partial" | "failed" | "skipped"
// result.steps: DeployStep[]（deploy_log に永続化済み）
```

## 実行フロー

1. `enabled()` && `!force` → false なら `skipped(feature_flag_disabled)`。
2. submission 取得。無ければ throw（`submission_not_found`）。
3. `status !== "approved"` → `skipped`。`!auto_deploy && !force` → `skipped(auto_deploy_not_opted_in)`。
4. `targets` を順に実行。未登録チャネルは `skipped(adapter_not_registered)`。成功は `completedSteps` に積む。
5. いずれかが throw したら中断し、**完了ステップを逆順に rollback**（`rolled_back`）。
6. `deploy_log` を永続化 → `audit` → `notify`。
7. 総合ステータス: 失敗あり=`failed` / 成功あり=`success` / それ以外=`partial`。

## 独自アダプタを足す

```ts
import type { DeployAdapter, SubmissionRecord, DeployStep } from "@torihanaku/autonomous-deploy";

const cms: DeployAdapter = {
  target: "cms",
  async run(submission: SubmissionRecord) {
    // 成功: { status: "success", detail } / 未設定: { status: "skipped", reason } / hard fail: throw
    return { status: "success", detail: { externalId: "post-123" } };
  },
  async rollback(submission: SubmissionRecord, step: DeployStep) {
    // step.detail.externalId を削除するなど。巻き戻せない場合も no-op で実装。
  },
};
```

## タイムライン

`normalizeDeployTimeline(rows, filters?)` は submission 行の `deploy_log` を新しい順のフラットな `DeployTimelineItem[]` に整形（不正な target/status/日付は除外、`durationMs` 算出）。`summarizeDeployTimeline(items)` で success/failed/skipped/rolledBack を集計。純粋関数なので保存層に依存しない。

## 移植メモ

- `getSupabaseAdmin`（submission 取得・deploy_log 更新）→ `DeployStore`。
- ハードコードの `ADAPTER_REGISTRY`（seo/cms/sns/ad を new）→ 注入 `adapters` レジストリ。未登録チャネルは `skipped(adapter_not_registered)` として truthful に記録（原典は全チャネル固定だったため未登録ケースを明示化）。
- `isEnabled("autonomousDeploy")` → `enabled` 述語。`logAuditSystem` → `audit`。Slack（env + fetch）→ `notify`。
- SEO アダプタの `proxyRequest`（Nango）/ target 読み出し / feature flag を `SeoAdapterConfig` に注入。`buildSeoIndexingPayload` と URL 正規化は原典のまま。
- `timeline.ts` / `types.ts` はロジック不変で移植。
