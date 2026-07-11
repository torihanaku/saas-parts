import { describe, it, expect } from "vitest";
import { extractKeywords, deriveGroupKey, matchCharacters } from "./matching";
import { createInMemoryCharacterStore, createInMemorySkillStore } from "./stores";
import type { Character, CharacterSkill } from "./types";

describe("extractKeywords", () => {
  it("drops stop words and short tokens", () => {
    const kws = extractKeywords("APIの設計をお願いします TypeScript");
    expect(kws).toContain("TypeScript");
    expect(kws).not.toContain("お願い");
    expect(kws.length).toBeLessThanOrEqual(10);
  });

  it("dedupes case-insensitively", () => {
    const kws = extractKeywords("React react REACT");
    expect(kws.length).toBe(1);
  });
});

describe("deriveGroupKey", () => {
  it("strips Jr/Sr and JP suffixes", () => {
    expect(deriveGroupKey("バックエンド Jr")).toBe("バックエンド");
    expect(deriveGroupKey("マーケ シニア")).toBe("マーケ");
    expect(deriveGroupKey("そのまま")).toBe("そのまま");
  });
});

describe("matchCharacters", () => {
  const characters: Character[] = [
    { id: "c1", name: "バックエンド太郎", team: "eng" },
    { id: "c2", name: "マーケ花子", team: "mkt" },
  ];
  const skills: CharacterSkill[] = [
    { character_id: "c1", name: "API設計", proficiency: "expert" },
    { character_id: "c1", name: "PostgreSQL", proficiency: "advanced" },
    { character_id: "c2", name: "広告運用", proficiency: "advanced" },
  ];

  it("returns the character whose skill matches the task keyword", async () => {
    const cs = createInMemoryCharacterStore(characters);
    const ss = createInMemorySkillStore(skills);
    const res = await matchCharacters(cs, ss, { taskTitle: "API設計 の相談" });
    expect(res.matches[0]!.character.id).toBe("c1");
    expect(res.matches[0]!.matchedSkills).toContain("API設計");
  });

  it("returns empty when no skills match", async () => {
    const cs = createInMemoryCharacterStore(characters);
    const ss = createInMemorySkillStore(skills);
    const res = await matchCharacters(cs, ss, { taskTitle: "全く無関係なタスク" });
    expect(res.matches).toEqual([]);
  });

  it("returns empty for blank task text", async () => {
    const cs = createInMemoryCharacterStore(characters);
    const ss = createInMemorySkillStore(skills);
    const res = await matchCharacters(cs, ss, { taskTitle: "   " });
    expect(res.matches).toEqual([]);
    expect(res.keywords).toEqual([]);
  });
});
