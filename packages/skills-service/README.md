# @torihanaku/skills-service

社内ノウハウを「スキル」として体系化するための CRUD と、AI によるスキル定義の生成・改善（LLM 注入）を提供します。

各メソッドは `ServiceResult<T>` を返し、HTTP・認証はホスト側の責務です。

## 用途

- スキルの作成・取得・一覧・更新・削除（クライアント単位でスコープ）
- `skill_type`（analysis / generation / review / research / custom）と `category`（marketing / pr / development / design / custom）の検証
- 更新のたびに `version` を自動インクリメント
- AI 生成: 目的説明＋ソース資料から JSON スキル定義を生成
- AI 改善: 質問生成モード（回答なし）／定義改善モード（回答あり）

## API例

```ts
import { SkillService, InMemorySkillStore } from "@torihanaku/skills-service";

const store = new InMemorySkillStore();
const skills = new SkillService({
  store,
  // Claude 等。null を返すとテンプレ / 標準質問のフォールバック
  llm: async (prompt) => ({ text: await callClaude(prompt) }),
});

// CRUD
const created = await skills.create({ name: "競合分析", definition: "...", skill_type: "analysis", category: "marketing" });
await skills.update(id, { definition: "改訂版" }); // version+1
await skills.list(clientId);

// AI 生成（ソース資料を混ぜて JSON 定義を生成）
const gen = await skills.generate({ description: "議事録を要約するスキル", source_ids: ["src-1"], client_id });
// gen.data.skill = { name, skill_type, category, definition, examples, triggers, version }

// AI 改善（回答なし → 質問生成 / 回答あり → 定義改善して保存）
const q = await skills.refine(id);                       // mode: "questions"
const refined = await skills.refine(id, { question: "Q&A テキスト" }); // mode: "refined"（保存）
```

## 注入ポイント

- `SkillStore` — 永続化。元実装は `cockpit_project_sources`（`source_type='skill'`、スキル固有値は metadata JSONB）を利用。`getSourceMaterials(ids)` で生成用のソース資料も取得。`InMemorySkillStore` 同梱
- `SkillLLM` — `(prompt) => Promise<{ text } | null>`。元実装の Anthropic REST（`fetchWithTimeout`）を注入 IF 化。`null` を返すと元の「APIキー未設定」フォールバック（生成=テンプレ定義／改善=標準質問5件）
- `uuid` / `now` — テスト決定性

## SQL スキーマ（出典どおり: 既存テーブル流用）

新規マイグレーションは不要です。既存の `cockpit_project_sources` を `source_type='skill'` で流用し、スキル固有値を `metadata` に格納します。

```sql
-- 既存テーブル cockpit_project_sources を流用
--   project_id  → client_id（スキルのクライアントスコープ）
--   name        → スキル名
--   description → 説明
--   source_type = 'skill'
--   metadata JSONB:
--     { skill_type, category, definition, examples[], triggers[], version }
```

`InMemorySkillStore` は論理的な `SkillRow`（`client_id` / `name` / `description` / `metadata`）を直接扱うため、ホスト側の実装で上記テーブルにマッピングしてください。

## 元実装からの変更点

- Supabase REST 直呼び（`cockpit_project_sources`）→ `SkillStore` 注入
- Anthropic REST 呼び出し（生成／質問生成／定義改善の3経路）→ 単一の `SkillLLM` 注入。プロンプト文言・JSON 抽出（`{...}` / `[...]` 正規表現）・parse フォールバックはそのまま移植
- 「APIキー未設定」時のテンプレ定義／標準質問フォールバックを維持
- HTTP `Response` → `ServiceResult<T>`。ステータス/メッセージ/レスポンス形状（`generated` / `ai_powered` / `mode` 等）を保持
- `requireRole` / BYOK キー解決（`getTenantSecret`）はホスト側へ

## 出典

- `dev-dashboard-v2/server/routes/skills/{index,shared,crud,ai}.ts`
```
