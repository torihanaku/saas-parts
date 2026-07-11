/**
 * AI社員（キャラクター）の CRUD ＋ Character Studio（LLM で役割から定義を生成）。
 *
 * 元実装（server/routes/team-characters/characters.ts）は Supabase・Anthropic API・
 * テナントシークレット・RBAC・アバターアップロードに直結した HTTP ハンドラだった。
 * このキットでは HTTP/認証/ストレージを剥がし、純粋なドメインロジックとして
 * CharacterStore / SkillStore / LlmCaller の注入に一般化した。認可（admin 判定）は
 * 呼び出し側の責務とする。
 *
 * 出典: server/routes/team-characters/characters.ts
 */
import type {
  AgentConfig,
  Character,
  CharacterInput,
  CharacterStore,
  LlmCaller,
  Personality,
  SkillStore,
} from "./types";

/**
 * AI社員を作成する。specializations があれば character_skills にも展開する。
 */
export async function createCharacter(
  store: CharacterStore,
  skillStore: SkillStore | undefined,
  input: CharacterInput,
): Promise<Character> {
  if (!input.name || !input.team) {
    throw new Error("名前とチームは必須です");
  }
  const character: Character = {
    id: input.id || `custom-${Date.now()}`,
    name: input.name,
    avatar: input.avatar || "/avatars/default.png",
    role: input.role || "",
    officialTitle: input.officialTitle || "",
    officialTitleEn: input.officialTitleEn || "",
    roleDescription: input.roleDescription || "",
    skills: input.skills || [],
    team: input.team,
    status: input.status || "休憩中",
    currentTask: input.currentTask || "",
    progress: input.progress || 0,
    collaborators: input.collaborators || [],
    isCustom: true,
    clientId: input.clientId ?? null,
    presetId: input.presetId || "custom",
    agentConfig: input.agentConfig ?? null,
    personality: input.personality ?? null,
    continuity: input.continuity ?? null,
    roleModelId: input.roleModelId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const saved = await store.insert(character);

  const specializations = character.agentConfig?.specializations ?? [];
  if (skillStore) {
    for (const skillName of specializations) {
      if (typeof skillName === "string" && skillName.trim()) {
        await skillStore
          .upsert({ character_id: saved.id, name: skillName.trim(), source: "studio", proficiency: "intermediate" })
          .catch(() => {
            /* ignore duplicate */
          });
      }
    }
  }
  return saved;
}

/**
 * AI社員を更新する。specializations があれば character_skills を追記する。
 */
export async function updateCharacter(
  store: CharacterStore,
  skillStore: SkillStore | undefined,
  id: string,
  patch: Partial<Character>,
): Promise<void> {
  if (!id || id.length > 100) throw new Error("Invalid character ID");
  const updates: Partial<Character> = { ...patch, updatedAt: new Date().toISOString() };
  await store.update(id, updates);

  const specializations = patch.agentConfig?.specializations;
  if (skillStore && Array.isArray(specializations)) {
    for (const skillName of specializations) {
      if (typeof skillName === "string" && skillName.trim()) {
        await skillStore
          .upsert({ character_id: id, name: skillName.trim(), source: "studio", proficiency: "intermediate" })
          .catch(() => {
            /* already exists */
          });
      }
    }
  }
}

/** AI社員を削除する（実装側で isCustom=true のみ許可する想定）。 */
export async function deleteCharacter(store: CharacterStore, id: string): Promise<void> {
  if (!id || id.length > 100) throw new Error("Invalid character ID");
  await store.remove(id);
}

// ─── Character Studio（LLM 生成） ────────────────────────────────────────────

export interface StudioQuestion {
  id: string;
  text: string;
  options?: string[];
}

/**
 * 役割イメージから、AI社員を定義するためのインタビュー質問を生成する。
 */
export async function generateInterviewQuestions(
  llm: LlmCaller,
  roleDescription: string,
): Promise<{ questions: StudioQuestion[] }> {
  if (!roleDescription) throw new Error("roleDescriptionが必要です");
  const system = `あなたはAIチームの人事担当者です。ユーザーが作りたいAIキャラクターの役割説明を受け取り、そのキャラクターの能力・性格・働き方を明確にするための質問を3〜5つ生成してください。
回答はJSON形式で返してください: { "questions": [{ "id": "q1", "text": "質問文", "options": ["選択肢A", "選択肢B", "選択肢C"] }] }
optionsは選択肢がある場合のみ含めてください。自由記述の場合はoptionsを省略。`;
  return llm.generateJson(system, roleDescription, { questions: [] });
}

export interface GeneratedCharacterDefinition {
  name: string;
  role: string;
  roleDescription: string;
  personality: Personality;
  agentConfig: AgentConfig;
}

/**
 * インタビュー回答から AI社員の完全な定義を生成する。
 */
export async function generateCharacterDefinition(
  llm: LlmCaller,
  roleDescription: string,
  answers: { questionId: string; question: string; answer: string }[],
): Promise<GeneratedCharacterDefinition> {
  if (!roleDescription || !answers) throw new Error("roleDescriptionとanswersが必要です");
  const answersText = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
  const system = `あなたはAIチームの人事担当者です。ユーザーの回答からAIキャラクターの完全な定義を生成してください。
以下のJSON形式で返してください:
{
  "name": "キャラクター名（日本語）",
  "role": "役職名",
  "roleDescription": "役割の説明（2〜3文）",
  "personality": {
    "communicationStyle": "コミュニケーションスタイルの説明",
    "tendencies": ["傾向1", "傾向2", "傾向3"]
  },
  "agentConfig": {
    "archetype": "orchestrator | executor | specialist | support のいずれか",
    "workingStyle": "autonomous | collaborative | review-only のいずれか",
    "specializations": ["専門領域1", "専門領域2"],
    "canDelegateTo": []
  }
}`;
  const userMessage = `役割イメージ: ${roleDescription}\n\n回答:\n${answersText}`;
  const fallback: GeneratedCharacterDefinition = {
    name: "",
    role: "",
    roleDescription: "",
    personality: {},
    agentConfig: { archetype: "specialist", workingStyle: "collaborative", specializations: [], canDelegateTo: [] },
  };
  return llm.generateJson(system, userMessage, fallback);
}
