/**
 * Skills service — CRUD for codified company know-how ("skills") plus AI
 * generation and refinement of skill definitions.
 *
 * Ported from 実運用SaaS `server/routes/skills/{index,crud,ai,shared}.ts`.
 * The Claude REST calls are replaced by an injected {@link SkillLLM}; when
 * omitted (or returning null), the original "no API key" template / standard-
 * questions fallbacks run.
 */
import type { SkillStore } from "./store";
import {
  VALID_CATEGORIES,
  VALID_SKILL_TYPES,
  buildGeneratePrompt,
  buildQuestionsPrompt,
  buildRefinePrompt,
  extractJsonArray,
  extractJsonObject,
  isValidUUID,
  templateSkill,
  toSkillView,
  STANDARD_QUESTIONS,
  type GeneratedSkill,
  type SkillMetadata,
  type SkillRow,
  type SkillView,
} from "./types";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}
function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** Injected LLM. Returns generated text, or null to trigger the fallback path. */
export type SkillLLM = (prompt: string) => Promise<{ text: string } | null>;

export interface SkillServiceOptions {
  store: SkillStore;
  llm?: SkillLLM;
  uuid?: () => string;
  now?: () => Date;
}

export interface CreateSkillInput {
  client_id?: string;
  name?: string;
  description?: string;
  category?: string;
  definition?: string;
  examples?: unknown[];
  triggers?: unknown[];
  skill_type?: string;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  skill_type?: string;
  category?: string;
  definition?: string;
  examples?: unknown[];
  triggers?: unknown[];
}

export class SkillService {
  private store: SkillStore;
  private llm?: SkillLLM;
  private uuid: () => string;
  private now: () => Date;

  constructor(opts: SkillServiceOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  async list(clientId?: string): Promise<ServiceResult<SkillView[]>> {
    if (clientId && !isValidUUID(clientId)) return fail(400, "Invalid client_id");
    const rows = await this.store.list(clientId);
    return ok(rows.map(toSkillView));
  }

  async get(id: string): Promise<ServiceResult<SkillView>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const row = await this.store.get(id);
    if (!row) return fail(404, "Skill not found");
    return ok(toSkillView(row));
  }

  async create(input: CreateSkillInput): Promise<ServiceResult<SkillView>> {
    if (input.client_id && !isValidUUID(input.client_id)) return fail(400, "Invalid client_id");
    if (!input.name) return fail(400, "name is required");
    if (!input.definition) return fail(400, "definition is required");

    const skillType = VALID_SKILL_TYPES.includes(input.skill_type as never)
      ? (input.skill_type as string)
      : "custom";
    const category = VALID_CATEGORIES.includes(input.category as never)
      ? (input.category as string)
      : "custom";

    const nowIso = this.iso();
    const row: SkillRow = {
      id: this.uuid(),
      client_id: input.client_id || null,
      name: input.name,
      description: input.description || "",
      metadata: {
        skill_type: skillType,
        category,
        definition: input.definition,
        examples: input.examples || [],
        triggers: input.triggers || [],
        version: 1,
      },
      created_at: nowIso,
      updated_at: nowIso,
    };
    await this.store.insert(row);
    return ok(toSkillView(row));
  }

  /** Update; bumps metadata.version. */
  async update(
    id: string,
    input: UpdateSkillInput,
  ): Promise<ServiceResult<{ ok: true; id: string; version: number }>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const current = await this.store.get(id);
    if (!current) return fail(404, "Skill not found");

    const updatedMeta: SkillMetadata = { ...current.metadata };
    if (input.skill_type !== undefined) updatedMeta.skill_type = input.skill_type;
    if (input.category !== undefined) updatedMeta.category = input.category;
    if (input.definition !== undefined) updatedMeta.definition = input.definition;
    if (input.examples !== undefined) updatedMeta.examples = input.examples;
    if (input.triggers !== undefined) updatedMeta.triggers = input.triggers;
    updatedMeta.version = (current.metadata.version || 1) + 1;

    const patch: Partial<SkillRow> = { metadata: updatedMeta, updated_at: this.iso() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;

    const done = await this.store.patch(id, patch);
    if (!done) return fail(500, "Failed to update skill in database");
    return ok({ ok: true, id, version: updatedMeta.version });
  }

