/**
 * ロールモデルライブラリ ＋ チームコンポーザー。
 *
 * ロールモデル = 実在人物などの役割を情報源から取り込み、LLM で代表スキル・行動傾向を
 * 抽出して AI社員のひな型にする仕組み。チームコンポーザーはプロジェクト説明から
 * 必要なチーム構成を提案し、既存 AI社員とマッチングする。
 *
 * 元実装（server/routes/team-characters/role-models.ts）は Supabase・Anthropic API 直結
 * だった。ここでは RoleModelStore / CharacterStore / LlmCaller の注入に一般化した。
 *
 * 出典: server/routes/team-characters/role-models.ts
 */
import type { Character, CharacterStore, LlmCaller, RoleModel, RoleModelStore } from "./types";

export async function listRoleModels(store: RoleModelStore): Promise<RoleModel[]> {
  return store.list();
}

export async function createRoleModel(
  store: RoleModelStore,
  input: { name: string; role?: string; description?: string },
): Promise<RoleModel> {
  if (!input.name) throw new Error("nameは必須です");
  const now = new Date().toISOString();
  const model: RoleModel = {
    id: crypto.randomUUID(),
    name: input.name,
    role: input.role ?? "",
    description: input.description ?? "",
    sources: [],
    extractedSkills: [],
    extractedTendencies: [],
    lastExtractedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return store.insert(model);
}

export async function updateRoleModel(
  store: RoleModelStore,
  id: string,
  patch: Partial<Pick<RoleModel, "name" | "role" | "description" | "sources">>,
): Promise<void> {
  if (!id) throw new Error("Invalid role model ID");
  await store.update(id, { ...patch, updatedAt: new Date().toISOString() });
}

export async function deleteRoleModel(store: RoleModelStore, id: string): Promise<void> {
  if (!id) throw new Error("Invalid role model ID");
  await store.remove(id);
}

/**
 * 情報源からこの人物の代表スキル・行動傾向を LLM で抽出し、ロールモデルに保存する。
 */
export async function extractRoleModel(
  store: RoleModelStore,
  llm: LlmCaller,
  id: string,
): Promise<{ extractedSkills: string[]; extractedTendencies: string[]; lastExtractedAt: string }> {
  if (!id) throw new Error("Invalid role model ID");
  const roleModel = await store.get(id);
  if (!roleModel) throw new Error("ロールモデルが見つかりません");

  const sourceSummary = roleModel.sources
    .map((s) => {
      const parts = [`[${s.type ?? "unknown"}]`];
      if (s.title) parts.push(`タイトル: ${s.title}`);
      if (s.url) parts.push(`URL: ${s.url}`);
      if (s.content) parts.push(`内容: ${s.content.slice(0, 200)}`);
      return parts.join(" / ");
    })
    .join("\n");

  const userMessage = `人物名: ${roleModel.name}\n役割: ${roleModel.role}\n説明: ${roleModel.description ?? ""}\n\n情報源:\n${sourceSummary || "（情報源なし）"}`;
  const system = `あなたは人物分析の専門家です。提供された情報源からこの人物の代表的なスキルと行動傾向を抽出してください。JSON形式で: {"extractedSkills": [...], "extractedTendencies": [...]} 各項目は短く具体的に（10文字以内）。`;

  const extracted = await llm.generateJson<{
    extractedSkills?: string[];
    extractedTendencies?: string[];
  }>(system, userMessage, {});

  const skills = extracted.extractedSkills ?? [];
  const tendencies = extracted.extractedTendencies ?? [];
  const now = new Date().toISOString();
  await store.update(id, {
    extractedSkills: skills,
    extractedTendencies: tendencies,
    lastExtractedAt: now,
    updatedAt: now,
  });
  return { extractedSkills: skills, extractedTendencies: tendencies, lastExtractedAt: now };
}

// ─── チームコンポーザー ─────────────────────────────────────────────────────

export interface SuggestedRole {
  role: string;
  description: string;
  isMissing: boolean;
  existingMatch?: { id: string; name: string; specializations: string[] };
}

export interface TeamComposition {
  projectSummary: string;
  suggestedTeam: SuggestedRole[];
}

/**
 * プロジェクト説明から必要なチーム構成を提案し、既存 AI社員とマッチングする。
 */
export async function composeTeam(
  characterStore: CharacterStore,
  llm: LlmCaller,
  projectDescription: string,
): Promise<TeamComposition> {
  if (!projectDescription) throw new Error("projectDescriptionが必要です");

  const existingChars: Character[] = await characterStore.list();
  const charSummary =
    existingChars
      .map((c) => `- ${c.name} (専門: ${(c.agentConfig?.specializations ?? []).join(", ") || "未設定"})`)
      .join("\n") || "（既存キャラクターなし）";

  const system = `あなたはAIチームのディレクターです。プロジェクトの説明を受け取り、必要なチーム構成を提案してください。
既存キャラクターの一覧と専門領域も提供するので、マッチングを行ってください。
以下のJSON形式で返してください:
{
  "projectSummary": "プロジェクトの要点（1〜2文）",
  "suggestedTeam": [
    { "role": "役割名", "description": "この役割に求められること（1文）", "existingMatchName": "既存キャラクター名またはnull", "isMissing": true/false }
  ]
}
isMissingはexistingMatchNameがnullの場合true。suggestedTeamは3〜6件が適切。`;

  const parsed = await llm.generateJson<{
    projectSummary: string;
    suggestedTeam: { role: string; description: string; existingMatchName?: string | null; isMissing: boolean }[];
  }>(system, `プロジェクト説明:\n${projectDescription}\n\n既存キャラクター:\n${charSummary}`, {
    projectSummary: "",
    suggestedTeam: [],
  });

  return {
    projectSummary: parsed.projectSummary,
    suggestedTeam: parsed.suggestedTeam.map((item) => {
      const match = item.existingMatchName
        ? existingChars.find((c) => c.name === item.existingMatchName)
        : null;
      return {
        role: item.role,
        description: item.description,
        isMissing: item.isMissing,
        existingMatch: match
          ? { id: match.id, name: match.name, specializations: match.agentConfig?.specializations ?? [] }
          : undefined,
      };
    }),
  };
}
