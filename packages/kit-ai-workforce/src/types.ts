/**
 * 「AI社員」システムのコア型定義。
 *
 * AI社員 = 役割・性格・スキルを持つAIキャラクターがチームとして働く、という
 * 製品コンセプトを表現するデータモデル。すべての永続化はストア注入で行い、
 * このパッケージ自体は DB/HTTP/LLM に直接依存しない。
 *
 * 出典: dev-dashboard-v2
 *   - server/routes/team-characters/*  (characters / role-models / presets)
 *   - server/routes/character-templates/*  (templates / match)
 *   - supabase/migrations の dashboard_characters / character_skills / role_models
 */

// ─── スキル ────────────────────────────────────────────────────────────────

/** 熟練度ラベル。BM25 の proficiency 重みとテンプレートで使用。 */
export type Proficiency = "beginner" | "intermediate" | "advanced" | "expert";

/** キャラクターが保持する 1 スキル（character_skills 行に対応）。 */
export interface CharacterSkill {
  character_id: string;
  name: string;
  category?: string;
  /** 文字列ラベル。BM25 の PROFICIENCY_WEIGHT と対応。 */
  proficiency: Proficiency | string;
  /** "manual" | "studio" | "template" 等の由来。 */
  source?: string;
}

// ─── キャラクター（AI社員） ──────────────────────────────────────────────────

export interface AgentConfig {
  archetype: string; // orchestrator | executor | specialist | support
  workingStyle: string; // autonomous | collaborative | review-only
  specializations: string[];
  canDelegateTo?: string[];
}

export interface Personality {
  communicationStyle?: string;
  tendencies?: string[];
  [key: string]: unknown;
}

