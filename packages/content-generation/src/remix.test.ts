import { describe, it, expect, vi } from "vitest";
import {
  ALL_REMIX_FORMATS,
  FORMAT_PROMPTS,
  FORMAT_TYPE_MAP,
  isRemixFormat,
  remixToFormat,
  atomizeContent,
} from "./remix.js";
import type { GenerateText } from "./types.js";

describe("remix format constants", () => {
  it("has a prompt and type for every format", () => {
    for (const f of ALL_REMIX_FORMATS) {
      expect(FORMAT_PROMPTS[f]).toBeTruthy();
      expect(FORMAT_TYPE_MAP[f]).toBeTruthy();
    }
  });

  it("isRemixFormat validates membership", () => {
    expect(isRemixFormat("x-thread")).toBe(true);
    expect(isRemixFormat("nonsense")).toBe(false);
  });
});

describe("remixToFormat", () => {
  it("passes the format prompt and source into transformContent", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const gen: GenerateText = vi.fn(async (system, user) => {
      calls.push({ system, user });
      return "変換結果";
    });
    const result = await remixToFormat(gen, { title: "元記事", content: "本文" }, "x-thread", "B2B");
    expect(result.format).toBe("x-thread");
    expect(result.contentType).toBe("sns-x");
    expect(result.content).toBe("変換結果");
    expect(calls[0]!.user).toContain(FORMAT_PROMPTS["x-thread"]);
    expect(calls[0]!.user).toContain("元記事");
    expect(calls[0]!.system).toContain("B2B");
  });
});

describe("atomizeContent", () => {
  it("atomizes to all formats by default", async () => {
    const gen: GenerateText = vi.fn(async () => "out");
    const { succeeded, failed } = await atomizeContent(gen, { title: "t", content: "c" }, undefined);
    expect(succeeded).toHaveLength(ALL_REMIX_FORMATS.length);
    expect(failed).toHaveLength(0);
  });

  it("filters invalid formats and keeps valid ones", async () => {
    const gen: GenerateText = vi.fn(async () => "out");
    const { succeeded } = await atomizeContent(gen, { title: "t", content: "c" }, ["x-thread", "bogus", "linkedin"]);
    expect(succeeded.map((s) => s.format).sort()).toEqual(["linkedin", "x-thread"]);
  });

  it("collects per-format failures without aborting the batch", async () => {
    let n = 0;
    const gen: GenerateText = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("LLM down");
      return "ok";
    });
    const { succeeded, failed } = await atomizeContent(gen, { title: "t", content: "c" }, ["x-thread", "linkedin"]);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain("LLM down");
  });
});
