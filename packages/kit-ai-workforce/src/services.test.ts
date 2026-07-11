import { describe, it, expect } from "vitest";
import {
  createCharacter,
  updateCharacter,
  deleteCharacter,
  generateCharacterDefinition,
} from "./characters";
import { cloneTemplate, filterTemplates } from "./templates";
import { createRoleModel, extractRoleModel, composeTeam } from "./role-models";
import {
  createInMemoryCharacterStore,
  createInMemorySkillStore,
  createInMemoryRoleModelStore,
} from "./stores";
import { EXAMPLE_TEMPLATES } from "./presets";
import type { LlmCaller } from "./types";

/** すべての generateJson で fallback をそのまま返すダミー LLM。 */
function stubLlm(json: Record<string, unknown>): LlmCaller {
  return {
    async generateJson<T>(_s: string, _p: string, fallback: T): Promise<T> {
      return { ...(fallback as object), ...json } as T;
    },
    async generateText() {
      return "stub";
    },
  };
}

describe("character CRUD", () => {
  it("creates a character and expands specializations into skills", async () => {
    const cs = createInMemoryCharacterStore();
    const ss = createInMemorySkillStore();
    const char = await createCharacter(cs, ss, {
      name: "エンジニアA",
      team: "eng",
      agentConfig: { archetype: "executor", workingStyle: "autonomous", specializations: ["API設計", "DB設計"] },
    });
    expect(char.isCustom).toBe(true);
    const skills = await ss.listByCharacter(char.id);
    expect(skills.map((s) => s.name).sort()).toEqual(["API設計", "DB設計"]);
  });

  it("throws when name/team missing", async () => {
    const cs = createInMemoryCharacterStore();
    const ss = createInMemorySkillStore();
    await expect(createCharacter(cs, ss, { name: "", team: "" } as never)).rejects.toThrow();
  });

  it("updates a character", async () => {
    const cs = createInMemoryCharacterStore();
    const ss = createInMemorySkillStore();
    const char = await createCharacter(cs, ss, { name: "X", team: "eng" });
    await updateCharacter(cs, ss, char.id, { role: "Lead" });
    expect((await cs.get(char.id))?.role).toBe("Lead");
  });

  it("deletes only custom characters", async () => {
    const cs = createInMemoryCharacterStore([{ id: "builtin", name: "B", team: "eng", isCustom: false }]);
    await deleteCharacter(cs, "builtin");
    expect(await cs.get("builtin")).not.toBeNull();
  });
});

describe("Character Studio", () => {
  it("generates a definition via injected LLM", async () => {
    const llm = stubLlm({ name: "生成太郎", role: "PM" });
    const def = await generateCharacterDefinition(llm, "PMがほしい", [
      { questionId: "q1", question: "得意分野は？", answer: "要件定義" },
    ]);
    expect(def.name).toBe("生成太郎");
    expect(def.role).toBe("PM");
  });
});

describe("templates", () => {
  it("filters by tag", () => {
    const eng = filterTemplates(EXAMPLE_TEMPLATES, ["engineering"]);
    expect(eng.every((t) => t.tags.includes("engineering"))).toBe(true);
    expect(eng.length).toBeGreaterThan(0);
  });

  it("clones a template into character + skills", async () => {
    const cs = createInMemoryCharacterStore();
    const ss = createInMemorySkillStore();
    const res = await cloneTemplate(EXAMPLE_TEMPLATES, cs, ss, "backend-engineer");
    expect(res.skillsAdded).toBe(3);
    const created = await cs.get(res.character.id);
    expect(created?.templateSlug).toBe("backend-engineer");
    expect(created?.presetId).toBe("template");
  });

  it("throws for unknown slug", async () => {
    const cs = createInMemoryCharacterStore();
    const ss = createInMemorySkillStore();
    await expect(cloneTemplate(EXAMPLE_TEMPLATES, cs, ss, "nope")).rejects.toThrow();
  });
});

describe("role models", () => {
  it("creates and extracts skills/tendencies via LLM", async () => {
    const rs = createInMemoryRoleModelStore();
    const model = await createRoleModel(rs, { name: "偉人", role: "戦略家" });
    const llm = stubLlm({ extractedSkills: ["戦略立案"], extractedTendencies: ["長期思考"] });
    const out = await extractRoleModel(rs, llm, model.id);
    expect(out.extractedSkills).toEqual(["戦略立案"]);
    expect((await rs.get(model.id))?.extractedTendencies).toEqual(["長期思考"]);
  });
});

describe("team composer", () => {
  it("matches suggested roles against existing characters", async () => {
    const cs = createInMemoryCharacterStore([
      { id: "c1", name: "太郎", team: "eng", agentConfig: { archetype: "executor", workingStyle: "autonomous", specializations: ["API"] } },
    ]);
    const llm = stubLlm({
      projectSummary: "SaaSを作る",
      suggestedTeam: [
        { role: "Backend", description: "API作る", existingMatchName: "太郎", isMissing: false },
        { role: "Designer", description: "UI作る", existingMatchName: null, isMissing: true },
      ],
    });
    const res = await composeTeam(cs, llm, "SaaSを作りたい");
    expect(res.projectSummary).toBe("SaaSを作る");
    expect(res.suggestedTeam[0]!.existingMatch?.name).toBe("太郎");
    expect(res.suggestedTeam[1]!.isMissing).toBe(true);
    expect(res.suggestedTeam[1]!.existingMatch).toBeUndefined();
  });
});
