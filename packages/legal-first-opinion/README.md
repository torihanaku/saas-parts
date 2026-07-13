# @torihanaku/legal-first-opinion

契約・広告文の **AI ファーストオピニオン**（一次見解）を生成するキット。日本の 4 法令（薬機法・景品表示法・特定商取引法・個人情報保護法）について、法令ごとに「違反 / 非該当」の判定とその根拠（リスク指摘・確認観点）を返す。実運用SaaS `server/lib/legal/first-opinion.ts` の移植。

## ⚠️ 免責事項（重要）

**本モジュールの出力は AI による一次判定であり、確定的な法的助言ではありません。**
最終判断は必ず弁護士・社内法務に確認してください。

この免責文（`STANDARD_DISCLAIMER`）は **全ての opinion に強制付与** されます（AI 出力に欠落しても後処理で補完）。ルールベースの確定的な違反検知が必要な場合は本モジュールの範囲外です — これはグレー領域の二次判定・非該当根拠の自動生成を目的とします。

## 特徴

- **LLM 注入式**: `generateJson` を注入（`@torihanaku/claude-api` 互換）。
- **API キー解決も注入式**: 原典の tenant-secret → env fallback を `resolveApiKey` に置換。省略時はキー無し＝全件 fallback（`process.env` 非依存）。
- **プロンプト原文デフォルト**: 法令ごとの few-shot・システムプロンプト・出力スキーマは原典のまま同梱。
- **graceful degradation**: AI 失敗時も免責付き fallback opinion を返し、無言の成功にはならない。

## 使い方

```ts
import { generateFirstOpinion, type FirstOpinionDeps } from "@torihanaku/legal-first-opinion";
import { generateJson } from "@torihanaku/claude-api";

const deps: FirstOpinionDeps = {
  generateJson,
  resolveApiKey: async (tenantId) =>
    (tenantId ? await getTenantKey(tenantId) : "") || process.env.ANTHROPIC_API_KEY || "",
};

const result = await generateFirstOpinion(deps, {
  contentText: "このサプリでシミが消える！即効性で痩せる！",
  laws: ["yakki", "keihyo"], // 省略時は 4 法令全件
  tenantId: "tenant-123",    // BYOK 用
});

for (const op of result.opinions) {
  console.log(op.lawLabel, op.violated ? "違反の可能性" : "非該当", op.reasoning);
  console.log(op.disclaimer); // 常に STANDARD_DISCLAIMER
}
console.log("全件AI由来:", result.fromAi); // 1件でも fallback があれば false
```

## 対象法令

| コード | ラベル |
| --- | --- |
| `yakki` | 薬機法 |
| `keihyo` | 景品表示法 |
| `tokusho` | 特定商取引法 |
| `kojinjoho` | 個人情報保護法 |

入力の `laws` に未対応コードを混ぜても無視される（`SUPPORTED_LAWS` でフィルタ）。

## 移植メモ

- `generateFirstOpinion(input)` → `generateFirstOpinion(deps, input)` に変更（依存を第 1 引数に注入）。
- `env.ANTHROPIC_API_KEY` / `getTenantSecret` を `resolveApiKey(tenantId)` に一本化。
- `console.error` を `logger`（省略時 no-op）に置換。
- 判定ロジック・免責文言・few-shot・出力 JSON スキーマは原典のまま。
