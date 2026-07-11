# @torihanaku/job-scheduler

## 用途

名前付きバックグラウンドジョブをインターバル実行する汎用スケジューラ（登録・tick ループ・状態追跡・手動実行・任意の永続化と完了フック）。

## 主要API

```ts
import {
  createJobScheduler,
  InMemoryJobStateStore,
  type JobStateStore,
  type JobCompletionEvent,
} from "@torihanaku/job-scheduler";

const scheduler = createJobScheduler({
  store: new InMemoryJobStateStore(),          // 省略可（省略時はメモリ内のみ・永続化なし）
  onComplete: (e: JobCompletionEvent) => {     // 省略可（各実行完了後に fire-and-forget で呼ばれる）
    console.log(e.name, e.status, e.durationMs);
  },
  checkIntervalMs: 30_000,                     // tick 間隔（デフォルト 30秒）
  initialDelayMs: 5_000,                       // start() 後の初回永続化+初回 tick までの遅延（デフォルト 5秒）
});

// ジョブ登録（この時点では実行されない。初回実行は 登録時刻 + intervalMs 以降の tick）
scheduler.registerJob({
  name: "cleanup",
  description: "古いデータの掃除",
  intervalMs: 86_400_000, // 24h
  handler: async () => { /* ... */ },
  enabled: true,
});

scheduler.start();                             // tick ループ開始
scheduler.getJobStates();                      // 監視用スナップショット（lastRunAt / nextRunAt / runCount / errorCount ...）
await scheduler.triggerJob("cleanup");         // 手動実行（run-now）。実行中なら { ok:false, error:"...already running" }
scheduler.setJobEnabled("cleanup", false);     // 有効/無効の切替（store へも反映）
scheduler.stop();                              // 停止
```

## 依存

なし（TypeScript のみ。実行時依存ゼロ、peerDependencies なし）。

## 設定ポイント（何を注入するか）

- `store?: JobStateStore` — 状態の永続化先。元実装の Supabase テーブル `dd_scheduled_jobs` への操作をそのままインターフェース化したもの:
  - `update(name, row)` … 既存行の更新（`false` を返すと `insert` にフォールバック）
  - `insert(row)` … 新規行の挿入（`created_at` 付き）
  - `loadEnabled(name)` … 実行直前に enabled フラグを再読込（`false` ならジョブをローカルでも無効化してスキップ。`null` は「行なし」扱いで実行続行）
  - 行の形は `PersistedJobRow`（snake_case を維持しているため、既存の `dd_scheduled_jobs` 互換テーブルにそのまま書ける）。省略時は永続化スキップ＋enabled 再読込なし（元実装で DB が空応答のときと同じ挙動）
- `onComplete?: (event) => void | Promise<void>` — 各ジョブ実行完了（成功/失敗とも）後に呼ばれるフック。Webhook 通知や Slack 通知はここに差し込む。例外を投げてもスケジューラには影響しない
- `checkIntervalMs` / `initialDelayMs` — 元実装の 30秒 tick / 5秒初期遅延を変更したい場合のみ

エラーハンドリングの挙動（元実装を踏襲）: handler が throw すると `lastStatus="error"`・`errorCount` 加算・`lastError` 記録のうえ次回 `nextRunAt = 実行完了時刻 + intervalMs` で継続（自動リトライ/自動無効化はしない。無効化は store の `loadEnabled` か `setJobEnabled` で行う）。

## 想定ランタイム

any（`setInterval` / `setTimeout` / `Date` / `console` のみ使用。Node / Bun / ブラウザで動作）

## 出典

- 元実装: `dev-dashboard-v2/server/lib/job-scheduler.ts`（958行のうちコア約240行を移植。約40件のプロダクト固有ジョブ登録と Supabase 直結コードは削除）
- 元テスト: `dev-dashboard-v2/tests/job-scheduler.test.ts`
