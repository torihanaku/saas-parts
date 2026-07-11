import { describe, it, expect } from "vitest";
import { parsePorcelain, InMemoryGitWorkspaceStore } from "./gitWorkspace.js";

describe("parsePorcelain", () => {
  it("returns [] for empty/whitespace", () => {
    expect(parsePorcelain("")).toEqual([]);
    expect(parsePorcelain("   \n  ")).toEqual([]);
  });

  it("parses code + path columns", () => {
    const raw = " M src/a.ts\n?? new.txt\nA  added.ts";
    expect(parsePorcelain(raw)).toEqual([
      { code: "M", path: "src/a.ts" },
      { code: "??", path: "new.txt" },
      { code: "A", path: "added.ts" },
    ]);
  });

  it("drops lines that are too short", () => {
    expect(parsePorcelain("M\nx")).toEqual([]);
  });
});

describe("InMemoryGitWorkspaceStore", () => {
  it("starts null, then stores the latest snapshot", () => {
    const store = new InMemoryGitWorkspaceStore();
    expect(store.get()).toBeNull();

    const now = new Date("2026-02-01T00:00:00Z");
    const state = store.set(
      { repo: "acme/web", branch: "main", lastCommit: "abc123", status: " M a.ts" },
      now,
    );

    expect(state.repo).toBe("acme/web");
    expect(state.files).toEqual([{ code: "M", path: "a.ts" }]);
    expect(state.updatedAt).toBe(now.toISOString());
    expect(store.get()).toEqual(state);
  });

  it("overwrites previous snapshot (keeps only latest)", () => {
    const store = new InMemoryGitWorkspaceStore();
    store.set({ repo: "r1" });
    store.set({ repo: "r2" });
    expect(store.get()?.repo).toBe("r2");
  });
});
