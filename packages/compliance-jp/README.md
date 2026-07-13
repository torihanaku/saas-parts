# @torihanaku/compliance-jp

日本の広告規制（薬機法・景表法・特商法）に対するテキストのコンプライアンスチェックです。
50 本の静的ルールライブラリ（regex / キーワード辞書）を同梱し、違反検出 → リスクスコア算出 → 代替表現の提案（LLM 注入）まで行います。**正規表現とワードリストそのものが本パッケージの価値**であり、出典から逐語的に移植しています。

## 同梱ルール（計 50）

| 法律 | 定数 | 本数 | 例 |
|------|------|------|-----|
| 薬機法 | `YAKKIHOU_RULES` | 20 | 「花粉症が治る」「副作用ゼロ」「免疫力アップ」等（error 多め） |
| 景表法 | `KEIHYOUHOU_RULES` | 20 | 「No.1」「最安値」二重価格・ステマ規制・おとり広告等 |
| 特商法 | `TOKUSHOUHOU_RULES` | 10 | 定期購入の初回価格表示・解約制限・返品特約等 |

出典資料: 厚労省「医薬品等適正広告基準」、化粧品効能 56 項目、消費者庁の景表法違反事例集・2023/10 ステマ規制告示、特商法 2022/06 改正（詐欺的定期購入対策）ほか。

## API 例

```ts
import {
  check,
  suggest,
  applyStaticJpLawRules,
  createRuleRegistry,
  type LlmCheckFn,
  type SuggestLlmFn,
} from "@torihanaku/compliance-jp";

// 1) 純粋関数でルール適用のみ（DB / LLM 不要）
const violations = applyStaticJpLawRules("業界No.1！飲むだけで痩せるサプリ");
// [{ ruleId: "JP-KEIHYO-001", severity: "warning", matchedText: "No.1", span: [...], suggestion: "..." }, ...]

// 2) フルチェック（リスクスコア 0-100 + 日本語サマリ）
const result = await check({ text: "副作用ゼロで絶対に安全です" });
// { checkId, riskScore, violations, summary: "2 件のリスクが検出されました（error: 2, ...）..." }

// 3) 自社ルールを追加（レジストリは拡張可能）
const registry = createRuleRegistry(); // 同梱 50 本でシード
registry.register({
  id: "MY-BRAND-001", lawCode: "keihyo", ruleKey: "brand_ngword",
  patternType: "keyword", pattern: JSON.stringify(["disruptive"]),
  severity: "warning", descriptionJa: "ブランドNGワード",
});
await check({ text, registry, industry: "finance" }); // industryFilter も適用

// 4) LLM ルール（patternType: "llm_prompt"）と代替表現の提案はコールバック注入
const llmCheck: LlmCheckFn = async ({ text, rule }) => {/* 任意の LLM クライアント */};
const suggestLlm: SuggestLlmFn = async (system, user, { maxTokens }) => {/* 同上 */};
await check({ text, llmCheck });
await suggest({ text, violation, rule }, suggestLlm);
```

## 注入ポイント

| 境界 | インターフェース | 備考 |
|------|-----------------|------|
| LLM チェック | `LlmCheckFn = ({ text, rule }) => Promise<LlmCheckResponse>` | 未注入なら `llm_prompt` ルールは warn してスキップ。プロンプトは `buildLlmCheckPrompt()` で出典と同一のものを生成可能 |
| 代替表現の提案 | `SuggestLlmFn = (system, user, { maxTokens }) => Promise<RawSuggestion[]>` | SYSTEM_PROMPT（`SUGGESTION_SYSTEM_PROMPT`）と ±100 文字の文脈窓は出典どおり |
| 履歴保存 | `CheckStore { saveCheck } `（省略可） | 失敗しても check は成功する（best-effort） |
| ルール | `createRuleRegistry(initial?)` / `check({ rules })` | 同梱 50 本がデフォルト。重複 id は register 時に throw |

リスクスコア重み（出典どおり）: `error: 40 / warning: 15 / info: 5`、上限 100。

## Runtime

ランタイム非依存（純 TypeScript、Node / Bun / edge / ブラウザ可）。I/O はすべて注入。

## 出典

- 実運用SaaS `server/lib/compliance/rules/{yakkihou,keihyouhou,tokushouhou,types,index}.ts`（#934・ルール内容は逐語移植）
- 実運用SaaS `server/lib/compliance/checker-service.ts` / `suggestion-service.ts`
- テストは `tests/jp-law-rules.test.ts`（全 50 ルールの違反テキスト検出＋安全テキスト通過のフィクスチャ）、`tests/server/lib/compliance/checker-service.test.ts`、`tests/compliance-suggestion.test.ts` を移植
