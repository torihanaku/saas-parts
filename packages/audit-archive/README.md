# @torihanaku/audit-archive

## 用途

1年（設定可）より古い監査イベントをオブジェクトストレージへ JSONL としてコールドアーカイブし、元ストアにアーカイブ済みマークを付けるジョブ本体。スケジューリング非依存の純粋な関数で、GCS SDK や DB クライアントは一切 import しない（構造的インターフェースで注入）。

## 処理ルール（元ジョブのまま）

1. `occurred_at < now - retentionYears` かつ未アーカイブのイベントを最大 `batchLimit`（既定1000）件取得
2. `tenant_id / year / month` でグループ化
3. グループごとに JSONL（1行1イベント・末尾改行あり）を `<tenant_id>/<year>/<month>/events_<timestamp>.jsonl` へ書き出し（タイムスタンプ付きなので衝突せず並列実行も安全）
4. 書き出し成功後、各イベントに `markArchived(id, path)` を記録
5. エラーは throw せずログに落とす（スケジューラーを巻き込まない）

## 主要API（コード例）

```ts
import { archiveAuditEvents } from "@torihanaku/audit-archive";

const result = await archiveAuditEvents({
  // 元実装では Supabase PostgREST:
  //   fetch → audit_events?occurred_at=lt.<cutoff>&archived_to_gcs=eq.false&limit=1000
  //   mark  → PATCH { archived_to_gcs: true, gcs_archive_path: path }
  source: {
    fetchUnarchived: (cutoffIso, limit) => db.fetchOldAuditEvents(cutoffIso, limit),
    markArchived: (id, path) => db.markAuditEventArchived(id, path),
  },
  // 元実装では GCS bucket。null を渡すと skip（bucket未設定環境の無害化）
  storage: bucketName
    ? { put: (path, content) => gcsBucket.file(path).save(content) }
    : null,
  logger: { info: (scope, msg) => log.info(scope, msg), error: (scope, e) => log.error(scope, e) },
  retentionYears: 1, // 既定 1
  batchLimit: 1000,  // 既定 1000
});
// result: { skipped, archivedCount, groupCount }
```

## スケジューラーへの配線

このパッケージはあえてスケジューラーを import しない。日次実行にするには呼び出し側で `@torihanaku/job-scheduler` 等に登録する:

```ts
scheduler.register("archive-audit-events", { cron: "0 3 * * *" }, () =>
  archiveAuditEvents({ source, storage, logger })
);
```

## 設計メモ

- イベント型 `ArchivableAuditEvent` は `id / tenant_id / occurred_at` のみ必須（残りは index signature）。JSONL にはイベント全フィールドがそのまま書かれる
- 1回の実行は最大 `batchLimit` 件。積み残しは次回実行で処理される（元実装と同じ設計）
- 戻り値のサマリ（`archivedCount` 等）は移植時の追加。元実装は void だったが、テスト・監視用に集計を返すようにした（挙動には影響なし）
- ランタイム: 任意（Node/エッジ）。外部依存ゼロ・env 読み取りなし

## 出自

`dev-dashboard-v2/server/jobs/archive-audit-events.ts`（88 LOC）。`@google-cloud/storage` 直参照 → `ObjectStorage { put }` 注入、`supabaseGet/supabasePatch` → `AuditEventSource` 注入、`env.GCS_AUDIT_ARCHIVE_BUCKET` ゲート → `storage: null` で skip、に変換。グループ化・JSONL・パス形式・エラー握りつぶしはロジック同一。テストは `tests/agency-audit-archive.test.ts` の3ケースを移植し、グループ化/JSONL形式/失敗時の未マーク保証を追加。
