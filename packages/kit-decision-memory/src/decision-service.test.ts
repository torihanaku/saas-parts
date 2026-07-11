import { describe, expect, it } from "vitest";
import { DecisionLogService } from "./decision-service.js";
import { InMemoryDecisionStore, InMemoryPendingDecisionStore } from "./stores.js";
import { fixedContext, TENANT } from "./test-helpers.js";
import { DecisionMemoryValidationError, NotFoundError } from "./types.js";

function makeService(overrides: Partial<ConstructorParameters<typeof DecisionLogService>[0]> = {}) {
  const store = new InMemoryDecisionStore();
  const pendingStore = new InMemoryPendingDecisionStore();
  const service = new DecisionLogService({
    store,
    pendingStore,
    context: fixedContext(),
    ...overrides,
  });
  return { service, store, pendingStore };
}

describe("DecisionLogService CRUD", () => {
  it("create: 決定的な id / 時刻でレコードを作成する", async () => {
    const { service } = makeService();
    const rec = await service.create(TENANT, {
      decisionType: "stop",
      subject: "Facebook 広告",
      reason: "CPA 高騰のため",
      context: "6月のレビューで判明",
    });
    expect(rec).toMatchObject({
      id: "id-1",
      tenantId: TENANT,
      decisionType: "stop",
      subject: "Facebook 広告",
      reason: "CPA 高騰のため",
      context: "6月のレビューで判明",
      source: "manual",
      decidedAt: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: null,
    });
  });

  it("create: 必須項目欠落・不正な decisionType はバリデーションエラー", async () => {
    const { service } = makeService();
    await expect(
      service.create(TENANT, { decisionType: "stop", subject: "", reason: "r" }),
    ).rejects.toThrow(DecisionMemoryValidationError);
    await expect(
      service.create(TENANT, { decisionType: "explode", subject: "s", reason: "r" }),
    ).rejects.toThrow(/decisionType must be one of/);
  });

  it("create: embedder 注入時は subject\\ncontext\\nreason の埋め込みをストアへ渡す", async () => {
    const embedded: string[] = [];
    const { service, store } = makeService({
      embedder: {
        embed: async (text) => {
          embedded.push(text);
          return [0.1, 0.2];
        },
      },
    });
    const rec = await service.create(TENANT, {
      decisionType: "start",
      subject: "S",
      reason: "R",
      context: "C",
    });
    expect(embedded).toEqual(["S\nC\nR"]);
    expect(store.embeddings.get(rec.id)).toEqual([0.1, 0.2]);
  });

  it("list: decidedAt 降順・テナント分離", async () => {
    const { service } = makeService();
    await service.create(TENANT, {
      decisionType: "start",
      subject: "A",
      reason: "r",
      decidedAt: "2026-01-01T00:00:00.000Z",
    });
    await service.create(TENANT, {
      decisionType: "start",
      subject: "B",
      reason: "r",
      decidedAt: "2026-02-01T00:00:00.000Z",
    });
    await service.create("other-tenant", { decisionType: "start", subject: "X", reason: "r" });

    const rows = await service.list(TENANT);
    expect(rows.map((r) => r.subject)).toEqual(["B", "A"]);
  });

  it("update: コア項目変更時のみ埋め込みを再計算し updatedAt を刻む", async () => {
    const embedded: string[] = [];
    const { service, store } = makeService({
      embedder: {
        embed: async (text) => {
          embedded.push(text);
          return [1];
        },
      },
    });
    const rec = await service.create(TENANT, {
      decisionType: "start",
      subject: "S",
      reason: "R",
      context: "C",
    });
    embedded.length = 0;

    // 非コア項目のみ → 埋め込み再計算なし
    await service.update(TENANT, rec.id, { decisionType: "change" });
    expect(embedded).toEqual([]);

    // コア項目 → 既存値とマージして再計算
    const updated = await service.update(TENANT, rec.id, { reason: "R2" });
    expect(embedded).toEqual(["S\nC\nR2"]);
    expect(updated.reason).toBe("R2");
    expect(updated.decisionType).toBe("change");
    expect(updated.updatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(store.embeddings.get(rec.id)).toEqual([1]);
  });

  it("update / delete: 存在しない id は NotFoundError", async () => {
    const { service } = makeService();
    await expect(service.update(TENANT, "nope", { reason: "r" })).rejects.toThrow(NotFoundError);
    await expect(service.delete(TENANT, "nope")).rejects.toThrow(NotFoundError);
  });

  it("delete: 物理削除後は get が null", async () => {
    const { service } = makeService();
    const rec = await service.create(TENANT, { decisionType: "start", subject: "S", reason: "R" });
    await service.delete(TENANT, rec.id);
    expect(await service.get(TENANT, rec.id)).toBeNull();
  });

  it("decisionTypes をパラメータ化できる", async () => {
    const { service } = makeService({ decisionTypes: ["adopt", "hold"] });
    await expect(
      service.create(TENANT, { decisionType: "start", subject: "s", reason: "r" }),
    ).rejects.toThrow(/adopt, hold/);
    const rec = await service.create(TENANT, { decisionType: "adopt", subject: "s", reason: "r" });
    expect(rec.decisionType).toBe("adopt");
  });
});

describe("DecisionLogService 抽出候補（pending）フロー", () => {
  it("stagePending → listPending → confirmPending で双方向リンクされる", async () => {
    const { service } = makeService();
    const pending = await service.stagePending(TENANT, {
      sourceRef: "https://chat.example/p/123",
      channel: "#marketing",
      rawText: "Meta広告は今月で止めます。CPAが目標の2倍なので。",
      extractedSubject: "Meta 広告",
      extractedReason: "CPA が目標の 2 倍",
      extractedType: "stop",
      confidence: 0.85,
    });
    expect(pending.status).toBe("pending");
    expect((await service.listPending(TENANT)).map((p) => p.id)).toEqual([pending.id]);

    const { pending: confirmed, decision } = await service.confirmPending(TENANT, pending.id, {
      reviewedBy: "user-9",
      decidedBy: "user-9",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedDecisionId).toBe(decision.id);
    expect(confirmed.reviewedBy).toBe("user-9");
    expect(decision).toMatchObject({
      decisionType: "stop",
      subject: "Meta 広告",
      reason: "CPA が目標の 2 倍",
      context: pending.rawText,
      source: "extracted",
      sourceRef: pending.sourceRef,
    });
    // confirm 済みは pending 一覧から消える
    expect(await service.listPending(TENANT)).toEqual([]);
    // 正式レコードとして参照できる
    expect(await service.get(TENANT, decision.id)).not.toBeNull();
  });

  it("confirmPending: overrides が抽出値より優先される", async () => {
    const { service } = makeService();
    const pending = await service.stagePending(TENANT, {
      sourceRef: "ref-1",
      rawText: "raw",
      extractedSubject: "旧件名",
      extractedReason: "旧理由",
      extractedType: "stop",
    });
    const { decision } = await service.confirmPending(TENANT, pending.id, {
      overrides: { subject: "新件名", decisionType: "pivot" },
    });
    expect(decision.subject).toBe("新件名");
    expect(decision.decisionType).toBe("pivot");
    expect(decision.reason).toBe("旧理由");
  });

  it("rejectPending: status が rejected になり再処理できない", async () => {
    const { service } = makeService();
    const pending = await service.stagePending(TENANT, { sourceRef: "ref-2", rawText: "raw" });
    const rejected = await service.rejectPending(TENANT, pending.id, { reviewedBy: "user-1" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedAt).toBe("2026-07-01T00:00:00.000Z");
    await expect(service.confirmPending(TENANT, pending.id)).rejects.toThrow(NotFoundError);
    await expect(service.rejectPending(TENANT, pending.id)).rejects.toThrow(NotFoundError);
  });

  it("onDecisionRecorded フックが create / confirm で発火する（失敗しても本処理は成功）", async () => {
    const recorded: string[] = [];
    const { service } = makeService({
      onDecisionRecorded: (d) => {
        recorded.push(d.subject);
        throw new Error("hook failure must not break the flow");
      },
    });
    await service.create(TENANT, { decisionType: "start", subject: "A", reason: "r" });
    const pending = await service.stagePending(TENANT, {
      sourceRef: "ref-3",
      rawText: "raw",
      extractedSubject: "B",
      extractedReason: "r",
      extractedType: "start",
    });
    await service.confirmPending(TENANT, pending.id);
    expect(recorded).toEqual(["A", "B"]);
  });

  it("pendingStore 未設定で pending API を呼ぶとバリデーションエラー", async () => {
    const service = new DecisionLogService({ store: new InMemoryDecisionStore() });
    await expect(service.listPending(TENANT)).rejects.toThrow(DecisionMemoryValidationError);
  });
});
