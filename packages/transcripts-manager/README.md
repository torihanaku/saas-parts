# @torihanaku/transcripts-manager

会議・打ち合わせの書き起こしレコードを管理します。書き起こしの CRUD、ライフサイクルのステータス遷移、音声メタデータ管理、構造化抽出、アクション抽出、議事録生成、検索を提供します。

各メソッドは `ServiceResult<T>` を返し、HTTP・認証・BYOK キー解決はホスト側の責務です。

## 用途

- 書き起こしレコードの作成・取得・一覧・更新・削除
- ステータス遷移: `pending` → `transcribing` → `structuring` → `completed` / `error`
- 音声メタデータ管理（ファイル名・サイズ・MIME・保存パス、50MB 上限、対応形式検証）
- 構造化抽出（要約・決定事項・アクション・重要点・参加者を LLM で JSON 化）
- アクション抽出（バックログ登録用に優先度をマッピング）
- 議事録ドラフト生成
- タイトル・本文・要約の全文検索

## 書き起こし API（transcription）の扱い

音声→テキスト変換（Whisper 等）そのものは **`@torihanaku/transcribe-client` の領域**です。本パッケージは transcribe-client を **import しません**。代わりに `TranscriptionClient` インターフェースを注入します（`runTranscription` が委譲）。ホスト側で transcribe-client をこの IF に接続してください。未注入時は 501 を返します。

## API例

```ts
import { TranscriptService, InMemoryTranscriptStore } from "@torihanaku/transcripts-manager";

const svc = new TranscriptService({
  store: new InMemoryTranscriptStore(),
  // 音声→テキスト: @torihanaku/transcribe-client をここに接続（本パッケージは import しない）
  transcribe: async ({ storagePath, mimeType, filename }) => {
    const text = await transcribeClient.run(storagePath, { mimeType, filename });
    return { text };
  },
  // 構造化 LLM（Claude 等）
  llm: async (prompt) => ({ text: await callClaude(prompt) }),
  // アクション抽出・議事録生成（元 content-engine）
  extractActions: async (text) => extractActionItems(text),
  generateNotes: async ({ topic, extraContext }) => ({ content: await genNotes(topic, extraContext) }),
  // 抽出結果の保存先（省略可）
  sinks: {
    saveBacklogItems: async (items) => saveToBacklog(items),
    saveNotesDraft: async (draft) => saveDraft(draft),
  },
});

const t = await svc.create(projectId, { title: "定例MTG" });
await svc.attachAudio(id, { filename: "rec.mp3", sizeBytes, mimeType: "audio/mpeg", storagePath: `${id}.mp3` });
await svc.runTranscription(id);   // → structuring
await svc.structure(id);          // → completed
await svc.extractActionItems(id); // 優先度: high→P1-High / medium→P2-Medium / low→P3-Low
await svc.generateMeetingNotes(id);
await svc.search("予算", projectId);
```

## 注入ポイント

- `TranscriptStore` — 永続化（元 `cockpit_transcripts`）。`InMemoryTranscriptStore` 同梱
- `TranscriptionClient` — 音声→テキスト。**@torihanaku/transcribe-client を接続**（本パッケージは import しない）
- `TranscriptLLM` — 構造化用の生 LLM 呼び出し `(prompt) => { text }`
- `ActionExtractor` / `NotesGenerator` — 元 `content-engine` の `extractActionItems` / `generateContent`
- `TranscriptSinks` — バックログ／議事録ドラフトの保存先（元 `batchInsert` / `dd_content_drafts`）
- `uuid` / `now` — テスト決定性

## SQL スキーマ（要点: `cockpit_transcripts`）

```sql
CREATE TABLE cockpit_transcripts (
  id                     uuid PRIMARY KEY,
  project_id             uuid NOT NULL,
  user_id                text NOT NULL DEFAULT 'system',
  title                  text NOT NULL,
  audio_filename         text,
  audio_size_bytes       bigint,
  audio_duration_seconds numeric,
  audio_mime_type        text,
  raw_transcript         text,
  summary                text,
  decisions              jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_points             jsonb NOT NULL DEFAULT '[]'::jsonb,
  participants           jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                 text NOT NULL DEFAULT 'pending',  -- pending/transcribing/structuring/completed/error
  error_message          text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- storage_path / notes_draft_id / action_items_extracted_at
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
```

補助テーブル（sinks 経由）: `dashboard_backlog`（アクション登録）, `dd_content_drafts`（議事録ドラフト）。

## 元実装からの変更点

- Supabase REST 直呼び → `TranscriptStore` 注入
- Whisper 呼び出し（`api.openai.com/v1/audio/transcriptions`）→ `TranscriptionClient` 注入 IF（transcribe-client の領域として import せず明記）
- Claude 構造化呼び出し → `TranscriptLLM` 注入。プロンプト文言・```json フェンス除去・JSON parse フォールバックはそのまま移植
- `content-engine.extractActionItems` / `generateContent` → `ActionExtractor` / `NotesGenerator` 注入
- Supabase Storage アップロード → ホスト責務。`attachAudio` は検証＋メタデータ記録のみ（`storagePath` を受け取る）
- HTTP `Response` → `ServiceResult<T>`。ステータス/メッセージは保持

## 出典

- `dev-dashboard-v2/server/routes/transcripts/{index,crud,audio,actions}.ts`（#226 / #523 / #531 / #1160）
```
