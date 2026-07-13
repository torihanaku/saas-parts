# @torihanaku/deployment-snapshot

## 用途

デプロイ前にテナントの現況状態をスナップショットとして退避し、1クリックロールバック時にその復元判断を decision log（監査証跡）へ記録する契約（capture / restore contracts）。何を退避するか・どこへ置くか・どう記録するかは全て構造的インターフェースで注入する。

## 主要API（コード例）

```ts
import { createDeploymentSnapshot } from "@torihanaku/deployment-snapshot";

const snapshot = createDeploymentSnapshot({
  // 何をスナップショットするか（例: brand DNA / パフォーマンス指標の現況行）
  stateSource: {
    fetchState: async (tenantId) =>
      db.from("dd_brand_dna_snapshots").select("*").eq("tenant_id", tenantId).limit(100),
  },
  // どこへ置くか（GCS/S3等）。省略すると元実装同様アップロードはシミュレート
  //（キー生成＋ログのみ）
  snapshotStore: { put: async (key, content) => bucket.file(key).save(content) },
  // ロールバックの監査証跡
  decisionLog: { insert: async (entry) => db.from("dd_decision_log").insert(entry) },
  warn: (m) => logger.warn(m), // 省略時 console.warn
});

// デプロイ直前に呼ぶ → snapshots/<tenantId>/<deployId>-<ts>.json 形式のキーを返す
const snapshotKey = await snapshot.capturePreDeploySnapshot(tenantId, deployId);

// 1クリックロールバック時。decision log に
// { decision_type: "stop", source: "manual", resource_type: "snapshot", ... } を記録
await snapshot.rollbackFromSnapshot(tenantId, snapshotKey);
```

## 責務境界（重要）

- **本パッケージ**: デプロイ単位の「事前状態スナップショット＋復元判断の記録」という汎用契約のみ
- **ai-agent kit（`kit-ai-agent`）側**: エージェントアクション単位のロールバック（`rollback_strategy: delete | unpublish | revert | cancel` によるアクション別の外部リソース巻き戻し。元実装 `server/lib/agent/rollback-service.ts`）は **含めない**。あちらはアクションのステータス遷移と戦略ディスパッチが本体であり、汎用スナップショットとは別レイヤー
- 元リポの `rollbackManager.ts`（capture→rollback のオーケストレーション薄層）は 20 LOC のグルーなので移植対象外。必要なら呼び出し側で 2 メソッドを順に呼ぶだけでよい

## 設計メモ

- 元実装の `rollbackFromSnapshot` は状態の実復元まではせず decision log 記録のみ（1-click rollback の監査契約）。実データ復元は snapshotStore から JSON を読み戻す処理を呼び出し側で足す
- キー形式 `snapshots/<tenantId>/<deployId>-<epochMs>.json` は元実装のまま
- ランタイム: 任意（Node/エッジ）。外部依存ゼロ・env 読み取りなし

## 出自

`実運用SaaS/server/jobs/snapshot.ts`（43 LOC）。Supabase admin クライアント直参照 → `SnapshotStateSource` / `DecisionLogStore` 注入に変換。シミュレートだった GCS/S3 アップロードは省略可能な `SnapshotStore` として実装可能にした。
