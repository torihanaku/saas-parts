import { describe, expect, it } from "vitest";
import { DecisionExtractorService, normalizeExtraction } from "./extractor.js";
import { InMemoryDecisionStore } from "./stores.js";
import { fixedContext, seedDecisions, TENANT } from "./test-helpers.js";

const GOOD_JSON = {
  found: true,
  type: "stop",
  subject: "Meta 広告",
  context: "定例で決定",
  reason: "CPA が目標の 2 倍",
  alternatives_considered: "予算半減案",
  confidence: 0.9,
};

function makeService(
  json: unknown,
  overrides: Partial<ConstructorParameters<typeof DecisionExtractorService>[0]> = {},
) {
  const store = new InMemoryDecisionStore();
  const service = new DecisionExtractorService({
    store,
    generateJson: async () => json,
    context: fixedContext(),
    ...overrides,
  });
  return { service, store };
}

const INPUT = {
  tenantId: TENANT,
  source: "slack",
  sourceRef: "https://chat.example/p/1",
  rawText: "Meta広告は今月で止めます。CPAが目標の2倍なので。",
};

describe("normalizeExtraction", () => {
  const types = new Set(["start", "stop"]);

  it("不正な入力は found=false のフォールバック", () => {
    expect(normalizeExtraction(null, types).found).toBe(false);
    expect(normalizeExtraction("string", types).found).toBe(false);
  });

  it("許可されない type は null、confidence は 0..1 にクランプ", () => {
    const ext = normalizeExtraction({ found: true, type: "pivot", confidence: 3 }, types);
    expect(ext.type).toBeNull();
    expect(ext.confidence).toBe(1);
    expect(normalizeExtraction({ found: true, confidence: -1 }, types).confidence).toBe(0);
  });

  it("文字列フィールドは trim される", () => {
    const ext = normalizeExtraction({ found: true, type: "stop", subject: " s ", reason: " r " }, types);
    expect(ext.subject).toBe("s");
    expect(ext.reason).toBe("r");
  });
});

describe("DecisionExtractorService.extract", () => {
  it("有効な抽出は DecisionRecord として登録され、フックも発火する", async () => {
    const recorded: string[] = [];
    const { service, store } = makeService(GOOD_JSON, {
      embedder: { embed: async () => [0.1] },
      onDecisionRecorded: (d) => {
        recorded.push(d.id);
      },
    });
    const result = await service.extract(INPUT);
    expect(result.inserted).toBe(true);
    expect(result.reason).toBe("inserted");
    expect(result.decision).toMatchObject({
      id: "id-1",
      decisionType: "stop",
      subject: "Meta 広告",
      reason: "CPA が目標の 2 倍",
      alternativesConsidered: "予算半減案",
      source: "slack",
      sourceRef: INPUT.sourceRef,
    });
    expect(store.embeddings.get("id-1")).toEqual([0.1]);
    expect(recorded).toEqual(["id-1"]);
  });

  it("context 欠落時はプレースホルダを補う", async () => {
    const { service } = makeService({ ...GOOD_JSON, context: null });
    const result = await service.extract(INPUT);
    expect(result.decision?.context).toBe("(自動抽出: 文脈情報なし)");
  });

  it("found=false / 必須欠落は no_decision_found", async () => {
    const { service, store } = makeService({ ...GOOD_JSON, found: false });
    expect((await service.extract(INPUT)).reason).toBe("no_decision_found");
    const { service: s2 } = makeService({ ...GOOD_JSON, subject: null });
    expect((await s2.extract(INPUT)).reason).toBe("no_decision_found");
    expect(await store.list(TENANT)).toEqual([]);
  });

  it("confidence < 0.6（デフォルト）は low_confidence でスキップ", async () => {
    const { service } = makeService({ ...GOOD_JSON, confidence: 0.5 });
    expect((await service.extract(INPUT)).reason).toBe("low_confidence");
    // 閾値はパラメータ化できる
    const { service: lax } = makeService({ ...GOOD_JSON, confidence: 0.5 }, { minConfidence: 0.4 });
    expect((await lax.extract(INPUT)).inserted).toBe(true);
  });

  it("generateJson の throw は invalid_response", async () => {
    const store = new InMemoryDecisionStore();
    const service = new DecisionExtractorService({
      store,
      generateJson: async () => {
        throw new Error("bad json");
      },
    });
    expect((await service.extract(INPUT)).reason).toBe("invalid_response");
  });

  it("dedup layer 1: 同じ sourceRef は duplicate", async () => {
    const { service, store } = makeService(GOOD_JSON);
    await seedDecisions(store, [
      { id: "existing", subject: "既存", reason: "r", sourceRef: INPUT.sourceRef },
    ]);
    expect((await service.extract(INPUT)).reason).toBe("duplicate");
  });

  it("dedup layer 2: 30 日以内・同 type・高類似はスキップ、窓の外なら登録", async () => {
    const { service, store } = makeService(GOOD_JSON, {
      dupSearcher: {
        search: async () => [{ id: "near-dup", similarity: 0.95 }],
      },
    });
    // now = 2026-07-01（fixedContext）。20 日前 → 窓内 → duplicate
    await seedDecisions(store, [
      {
        id: "near-dup",
        subject: "Meta 広告停止",
        reason: "CPA",
        decisionType: "stop",
        sourceRef: "other-ref",
        decidedAt: "2026-06-11T00:00:00.000Z",
      },
    ]);
    expect((await service.extract(INPUT)).reason).toBe("duplicate");

    // 60 日前 → 窓の外 → 登録される
    const { service: s2, store: store2 } = makeService(GOOD_JSON, {
      dupSearcher: { search: async () => [{ id: "old-dup", similarity: 0.95 }] },
    });
    await seedDecisions(store2, [
      {
        id: "old-dup",
        subject: "Meta 広告停止",
        reason: "CPA",
        decisionType: "stop",
        sourceRef: "other-ref",
        decidedAt: "2026-05-02T00:00:00.000Z",
      },
    ]);
    expect((await s2.extract(INPUT)).inserted).toBe(true);
  });

  it("dupSearcher の失敗は重複でない扱いで続行（本家と同じ degrade）", async () => {
    const { service } = makeService(GOOD_JSON, {
      dupSearcher: {
        search: async () => {
          throw new Error("rpc down");
        },
      },
    });
    expect((await service.extract(INPUT)).inserted).toBe(true);
  });
});
