# @torihanaku/lead-scorer

行動（behavior）・適合度（fit）・エンゲージメントの3軸でリードを決定的にスコアリングし、MQL判定と次元別内訳を返すエンジン。

## 主要API例

```ts
import {
  LeadScorer,
  InMemoryLeadScoringStore,
  getDefaultScoringConfig,
} from "@torihanaku/lead-scorer";

const scorer = new LeadScorer({
  store: new InMemoryLeadScoringStore(), // 本番は DB 実装の LeadScoringStore を注入
  // config: 重み・MQL閾値（既定は元実装の値: 閾値50 / email_open 5, email_click 10,
  //         site_visit 3, form_submit 20, deal_created 30, meeting_booked 25）
  config: getDefaultScoringConfig(),
  // now: テスト決定性用の時計注入（recency 採点に使用）
});

const score = await scorer.scoreContact(contactId, projectId);
// → { total_score, behavior_score, fit_score, engagement_score,
//     dimensions: { email_open, deal_created, …, fit, engagement }, is_mql, scored_at }

const { scored, mqls } = await scorer.bulkScoreContacts(projectId); // 50件ずつバッチ
const breakdown = await scorer.getScoreBreakdown(contactId);        // 保存済みスコアの読み出し

// 純関数も個別に使える
import { calculateFitScore, calculateEngagementScore, calculateBehaviorScore } from "@torihanaku/lead-scorer";
```

## 依存
- peerDependencies: なし（ランタイム依存ゼロ）

## 注入ポイント
- `LeadScoringStore` — dd_crm_contacts / dd_crm_deals / dd_marketing_campaigns / dd_lead_scores 相当の読み書き（元クエリ形状を型付きメソッドで写像。upsert は「id検索→patch/insert」の2段を維持）
- `ScoringConfig` — 重み・MQL閾値（既定 = 元実装値）
- `now` / `uuid` — 時刻（recency採点・scored_at）とID生成の注入

## 元実装からの変更点
- Supabase 直接呼び出し → `LeadScoringStore` 注入
- `Date.now()` 直接参照 → `now` 注入（既定は現在時刻。engagement の recency 採点が決定的にテスト可能）
- 内部関数だった calculateBehaviorScore / calculateFitScore / calculateEngagementScore を純関数として export
- fit / engagement のティア閾値（会社規模・役職・ライフサイクル等）は元実装のままハードコード
