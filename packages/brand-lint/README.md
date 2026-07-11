# @torihanaku/brand-lint

表現lint（禁止語 / トーン / 類似度）＋ 却下事例からのルール自動進化のルールエンジン。
dev-dashboard-v2 の Brand Firewall から、プロダクト固有の永続化・LLM 依存を剥がして抽出したもの。

> **マーケ / ブランド製品向け**のパーツです。「ブランドガイドラインに沿ったコピー・広告表現を守らせたい」「NG事例を溜めて lint を賢くしたい」用途を想定しています。
> 承認ワークフロー本体（申請 → リスク評価 → 承認 → 監査、Slack 承認、稟議）は `@torihanaku/kit-approval-workflow` が担当します。本パッケージは**ルールエンジン側**（禁止語 / トーン / 類似度チェッカーと、却下事例からのルール進化）だけを提供します。

## 機能説明

- **禁止語マッチャー（`matchForbiddenWords`）**: リテラル or 正規表現の禁止語リストに文章を照合する純粋関数。ヒット位置（span）付き。
- **トーンチェッカー（`checkTone`）**: 最新のブランド DNA スナップショット（voice / tone / forbidden_words）を読み、禁止語チェック＋（LLM を注入した場合は）voice/tone チェックを行う。
- **類似度チェック（`checkSimilarity`）**: 新しい投稿の embedding を過去の却下案件と照合。cosine 類似度 0.85 以上で warning。
- **AI クイックフィックス（`generateQuickFix`）**: 違反箇所の修正案と理由を LLM で生成（失敗時は原文フォールバック）。
- **Hard Negative embedding（`ingestRecentRejections`）**: 直近の却下投稿をバッチ embedding して DNA スナップショットに hard negative として注入。重複排除付き。
- **重み減衰（`hardNegativeDecay`）**: 古い却下は軽く扱う純粋関数群（半減期 30 日 / 180 日で実質ゼロ）。「5 年前 NG が今 OK」に対応。
- **ルール自動進化（`runRuleEvolution`）**: 減衰ウィンドウ内の rejected hard negative を重み上位で LLM に渡し、コンプライアンスルール案（pending）を生成する。

## 自己完結の方針（ポート注入）

原実装が直接叩いていた Supabase テーブル / pgvector RPC は `BrandLintStore` インターフェースに、
Claude / embedding クライアントは関数型（`GenerateJson` / `EmbedBatch`）に置換しています。
`process.env` やシークレット参照はパッケージ内に一切ありません。テスト / プロトタイプ用に
`InMemoryBrandLintStore` を同梱しています。

```ts
import {
  checkTone,
  checkSimilarity,
  generateQuickFix,
  ingestRecentRejections,
  runRuleEvolution,
  InMemoryBrandLintStore,
  type GenerateJson,
} from "@torihanaku/brand-lint";

const store = new InMemoryBrandLintStore();

// 実運用では Supabase 実装 + Claude 呼び出しを注入する。
const generateJson: GenerateJson = async (system, user, fallback, opts) => {
  /* あなたの LLM 実装（API キー解決は closure に閉じ込める） */
  return fallback;
};

const violations = await checkTone(tenantId, content, { store, generateJson });
```

## 主なエクスポート

| 種別 | シンボル |
|------|----------|
| チェッカー | `matchForbiddenWords` / `checkTone` / `checkSimilarity` / `generateQuickFix` |
| 進化 | `ingestRecentRejections` / `runRuleEvolution` |
| 減衰（純粋関数） | `decayWeight` / `isStillRelevant` / `selectRelevantSamples` / `weightSamples` / `weightedCount` |
| ポート / 参照実装 | `BrandLintStore` / `InMemoryBrandLintStore` |
| 型 | `BrandViolation` / `BrandDnaSnapshot` / `GenerateJson` / `EmbedBatch` ほか |

## テスト

```bash
npx vitest run packages/brand-lint
```
