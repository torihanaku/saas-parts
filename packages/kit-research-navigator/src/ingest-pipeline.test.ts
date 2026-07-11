import { describe, expect, it } from "vitest";
import { ingestSignals } from "./ingest-pipeline";
import {
  MemoryCardStore,
  MemoryContextStore,
  MemorySignalStore,
} from "./memory-stores";
import { stubLlm } from "./test-helpers";
import type { SignalSource } from "./ports";
import type { NewSignal } from "./types";

const USER = "user-1";

function fixtureSource(name: string, signals: NewSignal[]): SignalSource {
  return { name, fetch: async () => signals };
}

function sig(title: string, url: string): NewSignal {
  return { source: "test", url, title, body: null, fetchedAt: "2026-07-01T00:00:00.000Z" };
}

// タイトルで決定的に verdict を返す LLM
const verdictLlm = stubLlm({
  json: (req) => {
    if (req.user.includes("Big Launch")) {
      return { verdict: "big_deal", rationale: "major shift", importance_score: 90 };
    }
    if (req.user.includes("Watch This")) {
      return { verdict: "worth_watching", rationale: "keep an eye", importance_score: 55 };
    }
    return { verdict: "meh", rationale: "noise", importance_score: 5 };
  },
});

describe("ingestSignals", () => {
  it("シグナル保存 → verdict 判定 → context 保存 → big_deal は自動カード化する", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();
    const cardStore = new MemoryCardStore();

    const result = await ingestSignals(
      USER,
      [
        fixtureSource("a", [
          sig("Big Launch of X", "https://a.example/1"),
          sig("Watch This library", "https://a.example/2"),
          sig("Random noise", "https://a.example/3"),
        ]),
      ],
      { signalStore, contextStore, cardStore, llm: verdictLlm },
    );

    expect(result.fetched).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.cardsCreated).toBe(1);

    const card = result.createdCards[0];
    expect(card?.title).toBe("[Auto] Big Launch of X");
    expect(card?.triggerSource).toBe("signal");
    expect(card?.status).toBe("draft");
    // importance 0-100 → 0-1 に正規化される
    expect(card?.cardData.meta.importanceScore).toBeCloseTo(0.9);

    // 全シグナルに context が付く
    const signals = await signalStore.listSince(USER, "2026-01-01", 100);
    expect(signals).toHaveLength(3);
    for (const s of signals) {
      const ctx = await contextStore.getBySignalId(USER, s.id);
      expect(ctx).not.toBeNull();
    }
  });

  it("同一 URL の重複はスキップする", async () => {
    const signalStore = new MemorySignalStore();
    const deps = {
      signalStore,
      contextStore: new MemoryContextStore(),
      cardStore: new MemoryCardStore(),
      llm: verdictLlm,
    };
    await ingestSignals(USER, [fixtureSource("a", [sig("Random noise", "https://dup.example/1")])], deps);
    const result = await ingestSignals(
      USER,
      [fixtureSource("a", [sig("Random noise again", "https://dup.example/1")])],
      deps,
    );
    expect(result.inserted).toBe(0);
    expect(result.skippedDuplicates).toBe(1);
  });

  it("片方のソースが失敗しても残りは取り込まれる", async () => {
    const failing: SignalSource = {
      name: "broken",
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const warnings: string[] = [];
    const result = await ingestSignals(
      USER,
      [failing, fixtureSource("ok", [sig("Random noise", "https://ok.example/1")])],
      {
        signalStore: new MemorySignalStore(),
        contextStore: new MemoryContextStore(),
        cardStore: new MemoryCardStore(),
        llm: verdictLlm,
        onWarn: (m) => warnings.push(m),
      },
    );
    expect(result.inserted).toBe(1);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
  });

  it("LLM なしでは meh フォールバックとなりカードは作られない", async () => {
    const contextStore = new MemoryContextStore();
    const signalStore = new MemorySignalStore();
    const result = await ingestSignals(
      USER,
      [fixtureSource("a", [sig("Big Launch of X", "https://nollm.example/1")])],
      { signalStore, contextStore, cardStore: new MemoryCardStore(), llm: null },
    );
    expect(result.cardsCreated).toBe(0);
    const signals = await signalStore.listSince(USER, "2026-01-01", 10);
    const ctx = await contextStore.getBySignalId(USER, signals[0]!.id);
    expect(ctx?.verdict).toBe("meh");
    expect(ctx?.importanceScore).toBe(0);
  });

  it("autoCardVerdict: null で自動カード化を無効化できる", async () => {
    const result = await ingestSignals(
      USER,
      [fixtureSource("a", [sig("Big Launch of X", "https://off.example/1")])],
      {
        signalStore: new MemorySignalStore(),
        contextStore: new MemoryContextStore(),
        cardStore: new MemoryCardStore(),
        llm: verdictLlm,
        autoCardVerdict: null,
      },
    );
    expect(result.cardsCreated).toBe(0);
  });
});
