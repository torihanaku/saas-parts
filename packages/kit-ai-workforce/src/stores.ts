/**
 * 注入ストアのメモリ内リファレンス実装。テスト・ローカル検証・クイックスタート用。
 * 本番では各自の永続化層（Postgres/Firestore/Supabase…）で実装して差し替える。
 *
 * 出典: dev-dashboard-v2 の Supabase テーブル
 *       dashboard_characters / character_skills / role_models を
 *       インターフェース化したもの（実装は新規）。
 */
import type {
  Character,
  CharacterSkill,
  CharacterStore,
  CvEntry,
  CvStore,
  RoleModel,
  RoleModelStore,
  SkillStore,
  Task,
  TaskSeed,
  TaskStore,
} from "./types";

export interface InMemoryCharacterStore extends CharacterStore {
  rows: Map<string, Character>;
}

export function createInMemoryCharacterStore(seed: Character[] = []): InMemoryCharacterStore {
  const rows = new Map<string, Character>(seed.map((c) => [c.id, c]));
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(character) {
      rows.set(character.id, character);
      return character;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error("character_not_found");
      rows.set(id, { ...row, ...patch });
    },
    async remove(id) {
      // 元実装同様、is_custom=true のみ削除。
      const row = rows.get(id);
      if (row && row.isCustom !== false) rows.delete(id);
    },
    async findByName(name) {
      for (const c of rows.values()) {
        if (c.name === name) return c;
      }
      return null;
    },
  };
}

export interface InMemorySkillStore extends SkillStore {
  rows: CharacterSkill[];
}

export function createInMemorySkillStore(seed: CharacterSkill[] = []): InMemorySkillStore {
  const rows: CharacterSkill[] = [...seed];
  return {
    rows,
    async listByCharacter(characterId) {
      return rows.filter((s) => s.character_id === characterId);
    },
    async upsert(skill) {
      // UNIQUE(character_id, name)
      const exists = rows.some((s) => s.character_id === skill.character_id && s.name === skill.name);
      if (exists) return;
      rows.push(skill);
    },
    async all() {
      return [...rows];
    },
    async setProficiency(characterId, name, proficiency) {
      const skill = rows.find((s) => s.character_id === characterId && s.name === name);
      if (skill) skill.proficiency = proficiency;
    },
  };
}

export interface InMemoryRoleModelStore extends RoleModelStore {
  rows: Map<string, RoleModel>;
}

export function createInMemoryRoleModelStore(seed: RoleModel[] = []): InMemoryRoleModelStore {
  const rows = new Map<string, RoleModel>(seed.map((m) => [m.id, m]));
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(model) {
      rows.set(model.id, model);
      return model;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error("role_model_not_found");
      rows.set(id, { ...row, ...patch });
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

export interface InMemoryTaskStore extends TaskStore {
  rows: Map<string, Task>;
  seeds: TaskSeed[];
}

export function createInMemoryTaskStore(seed: Task[] = [], seeds: TaskSeed[] = []): InMemoryTaskStore {
  const rows = new Map<string, Task>(seed.map((t) => [t.id, t]));
  return {
    rows,
    seeds,
    async list(filter) {
      let out = [...rows.values()];
      if (filter?.clientId != null) out = out.filter((t) => t.clientId === filter.clientId);
      if (filter?.projectId != null) out = out.filter((t) => t.projectId === filter.projectId);
      if (filter?.status != null) out = out.filter((t) => t.status === filter.status);
      // created_at.desc に相当（新しいものが先）。
      return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(task) {
      rows.set(task.id, task);
      return task;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error("task_not_found");
      rows.set(id, { ...row, ...patch });
    },
    async remove(id) {
      rows.delete(id);
    },
    async listSeeds() {
      return [...seeds];
    },
  };
}

export interface InMemoryCvStore extends CvStore {
  rows: CvEntry[];
}

export function createInMemoryCvStore(seed: CvEntry[] = []): InMemoryCvStore {
  const rows: CvEntry[] = [...seed];
  return {
    rows,
    async insert(entry) {
      rows.push(entry);
    },
    async listByCharacter(characterId) {
      return rows
        .filter((e) => e.character_id === characterId)
        .sort((a, b) => b.completed_at.localeCompare(a.completed_at));
    },
  };
}
