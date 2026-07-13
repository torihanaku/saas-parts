/**
 * Property-based tests (fast-check) for BM25 scoring.
 *
 * Invariant: scores are ALWAYS finite (never NaN/Infinity), whatever the caller
 * passes for skill counts / avgdl. This directly guards the divide-by-zero →
 * NaN bug the audit fixed (avgSkillCount = 0 poisoned every score and destroyed
 * the ranking). A finite-score property catches the whole degenerate-input class.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeBm25Scores, type MatchedSkill } from "./index";

const proficiency = fc.constantFrom("expert", "advanced", "intermediate", "beginner", "unknown");

describe("computeBm25Scores — properties", () => {
  it("produces only finite scores for any skill-count / avgdl input (incl. 0, negative, NaN)", () => {
    fc.assert(
      fc.property(
        // a handful of docs, each with some matched skills
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1 }),
            fc.array(
              fc.record({ name: fc.string({ minLength: 1 }), proficiency }),
              { maxLength: 6 }
            )
          ),
          { maxLength: 8 }
        ),
        // adversarial avgdl: 0, negatives, huge, NaN all allowed
        fc.oneof(fc.constant(0), fc.constant(-1), fc.double(), fc.integer()),
        (docs, avgSkillCount) => {
          const matchedSkillsByChar = new Map<string, MatchedSkill[]>();
          const skillCountByChar = new Map<string, number>();
          const idfBySkill = new Map<string, number>();
          for (const [id, skills] of docs) {
            matchedSkillsByChar.set(id, skills);
            skillCountByChar.set(id, skills.length);
            for (const s of skills) idfBySkill.set(s.name, 1.0);
          }
          const results = computeBm25Scores({
            matchedSkillsByChar,
            skillCountByChar,
            idfBySkill,
            avgSkillCount,
          });
          for (const r of results) {
            expect(Number.isFinite(r.score)).toBe(true);
          }
        }
      )
    );
  });

  it("ranking is monotonically non-increasing (sorted by score desc)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1 }), fc.nat(5)), { maxLength: 8 }),
        (docs) => {
          const matchedSkillsByChar = new Map<string, MatchedSkill[]>();
          const skillCountByChar = new Map<string, number>();
          const idfBySkill = new Map<string, number>();
          docs.forEach(([id, n], i) => {
            const skills = Array.from({ length: n }, (_, k) => ({
              name: `s${i}_${k}`,
              proficiency: "expert",
            }));
            matchedSkillsByChar.set(id + i, skills);
            skillCountByChar.set(id + i, n);
            skills.forEach((s) => idfBySkill.set(s.name, 2.0));
          });
          const results = computeBm25Scores({
            matchedSkillsByChar,
            skillCountByChar,
            idfBySkill,
            avgSkillCount: 3,
          });
          for (let i = 1; i < results.length; i++) {
            expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
          }
        }
      )
    );
  });
});
