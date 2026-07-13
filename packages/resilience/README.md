# @torihanaku/resilience

## 用途

外部 API 呼び出しの信頼性を上げるレジリエンス基本部品 3 点セット（指数バックオフ付きリトライ／サーキットブレーカー／TTL 付き LRU キャッシュ）。

## 主要 API

```ts
import { RetryWithBackoff, CircuitBreaker, CircuitOpenError, LRUCache } from "@torihanaku/resilience";

// 1) リトライ（指数バックオフ + ジッター）
const retry = new RetryWithBackoff({
  maxRetries: 3,        // 初回を含む最大試行回数
  baseDelayMs: 1_000,   // 1s → 2s → 4s ... と倍々
  maxDelayMs: 30_000,   // 上限キャップ
  jitter: 0.2,          // ±20% ランダム化（thundering herd 回避）
  shouldRetry: (err) => !(err instanceof CircuitOpenError), // 任意: リトライ可否の判定
  onRetry: (err, attempt, delayMs) => console.warn(`retry #${attempt} in ${delayMs}ms`),
});
const data = await retry.execute(() => fetchExternalApi());

// 2) サーキットブレーカー（closed → open → half-open）
const breaker = new CircuitBreaker({
  failureThreshold: 5,     // 連続 5 回失敗で open
  resetTimeoutMs: 60_000,  // 60 秒後に half-open でプローブ許可
  onStateChange: (from, to) => console.warn(`circuit: ${from} → ${to}`),
});
try {
  await breaker.execute(() => fetchExternalApi());
} catch (e) {
  if (e instanceof CircuitOpenError) { /* fail-fast: フォールバックへ */ }
}
breaker.getState();               // "closed" | "open" | "half-open"
breaker.getConsecutiveFailures(); // メトリクス用
breaker.reset();                  // 手動リセット

// 3) TTL 付き LRU キャッシュ（グレースフルデグラデーション用）
const cache = new LRUCache<Result>({ maxSize: 500, ttlMs: 300_000 });
cache.set("key", value);              // デフォルト TTL
cache.set("key2", value, 60_000);     // エントリ単位の TTL 上書き
cache.get("key");                     // 期限切れは自動削除して undefined
cache.findSimilar((key, v) => v.score > 50); // 述語での線形探索（期限切れを掃除しながら）
```

## 依存

なし（peerDeps ゼロ、標準ライブラリのみ）。

## 注入ポイント

- `RetryOptions.shouldRetry` / `RetryOptions.onRetry` — リトライ可否の判定とログ出力を外から注入
- `CircuitBreakerOptions.onStateChange` — 状態遷移の通知（メトリクス/アラート連携）
- すべてコンストラクタの `Partial<Options>` で上書き可能（デフォルトは元実装と同一）

## 想定ランタイム

Node.js / Bun / ブラウザ（`setTimeout` / `Date.now` / `Map` のみ使用。Node 固有 API なし）。

## 出典

`実運用SaaS/server/lib/resilience.ts`（テストは `tests/resilience.test.ts` から移植し、fake timers のケースを追加）。
