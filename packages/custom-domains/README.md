# @torihanaku/custom-domains

顧客が自社ドメインを持ち込める「BYOD カスタムドメイン」機能の汎用ライフサイクル実装です。
CNAME 検証 → SSL 証明書プロビジョニング → 稼働、までの状態遷移をストレージ非依存で提供します。
ホワイトラベル SaaS・マルチテナント SaaS で汎用的に使える機能であり、ブランディング設定（ロゴ・色等の CRUD）は本パッケージのスコープ外です。

## 状態遷移

```
pending → verified          （CNAME が期待ターゲットを向いた）
pending → failed            （CNAME 誤設定 / NXDOMAIN。error に理由を保存）
verified → ssl_provisioning （証明書発行を開始）
ssl_provisioning → active   （証明書 Ready・配信開始）
ssl_provisioning → error    （プロバイダエラー / タイムアウト）
```

## API 例

```ts
import {
  verifyCname,
  runCnameVerificationCron,
  runSslProvisioner,
  createGcloudProvisioner,
  createMemoryDomainStore,
} from "@torihanaku/custom-domains";

// 1) 単発の CNAME 検証
const r = await verifyCname("app.customer.example", "edge.your-saas.example");
// { domain, ok, resolved?, error? }  — error は "nxdomain" / "cname_mismatch: ..." 等

// 2) cron: pending 行を全件検証して verified / failed へ遷移
const store = createMemoryDomainStore(); // 実運用では DomainStore を自前 DB で実装
const summary = await runCnameVerificationCron({
  store,
  target: "edge.your-saas.example",
});

// 3) cron: verified → ssl_provisioning → active（1 回の実行で両フェーズ処理）
const results = await runSslProvisioner({
  store,
  provisioner: createGcloudProvisioner({ service: "my-cloud-run-service" }),
  notify: async (e) => console.warn("[domains]", e.type, e.payload), // Slack 等
});
```

## 注入ポイント

| 境界 | インターフェース | デフォルト |
|------|-----------------|-----------|
| DNS 解決 | `CnameResolver = (domain) => Promise<string[]>` | `node:dns` の `resolveCname`（遅延 import。edge では DoH 等を注入） |
| クラウド API | `DomainMappingProvisioner { create, describe }` | `createGcloudProvisioner()` = GCP Cloud Run `gcloud run domain-mappings`（出典実装。Cloudflare for SaaS / ACM 等に差し替え可） |
| サブプロセス | `SpawnImpl`（gcloud デフォルト内） | Bun ランタイムでは `Bun.spawn`、それ以外は `node:child_process`。タイムアウトで exit 124 |
| ストレージ | `DomainStore { listByState, update }` | なし（必須注入）。テスト・雛形用に `createMemoryDomainStore()` 同梱 |
| 通知 | `DomainEventNotifier`（best-effort、失敗は warn のみ） | なし（省略可） |
| キルスイッチ | `enabled?: () => boolean` | 常時有効 |

失敗時の挙動（出典どおり）: ストア読み取り失敗時の SSL cron は fail-closed（通知して throw、どのドメインにも触らない）。更新失敗も通知して throw。プロビジョナ失敗は該当ドメインのみ `error` へ遷移し通知。

## Runtime

Node 18+ / Bun。`createGcloudProvisioner` を使う場合は認証済みの `gcloud` CLI が必要（Cloud Run ジョブ等）。edge で使う場合は resolver と provisioner を注入してください。

## 出典

- dev-dashboard-v2 `server/lib/white-label/cname-verifier.ts`（#1340 WhiteLabel-3a）
- dev-dashboard-v2 `server/lib/white-label/ssl-provisioner.ts`（#1341 WhiteLabel-3b）
- `server/lib/white-label.ts` はブランディング設定 CRUD とパートナー関係管理のみだったため、ドメインライフサイクルには含めていません
- テストは `tests/white-label/{cname-verifier,ssl-provisioner}.test.ts` を移植
