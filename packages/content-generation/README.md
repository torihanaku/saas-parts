# @torihanaku/content-generation

ペルソナ別コンテンツ生成・コピー多変量生成・長文 → SNS 原子化・実績ベースリミックス。
実運用SaaS の content-engine / prototype / content routes から、インフラ依存を剥がして抽出。

> **マーケ / ブランド製品向け**のパーツです。「テンプレートからブログ・SNS・レポートを量産する」「1 本の記事を X スレッド・LinkedIn・ニュースレターなどへ一括変換する」「広告コピーを多変量で出す」用途を想定しています。

## 機能説明

- **コンテンツ生成（`generateContent`）**: 14 種のテンプレート × 5 種のトーン × コンテキスト素材（ニュース / ナレッジ / CRM）から本文を生成。SEO スコアも同時算出。
- **レポート / 変換 / 抽出（`generateReport` / `transformContent` / `extractActionItems`）**: 週次サマリー等の構造化レポート、フォーマット変換、議事録からのアクションアイテム抽出。
- **コピー多変量（`generateCopyVariants`）**: 施策案 + ブランドボイス文脈から N 件のコピー案（見出し / 本文 / CTA）。LLM 失敗時は決定的フォールバックに縮退し、必ず count 件を返す。
- **原子化 / リミックス（`atomizeContent` / `remixToFormat`）**: 長文を 7 フォーマット（X スレッド / LinkedIn / メール / note / Slack / スライド / ブログ）へ並列変換。部分成功に対応。
- **LP モック（`generateLpMock`）**: 施策ブリーフから Tailwind スタイルの単一ページ HTML を生成。危険な script / iframe / on イベントを `sanitizeLpHtml` で除去。
- **実績メトリクス合成（`buildPerformanceReport`）**: draft ID をシードにした決定的な擬似メトリクス（views / 直帰 / シェア / SEO 等）と 30 日トレンド・タイプ別集計。実績ベースのリミックス判断材料に。

## 自己完結の方針（LLM 注入）

原実装が内部で呼んでいた Claude クライアントは、関数型 `GenerateText` / `GenerateJson` として
**すべて注入**します。API キー解決・テナント別 BYOK は呼び出し側の closure に閉じ込めてください。
`process.env` 参照はパッケージ内に一切ありません。プロンプトは原文をデフォルト保持しています。

```ts
import { generateContent, type GenerateText } from "@torihanaku/content-generation";

const generateText: GenerateText = async (system, user, opts) => {
  /* あなたの LLM 実装 */
  return "...";
};

const draft = await generateContent(generateText, {
  template: "trend-article",
  topic: "AI in marketing",
});
```

## テスト

```bash
npx vitest run packages/content-generation
```
