# @torihanaku/documents

プロジェクト向けドキュメントの CRUD と、テンプレート＋プロジェクト文脈からの AI 生成（LLM 注入）を提供します。テンプレート管理、ドキュメントのバージョニング、コメント（注釈）機能も含みます。

各メソッドは `ServiceResult<T>`（`{ ok: true; data }` / `{ ok: false; status; error }`）を返し、HTTP・認証・ルーティングはホスト側の責務です。

## 用途

- ドキュメントテンプレートの一覧・作成（内蔵4テンプレを初回自動シード）
- ドキュメントの作成・取得・一覧・更新・削除
- バージョニング（`newVersion` で version+1 ／ parent_id 連結）
- コメント（未解決のみ一覧、本文 2000 文字上限）
- テンプレート＋プロジェクト文脈から AI 本文生成（LLM 注入）

## API例

```ts
import { DocumentService, InMemoryDocumentStore } from "@torihanaku/documents";

const store = new InMemoryDocumentStore(
  // assembleProjectContext 相当。省略時は空文脈
  async (projectId) => fetchProjectContext(projectId),
);

const docs = new DocumentService({
  store,
  // Claude 等の呼び出しを注入。返り値 null で「APIキー未設定」プレースホルダ経路
  llm: async (prompt) => {
    const { text, model } = await callClaude(prompt);
    return { text, model };
  },
});

await docs.listTemplates();                              // 内蔵テンプレを初回シード
const created = await docs.createDocument("proj-1", { title: "要件定義書", template_type: "requirements" });
const gen = await docs.generate(created.ok ? created.data.id : "", { additional_instructions: "簡潔に" });
// gen.data.content_markdown / content_html / model_used / context_summary
const v2 = await docs.newVersion(created.ok ? created.data.id : "");
await docs.createComment(docId, "editor@example.com", { body: "ここを直したい" });
```

## 注入ポイント

- `DocumentStore` — 永続化。元実装の Supabase REST（`cockpit_document_templates` / `cockpit_documents` / `cockpit_document_comments`）を型付きメソッドに集約。`assembleProjectContext`（`cockpit_projects` / `cockpit_clients` / `cockpit_transcripts` / `cockpit_slack_messages` / `cockpit_project_sources` を読む）も `assembleProjectContext(projectId)` として注入。`InMemoryDocumentStore` を同梱（文脈プロバイダをコンストラクタ引数で注入可）
- `DocumentLLM` — `(prompt) => Promise<{ text; model } | null>`。元実装の Anthropic REST 呼び出しを注入 IF 化。`null` を返すと元の「ANTHROPIC_API_KEY 未設定」プレースホルダ本文を生成
- `uuid` / `now` — テスト決定性

## SQL スキーマ（要点）

```sql
CREATE TABLE cockpit_document_templates (
  id            uuid PRIMARY KEY,
  user_id       text NOT NULL,        -- 内蔵は 'system'
  name          text NOT NULL,
  template_type text NOT NULL,        -- requirements / report / proposal / meeting-notes / custom
  description   text,
  prompt_template text NOT NULL,      -- {{context}} を差し込み
  output_format text NOT NULL DEFAULT 'markdown',
  is_builtin    boolean NOT NULL DEFAULT false,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cockpit_documents (
  id              uuid PRIMARY KEY,
  project_id      uuid NOT NULL,
  user_id         text NOT NULL,
  title           text NOT NULL,
  template_type   text NOT NULL,
  content_markdown text,
  content_html    text,
  source_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 生成時の ProjectContext
  prompt_used     text,
  model_used      text,
  version         int  NOT NULL DEFAULT 1,
  parent_id       uuid,                                 -- newVersion で連結
  status          text NOT NULL DEFAULT 'draft',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cockpit_document_comments (
  id            uuid PRIMARY KEY,
  document_id   uuid NOT NULL REFERENCES cockpit_documents(id) ON DELETE CASCADE,
  author_email  text NOT NULL,
  author_name   text NOT NULL,
  body          text NOT NULL,          -- 2000 文字上限 (API で enforce)
  anchor        jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at   timestamptz,            -- NULL のみ一覧表示
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

## 元実装からの変更点

- Supabase REST 直呼び → `DocumentStore` 注入
- Anthropic REST 呼び出し（`api.anthropic.com/v1/messages`）→ `DocumentLLM` 注入。APIキー解決／`getTenantSecret`／`env` 参照はホスト側へ移動
- HTTP `Response` → `ServiceResult<T>`。ステータス/メッセージは保持
- `requireRole` / `checkAuth` / feature gate は除外
- 内蔵テンプレの初回シード、markdownToHtml、buildContextString はロジックそのまま移植

## 出典

- `dev-dashboard-v2/server/routes/documents/{index,shared,crud,generate}.ts`（#230）
```
