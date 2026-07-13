# @torihanaku/transcript-parser

字幕・書き起こしファイル（VTT / SRT / プレーンテキスト）を、話者ラベルを保った素のテキストに変換する依存ゼロのパーサーです。

## 主要API

### `detectFormat(fileName, content): TranscriptFormat`

ファイル名の拡張子と先頭数行の内容から形式（`"vtt" | "srt" | "plain" | "unknown"`）を判定します。

```ts
import { detectFormat } from "@torihanaku/transcript-parser";

detectFormat("meeting.vtt", "");                          // "vtt"
detectFormat("notes.txt", "1\n00:00:01,000 --> ...");     // "srt"（内容から推定）
detectFormat("notes.md", "Bob: Hello");                   // "unknown"
```

### `parseTranscript(content, format): ParsedTranscript`

指定した形式でパースし、タイミングキュー・インデックス番号・メタ行を除去した本文を返します。話者ラベル（例 `Bob: Hello`）はそのまま残ります。

```ts
import { parseTranscript } from "@torihanaku/transcript-parser";

const out = parseTranscript(
  "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nBob: Hello\n",
  "vtt",
);
// out.text     → "Bob: Hello"
// out.cueCount → 1
// out.format   → "vtt"
```

### `parseTranscriptFile(fileName, content): ParsedTranscript`

`detectFormat` → `parseTranscript` をまとめて実行する便利関数です。

```ts
import { parseTranscriptFile } from "@torihanaku/transcript-parser";

parseTranscriptFile("meeting.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nBob: hi\n");
// → { text: "Bob: hi", cueCount: 1, format: "vtt" }
```

`ParsedTranscript` は `{ text: string; cueCount: number; format: TranscriptFormat }` を持ちます（`cueCount === 0` は空／不正なファイルを表します）。

## 対応フォーマットと対応ツール

| フォーマット | 内容 |
| --- | --- |
| VTT (WebVTT) | `WEBVTT` ヘッダ・`NOTE`/`STYLE`/`REGION` ブロック・`<c.color>…</c>` タグを除去 |
| SRT (SubRip) | 連番インデックス・`00:00:01,000 --> 00:00:04,000` 形式のタイミングを除去 |
| plain / unknown | タイミング除去を行わず、トリムした素のテキストをそのまま返す |

Tactiq / Otter / Zoom Cloud Recording など、一般的な書き起こしツールが出力する VTT・SRT をそのまま処理できます。

## Runtime

any（ブラウザ / Node / Bun / Edge いずれでも動作。外部依存なし）

## 出典

`実運用SaaS/src/utils/transcriptParser.ts` からロジックを忠実に移植しました。
