import { describe, it, expect } from "vitest";
import {
  createTask,
  updateTask,
  deleteTask,
  listTasks,
  recordTaskFeedback,
  PROFICIENCY_LEVELS,
} from "./tasks";
import {
  createInMemoryCharacterStore,
  createInMemorySkillStore,
  createInMemoryCvStore,
  createInMemoryTaskStore,
} from "./stores";
import type { CharacterSkill } from "./types";

function seedCharacterWithSkills(name: string, proficiencies: string[]) {
  const characters = createInMemoryCharacterStore([{ id: "c1", name, team: "eng" }]);
  const skills = createInMemorySkillStore(
    proficiencies.map<CharacterSkill>((p, i) => ({
      character_id: "c1",
      name: `skill-${i}`,
      proficiency: p,
      source: "manual",
    })),
  );
  const cv = createInMemoryCvStore();
  return { characters, skills, cv };
}

describe("task CRUD + assignment", () => {
  it("creates a task assigned to a character", async () => {
    const ts = createInMemoryTaskStore();
    const task = await createTask(ts, { title: "設計する", assignee: "太郎", priority: "high" });
    expect(task.assignee).toBe("太郎");
    expect(task.status).toBe("todo");
    expect(await ts.get(task.id)).not.toBeNull();
  });

  it("throws when title missing", async () => {
    const ts = createInMemoryTaskStore();
    await expect(createTask(ts, { title: "" } as never)).rejects.toThrow();
  });

  it("updates and reassigns a task", async () => {
    const ts = createInMemoryTaskStore();
    const task = await createTask(ts, { title: "X", assignee: "太郎" });
    await updateTask(ts, task.id, { assignee: "花子", status: "done" });
    const updated = await ts.get(task.id);
    expect(updated?.assignee).toBe("花子");
    expect(updated?.status).toBe("done");
  });

  it("lists with status filter", async () => {
    const ts = createInMemoryTaskStore();
    await createTask(ts, { title: "A", status: "todo" });
    await createTask(ts, { title: "B", status: "done" });
    const done = await listTasks(ts, { status: "done" });
    expect(done.map((t) => t.title)).toEqual(["B"]);
  });

  it("deletes a task", async () => {
    const ts = createInMemoryTaskStore();
    const task = await createTask(ts, { title: "X" });
    await deleteTask(ts, task.id);
    expect(await ts.get(task.id)).toBeNull();
  });
});

describe("task feedback loop — growth", () => {
  it("rating>=4 promotes up to 3 skills by one level (beginner→intermediate)", async () => {
    const stores = seedCharacterWithSkills("太郎", ["beginner", "beginner", "beginner", "beginner"]);
    const res = await recordTaskFeedback("t1", { rating: 5, assignee: "太郎", taskTitle: "リリース" }, stores);

    // 最大 3 件だけ昇格。
    expect(res.promotedSkills).toHaveLength(3);
    expect(res.promotedSkills.every((p) => p.from === "beginner" && p.to === "intermediate")).toBe(true);

    const skills = await stores.skills.listByCharacter("c1");
    const promoted = skills.filter((s) => s.proficiency === "intermediate");
    const untouched = skills.filter((s) => s.proficiency === "beginner");
    expect(promoted).toHaveLength(3);
    expect(untouched).toHaveLength(1); // 4 件目は据え置き
  });

  it("promotion is capped at expert (does not overflow the ladder)", async () => {
    const stores = seedCharacterWithSkills("太郎", ["expert"]);
    const res = await recordTaskFeedback("t1", { rating: 5, assignee: "太郎" }, stores);
    expect(res.promotedSkills).toHaveLength(0);
    const skills = await stores.skills.listByCharacter("c1");
    expect(skills[0]!.proficiency).toBe("expert");
  });

  it("rating<4 does NOT promote skills but still records CV", async () => {
    const stores = seedCharacterWithSkills("太郎", ["beginner", "beginner"]);
    const res = await recordTaskFeedback("t1", { rating: 3, assignee: "太郎", comment: "まあまあ" }, stores);
    expect(res.promotedSkills).toHaveLength(0);
    expect(res.cvRecorded).toBe(true);
    const skills = await stores.skills.listByCharacter("c1");
    expect(skills.every((s) => s.proficiency === "beginner")).toBe(true);
  });

  it("records a CV entry with correct fields (職務経歴の蓄積)", async () => {
    const stores = seedCharacterWithSkills("太郎", ["beginner"]);
    await recordTaskFeedback("task-42", { rating: 4, assignee: "太郎", comment: "良い出来", taskTitle: "PR レビュー" }, stores);
    const cv = await stores.cv.listByCharacter("c1");
    expect(cv).toHaveLength(1);
    expect(cv[0]).toMatchObject({
      character_id: "c1",
      task_id: "task-42",
      title: "PR レビュー",
      outcome: "良い出来",
      rating: 4,
    });
    expect(cv[0]!.completed_at).toBeTruthy();
    expect(cv[0]!.skills_used).toEqual([]);
  });

  it("unknown assignee is a no-op (no CV, no promotion)", async () => {
    const stores = seedCharacterWithSkills("太郎", ["beginner"]);
    const res = await recordTaskFeedback("t1", { rating: 5, assignee: "誰でもない" }, stores);
    expect(res.character).toBeNull();
    expect(res.cvRecorded).toBe(false);
    expect(res.promotedSkills).toHaveLength(0);
    expect(await stores.cv.listByCharacter("c1")).toHaveLength(0);
    const skills = await stores.skills.listByCharacter("c1");
    expect(skills[0]!.proficiency).toBe("beginner");
  });

  it("null assignee is a no-op", async () => {
    const stores = seedCharacterWithSkills("太郎", ["beginner"]);
    const res = await recordTaskFeedback("t1", { rating: 5, assignee: null }, stores);
    expect(res.cvRecorded).toBe(false);
    expect(res.promotedSkills).toHaveLength(0);
  });

  it("rejects out-of-range rating", async () => {
    const stores = seedCharacterWithSkills("太郎", ["beginner"]);
    await expect(recordTaskFeedback("t1", { rating: 6, assignee: "太郎" }, stores)).rejects.toThrow();
    await expect(recordTaskFeedback("t1", { rating: 0, assignee: "太郎" }, stores)).rejects.toThrow();
  });

  it("exports the proficiency ladder verbatim", () => {
    expect(PROFICIENCY_LEVELS).toEqual(["beginner", "intermediate", "advanced", "expert"]);
  });
});
