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
  RoleModel,
  RoleModelStore,
  SkillStore,
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
