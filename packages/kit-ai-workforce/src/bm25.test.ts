import { describe, it, expect } from "vitest";
import {
  BM25_K1,
  BM25_B,
  PROFICIENCY_WEIGHT,
  computeBm25Scores,
  buildIdfMap,
  buildSkillCountMap,
  computeAvgSkillCount,
  type Bm25Input,
} from "./bm25";

describe("constants", () => {
  it("exports standard BM25 parameters", () => {
    expect(BM25_K1).toBe(1.5);
    expect(BM25_B).toBe(0.75);
  });

  it("exposes proficiency weights where expert > advanced > intermediate > beginner", () => {
    expect(PROFICIENCY_WEIGHT.expert!).toBeGreaterThan(PROFICIENCY_WEIGHT.advanced!);
    expect(PROFICIENCY_WEIGHT.advanced!).toBeGreaterThan(PROFICIENCY_WEIGHT.intermediate!);
    expect(PROFICIENCY_WEIGHT.intermediate!).toBeGreaterThan(PROFICIENCY_WEIGHT.beginner!);
  });
});

describe("buildIdfMap", () => {
  it("turns a flat row array into a name→idf map", () => {
    const m = buildIdfMap([
      { skill_name: "rust", idf: 4.2 },
      { skill_name: "typescript", idf: 1.1 },
    ]);
    expect(m.get("rust")).toBe(4.2);
    expect(m.get("typescript")).toBe(1.1);
    expect(m.size).toBe(2);
  });

  it("returns an empty map for empty input", () => {
    expect(buildIdfMap([]).size).toBe(0);
  });
});

describe("buildSkillCountMap", () => {
  it("turns rows into a character_id→count map", () => {
    const m = buildSkillCountMap([
      { character_id: "c1", skill_count: 30 },
      { character_id: "c2", skill_count: 90 },
    ]);
    expect(m.get("c1")).toBe(30);
    expect(m.get("c2")).toBe(90);
  });
});

describe("computeAvgSkillCount", () => {
  it("computes the arithmetic mean of map values", () => {
    const m = new Map([
      ["c1", 10],
      ["c2", 20],
      ["c3", 30],
    ]);
    expect(computeAvgSkillCount(m)).toBe(20);
  });

  it("returns the 90 fallback for an empty map", () => {
    expect(computeAvgSkillCount(new Map())).toBe(90);
  });
});

describe("computeBm25Scores", () => {
  function baseInput(): Bm25Input {
    return {
      matchedSkillsByChar: new Map([
        ["c1", [{ name: "rust", proficiency: "expert" }]],
        ["c2", [{ name: "rust", proficiency: "beginner" }]],
      ]),
      skillCountByChar: new Map([
        ["c1", 30],
        ["c2", 30],
      ]),
      idfBySkill: new Map([["rust", 3.0]]),
      avgSkillCount: 30,
    };
  }

  it("returns one result per candidate character", () => {
    const results = computeBm25Scores(baseInput());
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.characterId).sort()).toEqual(["c1", "c2"]);
  });

  it("ranks experts above beginners for the same skill", () => {
    const results = computeBm25Scores(baseInput());
    expect(results[0]!.characterId).toBe("c1");
    expect(results[1]!.characterId).toBe("c2");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("penalizes characters with longer skill docs (BM25 normalization)", () => {
    const input = baseInput();
    input.matchedSkillsByChar = new Map([
      ["c1", [{ name: "rust", proficiency: "advanced" }]],
      ["c2", [{ name: "rust", proficiency: "advanced" }]],
    ]);
    input.skillCountByChar = new Map([
      ["c1", 10],
      ["c2", 200],
    ]);
    input.avgSkillCount = 50;
    const results = computeBm25Scores(input);
    const c1 = results.find((r) => r.characterId === "c1")!;
    const c2 = results.find((r) => r.characterId === "c2")!;
    expect(c1.score).toBeGreaterThan(c2.score);
  });

  it("falls back to IDF=1.0 when a skill is missing from the idf map", () => {
    const input = baseInput();
    input.matchedSkillsByChar = new Map([["c1", [{ name: "unknown-skill", proficiency: "expert" }]]]);
    input.idfBySkill = new Map();
    const results = computeBm25Scores(input);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("returns an empty array when no characters are given", () => {
    const input = baseInput();
    input.matchedSkillsByChar = new Map();
    expect(computeBm25Scores(input)).toEqual([]);
  });

  it("sorts results descending by score", () => {
    const results = computeBm25Scores(baseInput());
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});
