/**
 * タスク割り当てと「AI社員が専門業務をこなして成長する」ライフサイクル。
 *
 * AI社員（Character）にタスクを `assignee`（名前）で割り当て、完了時に評価
 * （rating / comment）を受け取ると:
 *   1. assignee 名からキャラクターを引き当て、職務経歴（CV エントリ）を積み上げる
 *      —「職務経歴」の蓄積。
 *   2. rating >= 4 のときは、そのキャラクターのスキルを最大 3 件、熟練度ラダーで
 *      1 段階昇格させる — 成長メカニクス。
 *
 * 元実装（server/routes/tasks.ts）は Supabase REST・HTTP ハンドラ直結だった。
 * ここでは HTTP/認証/DB を剥がし、TaskStore / CharacterStore / SkillStore / CvStore
 * の注入に一般化した純粋なサービス関数として提供する（Response ではなくプレーンな
 * 値を返す）。認可・入力元（誰が呼ぶか）は呼び出し側の責務。
 *
 * ドロップ: 議事録 action_items からのタスク一括生成（transcript 依存の製品固有機能）
 * は移植していない。README「落としたもの」参照。
 *
 * 出典: server/routes/tasks.ts
 */
import type {
  Character,
  CharacterStore,
  CvEntry,
  CvStore,
  SkillStore,
  Task,
  TaskInput,
  TaskSeed,
  TaskStore,
} from "./types";

/**
 * 熟練度ラダー。左から右へ 1 段階ずつ昇格する。成長メカニクスの中核。
 * 元実装（tasks.ts L208）から verbatim に移植。
 */
export const PROFICIENCY_LEVELS = ["beginner", "intermediate", "advanced", "expert"] as const;

/** 1 回のフィードバックで昇格させるスキルの最大数（tasks.ts L218 verbatim）。 */
export const MAX_PROMOTIONS_PER_TASK = 3;

/** スキル自動昇格が発火する最低評価（tasks.ts L207 verbatim）。 */
export const PROMOTION_RATING_THRESHOLD = 4;

// ─── タスク CRUD ─────────────────────────────────────────────────────────────

/** タスク一覧（client_id / project_id / status で絞り込み）。 */
export async function listTasks(
  store: TaskStore,
  filter?: { clientId?: string | null; projectId?: string | null; status?: string },
): Promise<Task[]> {
  return store.list(filter);
}

/** スターター用タスクひな型一覧（未対応ストアなら空配列）。 */
export async function listTaskSeeds(store: TaskStore): Promise<TaskSeed[]> {
  if (!store.listSeeds) return [];
  return store.listSeeds();
}

/**
 * タスクを作成する。`assignee` に AI社員の名前を渡すと、その社員への割り当てになる。
 */
export async function createTask(store: TaskStore, input: TaskInput): Promise<Task> {
  if (!input.title) throw new Error("タイトルは必須です");
  const now = new Date().toISOString();
  const task: Task = {
    id: input.id || crypto.randomUUID(),
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "todo",
    priority: input.priority ?? "medium",
    assignee: input.assignee ?? null,
    dueDate: input.dueDate ?? null,
    clientId: input.clientId ?? null,
    projectId: input.projectId ?? null,
    sourceType: input.sourceType ?? "manual",
    sourceId: input.sourceId ?? null,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
  return store.insert(task);
}

/** タスクを更新する（assignee の付け替え＝担当の再割り当てもここで行う）。 */
export async function updateTask(store: TaskStore, id: string, patch: Partial<Task>): Promise<void> {
  if (!id) throw new Error("Invalid task ID");
  const updates: Partial<Task> = { ...patch, updatedAt: new Date().toISOString() };
  await store.update(id, updates);
}

/** タスクを削除する。 */
export async function deleteTask(store: TaskStore, id: string): Promise<void> {
  if (!id) throw new Error("Invalid task ID");
  await store.remove(id);
}

// ─── タスク・フィードバックループ（成長の中核） ──────────────────────────────

export interface TaskFeedback {
  rating: number;
  comment?: string;
  taskTitle?: string;
  /** 担当 AI社員の名前。null なら CV 記録・昇格ともに no-op。 */
  assignee?: string | null;
}

export interface TaskFeedbackResult {
  taskId: string;
  rating: number;
  /** assignee 名から引き当てたキャラクター（見つからなければ null）。 */
  character: Character | null;
  /** CV エントリを記録したか。 */
  cvRecorded: boolean;
  /** 昇格したスキル（name と new proficiency）。 */
  promotedSkills: { name: string; from: string; to: string }[];
}

/**
 * assignee 名からキャラクターを引き当てる。store.findByName があればそれを使い、
 * なければ list() の線形走査でフォールバックする。
 */
async function findCharacterByName(store: CharacterStore, name: string): Promise<Character | null> {
  if (store.findByName) return store.findByName(name);
  const all = await store.list();
  return all.find((c) => c.name === name) ?? null;
}

/**
 * タスク完了の評価を記録する。
 *
 * - assignee があればキャラクターを引き当て、CV エントリ（職務経歴）を 1 件挿入する。
 * - rating >= 4 なら、そのキャラクターのスキルを最大 3 件、熟練度ラダーで 1 段階昇格。
 * - assignee 未指定 / 引き当て失敗（未知の担当）は成長ループとしては no-op。
 *
 * rating は 1〜5。範囲外は例外。
 */
export async function recordTaskFeedback(
  taskId: string,
  feedback: TaskFeedback,
  stores: {
    characters: CharacterStore;
    skills: SkillStore;
    cv: CvStore;
  },
): Promise<TaskFeedbackResult> {
  if (!taskId) throw new Error("Invalid task ID");
  const { rating, comment, taskTitle, assignee } = feedback;
  if (!rating || rating < 1 || rating > 5) throw new Error("rating (1-5) が必要です");

  const result: TaskFeedbackResult = {
    taskId,
    rating,
    character: null,
    cvRecorded: false,
    promotedSkills: [],
  };

  if (!assignee) return result;

  // 担当キャラクターを名前で引き当て（未知なら no-op）。
  const character = await findCharacterByName(stores.characters, assignee);
  if (!character) return result;
  result.character = character;
  const characterId = character.id;

  // CV エントリ（職務経歴）を積み上げる。
  const entry: CvEntry = {
    character_id: characterId,
    task_id: taskId,
    title: taskTitle || "タスク完了",
    outcome: comment || "",
    skills_used: [],
    rating,
    completed_at: new Date().toISOString(),
  };
  await stores.cv.insert(entry);
  result.cvRecorded = true;

  // スキル自動昇格: rating >= 4 → 最大 3 件を 1 段階昇格（tasks.ts L207-233 verbatim ロジック）。
  if (rating >= PROMOTION_RATING_THRESHOLD) {
    const skills = await stores.skills.listByCharacter(characterId);
    for (const skill of skills.slice(0, MAX_PROMOTIONS_PER_TASK)) {
      const from = skill.proficiency as string;
      const idx = PROFICIENCY_LEVELS.indexOf(from as (typeof PROFICIENCY_LEVELS)[number]);
      if (idx >= 0 && idx < PROFICIENCY_LEVELS.length - 1) {
        const to = PROFICIENCY_LEVELS[idx + 1]!;
        if (stores.skills.setProficiency) {
          await stores.skills.setProficiency(characterId, skill.name, to);
        }
        result.promotedSkills.push({ name: skill.name, from, to });
      }
    }
  }

  return result;
}