/** 1 人の AI社員。dashboard_characters 行に対応。 */
export interface Character {
  id: string;
  name: string;
  team: string;
  avatar?: string;
  role?: string;
  officialTitle?: string;
  officialTitleEn?: string;
  roleDescription?: string;
  skills?: unknown[];
  status?: string;
  currentTask?: string;
  progress?: number;
  collaborators?: string[];
  isCustom?: boolean;
  clientId?: string | null;
  presetId?: string;
  templateSlug?: string;
  agentConfig?: AgentConfig | null;
  personality?: Personality | null;
  continuity?: Record<string, unknown> | null;
  roleModelId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** 作成入力（id は任意。未指定なら生成）。 */
export type CharacterInput = Partial<Character> & { name: string; team: string };

// ─── ロールモデル（実在人物の役割を参照した AI社員のひな型） ──────────────────

export interface RoleModelSource {
  type?: string;
  title?: string;
  url?: string;
  content?: string;
}

export interface RoleModel {
  id: string;
  name: string;
  role?: string;
  description?: string;
  sources: RoleModelSource[];
  extractedSkills: string[];
  extractedTendencies: string[];
  lastExtractedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ─── テンプレート（静的な AI社員プリセット定義） ─────────────────────────────

export interface TemplateSkill {
  name: string;
  category: string;
  proficiency: Proficiency;
}

export interface CharacterTemplate {
  slug: string;
  name: string;
  role: string;
  roleDescription: string;
  team: string;
  personality: Record<string, unknown>;
  agentConfig: {
    archetype: string;
    workingStyle: string;
    specializations: string[];
  };
  skills: TemplateSkill[];
  tags: string[];
}

// ─── LLM 注入ポイント ────────────────────────────────────────────────────────

/**
 * LLM 呼び出しは実装を注入する。@torihanaku/claude-api や OpenAI SDK を薄く
 * ラップして満たせる。パッケージ内部はプロバイダに一切依存しない。
 */
export interface LlmCaller {
  /** JSON 構造化出力。パース失敗時は fallback を返す実装にする。 */
  generateJson<T>(system: string, prompt: string, fallback: T): Promise<T>;
  /** プレーンテキスト補完。 */
  generateText(system: string, prompt: string): Promise<string>;
}

// ─── ストア注入ポイント ──────────────────────────────────────────────────────

/** キャラクター永続化。Postgres/Firestore/Supabase 等で実装して差し替える。 */
export interface CharacterStore {
  list(): Promise<Character[]>;
  get(id: string): Promise<Character | null>;
  insert(character: Character): Promise<Character>;
  update(id: string, patch: Partial<Character>): Promise<void>;
  /** isCustom=true のみ削除する実装が望ましい。 */
  remove(id: string): Promise<void>;
  /**
   * 名前で 1 件検索（dashboard_characters?name=eq.<name> 相当）。
   * 成長ループが assignee 名からキャラクターを引き当てるのに使う。
   * 未実装なら list() を線形走査するフォールバックが使われる。
   */
  findByName?(name: string): Promise<Character | null>;
}

/** スキル永続化（character_skills 相当）。 */
export interface SkillStore {
  listByCharacter(characterId: string): Promise<CharacterSkill[]>;
  /** UNIQUE(character_id, name) を尊重（重複は無視）。 */
  upsert(skill: CharacterSkill): Promise<void>;
  /** マッチング用: 全キャラの全スキルを走査（小規模前提の参照実装）。 */
  all(): Promise<CharacterSkill[]>;
  /**
   * 既存スキルの熟練度を書き換える（character_skills?character_id=eq&name=eq を
   * PATCH proficiency 相当）。成長ループのスキル自動昇格で使う。
   * 未実装だと昇格は no-op になる。
   */
  setProficiency?(characterId: string, name: string, proficiency: string): Promise<void>;
}

/** ロールモデル永続化（role_models 相当）。 */
export interface RoleModelStore {
  list(): Promise<RoleModel[]>;
  get(id: string): Promise<RoleModel | null>;
  insert(model: RoleModel): Promise<RoleModel>;
  update(id: string, patch: Partial<RoleModel>): Promise<void>;
  remove(id: string): Promise<void>;
}

// ─── タスク（AI社員への仕事の割り当て） ──────────────────────────────────────

/**
 * 1 件のタスク。cockpit_tasks 行に対応。`assignee` は担当する AI社員（Character）の
 * 名前で、完了評価時にこの名前からキャラクターを引き当てて成長ループを回す。
 */
export interface Task {
  id: string;
  title: string;
  description?: string;
  /** todo | in-progress | done */
  status?: string;
  /** critical | high | medium | low */
  priority?: string;
  /** 担当 AI社員の名前（dashboard_characters.name と照合）。 */
  assignee?: string | null;
  dueDate?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  /** manual | transcript | slack — 由来。 */
  sourceType?: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** タスク作成入力（id は任意。未指定なら生成）。 */
export type TaskInput = Partial<Task> & { title: string };

/**
 * 職務経歴（CV）1 件。character_cv_entries 行に対応。
 * 完了評価のたびに担当キャラクターへ積み上がる「実績」。
 */
export interface CvEntry {
  character_id: string;
  task_id?: string | null;
  title: string;
  outcome?: string;
  skills_used?: string[];
  rating?: number | null;
  completed_at: string;
}

/** スターター用のタスクひな型（task_seeds 相当）。 */
export interface TaskSeed {
  id: string | number;
  title: string;
  description?: string;
  priority?: string;
  [key: string]: unknown;
}

// ─── タスク・成長ループのストア注入ポイント ──────────────────────────────────

/** タスク永続化（cockpit_tasks 相当）。 */
export interface TaskStore {
  list(filter?: { clientId?: string | null; projectId?: string | null; status?: string }): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  insert(task: Task): Promise<Task>;
  update(id: string, patch: Partial<Task>): Promise<void>;
  remove(id: string): Promise<void>;
  /** スターター用のタスクひな型一覧（未対応なら空配列でよい）。 */
  listSeeds?(): Promise<TaskSeed[]>;
}

/** 職務経歴（CV）永続化（character_cv_entries 相当）。 */
export interface CvStore {
  insert(entry: CvEntry): Promise<void>;
  listByCharacter(characterId: string): Promise<CvEntry[]>;
}