  async delete(id: string): Promise<ServiceResult<{ ok: true; id: string }>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    await this.store.delete(id);
    return ok({ ok: true, id });
  }

  // ─── AI: generate ────────────────────────────────────────────────────────────

  async generate(input: {
    description?: string;
    source_ids?: string[];
    client_id?: string;
  }): Promise<
    ServiceResult<{
      generated: true;
      ai_powered: boolean;
      parse_error?: boolean;
      message: string;
      raw_response?: string;
      skill: GeneratedSkill;
      source_ids?: string[];
      client_id?: string | null;
    }>
  > {
    const description = input.description;
    if (!description) return fail(400, "description is required");

    // Gather source materials (if any).
    let sourceMaterials = "";
    const ids = Array.isArray(input.source_ids) ? input.source_ids : [];
    if (ids.length > 0) {
      const sources = await this.store.getSourceMaterials(ids);
      sourceMaterials = sources.map((s) => `--- ${s.name || "Source"} ---\n${s.content}`).join("\n\n");
    }

    const llmResult = this.llm ? await this.llm(buildGeneratePrompt(description, sourceMaterials)) : null;
    if (!llmResult) {
      return ok({
        generated: true,
        ai_powered: false,
        message: "ANTHROPIC_API_KEY not configured. Returning template-based skill definition.",
        skill: templateSkill(description),
      });
    }

    const parsed = extractJsonObject(llmResult.text);
    if (!parsed) {
      return ok({
        generated: true,
        ai_powered: true,
        parse_error: true,
        message: "AI generated a response but it could not be parsed as JSON. Raw response included.",
        raw_response: llmResult.text,
        skill: {
          name: `スキル: ${description.substring(0, 50)}`,
          skill_type: "custom",
          category: "custom",
          definition: llmResult.text,
          examples: [],
          triggers: [],
          version: 1,
        },
      });
    }

    return ok({
      generated: true,
      ai_powered: true,
      message: "Skill definition generated. Review and edit before saving.",
      skill: {
        name: (parsed.name as string) || `スキル: ${description.substring(0, 50)}`,
        skill_type: (parsed.skill_type as string) || "custom",
        category: (parsed.category as string) || "custom",
        definition: (parsed.definition as string) || "",
        examples: (parsed.examples as unknown[]) || [],
        triggers: (parsed.triggers as unknown[]) || [],
        version: 1,
      },
      source_ids: ids,
      client_id: input.client_id || null,
    });
  }

  // ─── AI: refine (questions mode + refined mode) ────────────────────────────────

  /** No question → clarifying questions; question provided → refined definition. */
  async refine(
    id: string,
    input: { question?: string } = {},
  ): Promise<
    ServiceResult<
      | { skill_id: string; ai_powered: false; message: string; questions: string[] }
      | { skill_id: string; ai_powered: true; mode: "questions"; questions: string[] }
      | { skill_id: string; ai_powered: true; mode: "refined"; definition: string; version: number; message: string }
    >
  > {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const skill = await this.store.get(id);
    if (!skill) return fail(404, "Skill not found");

    const currentDefinition = skill.metadata.definition || "";
    const question = input.question;

    // No LLM → standard clarifying questions.
    if (!this.llm) {
      return ok({
        skill_id: id,
        ai_powered: false,
        message: "ANTHROPIC_API_KEY not configured. Returning standard clarifying questions.",
        questions: STANDARD_QUESTIONS,
      });
    }

    // Questions mode.
    if (!question) {
      const res = await this.llm(
        buildQuestionsPrompt(skill.name || "", skill.description || "", currentDefinition),
      );
      if (!res) return fail(502, "AI question generation failed");
      const arr = extractJsonArray(res.text);
      const questions = arr ? (arr as string[]) : ["スキル定義を改善するための追加情報を教えてください。"];
      return ok({ skill_id: id, ai_powered: true, mode: "questions", questions });
    }

    // Refine mode.
    const res = await this.llm(buildRefinePrompt(currentDefinition, question));
    if (!res) return fail(502, "AI refinement failed");
    const refinedDefinition = res.text || currentDefinition;
    const newVersion = (skill.metadata.version || 1) + 1;
    await this.store.patch(id, {
      metadata: { ...skill.metadata, definition: refinedDefinition, version: newVersion },
      updated_at: this.iso(),
    });
    return ok({
      skill_id: id,
      ai_powered: true,
      mode: "refined",
      definition: refinedDefinition,
      version: newVersion,
      message: "Skill definition has been refined and saved.",
    });
  }
}
