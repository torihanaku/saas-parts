# @torihanaku/okr-service

OKR（Objectives & Key Results）の CRUD・進捗計算・データソース連動の自動進捗更新を行うサービス。

## 主要API例

```ts
import {
  OkrService,
  InMemoryOkrStore,
  InMemoryOkrMetricsStore,
  createDefaultAutoSourceProviders,
  calculateProgress,
} from "@torihanaku/okr-service";

const store = new InMemoryOkrStore(); // 本番は DB 実装の OkrStore を注入
const metrics = new InMemoryOkrMetricsStore();

const okr = new OkrService({
  store,
  // 自動更新ソース（ga4:sessions / crm:mqls / crm:contacts / deals:pipeline / mailchimp:subscribers）
  // 元実装のテーブル参照ロジックは OkrMetricsStore 経由で忠実に再現
  providers: createDefaultAutoSourceProviders(metrics),
});

await okr.upsertObjective({ project_id: "p1", title: "トラフィック成長", quarter: "2026-Q2", progress: 0 });
await okr.upsertKeyResult({ objective_id: "obj-1", title: "月間セッション", target: 10000, current: 0, unit: "sessions", auto_source: "ga4:sessions" });

const objectives = await okr.getObjectives("p1", "2026-Q2"); // KR 付き
const updated = await okr.autoUpdateProgress("p1");          // 連動KRを更新し progress を再計算
await okr.deleteObjective("obj-1");                          // KR→Objective の順にカスケード削除

calculateProgress(keyResults); // KR達成率の平均（各KRは100%でキャップ）
```

## 依存
- peerDependencies: なし（ランタイム依存ゼロ）

## 注入ポイント
- `OkrStore` — dd_okr_objectives / dd_okr_key_results 相当の永続化（クエリ形状を型付きメソッドで写像）
- `AutoSourceProviderMap` — auto_source 文字列 → 現在値リゾルバ。任意ソースを追加可能
- `OkrMetricsStore` — 既定プロバイダが読むメトリクス（元実装の Supabase クエリ形状を写像）
- `now` / `uuid` — 時刻・ID生成（テスト決定性用、既定は `new Date()` / `crypto.randomUUID()`）

## 元実装からの変更点
- Supabase 直接呼び出し（supabaseGet/Insert/Patch/DELETE fetch）→ `OkrStore` 注入
- `resolveAutoSource` の内蔵5ソース → `createDefaultAutoSourceProviders(metrics)` に抽出（ロジックは同一）
- エラー時に null を返して静かにスキップする挙動は維持
