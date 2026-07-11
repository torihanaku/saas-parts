# @torihanaku/cache

Redis（ioredis互換クライアント注入）＋インメモリMapフォールバックのキャッシュ層。TTL・プレフィックス一括無効化・ヒット/ミス統計・分散スライディングウィンドウレート制限つき。

## 主要API

```ts
import { createCache } from "@torihanaku/cache";

// インメモリのみ（Redisなし）
const cache = createCache();

// Redisあり（ioredisクライアントを呼び出し側で生成して注入）
import Redis from "ioredis";
const cache = createCache({
  redis: new Redis({ host: process.env.REDIS_HOST, lazyConnect: true }),
});

await cache.cacheSet("user:123:profile", { name: "A" }, 60_000); // TTLはms
const profile = await cache.cacheGet<{ name: string }>("user:123:profile");
await cache.cacheDel("user:123:profile");
const removed = await cache.cacheInvalidatePrefix("user:123"); // SCAN+DELで一括削除

// 分散レート制限（Redisのsorted set / メモリフォールバック）
const rl = await cache.slidingWindowRateLimit("rl:192.0.2.1:read", 100, 60_000);
if (!rl.allowed) return new Response("Too Many Requests", { status: 429 });

cache.getCacheStats();   // { backend, hits, misses, hitRate, prefixBreakdown, ... }
cache.isRedisConnected();
cache.getRedis();        // 原子的操作が必要なモジュール向け（未接続ならnull）
cache.dispose();         // メモリ掃除タイマー停止（テストやシャットダウン時）
```

## 依存

- `ioredis`（**optional peerDependency**）— 本パッケージはioredisをランタイムでも型でも一切importしない。ローカル定義の `RedisLike` インターフェース（get/set/del/scan/multi/zrem/status/on）にioredisの `Redis` インスタンスが構造的に適合する。

## 設定ポイント（何を注入するか）

- `redis`: ioredis互換クライアント（接続設定・lazyConnect等は呼び出し側の責任）。省略でインメモリ動作。クライアントの `error` イベントで自動的にメモリへフォールバック（元実装と同じ挙動）
- `cleanupIntervalMs`: 期限切れメモリエントリの掃除間隔（デフォルト60秒、`false`で無効。タイマーは `unref` 済み）
- 元実装のプロダクト固有定数 `CACHE_TTL` / `CACHE_KEYS`（dashboard:*）は移植時に削除。キー命名は `prefix:sub:rest` 形式にするとプレフィックス別統計が効く

## 想定ランタイム

any（Node/Bun/エッジ。Redisを注入する場合はそのクライアントのランタイム要件に従う）

## 出典

dev-dashboard-v2 `/cache.ts`（リポジトリルート。テストは `tests/cache.test.ts` から移植）。
