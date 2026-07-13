# @torihanaku/rate-limiter

## 用途

分散スライディングウィンドウ方式のレートリミッター（ティア別上限・IPブロックリスト/許可リスト・違反追跡・段階的バックオフ・統計API付き。Redis互換クライアント注入＋インメモリフォールバック内蔵）。

## 主要API

```ts
import {
  RateLimiter,
  rateLimitHeaders,
  getRateLimitKey,
  DEFAULT_RATE_LIMIT_TIERS,
} from "@torihanaku/rate-limiter";

// クライアント未注入 → インメモリで動作（単一インスタンス向け）
const limiter = new RateLimiter({
  // endpointRules は既定で空。プロジェクト固有のパスは設定で渡す
  endpointRules: {
    authExactPaths: ["/api/login"],
    authPathPrefixes: ["/auth/", "/api/sso"],
    essentialReadExactPaths: ["/api/user/me", "/api/version"],
    essentialReadPathPrefixes: ["/api/notifications/stream"],
  },
});

// リクエスト処理（Fetch API の Request を想定）
async function handle(req: Request) {
  if (limiter.shouldBypassRateLimit(req)) return; // 既定では常に false

  const key = getRateLimitKey(req); // Bearer/セッションのハッシュ or クライアントIP
  const tier = limiter.getEndpointTier(req.method, new URL(req.url).pathname);
  const result = await limiter.checkRateLimit(key, tier);

  if (!result.allowed) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: rateLimitHeaders(result), // X-RateLimit-* / Retry-After
    });
  }
}

// IPリスト管理と統計（管理画面向け）
await limiter.manageIpList("block", "203.0.113.7");  // "block" | "allow" | "remove"
const stats = await limiter.getRateLimitStats();      // tiers / blocklist / allowlist / backend 等

// テストやシャットダウン時にインメモリ掃除タイマーを停止
limiter.dispose();
```

Redis を使う場合（ioredis は構造的にそのまま `RateLimiterClient` を満たします）:

```ts
import Redis from "ioredis";
const limiter = new RateLimiter({ client: new Redis(redisUrl) });
```

## 依存

- ランタイム依存なし（`node:crypto` のみ使用）。peerDependencies なし。
- 注入するクライアントは `RateLimiterClient` インターフェース（`get` / `set(PX)` / `pttl` / `incr` / `decr` / `expire` / `sismember` / `smembers` / `sadd` / `srem` / `zrem` / `multi().zremrangebyscore().zcard().zadd().pexpire().exec()`）を満たせば何でもよい。ioredis で動作確認済みの呼び出し形。

## 設定ポイント（何を注入するか）

| オプション | 既定値 | 説明 |
|---|---|---|
| `client` | なし（インメモリ） | Redis互換クライアント。呼び出し失敗時もインメモリへ自動フォールバック |
| `tiers` | `DEFAULT_RATE_LIMIT_TIERS`（essential_read=1000 / read=200 / write=50 / auth=30、各60秒窓） | ティア定義。任意のティア名で上書き可 |
| `endpointRules` | すべて空 | `getEndpointTier()` 用のパス分類ルール（auth / essential_read）。空なら 変更系メソッド=write、それ以外=read |
| `bypass` | `() => false` | バイパス判定関数（旧 E2E バイパスの置き換え。既定はオフ） |
| `violationTtlSeconds` | 3600 | Redis 側の違反カウンタ TTL |
| `cleanupIntervalMs` | 60000 | インメモリ掃除間隔。`0` で無効化 |

Redisキー形式は元実装のまま: `rl:{key}:{tier}` / `rl:block:{ip}` / `rl:blocklist` / `rl:allowlist` / `rl:violations:{key}`。

## 想定ランタイム

node / bun（`node:crypto` と Fetch API の `Request` を使用。ブラウザは対象外）

## 出典

- `実運用SaaS/server/lib/rate-limiter.ts`
- `実運用SaaS/cache.ts`（`slidingWindowRateLimit` を本パッケージ内に移植）
- テスト: `実運用SaaS/tests/rate-limiter.test.ts`
