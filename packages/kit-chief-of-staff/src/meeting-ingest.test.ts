import { describe, expect, it } from "vitest";
import { MeetingIngestService, type Transcriber } from "./meeting-ingest";
import { InMemoryDigestStore, InMemoryTaskStore } from "./stores";
import { consentDenied, consentGranted, mockLlm } from "./test-helpers";

const okTranscriber: Transcriber = {
  transcribe: async () => ({ text: "会議の内容。田中さんが来週金曜までにLP改修。" }),
};

const baseInput = {
  tenantId: "t1",
  userId: "u1",
  audioUrl: "https://zoom.example/rec/123",
  meetingTitle: "週次マーケ定例",
  meetingDate: "2026-07-10T10:00:00Z",
};

function makeService(overrides: Partial<ConstructorParameters<typeof MeetingIngestService>[0]> = {}) {
  const digestStore = new InMemoryDigestStore();
  const taskStore = new InMemoryTaskStore();
  const svc = new MeetingIngestService({
    transcriber: okTranscriber,
    digestStore,
    taskStore,
    consent: consentGranted,
    llm: mockLlm({
      generateText: async () => "会議要約",
      generateJson: async <T>() =>
        [
          { task_text: "LP改修", assignee_hint: "@田中", due_hint: "来週金曜" },
          { task_text: "   " }, // 空テキストはスキップされる
        ] as T,
    }),
    ...overrides,
  });
  return { svc, digestStore, taskStore };
}

describe("MeetingIngestService", () => {
  it("同意なしは skipped_no_consent（何も保存しない）", async () => {
    const { svc, digestStore, taskStore } = makeService({ consent: consentDenied });
    const res = await svc.ingest(baseInput);
    expect(res).toEqual({ digestId: null, tasksExtracted: 0, status: "skipped_no_consent" });
    expect(digestStore.items).toHaveLength(0);
    expect(taskStore.tasks).toHaveLength(0);
  });

  it("書き起こし失敗は transcribe_failed（throw しない）", async () => {
    const { svc } = makeService({
      transcriber: { transcribe: async () => { throw new Error("assemblyai down"); } },
    });
    const res = await svc.ingest(baseInput);
    expect(res.status).toBe("transcribe_failed");
    expect(res.digestId).toBeNull();
  });

  it("happy path: digest 保存 + action item 抽出（空テキストは除外）", async () => {
    const { svc, digestStore, taskStore } = makeService();
    const res = await svc.ingest(baseInput);
    expect(res.status).toBe("ok");
    expect(res.digestId).not.toBeNull();
    expect(res.tasksExtracted).toBe(1);

    expect(digestStore.items[0]).toMatchObject({
      sourceType: "meeting",
      sourcePermalink: baseInput.audioUrl,
      sourceActor: null,
      summary: "会議要約",
      relevanceScore: 1.0,
    });
    expect(taskStore.tasks[0]).toMatchObject({
      taskText: "LP改修",
      assigneeHint: "@田中",
      dueHint: "来週金曜",
      status: "pending_review",
      digestItemId: res.digestId,
    });
  });

  it("フル書き起こしは保存されない（preview 200 文字契約）", async () => {
    const long = "会".repeat(5000);
    const { svc, digestStore } = makeService({
      transcriber: { transcribe: async () => ({ text: long }) },
    });
    await svc.ingest(baseInput);
    expect(digestStore.items[0]!.rawTextPreview).toHaveLength(200);
    expect(digestStore.items[0]!.rawTextTruncated).toBe(true);
  });

  it("digest 保存失敗は digest_insert_failed でタスク抽出に進まない", async () => {
    const failingStore = new InMemoryDigestStore();
    failingStore.insert = async () => ({ ok: false, error: "db down" });
    const { svc, taskStore } = makeService({ digestStore: failingStore });
    const res = await svc.ingest(baseInput);
    expect(res.status).toBe("digest_insert_failed");
    expect(taskStore.tasks).toHaveLength(0);
  });

  it("LLM 未注入でも digest は保存される（要約空・タスク 0）", async () => {
    const { svc, digestStore } = makeService({ llm: undefined });
    const res = await svc.ingest(baseInput);
    expect(res.status).toBe("ok");
    expect(res.tasksExtracted).toBe(0);
    expect(digestStore.items[0]!.summary).toBe("");
  });
});
