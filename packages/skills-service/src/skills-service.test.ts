import { describe, it, expect, beforeEach, vi } from "vitest";
import { SkillService, type SkillLLM } from "./service";
import { InMemorySkillStore } from "./store";
import { toSkillView, extractJsonObject, extractJsonArray, templateSkill } from "./types";

const CLIENT = "11111111-1111-4111-8111-111111111111";

function make(llm?: SkillLLM) {
  const store = new InMemorySkillStore();
  let n = 0;
  const svc = new SkillService({
    store,
    llm,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    now: () => new Date("2026-07-11T00:00:00Z"),
  });
  return { svc, store };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("extractJsonObject / extractJsonArray tolerate surrounding text", () => {
    expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 });
    expect(extractJsonArray('here: ["x","y"] done')).toEqual(["x", "y"]);
    expect(extractJsonObject("no json")).toBeNull();
    expect(extractJsonArray("no arr")).toBeNull();
  });

  it("toSkillView flattens metadata with defaults", () => {
    const view = toSkillView({
      id: "s1",
      client_id: null,
      name: "N",
      description: "",
      metadata: { skill_type: "", category: "", definition: "", examples: [], triggers: [], version: 0 },
      created_at: "x",
      updated_at: "x",
    });
    expect(view.category).toBe("custom");
    expect(view.skill_type).toBe("custom");
    expect(view.version).toBe(1);
  });

  it("templateSkill trims description to 50 chars in name", () => {
    const t = templateSkill("x".repeat(80));
    expect(t.name.length).toBeLessThanOrEqual("スキル: ".length + 50);
  });
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

describe("CRUD", () => {
  let svc: SkillService;
  let store: InMemorySkillStore;
  beforeEach(() => ({ svc, store } = make()));

  it("creates with validated type/category defaults", async () => {
    const r = await svc.create({ name: "S", definition: "d", skill_type: "bogus", category: "bogus" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.skill_type).toBe("custom");
      expect(r.data.category).toBe("custom");
      expect(r.data.version).toBe(1);
    }
  });

  it("preserves valid type/category", async () => {
    const r = await svc.create({ name: "S", definition: "d", skill_type: "review", category: "marketing" });
    expect(r.ok && r.data.skill_type).toBe("review");
    expect(r.ok && r.data.category).toBe("marketing");
  });

  it("requires name and definition", async () => {
    expect((await svc.create({ definition: "d" })).ok).toBe(false);
    expect((await svc.create({ name: "S" })).ok).toBe(false);
  });

  it("rejects invalid client_id", async () => {
    const r = await svc.create({ name: "S", definition: "d", client_id: "nope" });
    expect(r.ok).toBe(false);
  });

  it("list flattens + filters by client", async () => {
    await svc.create({ name: "A", definition: "d", client_id: CLIENT });
    await svc.create({ name: "B", definition: "d" });
    const all = await svc.list();
    expect(all.ok && all.data.length).toBe(2);
    const scoped = await svc.list(CLIENT);
    expect(scoped.ok && scoped.data.length).toBe(1);
  });

  it("get 404 / invalid id", async () => {
    expect((await svc.get("nope")).ok).toBe(false);
    expect((await svc.get("00000000-0000-4000-8000-000000000999")).ok).toBe(false);
  });

  it("update bumps version and patches fields", async () => {
    const c = await svc.create({ name: "S", definition: "d" });
    const id = c.ok ? c.data.id : "";
    const u = await svc.update(id, { definition: "d2", name: "S2" });
    expect(u.ok && u.data.version).toBe(2);
    const view = toSkillView((await store.get(id))!);
    expect(view.definition).toBe("d2");
    expect(view.name).toBe("S2");
  });

  it("update 404 when missing", async () => {
    const r = await svc.update("00000000-0000-4000-8000-000000000999", { name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("delete", async () => {
    const c = await svc.create({ name: "S", definition: "d" });
    const id = c.ok ? c.data.id : "";
    expect((await svc.delete(id)).ok).toBe(true);
    expect(await store.get(id)).toBeNull();
  });
});

// ─── AI generate ─────────────────────────────────────────────────────────────

describe("generate", () => {
  it("requires description", async () => {
    const { svc } = make();
    expect((await svc.generate({})).ok).toBe(false);
  });

  it("template fallback when no LLM", async () => {
    const { svc } = make();
    const r = await svc.generate({ description: "書き起こしを要約する" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.ai_powered).toBe(false);
      expect(r.data.skill.definition).toContain("## 目的");
    }
  });

  it("uses source materials in the prompt and parses JSON", async () => {
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("SRC-CONTENT");
      return { text: '{"name":"要約スキル","skill_type":"analysis","category":"marketing","definition":"do it","examples":[],"triggers":["always"]}' };
    });
    const { svc, store } = make(llm);
    store.materials.set("m1", { name: "資料A", content: "SRC-CONTENT" });
    const r = await svc.generate({ description: "d", source_ids: ["m1"], client_id: CLIENT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.ai_powered).toBe(true);
      expect(r.data.skill.name).toBe("要約スキル");
      expect(r.data.skill.skill_type).toBe("analysis");
      expect(r.data.client_id).toBe(CLIENT);
    }
    expect(llm).toHaveBeenCalledOnce();
  });

  it("parse_error path when LLM returns non-JSON", async () => {
    const llm = vi.fn(async () => ({ text: "just prose, no json" }));
    const { svc } = make(llm);
    const r = await svc.generate({ description: "d" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.parse_error).toBe(true);
      expect(r.data.skill.definition).toBe("just prose, no json");
    }
  });

  it("null LLM result → template fallback", async () => {
    const llm = vi.fn(async () => null);
    const { svc } = make(llm);
    const r = await svc.generate({ description: "d" });
    expect(r.ok && r.data.ai_powered).toBe(false);
  });
});

// ─── AI refine ───────────────────────────────────────────────────────────────

describe("refine", () => {
  async function seed(svc: SkillService) {
    const c = await svc.create({ name: "S", definition: "current def" });
    return c.ok ? c.data.id : "";
  }

  it("standard questions when no LLM", async () => {
    const { svc } = make();
    const id = await seed(svc);
    const r = await svc.refine(id);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.ai_powered === false) expect(r.data.questions.length).toBe(5);
  });

  it("questions mode when LLM and no question", async () => {
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("質問を5つ");
      return { text: '["Q1","Q2"]' };
    });
    const { svc } = make(llm);
    const id = await seed(svc);
    const r = await svc.refine(id);
    expect(r.ok).toBe(true);
    if (r.ok && "mode" in r.data && r.data.mode === "questions") {
      expect(r.data.questions).toEqual(["Q1", "Q2"]);
    }
  });

  it("refined mode when question provided, persists new version", async () => {
    const llm = vi.fn(async (prompt: string) => {
      if (prompt.includes("改善してください")) return { text: "improved definition" };
      return { text: "[]" };
    });
    const { svc, store } = make(llm);
    const id = await seed(svc);
    const r = await svc.refine(id, { question: "Q: audience? A: developers" });
    expect(r.ok).toBe(true);
    if (r.ok && "mode" in r.data && r.data.mode === "refined") {
      expect(r.data.definition).toBe("improved definition");
      expect(r.data.version).toBe(2);
    }
    expect((await store.get(id))!.metadata.definition).toBe("improved definition");
  });

  it("404 when skill missing", async () => {
    const llm = vi.fn(async () => ({ text: "[]" }));
    const { svc } = make(llm);
    const r = await svc.refine("00000000-0000-4000-8000-000000000999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});
