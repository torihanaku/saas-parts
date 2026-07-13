# @torihanaku/bias-detector

マーケティング意思決定文から**認知バイアス6種**（sunk_cost / confirmation / recency / bandwagon / anchoring / hippo）をAIで検知するパッケージです。実運用SaaS（Epic G10 MOAT / #356）の実装を移植し、外部依存を差し込み式にして自己完結化しました。

## 特徴

- **拡張可能なバイアス分類レジストリ**: 6種の元バイアスを既定として登録済み（元のプロンプトルーブリックをそのまま同梱）。`BiasRegistry.register()` で独自バイアスを追加・上書きできます。
- **LLM は差し込み式**: `BiasLlmClient`（`generateJson(system, userPrompt, fallback, options)`）を渡します。Claude api-client などをここに接続してください。エラー時は `fallback` を返す契約（例外を投げない）です。
- **自動トリガーの I/O も差し込み式**: フィーチャーフラグ・永続化ストア・通知（Slack等）・ロガーをすべて注入します。シークレットや特定バックエンド（supabase 等）への依存はありません。

## 使い方

### バイアス検知（v1 per-bias 検出器）

```ts
import { createBiasDetectorService } from "@torihanaku/bias-detector";

const llm = {
  async generateJson(system, user, fallback, opts) {
    // 例: Claude api-client の generateJson を呼ぶ
    return callClaudeGenerateJson(system, user, fallback, opts);
  },
};

const detector = createBiasDetectorService(llm);
const detections = await detector.detectBiases({
  subject: "Instagram広告を継続",
  reason: "すでに200万円投資したから",
  decisionMakerRole: "ceo",
});
```

### 意思決定作成時の自動トリガー

```ts
import { enqueueBiasDetectionForDecision, buildCriticalSlackText } from "@torihanaku/bias-detector";

enqueueBiasDetectionForDecision(input, {
  detector,
  isEnabled: () => featureFlags.aiBiasDetection,
  store: {
    hasExistingDetections: ({ tenantId, decisionId }) => db.exists(...),
    insertDetection: ({ tenantId, decisionId, detection }) => db.insert(...),
  },
  notifyCritical: async (input, critical) => slack.post(buildCriticalSlackText(input, critical)),
  logger,
});
```

### クライアントフック（React）

`src/client/useBiasDetections.ts` に読み取り専用フックがあります。HTTP クライアント（`{ get<T>(path) }`）を注入します。`react` は peer dependency です。

```tsx
const { data } = useBiasDetections(api, decisionId);
```

## 拡張バイアスの登録

```ts
import { BiasRegistry, createBiasDetectorService } from "@torihanaku/bias-detector";

const registry = new BiasRegistry().register({
  type: "loss_aversion",
  rubric: "## loss_aversion — 損失回避バイアスの検出基準…",
});
const detector = createBiasDetectorService(llm, registry);
```

## テスト

- `bias-detector.test.ts` — v1 検出器 / legacy single-shot / サニタイズ
- `claude-detector.test.ts` — per-bias プロンプト / HiPPO 重み付け / レジストリ拡張
- `decision-trigger.test.ts` — フラグ / 冪等 / 挿入 / critical 通知
- `client/useBiasDetections.test.tsx` — React フック（jsdom）
