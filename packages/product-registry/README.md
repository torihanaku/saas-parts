# @torihanaku/product-registry

プロダクト × プラン × Stripe Price（env 変数名）× エンタイトルメント宣言を一元管理し、起動時に DB へ同期するレジストリ。

## 主要API例

```ts
import {
  ProductRegistry,
  InMemoryProductStore,
  EXAMPLE_PRODUCTS, // 2プロダクトのドキュメント例（platform + analytics）
} from "@torihanaku/product-registry";

// プロダクト定義は呼び出し側の設定（元実装は Folia 5製品をハードコード）
const registry = new ProductRegistry({
  products: EXAMPLE_PRODUCTS,
  env: { STRIPE_ANALYTICS_PRO_PRICE_ID: priceId }, // env マップを注入（process.env 直読みなし）
  store: new InMemoryProductStore(),               // 本番は DB 実装を注入
  isProduction: nodeEnv === "production",
  devBaseUrl: "http://localhost:5174",
  productionDomain: "example.com", // https://{subdomain}.{domain} の生成に使用
});

registry.getProduct("analytics");                  // 定義取得（未知キーは throw）
registry.resolveStripePrice("analytics", "pro");   // env 変数名 → Price ID（未設定は undefined）
registry.resolveProductUrl("analytics");           // dev: localhost / prod: サブドメイン URL

await registry.syncProductsToDb();  // 起動時同期（失敗は warn のみ・throw しない）
registry.validateEnvironment();     // active 製品の Price env 欠落を警告（配列で返す）
```

## 依存
- peerDependencies: なし（ランタイム依存ゼロ）

## 注入ポイント
- `products`: プロダクト定義マップ（`stripePrices` はプラン → **env 変数名**）
- `env`: Stripe Price 解決用の env マップ（元実装の `process.env` 読みを置換）
- `store`: `ProductStore`（`upsertProducts`）。元実装の supabase `products` テーブルへの merge-duplicates upsert を置換。インメモリ実装同梱
- `isProduction` / `devBaseUrl` / `productionDomain`: URL 解決の環境判定（元実装の `NODE_ENV` / `PORT` / ハードコード `folia.la` を置換）
- `logger`: 警告出力先（デフォルト console）

## 想定ランタイム
Node.js 18+ / Bun / エッジランタイム（環境 API 非依存）

## 出典
`dev-dashboard-v2/server/lib/product-registry.ts`（約150行）＋ 型は `shared/types/product.ts`
