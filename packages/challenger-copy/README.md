# @torihanaku/challenger-copy

Safe / Edgy 2 案コピー生成 → 提示 → 選択フィードバック学習ループ（Active Learning）。
実運用SaaS の「Challenger」機構から、インフラ依存を剥がして抽出。

> **マーケ / ブランド製品向け**のパーツです。「本命コピーに対してあえて境界を攻める対抗案（challenger）を出し、CMO の選択・却下から lint を賢く育てる」用途を想定しています。

## 機能説明

- **Safe / Edgy 2 案生成（`generateDualOptions`）**: ブランド DNA（voice / tone）を文脈に、遵守寄りの Safe 案と少し逸脱した Edgy 案の 2 案を LLM で生成。
- **Challenger 提案生成（`generateChallengerProposals`）**: 本命案から意図的に逸脱した対抗案を N 件生成し保存。カムフラージュ原則（メタラベル禁止）をシステムプロンプトで担保。
- **フィードバックループ（`recordHardNegative`）**: 却下された対抗案を hard negative として記録 → embedding → 後付け保存。将来の類似度検索に効かせる。
- **類似度チェック（`checkHardNegativeSimilarity`）**: 新規コンテンツが過去の hard negative に類似（cosine 0.85 超）していれば検出。200 ケース検出率テスト同梱。
- **lint 連携（`runChallengerLint`）**: 本命 A と対抗案 B に lint を並列適用し、「本命は落ちるが対抗案は通る」特別バッジを判定。
- **メトリクス集計（`aggregateDailyMetrics` / `getChallengerMetrics`）**: 提案数 / 採用数 / hard negative 数 / lint 精度の日次集計と、Day1 vs Day30 の学習効果比較。

## 自己完結の方針（注入）

- **LLM / embedding**: 関数型 `GenerateJson` / `EmbedText` を注入。
- **lint 連携**: import せず、注入述語 `LintCheck` として受ける（README のとおり **@torihanaku/brand-lint** や **@torihanaku/kit-approval-workflow** が充足。本パッケージからの import はなし）。
- **永続化**: `ChallengerStore` インターフェース。テスト / プロトタイプ用に `InMemoryChallengerStore` を同梱。
- `process.env` 参照はパッケージ内に一切なし。原実装の feature flag は `enabled` 注入（既定 true）に置換。

```ts
import {
  generateDualOptions,
  runChallengerLint,
  InMemoryChallengerStore,
  type GenerateJson,
  type LintCheck,
} from "@torihanaku/challenger-copy";

const store = new InMemoryChallengerStore();
const generateJson: GenerateJson = async (system, user, fallback) => fallback;
const lintCheck: LintCheck = async ({ contentText }) => ({ riskScore: 0 });

const { safe, edgy } = await generateDualOptions(tenantId, "元の原稿", { store, generateJson });
```

## テスト

```bash
npx vitest run packages/challenger-copy
```
