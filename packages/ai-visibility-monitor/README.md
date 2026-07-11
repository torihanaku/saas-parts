# @torihanaku/ai-visibility-monitor

ChatGPT / Perplexity / Gemini などの AI 検索エンジンでの自社ブランド言及をサンプリング監視するパッケージ。dev-dashboard-v2（マーケ運用ダッシュボード製品）の AI 可視性ジョブを移植・自己完結化したものです。

## これは何か（正直な適用範囲）

**「AI 検索での自社ブランドの見え方（AI visibility / GEO）」を追う、マーケ製品固有** のロジックです。登録キーワードごとに複数の AI エンジンへ問い合わせ、その回答に自社ブランドが言及されているかを分類し、結果を記録します。汎用の LLM オーケストレータではありません。

## 移植にあたっての切り離し（依存の注入化）

元コードは OpenAI API・社内 Claude クライアント・Supabase・feature-flags・`process.env`（各種 API キー）に直結していました。本パッケージでは **すべて注入** に変え、API キーはこのパッケージの外（注入された caller）だけに存在します。

| 元の依存 | 本パッケージでの扱い |
| --- | --- |
| OpenAI / Claude-backed Perplexity・Gemini 呼び出し | エンジンごとの `EngineCaller` として注入（`createOpenAiEngine` ヘルパ同梱） |
| ブランド言及の分類（Claude `generateJson`） | `MentionAnalyzer` として注入 |
| Supabase (`dd_ai_visibility_queries` / `dd_ai_visibility_results`) | `VisibilityStore` として注入 |
| `isEnabled("aiSearchVisibility")` | `isEnabled()` として注入 |
| `ANTHROPIC_API_KEY` 事前チェック | `ready()` プリフライトとして注入 |
| キーワード・ブランド名 | クエリ（`VisibilityQuery`）と caller/analyzer 側の設定として外出し |
| `global.fetch` | `FetchLike` として注入 |

`@torihanaku/*` への依存・`process.env`・DB・秘匿情報は一切持ちません。

## 使い方（概略）

```ts
import { runVisibilityMonitor, createOpenAiEngine } from "@torihanaku/ai-visibility-monitor";

await runVisibilityMonitor({
  isEnabled: () => featureFlags.on("aiSearchVisibility"),
  ready: () => Boolean(hasLlmKey),
  engines: {
    openai: createOpenAiEngine({ fetchImpl: fetch, getApiKey: (t) => keys.openai(t) }),
    perplexity: (kw) => llm.answer(kw),
    gemini: (kw) => llm.answer(kw),
  },
  analyze: (kw, text, tenantId) => llm.classifyMention(kw, text, tenantId),
  store: myVisibilityStore,
});
```

## 残課題

- Perplexity / Gemini は元コードでは専用コネクタが未整備で Claude 経由の代替だった。本パッケージでは caller を注入する設計なので、専用コネクタを差し込めば解消する（パッケージ側の変更は不要）。
- サンプリング頻度・キーワードの選定ロジックは呼び出し側の責務。
