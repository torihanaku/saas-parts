# @torihanaku/live-state

ポーリング + SSE ハイブリッドのライブ状態フック。固定間隔のポーリングを土台（フォールバック）にしつつ、SSE の `state-change` イベントを受けたらデバウンス付きで即時再取得する。SSE 非対応・接続断でもポーリングが生き続けるため、リアルタイム性と堅牢性を両立する。

移植元: dev-dashboard-v2 `src/hooks/useLiveState.ts`（104 LOC）。

## 使い方

```tsx
import { useLiveState } from "@torihanaku/live-state";

function Dashboard() {
  // 60秒間隔ポーリング + SSEによる即時更新
  const state = useLiveState(60000, {
    // すべて省略可。既定は fetch / EventSource ベース
    endpoints: {
      state: "/api/state",                   // ポーリング対象（既定値）
      stream: "/api/notifications/stream",   // SSEストリーム（既定値・元実装は通知ストリームに相乗り）
    },
    debounceMs: 300,                 // SSEイベント→再取得のデバウンス（既定値）
    stateChangeEvent: "state-change" // 再取得トリガーのSSEイベント名（既定値）
  });

  state.tasks;      // Record<string, { status, completedAt?, updatedAt? }>
  state.characters; // Record<string, { status, progress, currentTask, updatedAt }>
  state.history;    // HistoryEntry[]
  state.sessions;   // SessionInfo[]
  state.updatedAt;  // string
}
```

## 動作仕様（元実装準拠）

- 初回フェッチは effect 外で即時実行（マウント直後の空白時間を減らす）。
- `intervalMs` ごとにポーリング（既定 60000ms）。
- SSE ストリームの `state-change`（名前付きイベント）を受けると 300ms デバウンスで再取得。連続イベントは1回のフェッチにまとまる。
- `EventSource` が使えない / stream 生成が throw した場合は黙ってポーリングのみで継続。
- フェッチ失敗は握りつぶし、直前の状態を保持。
- アンマウント時に interval / デバウンスタイマー / ストリームをすべて解放。

## 注入ポイント

`api`（`LiveStateApi`）を丸ごと差し替えるか、既定実装のファクトリに `fetcher` / `createEventSource` を渡す:

```ts
import { createDefaultLiveStateApi } from "@torihanaku/live-state";

const api = createDefaultLiveStateApi({
  fetcher: authedFetch,                          // 認証ヘッダー付き fetch
  createEventSource: (url) => new EventSource(withToken(url)), // トークン付きSSE
});
```

サーバー側は「`{ tasks, characters, history, sessions, updatedAt }` を返す GET エンドポイント」と「`state-change` イベントを流す SSE」があれば何でもよい（欠けたフィールドは空値に正規化される）。SSE 側は `@torihanaku/notifications` のサーバーハンドラ（`sseClients` に対して `event: state-change` をブロードキャスト）と組み合わせられる。

## peerDependencies

- `react >= 18`
