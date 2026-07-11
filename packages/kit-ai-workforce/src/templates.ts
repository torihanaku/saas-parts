/**
 * AI社員テンプレート: 一覧・タグ絞り込み・クローン（チームへ追加）。
 *
 * テンプレート = 事前定義された AI社員のひな型（役割・性格・スキル一式）。
 * clone するとストアに新しいキャラクターとスキル群を登録する。
 *
 * 元実装（server/routes/character-templates/templates.ts）は静的 JSON 読み込みと
 * Supabase 挿入だった。ここではテンプレート配列と CharacterStore / SkillStore の
 * 注入に一般化した。
 *
 * 出典: server/routes/character-templates/templates.ts + shared.ts の型。
 */
import type {
  Character,
  CharacterStore,
  CharacterTemplate,
  SkillStore,
} from "./types";

/** タグでテンプレートを絞り込む（tags は小文字比較）。 */
export function filterTemplates(
  templates: CharacterTemplate[],
  tags?: string[],
): CharacterTemplate[] {
  if (!tags || tags.length === 0) return templates;
  const tagList = tags.map((t) => t.trim().toLowerCase());
  return templates.filter((t) => t.tags.some((tag) => tagList.includes(tag.toLowerCase())));
}

export interface CloneResult {
  character: { id: string; name: string; role: string };
  skillsAdded: number;
  templateSlug: string;
}

/**
 * テンプレートを clone してチームに追加する。
 */
export async function cloneTemplate(
  templates: CharacterTemplate[],
  characterStore: CharacterStore,
  skillStore: SkillStore,
  slug: string,
  opts: { clientId?: string | null } = {},
): Promise<CloneResult> {
  const template = templates.find((t) => t.slug === slug);
  if (!template) throw new Error(`Template '${slug}' not found`);

  const character: Character = {
    id: crypto.randomUUID(),
    name: template.name,
    role: template.role,
    roleDescription: template.roleDescription,
    team: template.team,
    personality: template.personality,
    agentConfig: template.agentConfig,
    clientId: opts.clientId ?? null,
    isCustom: true,
    presetId: "template",
    templateSlug: slug,
    currentTask: "",
    progress: 0,
    collaborators: [],
    status: "休憩中",
  };
  const saved = await characterStore.insert(character);

  let skillsAdded = 0;
  for (const skill of template.skills) {
    try {
      await skillStore.upsert({
        character_id: saved.id,
        name: skill.name,
        category: skill.category,
        proficiency: skill.proficiency,
        source: "template",
      });
      skillsAdded++;
    } catch {
      /* duplicate */
    }
  }

  return {
    character: { id: saved.id, name: template.name, role: template.role },
    skillsAdded,
    templateSlug: slug,
  };
}
