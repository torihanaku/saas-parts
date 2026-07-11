# @torihanaku/customer-intelligence

CRMデータ・リードスコア・活動シグナルを統合した顧客プロファイル構築と、チャーンリスク予測・購買意欲分析（LLMは注入コールバック、なければヒューリスティックにフォールバック）。

## 主要API例

```ts
import {
  CustomerIntelligence,
  InMemoryCustomerIntelligenceStore,
} from "@torihanaku/customer-intelligence";

const ci = new CustomerIntelligence({
  store: new InMemoryCustomerIntelligenceStore(), // 本番は DB 実装の CustomerIntelligenceStore を注入
  // リードスコアは最小インターフェースの provider で注入（スコアリングパッケージへの依存なし）
  leadScoreProvider: async (contactId) => ({ total_score: 60, engagement_score: 20 }),
  // LLM は JsonGenerator コールバック（APIキー解決・BYOK は呼び出し側の責務）。
  // 未設定なら predictChurnRisk / calculatePurchaseIntent はヒューリスティック値を返す
  generateJson: myLlmJson,
});

// 統合プロファイル構築（ライフサイクル導出・購買意欲・チャーンスコアのヒューリスティック計算＋upsert）
const profile = await ci.buildUnifiedProfile(contactId, projectId);
// lifecycle: won deal→customer / negotiation→opportunity / score≥50→lead / contact「churned」が最優先

await ci.predictChurnRisk(profile.id);       // → { risk_score, risk_level, signals[] }（LLM後に0..100へクランプ＋保存）
await ci.calculatePurchaseIntent(profile.id); // → { intent_score, signals[] }
await ci.syncAllProfiles(projectId);          // 全コンタクトを走査（エラーは数えて継続）
await ci.getCustomerProfiles(projectId);      // updated_at 降順
```

## 依存
- peerDependencies: なし（ランタイム依存ゼロ）

## 注入ポイント
- `CustomerIntelligenceStore` — dd_customer_profiles / dd_crm_contacts / dd_crm_deals 相当の読み書き（元クエリ形状を型付きメソッドで写像。upsert は「id検索→patch/insert」の2段を維持）
- `LeadScoreProvider` — `(contactId) => { total_score, engagement_score } | null` の最小インターフェース（元実装の lead-scoring import を置換。@torihanaku/lead-scorer をラップして渡すことも可能だが依存はしない）
- `JsonGenerator` — LLM の JSON 生成コールバック（元実装の claude-api-client.generateJson + テナントBYOK/ANTHROPIC_API_KEY 解決を置換）
- `now` / `uuid` / `logger` — 時刻・ID・構造化ログの注入（既定は元実装と同じ console.log JSON）

## 元実装からの変更点
- Supabase / env / tenant-secrets 直接参照を全廃 → すべて注入
- `predictChurnRisk` / `calculatePurchaseIntent` の `tenantId` 引数（BYOKキー解決用）を削除 — キー解決は `generateJson` を作る側の責務
- LLM 未設定時はフォールバック値を返す（元実装の「APIキーなし」パスと同挙動）
- チャーン/購買意欲のヒューリスティック（重み・閾値・クランプ）は無改変
