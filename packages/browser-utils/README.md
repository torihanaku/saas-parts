# @torihanaku/browser-utils

ブラウザ向けの小物ユーティリティ（UTF-8 BOM付きCSVのクライアントサイドダウンロード＋日付/テキストフォーマッタ）。

## 主要API

```ts
import {
  exportToCsv,
  formatDate,
  formatDateTime,
  formatDateShort,
  truncate,
} from "@torihanaku/browser-utils";

// 行オブジェクト配列 → CSV(BOM付き・カンマ/引用符/改行エスケープ) → Blob → <a download> でDL
exportToCsv("report", [
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
]); // → report.csv がダウンロードされる（空配列なら何もしない）

formatDate("2024-03-05T12:00:00+09:00");            // "2024/03/05"（デフォルト ja-JP）
formatDate("2024-03-05T12:00:00+09:00", "en-US");   // "03/05/2024"（ロケール指定可）
formatDateTime("2024-03-05T12:00:00+09:00");        // "2024/03/05 12:00"
formatDateShort("2024-03-05T12:00:00+09:00");       // "2024年3月5日"
truncate("hello world", 5);                          // "hello..."
```

## 依存

なし（DOM標準の `Blob` / `URL.createObjectURL` / `document` と `Intl` のみ）。

## 注入ポイント

- 各 format 関数の第2引数 `locale` — 元実装でハードコードされていた `ja-JP` をオプション引数化（デフォルト `ja-JP`）

## 想定ランタイム

ブラウザ（`exportToCsv` は DOM 必須。format/truncate は Node.js でも動作するが出力は実行環境の ICU に依存）。

## 出典

- `実運用SaaS/src/lib/exportCsv.ts`
- `実運用SaaS/src/utils/format.ts`
