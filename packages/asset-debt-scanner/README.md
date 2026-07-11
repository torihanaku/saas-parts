# @torihanaku/asset-debt-scanner

「放置すると価値が下がる資産（＝負債）」を per-tenant で**巡回スキャンして劣化スコアと修繕提案を出す**フレームワーク。dev-dashboard-v2 の Marketing Debt Tracker (#355) から抽出しました。

> ドメイン用語（marketing debt / freshness / 6 asset 種別）はマーケティング由来です。汎用フレームワークとして asset 種別は文字列に緩め、テーブル名・文言は config / 注入で差し替えられます。

## 3 つのコア部品

### 1. scorer — 劣化スコアリング (`scorer.ts`)

freshness decay（時間経過）と asset 固有メタデータ（トラフィック減・順位下落・バウンス率など）を組み合わせ、`severity` と `recommendation` を導出します。

```ts
import { scoreDebtItem } from "@torihanaku/asset-debt-scanner";

const result = scoreDebtItem({
  tenantId: "t1",
  assetType: "seo_article",
  assetRef: "https://x/post",
  lastActiveAt: "2026-01-01T00:00:00Z",
  metadata: { currentRank: 18, previousRank: 4 },
});
// → { freshnessScore, decayRate, severity: "high" | "med" | "low", recommendation }
```

### 2. scanner — 巡回オーケストレータ + レジストリ (`scanner.ts`)

`AssetScanner` を名前で登録し、**並列実行**します。1 スキャナの失敗は他を止めません（per-scanner error isolation）。永続化は `ScanContext.store`（`DebtStore`）に注入、外部 HTTP プローブは `ScanContext.fetchImpl` に注入します。

```ts
import { createDefaultScannerRegistry } from "@torihanaku/asset-debt-scanner";

const registry = createDefaultScannerRegistry(); // 7 スキャナ全登録

const result = await registry.runAll(
  "tenant-1",
  {
    "dead-link": [{ url: "https://x/a" }],
    "seo-rank": [{ keyword: "foo", rank_30d_ago: 3, rank_today: 15 }],
    // 未指定スキャナは空入力で no-op
  },
  {
    store: async (records) => {
      // dd_marketing_debt_items 等へ upsert して記録件数を返す
      await upsertDebtRows(records);
      return records.length;
    },
    fetchImpl: fetch,
  },
);
// result: { tenantId, scanners: { <name>: {ok, summary, error} }, totalRecorded, durationMs }
```

独自スキャナは `AssetScanner` を実装して `registry.register(scanner)` で追加できます。

### 3. suggester — 修繕提案 (`suggester.ts`)

負債 1 件に対し、LLM で 3 案の修正提案を生成します。LLM 呼び出しは `GenerateJson` を注入。API キー未指定なら `FALLBACK_SUGGESTIONS` を返します。

```ts
import { generateDebtSuggestions } from "@torihanaku/asset-debt-scanner";

const suggestions = await generateDebtSuggestions(
  { assetType: "link", assetRef: "https://x/old", severity: "high", recommendation: "404", apiKey },
  generateJson, // @torihanaku/claude-api 互換の generateJson
);
```

## 同梱スキャナ（`AssetScanner` の実装例）

| name | 検出内容 | asset_type | 外部依存 |
|---|---|---|---|
| `dead-link` | HTTP 4xx/5xx・timeout・network error | `link` | fetch 注入 |
| `image` | 404・placeholder(極小)・empty(0byte) | `content` | fetch 注入 |
| `seo-quality` | title/meta/h1/img alt の問題（純粋関数） | `seo_article` | なし |
| `seo-rank` | 30 日で 5 位以上の順位下落 | `seo_keyword` | 入力 rows 注入 |
| `dormant-email` | 90 日以上未送信のキャンペーン | `email_campaign` | 入力 rows 注入 |
| `crm-bounce` | bounce 率 > 5% の配信リスト | `crm_data` | 入力 rows 注入 |
| `schedule-expiry` | 予定時刻を過ぎた pending スケジュール | `campaign` | 入力 rows 注入 |

いずれもコアの `AssetScanner` 契約に沿った移植であり、DB 読み書きは呼び出し側の注入（`store` / 入力 rows）に置換しています。

## 出典

- `server/lib/marketing-debt-scorer.ts`（scorer）
- `server/lib/marketing-debt/scanner-orchestrator.ts`（orchestrator）
- `server/lib/marketing-debt/suggester.ts`（suggester）
- `server/lib/marketing-debt/*-scanner.ts`（7 scanners）

feature flag 判定・Supabase 直アクセス・env 読み取りはアプリ側の責務として除外しています。
