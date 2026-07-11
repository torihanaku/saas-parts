/**
 * 一気通貫パイプラインテスト:
 * ingest（Slack + Meeting）→ digest feed → briefing → Q&A → タスクレビュー → 外部同期。
 * LLM / ソース / 同期先はすべてモック、ストアはインメモリ。
 */
import { describe, expect, it } from "vitest";
import {
  BriefingGenerator,
  FeedService,
  InMemoryBriefingStore,
  InMemoryDigestStore,
  InMemoryTaskStore,
  MeetingIngestService,
  QaEngine,
  SlackIngestService,
  TaskReviewService,
  type LlmCaller,
  type SlackSource,
  type TaskSyncTarget,
  type Transcriber,
} from "./index";
import { consentGranted } from "./test-helpers";

function pipelineLlm(): LlmCaller {
  return {
    async generateText(system, prompt) {
      if (system.includes("チーフ・オブ・スタッフ")) return `ブリーフィング: ${prompt.length} 字の入力から生成`;
      if (system.includes("要約するアシスタント")) return "会議要約: LP改修を決定";
      if (system.includes("チーフオブスタッフ")) return "回答 [source: cos_digest, id: cos-0000]";
      return "generic";
    },
    async generateJson<T>(system: string, _prompt: string, fallback: T): Promise<T> {
      if (system.includes("classifier")) {
        return { relevant: true, relevance_score: 0.7, tags: ["campaign"], summary: "施策の議論" } as T;
      }
      if (system.includes("action item")) {
        return [{ task_text: "LP改修", assignee_hint: "@田中", due_hint: "金曜" }] as T;
      }
      return fallback;
    },
  };
}

describe("COS パイプライン（ingest → feed → briefing → QA → task review → sync）", () => {
  it("一気通貫で動く", async () => {
    const digestStore = new InMemoryDigestStore();
    const taskStore = new InMemoryTaskStore();
    const briefingStore = new InMemoryBriefingStore();
    const llm = pipelineLlm();

    // 1. Slack ingest
    const slackSource: SlackSource = {
      fetchHistory: async () => [{ ts: "1", user: "U1", text: "新キャンペーンのCVRが上がった" }],
      fetchPermalink: async (c, ts) => `https://slack.example/${c}/${ts}`,
    };
    const slack = new SlackIngestService({
      source: slackSource,
      digestStore,
      consent: consentGranted,
      llm,
    });
    const slackRes = await slack.ingest({
      tenantId: "t1",
      ownerUserId: "u1",
      channels: ["C1"],
      sinceIso: "2026-07-01T00:00:00Z",
    });
    expect(slackRes.ingested).toBe(1);

    // 2. Meeting ingest（action item がタスク化される）
    const transcriber: Transcriber = {
      transcribe: async () => ({ text: "定例。LP改修を田中さんが金曜まで。" }),
    };
    const meeting = new MeetingIngestService({
      transcriber,
      digestStore,
      taskStore,
      consent: consentGranted,
      llm,
    });
    const meetingRes = await meeting.ingest({
      tenantId: "t1",
      userId: "u1",
      audioUrl: "https://rec.example/1",
      meetingTitle: "定例",
      meetingDate: "2026-07-10T10:00:00Z",
    });
    expect(meetingRes.status).toBe("ok");
    expect(meetingRes.tasksExtracted).toBe(1);

    // 3. Feed に両方現れる（meeting relevance=1.0 が先頭）
    const feed = new FeedService({ digestStore });
    const items = await feed.list("t1");
    expect(items).toHaveLength(2);
    expect(items[0]!.sourceType).toBe("meeting");

    // 4. Briefing（digest + pending タスクが集約される）
    const generator = new BriefingGenerator({ digestStore, taskStore, briefingStore, llm });
    const briefing = await generator.generate("t1", "daily");
    expect(briefing.summary).toContain("ブリーフィング:");
    expect(briefing.keyItemIds).toHaveLength(2);

    // 5. Q&A（digest を根拠に回答）
    const qa = new QaEngine({ digestStore, llm });
    const answer = await qa.ask({ tenantId: "t1", question: "LP はどうなった？" });
    expect(answer.hasAnswer).toBe(true);
    expect(answer.citations.length).toBeGreaterThan(0);

    // 6. タスクレビュー → 外部同期
    const syncTarget: TaskSyncTarget = {
      syncedToLabel: "github_issue",
      sync: async () => ({ ok: true, externalId: "7", externalUrl: "https://gh/7" }),
    };
    const review = new TaskReviewService({ taskStore, syncTargets: { github: syncTarget } });
    const pending = await review.listPending("t1");
    expect(pending).toHaveLength(1);

    const confirmed = await review.confirm("t1", pending[0]!.id);
    expect(confirmed.ok).toBe(true);

    const synced = await review.sync("t1", pending[0]!.id, "github");
    expect(synced).toMatchObject({ ok: true, status: "synced", externalId: "7" });
    expect(await review.listPending("t1")).toHaveLength(0);
  });
});
