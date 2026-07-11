# @torihanaku/transcribe-client

AssemblyAI の音声書き起こしAPIの薄いラッパー（音声URL投入 → 話者分離付き書き起こしをポーリング取得。3秒→12秒上限の線形バックオフ、10分ハードタイムアウト、`TranscribeError` で失敗種別を区別）。

## 主要API

```ts
import { transcribeAudio, TranscribeError } from "@torihanaku/transcribe-client";

try {
  const result = await transcribeAudio(
    {
      url: "https://example.com/meeting.mp3", // http(s) 絶対URL必須
      language: "ja",          // デフォルト "ja"
      speakerLabels: true,     // デフォルト true（話者分離）
    },
    { apiKey: myConfig.assemblyAiKey },
  );
  // result: { id, text, language, utterances: [{ speaker, text, start, end }] }
} catch (e) {
  if (e instanceof TranscribeError) {
    // キー未設定 / submit・poll のHTTP失敗 / ジョブがerror終了 / 10分タイムアウト
  }
}
```

## 依存

なし（fetch標準のみ。`fetchWithTimeout` は本パッケージ内にプライベートコピーを内包）。

## 注入ポイント

- `config.apiKey` — AssemblyAI APIキー（必須。env読みはしないので呼び出し側の設定層から渡す）
- `config.baseUrl` — APIベースURL（デフォルト `https://api.assemblyai.com/v2`。モックサーバー向け）
- `config.fetchImpl` — fetch実装の差し替え（テスト用。デフォルト `globalThis.fetch`）
- `transcribeAudio` 第3引数 `sleep` — ポーリング待機の差し替え（テスト用。デフォルト setTimeout）

## 想定ランタイム

Node.js 18+ / Bun（サーバーサイド。全fetchに30秒タイムアウト付きでインスタンスのハングを防止）。

## 出典

`dev-dashboard-v2/server/lib/transcribe-client.ts`（`fetchWithTimeout` は同 `server/lib/helpers.ts` から内包）
