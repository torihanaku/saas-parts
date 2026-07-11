# @torihanaku/usage-quota

プラン別のアクション日次利用上限（デイリークォータ）を判定・強制する軽量エンジン（UTC 0時リセット）。

## 主要API例

```ts
import {
  UsageQuota,
  InMemoryUsageStore,
  EXAMPLE_PLAN_LIMITS,
} from "@torihanaku/usage-quota";

// プラン上限は呼び出し側の設定（plan → action → 日次上限。-1=無制限, 0=禁止）
// EXAMPLE_PLAN_LIMITS は元実装の free/pro/enterprise 既定値のドキュメント例
const quota = new UsageQuota({
  store: new InMemoryUsageStore(), // 本番は DB 実装の UsageStore を注入
  planLimits: EXAMPLE_PLAN_LIMITS,
  // defaultPlan: "free", defaultLimit: 999, upgradeUrl: "/pricing"（元実装の既定値）
});

// ルートミドルウェア的に使う（userId/plan の解決は呼び出し側の認証層で）
const denied = await quota.enforceUsageLimit(userId, "content_generate", user.plan);
if (denied) return denied;
// → 403 { error:"usage_limit_exceeded", action, used, limit, plan, upgradeUrl, resetAt }
//   resetAt は次の UTC 0時（元実装と同じペイロード形状）

// 実行後に計上（best-effort — ストア障害では投げない）
await quota.trackUsage(userId, "content_generate", tokensUsed);

// 個別 API
await quota.checkUsageLimit(userId, "autopilot", "enterprise"); // { allowed, used, limit }
await quota.getDailyUsage(userId, "content_generate");          // 今日(UTC)の使用回数
quota.getPlanLimits("pro");                                     // プランの上限マップ
```

## 依存
- peerDependencies: なし（ランタイム依存ゼロ。fetch API の `Response` のみ使用）

## 注入ポイント
- `store`: `UsageStore`（`countSince` / `record`）。元実装の supabase `dd_usage` テーブル（content-range によるカウント）を置換。インメモリ実装同梱
- `planLimits`: plan キー → アクション別日次上限のマップ（元実装のハードコード PLAN_LIMITS ＋ action→フィールドの limitMap を汎用化）
- `now`: クロック注入（テスト用）
- 認証・ユーザー設定の解決（元実装の getUserId / getOrCreateUserConfig / feature flag ゲート）は呼び出し側に残す — `enforceUsageLimit(userId, action, plan)` に直接渡す

## 想定ランタイム
Node.js 18+ / Bun / エッジランタイム（fetch API 標準の環境）

## 出典
`dev-dashboard-v2/server/lib/usage-limiter.ts`（38行）＋ `server/lib/user-context.ts` のクォータ部分（PLAN_LIMITS / getPlanLimits / getDailyUsage / trackUsage / checkUsageLimit）
