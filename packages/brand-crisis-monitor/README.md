# @torihanaku/brand-crisis-monitor

SNS 炎上監視・深刻度（感情）判定・スパイクアラートのキット。監視ソースから言及を取得し、LLM で感情分類、直近 24 時間のスパイクを検知して閾値超過でアラートを発報する。実運用SaaS `server/lib/brand-crisis-job.ts` + `brand-crisis/reddit-client.ts` の移植。

## 特徴

- **ソース注入式（`CrisisSource`）**: 原典は Reddit ハードコードだったが、監視ソースを注入 IF に一般化。Reddit 実装（`createRedditSource`）を **一例として同梱**。X・ニュース等は同 IF を実装すれば差し込める。
- **ストア注入式（`CrisisStore`）**: 永続化を抽象化。`InMemoryCrisisStore` を同梱。
- **LLM 注入式**: 感情分類の `generateJson` を注入（`@torihanaku/claude-api` 互換）。
- **API キー解決・アラート通知も注入式**: `resolveApiKey`（tenant secret → env fallback を委譲）、`alerter`（Slack 等）。
- **`process.env` 非依存 / シークレット非同梱 / fetch も注入可能**。

## 使い方

```ts
import {
  runBrandCrisisMonitor,
  InMemoryCrisisStore,
  createRedditSource,
  type BrandCrisisConfig,
} from "@torihanaku/brand-crisis-monitor";
import { generateJson } from "@torihanaku/claude-api";

const reddit = createRedditSource({
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  userAgent: "myapp/1.0",
  // fetchFn 省略時は globalThis.fetch
});

const config: BrandCrisisConfig = {
  sources: [reddit],
  store: new InMemoryCrisisStore(),
  generateJson,
  resolveApiKey: async (tenantId) =>
    (await getTenantKey(tenantId)) || process.env.ANTHROPIC_API_KEY || "",
  alerter: async ({ tenantId, count, threshold }) => {
    await postSlack(`🚨 Brand Crisis for ${tenantId}: ${count} mentions (>${threshold})`);
  },
  // threshold 省略時 = 10, searchOptions 省略時 = { limit: 25, sort: "new", time: "day" }
};

// cron から 1 回走らせる（feature flag / スケジューラ登録は呼び出し側の責務）
await runBrandCrisisMonitor(config);
```

## 独自ソースを足す

```ts
import type { CrisisSource, CrisisMention } from "@torihanaku/brand-crisis-monitor";

const xSource: CrisisSource = {
  name: "x",
  async search(keyword, options) {
    // 失敗時は throw せず [] を返す（graceful degradation）
    return [/* CrisisMention[] */];
  },
};
```

## 判定ロジック

- **感情分類**: 各言及本文を LLM（既定 `claude-3-haiku-20240307`）で `positive | neutral | negative` に分類。API キーが解決できなければ LLM を呼ばず `neutral`。
- **スパイク検知**: 直近 24 時間のテナント言及数が閾値（既定 10）を超えたら `spike` アラート。

## 移植メモ

- `env.REDDIT_*` 直参照 → `createRedditSource(config)` の引数へ。トークンキャッシュは factory インスタンスに閉じ、`__clearTokenCache()` でリセット可（原典 `__clearRedditTokenCache` 相当）。
- `RedditMention` の `subreddit / author / created_utc` は汎用 `CrisisMention.metadata` に格納。
- `supabaseGet/Insert` → `CrisisStore`。`isEnabled("brandCrisisDetection")`（feature flag）と `registerJob`（scheduler）は本体から除外し、呼び出し側のゲート／登録に委譲。
- Slack webhook（env + グローバル fetch）→ 注入式 `alerter`。
- 感情分類プロンプト・スパイク閾値・Reddit の OAuth/検索ロジックは原典のまま。
