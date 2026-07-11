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
| タスク・成長ループ | `createTask` / `updateTask` / `listTasks` / `recordTaskFeedback` | AI社員へのタスク割り当て（`assignee`）と、完了評価 → 職務経歴（CV）記録 → スキル自動昇格。 |
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

## タスク割り当てと成長ループ

「AI社員が専門業務をこなして成長する」ライフサイクルです。人間の同僚と同じように、
タスクを任せ → 完了して評価され → 職務経歴が積み上がり → 得意分野が伸びる、という
サイクルを回します。

```
タスク作成(assignee=社員名) ──▶ 完了評価(rating/comment)
        │                              │
        ▼                              ▼
  cockpit_tasks              ①assignee 名でキャラクター引き当て
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                              ▼
              ②CV エントリを挿入          ③rating>=4 ならスキル自動昇格
              (職務経歴の蓄積)             (最大 3 件を 1 段階アップ)
              character_cv_entries         character_skills.proficiency
```

- **割り当て**: `createTask(taskStore, { title, assignee, ... })`。`assignee` は
  担当 AI社員の **名前**（`dashboard_characters.name` と照合）。`updateTask` で
  付け替え＝再割り当て。
- **完了評価（成長ループの中核）**: `recordTaskFeedback(taskId, { rating, comment,
  taskTitle, assignee }, { characters, skills, cv })`。
  1. `assignee` 名からキャラクターを引き当てる（`CharacterStore.findByName`、
     未実装なら `list()` を線形走査でフォールバック）。
  2. **CV エントリ**を 1 件挿入する（`character_cv_entries`: character_id / task_id /
     title / outcome / skills_used / rating / completed_at）— これが「職務経歴」の蓄積。
  3. **スキル自動昇格**: `rating >= 4` のとき、そのキャラクターのスキルを **最大 3 件**、
     熟練度ラダー `PROFICIENCY_LEVELS`（`beginner → intermediate → advanced → expert`）で
     **1 段階** 昇格させる。`expert` は上限で頭打ち。しきい値（`rating>=4`・最大 3 件）と
     ラダーは元実装から **verbatim**（`PROMOTION_RATING_THRESHOLD` /
     `MAX_PROMOTIONS_PER_TASK` / `PROFICIENCY_LEVELS` としてエクスポート）。
  - `assignee` 未指定、または名前が引き当たらない（**未知の担当**）場合は、CV 記録・
    昇格ともに **no-op**（例外を投げず、`character: null` を返す）。`rating` は 1〜5。

```ts
import {
  createInMemoryCharacterStore,
  createInMemorySkillStore,
  createInMemoryCvStore,
  createInMemoryTaskStore,
  createTask,
  recordTaskFeedback,
} from "@torihanaku/kit-ai-workforce";

const characters = createInMemoryCharacterStore([{ id: "c1", name: "太郎", team: "eng" }]);
const skills = createInMemorySkillStore([
  { character_id: "c1", name: "API設計", proficiency: "beginner", source: "manual" },
]);
const cv = createInMemoryCvStore();
const tasks = createInMemoryTaskStore();

const task = await createTask(tasks, { title: "認証APIを実装", assignee: "太郎" });
const res = await recordTaskFeedback(task.id, { rating: 5, assignee: "太郎", taskTitle: "認証API" }, { characters, skills, cv });
// res.promotedSkills → [{ name: "API設計", from: "beginner", to: "intermediate" }]
// cv.listByCharacter("c1") → 職務経歴 1 件
```

### 注入ポイント（成長ループ）

- **`TaskStore`** — `cockpit_tasks` 相当。`list` / `get` / `insert` / `update` /
  `remove`、任意で `listSeeds`（スターター用ひな型 `task_seeds`）。
- **`CvStore`** — `character_cv_entries` 相当。`insert` / `listByCharacter`。
- **`CharacterStore.findByName`**（任意）— assignee 名の引き当て。未実装でも
  `list()` フォールバックで動く。
- **`SkillStore.setProficiency`**（任意）— 昇格の書き込み。未実装だと昇格は no-op。

いずれも `createInMemory{Task,Cv}Store()` と、既存 `createInMemory{Character,Skill}Store()`
（`findByName` / `setProficiency` を実装済み）が参照実装です。

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

-- タスク（AI社員への仕事の割り当て）
CREATE TABLE cockpit_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID,
  client_id    UUID,
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'todo',      -- todo | in-progress | done
  priority     TEXT NOT NULL DEFAULT 'medium',    -- critical | high | medium | low
  assignee     TEXT,                              -- 担当 AI社員の名前（dashboard_characters.name）
  due_date     TEXT,
  source_type  TEXT,                              -- manual | transcript | slack
  source_id    UUID,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 職務経歴（CV）— 完了評価のたびに担当キャラクターへ積み上がる実績
CREATE TABLE character_cv_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id TEXT NOT NULL REFERENCES dashboard_characters(id) ON DELETE CASCADE,
  task_id      UUID,
  title        TEXT NOT NULL,
  outcome      TEXT DEFAULT '',
  skills_used  JSONB DEFAULT '[]'::jsonb,
  rating       INTEGER CHECK (rating BETWEEN 1 AND 5),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 成長ループでは character_skills.proficiency を beginner→intermediate→advanced→expert の
-- 文字列ラダーで 1 段階ずつ UPDATE する（rating>=4 のとき最大 3 件）。上の character_skills 参照。

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
- **議事録 action_items からのタスク一括生成**（`tasks.ts` の
  `POST /api/tasks/import-from-transcript`）— `cockpit_transcripts` テーブル依存で
  製品・書き起こし固有のため移植していない。タスク作成の一般 API（`createTask`）で
  代替可能（source_type を "transcript" にして呼ぶだけ）。
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
  - `server/routes/tasks.ts` → `tasks.ts`（タスク割り当て＋成長ループ。
    transcript 由来のタスク生成は除外）
  - `server/routes/project-characters.ts`（型・デフォルト設計の参考）
  - `src/pages/team/useTeamState.ts` + `src/hooks/useLiveState.ts` → `client/`
  - `supabase/migrations`（スキーマ）
- 製品書籍 `docs/AI社員スタートブック.pdf` / `docs/AI社員マスターブック.pdf`

`EXAMPLE_PRESETS` / `EXAMPLE_TEMPLATES` は汎用サンプル。`ORIGINAL_PRESETS` /
`ORIGINAL_CHARACTER_NAMES`（ドラゴンボールZ 世界観）は製品オーナーの IP として温存。
