import { describe, expect, it } from "vitest";
import { pickRepresentative, reevaluateSignals } from "./reevaluate";
import {
  MemoryCardStore,
  MemoryContextStore,
  MemorySignalStore,
} from "./memory-stores";
import { stubLlm } from "./test-helpers";
import type { SignalContext } from "./types";

const USER = "user-1";
const NOW = new Date("2026-07-10T00:00:00.000Z");

function ctx(
  id: string,
  signalId: string,
  verdict: SignalContext["verdict"],
  importanceScore: number,
  createdAt: string,
): SignalContext {
  return {
    id,
    userId: USER,
    signalId,
    relatedSignalIds: [],
    importanceScore,
    verdict,
    rationale: `rationale-${id}`,
    createdAt,
  };
}

const trendLlm = stubLlm({
  json: {
    title: "Trend hypothesis",
    summary: "Cluster summary",
    hypothesis: "If we adopt X, Y improves",
    rationale: "Three signals in one week",
  },
});

async function setup(contexts: SignalContext[]) {
  const signalStore = new MemorySignalStore();
  const contextStore = new MemoryContextStore();
  const cardStore = new MemoryCardStore();
  const idMap = new Map<string, string>();

  for (const c of contexts) {
    if (!idMap.has(c.signalId)) {
      const s = await signalStore.insert(USER, {
        source: "test",
        url: `https://example.com/${c.signalId}`,
        title: `Signal ${c.signalId}`,
        fetchedAt: c.createdAt,
      });
      idMap.set(c.signalId, s!.id);
    }
    contextStore.seed({ ...c, signalId: idMap.get(c.signalId)! });
  }
  return { signalStore, contextStore, cardStore, idMap };
}

describe("pickRepresentative", () => {
  it("importance 降順 → signalId 昇順で決定的に選出する", () => {
    const contexts = [
      ctx("c1", "sig-b", "worth_watching", 70, "2026-07-08T00:00:00.000Z"),
      ctx("c2", "sig-a", "worth_watching", 70, "2026-07-09T00:00:00.000Z"),
      ctx("c3", "sig-c", "worth_watching", 50, "2026-07-07T00:00:00.000Z"),
    ];
    // 同点 70 は signalId 昇順 → sig-a が勝つ。入力順を変えても同じ。
    expect(pickRepresentative(contexts)?.signalId).toBe("sig-a");
    expect(pickRepresentative([...contexts].reverse())?.signalId).toBe("sig-a");
  });

  it("空配列は null", () => {
    expect(pickRepresentative([])).toBeNull();
  });
});

describe("reevaluateSignals", () => {
  it("窓内に worth_watching が閾値以上あれば代表を昇格しカードを作る", async () => {
    const { signalStore, contextStore, cardStore, idMap } = await setup([
      ctx("c1", "s1", "worth_watching", 80, "2026-07-08T00:00:00.000Z"),
      ctx("c2", "s2", "worth_watching", 60, "2026-07-09T00:00:00.000Z"),
      ctx("c3", "s3", "worth_watching", 40, "2026-07-07T00:00:00.000Z"),
    ]);

    const result = await reevaluateSignals(
      USER,
      { signalStore, contextStore, cardStore, llm: trendLlm, now: () => NOW },
    );

    expect(result.promoted).toBe(1);
    expect(result.promotedCard?.title).toBe("Trend hypothesis");
    expect(result.promotedCard?.hypothesis).toBe("If we adopt X, Y improves");
    // 代表 = importance 最大の s1
    expect(result.promotedCard?.triggerSignalId).toBe(idMap.get("s1"));

    // クラスタ全体が big_deal に更新され、再実行しても昇格しない
    const remaining = await contextStore.listByVerdictSince(
      USER,
      "worth_watching",
      "2026-07-01T00:00:00.000Z",
    );
    expect(remaining).toHaveLength(0);

    const again = await reevaluateSignals(
      USER,
      { signalStore, contextStore, cardStore, llm: trendLlm, now: () => NOW },
    );
    expect(again.promoted).toBe(0);
  });

  it("閾値未満なら昇格しない", async () => {
    const { signalStore, contextStore, cardStore } = await setup([
      ctx("c1", "s1", "worth_watching", 80, "2026-07-08T00:00:00.000Z"),
      ctx("c2", "s2", "worth_watching", 60, "2026-07-09T00:00:00.000Z"),
    ]);
    const result = await reevaluateSignals(
      USER,
      { signalStore, contextStore, cardStore, llm: trendLlm, now: () => NOW },
    );
    expect(result.promoted).toBe(0);
  });

  it("窓の外の worth_watching はクラスタに数えない", async () => {
    const { signalStore, contextStore, cardStore } = await setup([
      ctx("c1", "s1", "worth_watching", 80, "2026-07-08T00:00:00.000Z"),
      ctx("c2", "s2", "worth_watching", 60, "2026-07-09T00:00:00.000Z"),
      ctx("c3", "s3", "worth_watching", 40, "2026-06-01T00:00:00.000Z"), // 39日前
    ]);
    const result = await reevaluateSignals(
      USER,
      { signalStore, contextStore, cardStore, llm: trendLlm, now: () => NOW },
    );
    expect(result.promoted).toBe(0);
  });

  it("purgeDays より古い meh を削除する (新しい meh と他 verdict は残す)", async () => {
    const { signalStore, contextStore, cardStore } = await setup([
      ctx("c1", "s1", "meh", 5, "2026-05-01T00:00:00.000Z"), // 70日前 → 削除
      ctx("c2", "s2", "meh", 5, "2026-07-01T00:00:00.000Z"), // 9日前 → 残す
      ctx("c3", "s3", "big_deal", 90, "2026-05-01T00:00:00.000Z"), // meh でない → 残す
    ]);
    const result = await reevaluateSignals(
      USER,
      { signalStore, contextStore, cardStore, llm: trendLlm, now: () => NOW },
    );
    expect(result.purged).toBe(1);
  });

  it("LLM が null の場合は昇格をスキップし purge のみ行う", async () => {
    const { signalStore, contextStore, cardStore } = await setup([
      ctx("c1", "s1", "worth_watching", 80, "2026-07-08T00:00:00.000Z"),
      ctx("c2", "s2", "worth_watching", 60, "2026-07-09T00:00:00.000Z"),
      ctx("c3", "s3", "worth_watching", 40, "2026-07-07T00:00:00.000Z"),
      ctx("c4", "s4", "meh", 5, "2026-05-01T00:00:00.000Z"),
    ]);
    const result = await reevaluateSignals(
      USER,
      { signalStore, contextStore, cardStore, llm: null, now: () => NOW },
    );
    expect(result.promoted).toBe(0);
    expect(result.purged).toBe(1);
  });
});
