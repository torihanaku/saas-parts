# @torihanaku/kit-devops-metrics

開発組織メトリクス（DORA）とデプロイ運用のための汎用コアキット。
`実運用SaaS` の `dora` / `deploy-*` / `git-workspace` / `autonomous-deploy`
から抽出し、GitHub API・Supabase・Slack への直接依存をすべて **注入インターフェース**
に置き換えて自己完結にしたものです。

- GitHub REST API → `GitProvider` インターフェース（fetch ベースの既定実装 `createGitHubProvider` 同梱）
- 永続化（Supabase）→ 注入 store（`SubmissionStore`、`InMemoryGitWorkspaceStore`）
- Slack 通知・監査ログ → 注入コールバック（`DeployNotifier` / `AuditLogger`）
- DORA の計算式は元実装 verbatim（ゴールデンテストで固定）

外部依存なし（`@torihanaku/*` を import しない・`process.env` / supabase を参照しない）。
クライアントフックは `react`（>=18）を peer に持ちます。

## 収録内容

| モジュール | 役割 |
|-----------|------|
| `dora.ts` | DORA 4 指標（デプロイ頻度・リードタイム・変更失敗率・MTTR）計算。純関数 `computeDoraMetrics` と provider 版 `calculateDoraMetrics` |
| `deployHealth.ts` | デプロイ到達率（`getDeployReach`）とサイレント障害検知（`getSilentFailures`） |
| `deployTimeline.ts` | `deploy_log` の正規化・集計（純関数） |
| `deployOrchestrator.ts` | デプロイオーケストレーションコア。承認済み submission をアダプタレジストリで順に実行し、失敗時は逆順ロールバック |
| `deployControl.ts` | ステージング→本番昇格の状態取得・トリガー（5分クールダウン）・Issue CRUD |
| `gitProvider.ts` | `GitProvider` ポートと GitHub REST 既定実装 |
| `gitWorkspace.ts` | `git status --porcelain` パース＋最新状態を保持するインメモリ store |
| `client/useGitHub.ts` | コミット / ワークフローをポーリングする React フック（REPOS はハードコードせず引数化） |

## 使い方

### DORA メトリクス

```ts
import { createGitHubProvider, calculateDoraMetrics } from "@torihanaku/kit-devops-metrics";

const provider = createGitHubProvider({ token: myGithubToken });
const repos = [
  { owner: "acme", name: "web", label: "Frontend" },
  { owner: "acme", name: "api", label: "Backend" },
];
const metrics = await calculateDoraMetrics(repos, provider);
// metrics.level === "Elite" | "High" | "Medium" | "Low"
```

計算式（元実装のまま）:
- **DORA レベル判定** — Elite: DF>7/週 & LT<1h & CFR<5% & MTTR<1h、High: DF>1/週 & LT<24h & CFR<15% & MTTR<24h、Medium: DF>0.25/週 & LT<168h & CFR<30% & MTTR<168h、それ以外 Low
- **リードタイム / MTTR** の `median` / `p90` は Actions の平均で近似（真のパーセンタイルには PR 単位データが必要）

### デプロイオーケストレーション

```ts
import { runAutonomousDeploy } from "@torihanaku/kit-devops-metrics";

const result = await runAutonomousDeploy(submissionId, {
  store,                       // SubmissionStore（getById / updateDeployLog）
  registry: { seo, cms },      // DeployTarget -> DeployAdapter（マーケ用アダプタは注入）
  defaultTargets: ["seo", "cms"],
  isFeatureEnabled: () => true,
  audit: (entry) => { /* 監査ログ */ },
  notify: (r) => { /* Slack 等 */ },
}, { triggeredBy: "admin", force: true });
```

### クライアントフック

```tsx
import { useGitHubCommits } from "@torihanaku/kit-devops-metrics";

const { commits, loading } = useGitHubCommits({
  repos: [{ owner: "acme", name: "web", label: "Web" }],
  apiBase: "/github-api",   // GitHub API プロキシのベースパス
});
```

## データスキーマ（参考）

元実装は Supabase に永続化していました。キットは store 経由なので任意の DB を使えますが、
既存互換の Postgres スキーマは以下の通りです（migration は同梱しません）。

### `dd_submissions`（デプロイオーケストレーション）

```sql
ALTER TABLE dd_submissions
  ADD COLUMN deploy_log JSONB NOT NULL DEFAULT '[]'::jsonb, -- DeployStep[]
  ADD COLUMN auto_deploy BOOLEAN NOT NULL DEFAULT false;    -- 自律デプロイ opt-in
```

`SubmissionRecord` は `{ id, tenantId, title, contentText, status, autoDeploy, deployLog }`。
`deploy_log` の各要素が `DeployStep`（`{ target, status, startedAt, finishedAt?, detail?, error? }`）。

### `deploy_checklist`（deployControl のチェックリスト、任意）

```sql
CREATE TABLE deploy_checklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  "order" INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

（このキットはチェックリストの永続 CRUD 自体は含みません。昇格制御ロジックのみ収録。）

### サイレント障害検知

`getSilentFailures(checks, lastActivityOf)` の `lastActivityOf` に、各チェック対象テーブルの
最終行タイムスタンプを返す関数を渡します（元実装は
`select <column> order <column>.desc limit 1` 相当）。

## テスト

```bash
npx tsc --noEmit -p packages/kit-devops-metrics/tsconfig.json
npx vitest run packages/kit-devops-metrics
```

DORA はゴールデンフィクスチャ（固定時刻・既知の run 集合）で計算値を固定しています。
