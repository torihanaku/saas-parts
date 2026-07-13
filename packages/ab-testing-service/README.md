# @torihanaku/ab-testing-service

AIネイティブなA/Bテストの**実験ライフサイクル**（起票 → バリアントAI生成 → 計測 → 勝者判定 → 終了）を担うパッケージです。実運用SaaS（#362）の実装を移植し、永続化・バンディット割当・有意差判定をすべて差し込み式にして自己完結化しました。

## 設計

- **永続化は差し込み式**（`AbTestingStore`）: Supabase 直結だった元実装を、ドメインオブジェクト（`Experiment` / `Variant`）を返すストアインターフェイスに抽象化。Supabase / Postgres / インメモリなどのアダプタを実装します。
- **バンディット割当は差し込み式**（`Allocator`）: `thompsonAllocate` / `uniformAllocate` / `posteriorBestProbability` を注入します。
- **有意差判定は差し込み式**（`SignificanceTester`）: ベイズ信用区間ベースの判定関数を注入します。
- **バリアント生成 LLM も差し込み式**（`VariantLlmClient`）、**コスト台帳も差し込み式**（`VariantCostLedger`）。シークレットや特定バックエンドへの依存はありません。

## 対になるパッケージ（インターフェイスを満たすが import はしない）

- `@torihanaku/thompson-bandit` — `thompsonAllocate` / `uniformAllocate` / `posteriorBestProbability` を提供し、本パッケージの `Allocator` インターフェイスを構造的に満たします。
- `@torihanaku/ab-significance` — `decideSignificance` を提供し、本パッケージの `SignificanceTester` インターフェイスを構造的に満たします。

> 依存の向きを一方向に保つため、本パッケージからこれらを import していません。利用側で束ねてください。

## 使い方

```ts
import { AbTestingService } from "@torihanaku/ab-testing-service";
import { thompsonAllocate, uniformAllocate, posteriorBestProbability } from "@torihanaku/thompson-bandit";
import { decideSignificance } from "@torihanaku/ab-significance";

const svc = new AbTestingService({
  store: myAbStore, // AbTestingStore を実装
  allocator: { thompsonAllocate, uniformAllocate, posteriorBestProbability },
  significance: decideSignificance,
});

const exp = await svc.createExperiment({ tenantId, name, surface: "email_subject", targetMetric: "open_rate" });
const variants = await svc.generateVariants(exp.id, tenantId, 5, generator);
const alloc = await svc.allocate(exp.id, tenantId);
await svc.recordOutcome({ experimentId: exp.id, variantId: alloc.variantId, tenantId, eventType: "conversion" });
const winner = await svc.determineWinner(exp.id, tenantId);
```

### バリアント AI 生成

```ts
import { generateClaudeVariants } from "@torihanaku/ab-testing-service";

const seeds = await generateClaudeVariants(input, {
  llm: { generateJson: callClaudeGenerateJson },
  ledger: {
    getMonthlySpendJpy: (tenantId) => costDb.rolling30d(tenantId),
    recordSpend: (row) => costDb.append(row),
  },
});
```

コストガード: 実験あたり最大 50 バリアント、テナントあたり月次 ¥10,000 上限。上限超過時は `VariantCostCapError` を投げます。

### クライアントフック（React）

`src/client/useAbTesting.ts` に `useExperiments` / `useExperimentDetail` があります。HTTP クライアント（`{ get<T>(path) }`）を注入します。`react` は peer dependency です。

## テスト

- `ab-testing-service.test.ts` — ライフサイクル（インメモリストア + スタブ割当/有意差）
- `claude-variant-generator.test.ts` — バリアント生成 / コストキャップ / サニタイズ
- `client/useAbTesting.test.tsx` — React フック（jsdom）
