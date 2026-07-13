# @torihanaku/command-palette

コマンドパレット用のクライアント部品。自由入力コマンドの送信・履歴取得を行う React フック（`useCommands`）と、送信前プレビュー用のクライアント側分類器（`classifyCommand` / `createClassifier`）を提供する。

移植元: 実運用SaaS `src/hooks/useCommands.ts`（72 LOC）。

## なぜバックエンドを同梱しないか

元実装のバックエンド `POST /api/command`（`server/routes/core-chat.ts`）はプロダクト固有のタスク生成ロジック（intent判定 → GitHub Issue作成 / Anthropic APIでのQ&A / Supabaseバックログ追加 / ファイルへの履歴保存）であり、再利用可能な汎用部品ではないため抽出対象外とした。なお `server/routes/command-palette.ts` は Cmd+K の横断検索（Supabaseテーブル横断の ilike 検索 + 静的コマンド一覧）で、これも本フックの対向ではない。

## バックエンド API 契約

このフックと互換のバックエンドは次の2エンドポイントを実装する:

### `GET /api/commands` — 履歴一覧

レスポンス: `Command[]`（`{ items: Command[] }` / `{ data: Command[] }` 形式も可）

```ts
interface Command {
  id: string;
  text: string;       // 入力された自由文
  assignee: string;   // 分類された担当
  repo: string;       // 分類されたリポジトリ
  labels: string[];
  timestamp: string;  // ISO 8601
  issueUrl?: string;  // 作成された Issue 等へのリンク
}
```

### `POST /api/command` — コマンド送信

リクエスト: `{ "text": string }`（空文字は 400）

レスポンス（元実装。intentにより可変）:

```jsonc
{
  "text": "...", "intent": "develop|dashboard|question|backlog", "createdAt": "ISO8601",
  // develop/dashboard の場合:
  "assignee": "...", "repo": "...", "labels": ["..."], "issueUrl": "https://...",
  // question の場合:
  "answer": "...",
  // backlog の場合:
  "message": "「...」をバックログに追加しました"
}
```

フックはレスポンスボディを解釈せず、成功/失敗（真偽値）のみ返して履歴を再取得する。

## 使い方

```tsx
import { useCommands, classifyCommand, createClassifier } from "@torihanaku/command-palette";

function Palette() {
  const { commands, sendCommand, loading, refetch } = useCommands({
    // 省略可: api（get/post注入）, endpoints { list, send }
  });

  // 送信前プレビュー（クライアント側分類）
  const preview = classifyCommand("デザインを直して");
  // → { assignee: "18号（デザイン担当）", repo: "techradar-ai" }
}
```

### 分類ルールの差し替え

元実装ではルールがハードコードされていたが、設定として注入できる（先勝ち・小文字化した本文に対して正規表現でマッチ）:

```ts
const classify = createClassifier(
  [
    { pattern: /課金|billing/, assignee: "Billing Team", repo: "billing-service" },
    { pattern: /デザイン|ui/, assignee: "Design", repo: "frontend" },
  ],
  { assignee: "Triage", repo: "monolith" } // フォールバック
);
```

`DEFAULT_CLASSIFIER_RULES` / `DEFAULT_CLASSIFIER_FALLBACK` が元実装のルール（ドラゴンボールの担当キャラ名）をそのまま保持している。

## peerDependencies

- `react >= 18`
