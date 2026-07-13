# @torihanaku/press-media

プレスリリース生成・記者CRM（メディアリレーション）・PRオペレーションを 1 パッケージに束ねた広報向けキット。実運用SaaS の `press-release-engine` / `media-ledger-service` / `pr-ops-service` を移植したもの。

## 特徴

- **自己完結**: 永続化ストアを持たない。データは呼び出し側が渡す。
- **LLM 注入式**: プロバイダに直接触れない。`generateJson` / `generateText` を注入する（`@torihanaku/claude-api` の同名関数がそのまま適合）。
- **`process.env` 非依存 / シークレット非同梱**。

## 3 モジュール

### 1. プレスリリース生成（press-release-engine）

4 類型 + その他（`new_product` / `event` / `earnings` / `partnership` / `other`）に応じた日本語プレスリリースを構造化 JSON で生成。ブランドボイス準拠チェック（0-100 スコア、80 以上で合格）と、ダウンロード用テキスト整形を提供。

```ts
import { generatePressRelease, brandCheckPressRelease, formatPressReleaseAsText } from "@torihanaku/press-media";
import { generateJson } from "@torihanaku/claude-api"; // 注入する LLM 実装（例）

const pr = await generatePressRelease(generateJson, apiKey, {
  topic: "新AIアシスタントの提供開始",
  prType: "new_product",
  context: "2026年8月提供開始、月額980円",
  brandVoicePrompt: "誠実で落ち着いたトーン",
});

const check = await brandCheckPressRelease(generateJson, apiKey, pr, "誠実で落ち着いたトーン");
const text = formatPressReleaseAsText(pr);
```

### 2. 記者CRM（media-ledger-service）

- `calculateRelationshipScore(interactions)`: 関係スコアを 4 次元で算出（LLM 不要のピュア関数）。
  - Recency 0-30 / Frequency 0-30 / ResponseRate 0-20 / Coverage 0-20（合計 0-100）
- `generatePitchEmail(generateText, apiKey, params)`: 記者ごとにパーソナライズしたピッチメール（件名＋本文）を生成。
- `suggestSortRule(email)`: メールドメインから仕分けルールを提案。
- `MediaContact` は同意管理（`consent_status: pending | granted | revoked`）と PII 列（`*_encrypted` 命名で Phase 2 の pgcrypto を示唆）を型に持つ。

```ts
import { calculateRelationshipScore, generatePitchEmail } from "@torihanaku/press-media";

const score = calculateRelationshipScore(interactions); // { recency, frequency, responseRate, coverage, total }
const pitch = await generatePitchEmail(generateText, apiKey, {
  contactName: "田中太郎", outlet: "日経新聞", beat: "テクノロジー",
  pastInteractions: "前回取材 2026-03", topic: "新製品リリース",
});
```

### 3. PRオペレーション（pr-ops-service）

- `suggestTiming(generateJson, apiKey, { upcomingEvents, industryEvents, pastPerformance? })`: 業界イベントや自社PRイベントとの衝突を避けた配信タイミングを提案（confidence は 0-1 にクランプ）。
- `generateStrategySummary(generateJson, apiKey, { events, industryEvents })`: PR カレンダーと業界動向から戦略サマリを生成。

## LLM 注入契約

```ts
type GenerateJson = <T>(apiKey: string, system: string, userPrompt: string, fallback: T, options?: { maxTokens?: number; timeout?: number }) => Promise<T>;
type GenerateText = (apiKey: string, system: string, userPrompt: string, options?: { maxTokens?: number; timeout?: number }) => Promise<string>;
```

いずれも「失敗時は fallback を返す（throw しない）」実装が望ましい。オフラインテストではモックを注入する。

## 移植メモ

- 原典では `claude-api-client` を直 import していた LLM 呼び出しを、各関数の第 1 引数への注入に変更（`apiKey` はそのまま第 2 引数）。
- `pr-ops-service` の TIMING フォールバックは、モジュール読込時刻に固定されないよう関数化（`timingFallback()`）。
- ロジック・プロンプト原文・スコア計算は原典のまま。
