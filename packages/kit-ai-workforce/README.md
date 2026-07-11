# @torihanaku/kit-ai-workforce

「AI社員」システムの自己完結キット。

## 製品コンセプト

**AI社員** とは、「役割・性格・スキルを持つ AI キャラクターが、人間の同僚のように
チームを組んで働く」という製品コンセプトです。各キャラクターは所属チーム・専門
スキル・作業状態（作業中／完了／休憩中…）を持ち、タスクが来ると最適な担当者が
アサインされ、進捗がリアルタイムに可視化されます。

このキットは、その中核ロジックを DB・HTTP・LLM・特定クラウドから切り離し、
**すべて注入（injection）** で動くように一般化したものです。フェイク SaaS や
社内ダッシュボード、AI エージェントのチーム編成 UI などに移植できます。

- 製品オーナー向けの詳しい思想は `docs/AI社員スタートブック.pdf` /
  `docs/AI社員マスターブック.pdf` を参照（バイナリ同梱）。

## コア API

| 領域 | エクスポート | 説明 |
|------|-------------|------|
| 状態機械 | `WorkforceState` | AI社員のライブ状態・アクティビティログ・セッション追跡・**SSE ブロードキャスト**（`broadcastNotification` / `broadcastStateChange`）。ロジックは元実装から verbatim。 |
| マッチング | `matchCharacters` / `extractKeywords` / `deriveGroupKey` | タスク文からキーワードを抽出し、**BM25** で最適な AI社員をランキング。 |
| BM25 | `computeBm25Scores` ほか | TF-IDF 改良版スコアリング（プライベートコピー）。専門度（proficiency）で重み付け。 |
| キャラクター | `createCharacter` / `updateCharacter` / `deleteCharacter` | AI社員 CRUD。`specializations` を自動でスキル行に展開。 |
| Character Studio | `generateInterviewQuestions` / `generateCharacterDefinition` | 役割イメージ → LLM で AI社員定義を生成。 |
| ロールモデル | `createRoleModel` / `extractRoleModel` / … | 実在人物などの情報源から LLM で代表スキル・傾向を抽出し、ひな型化。 |
| チームコンポーザー | `composeTeam` | プロジェクト説明 → 必要なチーム構成を提案し既存 AI社員とマッチング。 |
| テンプレート | `filterTemplates` / `cloneTemplate` | AI社員ひな型の一覧・タグ絞り込み・クローン。 |
| プリセット | `EXAMPLE_PRESETS` / `EXAMPLE_TEMPLATES` / `ORIGINAL_*` | 世界観プリセット。汎用サンプルとオリジナル IP（温存）。 |
| メモリ内ストア | `createInMemoryCharacterStore` ほか | テスト・クイックスタート用の参照実装。 |
| クライアント | `useTeamState` / `useLiveState` | React フック（peer: react >=18）。 |

### クイックスタート

```ts
import {
  createInMemoryCharacterStore,
  createInMemorySkillStore,
  cloneTemplate,
  matchCharacters,
  EXAMPLE_TEMPLATES,
} from "@torihanaku/kit-ai-workforce";

const characters = createInMemoryCharacterStore();
const skills = createInMemorySkillStore();

await cloneTemplate(EXAMPLE_TEMPLATES, characters, skills, "backend-engineer");
await cloneTemplate(EXAMPLE_TEMPLATES, characters, skills, "marketing-specialist");

const { matches } = await matchCharacters(characters, skills, {
  taskTitle: "API設計 の相談",
});
// → バックエンドエンジニアが上位に
```

## 注入ポイント

このパッケージは外部依存を一切持たず、以下を注入して使います。

- **`LlmCaller`** — `generateJson<T>(system, prompt, fallback)` と
  `generateText(system, prompt)` の 2 メソッド。`@torihanaku/claude-api` や
  OpenAI SDK を薄くラップして満たせます。未注入でも BM25 マッチング等は動作。
- **`CharacterStore` / `SkillStore` / `RoleModelStore`** — 永続化層。
  `createInMemory*Store()` が参照実装。本番は Postgres/Firestore/Supabase 等で実装。
- **`StateStore`**（任意）— `WorkforceState` の永続化フック
  （`saveState` / `loadState` / `saveActivity`…）。未指定ならメモリ内のみ。
