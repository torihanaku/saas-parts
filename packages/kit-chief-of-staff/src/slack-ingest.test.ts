import { describe, expect, it, vi } from "vitest";
import {
  SlackIngestService,
  isoToSlackOldest,
  type SlackSource,
} from "./slack-ingest";
import { InMemoryDigestStore, InMemoryTenantSettingsStore } from "./stores";
import { COS_RAW_TEXT_PREVIEW_MAX } from "./types";
import { consentDenied, consentGranted, mockLlm } from "./test-helpers";

function makeSource(messages: Record<string, { ts: string; user?: string; text: string }[]>): SlackSource {
  return {
    fetchHistory: async (channel) => messages[channel] ?? [],
    fetchPermalink: async (channel, ts) => `https://slack.example/${channel}/${ts}`,
  };
}

function relevantLlm(score = 0.9) {
  return mockLlm({
    generateJson: async <T>() =>
      ({ relevant: true, relevance_score: score, tags: ["campaign"], summary: "要約" }) as T,
  });
}

describe("isoToSlackOldest", () => {
  it("ISO を epoch 秒（小数 6 桁）に変換する", () => {
    expect(isoToSlackOldest("1970-01-01T00:00:10.000Z")).toBe("10.000000");
  });

  it("不正な ISO は '0'", () => {
    expect(isoToSlackOldest("not-a-date")).toBe("0");
  });
});

describe("SlackIngestService", () => {
  const baseInput = {
    tenantId: "t1",
    ownerUserId: "u1",
    channels: ["C1"],
    sinceIso: "2026-07-01T00:00:00Z",
  };

  it("同意が無ければ consentMissing でハードスキップする", async () => {
    const store = new InMemoryDigestStore();
    const svc = new SlackIngestService({
      source: makeSource({ C1: [{ ts: "1", text: "hello" }] }),
      digestStore: store,
      consent: consentDenied,
      llm: relevantLlm(),
    });
    const res = await svc.ingest(baseInput);
    expect(res).toEqual({ ingested: 0, skipped: 0, consentMissing: true });
    expect(store.items).toHaveLength(0);
  });

  it("関連度が閾値以上のメッセージだけを digest として保存する", async () => {
    const store = new InMemoryDigestStore();
    let call = 0;
    const llm = mockLlm({
      generateJson: async <T>() => {
        call++;
        return (call === 1
          ? { relevant: true, relevance_score: 0.8, tags: ["ad"], summary: "広告の話" }
          : { relevant: true, relevance_score: 0.1, tags: [], summary: "雑談" }) as T;
      },
    });
    const svc = new SlackIngestService({
      source: makeSource({
        C1: [
          { ts: "1", user: "U9", text: "新キャンペーンのCTR共有" },
          { ts: "2", user: "U9", text: "ランチどこ行く？" },
        ],
      }),
      digestStore: store,
      consent: consentGranted,
      llm,
    });
    const res = await svc.ingest(baseInput);
    expect(res.ingested).toBe(1);
    expect(res.skipped).toBe(1);
    expect(store.items[0]).toMatchObject({
      sourceType: "slack",
      sourceActor: "slack:U9",
      summary: "広告の話",
      relevanceScore: 0.8,
      sourcePermalink: "https://slack.example/C1/1",
    });
  });

  it("raw_text_preview は 200 文字に切り詰め truncated=true", async () => {
    const store = new InMemoryDigestStore();
    const svc = new SlackIngestService({
      source: makeSource({ C1: [{ ts: "1", text: "あ".repeat(300) }] }),
      digestStore: store,
      consent: consentGranted,
      llm: relevantLlm(),
    });
    await svc.ingest(baseInput);
    expect(store.items[0]!.rawTextPreview).toHaveLength(COS_RAW_TEXT_PREVIEW_MAX);
    expect(store.items[0]!.rawTextTruncated).toBe(true);
  });

  it("LLM 未注入時は全メッセージがスキップされる", async () => {
    const store = new InMemoryDigestStore();
    const svc = new SlackIngestService({
      source: makeSource({ C1: [{ ts: "1", text: "hello" }] }),
      digestStore: store,
      consent: consentGranted,
    });
    const res = await svc.ingest(baseInput);
    expect(res).toEqual({ ingested: 0, skipped: 1 });
  });

  it("history 取得失敗はチャンネル単位で continue する", async () => {
    const store = new InMemoryDigestStore();
    const source: SlackSource = {
      fetchHistory: vi
        .fn()
        .mockRejectedValueOnce(new Error("slack_history_http_500"))
        .mockResolvedValueOnce([{ ts: "1", text: "campaign" }]),
      fetchPermalink: async () => "https://slack.example/p",
    };
    const svc = new SlackIngestService({
      source,
      digestStore: store,
      consent: consentGranted,
      llm: relevantLlm(),
    });
    const res = await svc.ingest({ ...baseInput, channels: ["BAD", "C1"] });
    expect(res.ingested).toBe(1);
  });

  it("完了時に settingsStore のウォーターマークを更新する", async () => {
    const settings = new InMemoryTenantSettingsStore();
    await settings.upsert("t1", "u1", {});
    const svc = new SlackIngestService({
      source: makeSource({}),
      digestStore: new InMemoryDigestStore(),
      consent: consentGranted,
      llm: relevantLlm(),
      settingsStore: settings,
    });
    await svc.ingest(baseInput);
    expect((await settings.get("t1"))!.lastSlackIngestedAt).not.toBeNull();
  });

  it("listIngestEnabledTenants は briefing 有効かつチャンネルありのみ返す", async () => {
    const settings = new InMemoryTenantSettingsStore();
    await settings.upsert("t1", "u1", { slackChannels: ["C1"] });
    await settings.upsert("t2", "u2", { slackChannels: [] });
    await settings.upsert("t3", "u3", {
      slackChannels: ["C9"],
      dailyBriefingEnabled: false,
    });
    const svc = new SlackIngestService({
      source: makeSource({}),
      digestStore: new InMemoryDigestStore(),
      consent: consentGranted,
      settingsStore: settings,
    });
    const rows = await svc.listIngestEnabledTenants();
    expect(rows).toEqual([
      { tenantId: "t1", ownerUserId: "u1", channels: ["C1"], lastIngestedAt: null },
    ]);
  });
});