- **`useLiveState(fetchState, intervalMs)`** — `/state` を取得する `fetchState`
  関数を注入（認証・ベース URL はプロダクト側）。

## SQL スキーマ

元実装（Supabase）のテーブルに対応します（PostgreSQL 例）。

```sql
-- AI社員本体
CREATE TABLE dashboard_characters (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  avatar            TEXT DEFAULT '/avatars/default.png',
  role              TEXT DEFAULT '',
  official_title    TEXT DEFAULT '',
  official_title_en TEXT DEFAULT '',
  role_description  TEXT DEFAULT '',
  skills            JSONB DEFAULT '[]'::jsonb,
  team              TEXT NOT NULL,
  status            TEXT DEFAULT '休憩中',
  current_task      TEXT DEFAULT '',
  progress          INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  collaborators     JSONB DEFAULT '[]'::jsonb,
  is_custom         BOOLEAN DEFAULT false,
  client_id         UUID,
  preset_id         TEXT DEFAULT 'business',
  template_slug     TEXT,
  agent_config      JSONB,
  personality       JSONB,
  continuity        JSONB,
  role_model_id     UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- スキル（BM25 の文書に相当）
CREATE TABLE character_skills (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id TEXT NOT NULL REFERENCES dashboard_characters(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  category     TEXT DEFAULT '',
  -- ⚠️ 本キットの BM25 は proficiency を文字列ラベル（beginner/intermediate/
  --    advanced/expert）で扱う。元 DB は INTEGER 版もあるため、移植時は
  --    proficiency のラベル体系を PROFICIENCY_WEIGHT に合わせること。
  proficiency  TEXT DEFAULT 'intermediate',
  source       TEXT DEFAULT 'manual',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (character_id, name)   -- BM25 が TF=0/1 前提にしている制約
);

-- ロールモデル
CREATE TABLE role_models (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  role                  TEXT DEFAULT '',
  description           TEXT DEFAULT '',
  sources               JSONB DEFAULT '[]'::jsonb,
  extracted_skills      JSONB DEFAULT '[]'::jsonb,
  extracted_tendencies  JSONB DEFAULT '[]'::jsonb,
  last_extracted_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- プリセット（世界観の切り替え）
CREATE TABLE character_presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_builtin  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

## 落としたもの（と理由）

- **Supabase / fetch / RBAC / テナントシークレット直結** — 自己完結のため全撤去。
  認可（admin 判定）は呼び出し側の責務。
- **pgvector セマンティック検索 + RRF ハイブリッド** — 外部埋め込み基盤
  （OpenAI embeddings・`match_characters_by_embedding` RPC・RLS ステージング）に
  依存するため除外。BM25 の純粋パスのみ移植（IDF は全スキル走査からその場計算）。
- **アバターアップロード（Supabase Storage / base64 デコード）** — ストレージ依存。
- **パイプライントリガー・BigQuery コスト集計・resume/CV ルート** — プロダクト固有の
  外部連携（GitHub Actions dispatch / BigQuery）で AI社員コンセプトの中核ではない。
- **fs による state.json / activity.json / commands.json 永続化** — `StateStore`
  フック注入に置換（デフォルトはメモリ内）。SSE と状態機械のロジック自体は verbatim。
- **`process.env` / Redis キャッシュ** — 撤去。

## 出典

- `dev-dashboard-v2`（READ-ONLY）
  - `server/lib/state.ts` → `state.ts`
  - `server/lib/bm25.ts` → `bm25.ts`（プライベートコピー）
  - `server/routes/team-characters/{characters,role-models,presets-resume}.ts`
    → `characters.ts` / `role-models.ts` / `presets.ts`
  - `server/routes/character-templates/{templates,match,shared}.ts`
    → `templates.ts` / `matching.ts`
  - `server/routes/project-characters.ts`（型・デフォルト設計の参考）
  - `src/pages/team/useTeamState.ts` + `src/hooks/useLiveState.ts` → `client/`
  - `supabase/migrations`（スキーマ）
- 製品書籍 `docs/AI社員スタートブック.pdf` / `docs/AI社員マスターブック.pdf`

`EXAMPLE_PRESETS` / `EXAMPLE_TEMPLATES` は汎用サンプル。`ORIGINAL_PRESETS` /
`ORIGINAL_CHARACTER_NAMES`（ドラゴンボールZ 世界観）は製品オーナーの IP として温存。
