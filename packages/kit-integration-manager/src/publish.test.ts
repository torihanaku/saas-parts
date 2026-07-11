import { describe, it, expect, vi } from "vitest";
import {
  buildPublishPayload,
  publishToPlatform,
  publishToMultiplePlatforms,
  type PublishTarget,
} from "./publish";
import { MockIntegrationProvider } from "./mock-provider";

const DRAFT = { id: "draft-1", title: "Test", content: "Content here for testing purposes" };

describe("buildPublishPayload", () => {
  it("builds Slack payload with default channel", () => {
    const p = buildPublishPayload("slack", "T", "C");
    expect(p?.endpoint).toBe("/chat.postMessage");
    expect(p?.body.channel).toBe("#general");
  });

  it("builds WordPress publish payload", () => {
    const p = buildPublishPayload("wordpress", "T", "C");
    expect(p?.endpoint).toBe("/wp/v2/posts");
    expect(p?.body.status).toBe("publish");
  });

  it("builds LinkedIn payload truncated to 700 chars", () => {
    const p = buildPublishPayload("linkedin", "T", "x".repeat(1000));
    expect(p?.endpoint).toBe("/ugcPosts");
    expect(String(p?.body.commentary)).toHaveLength(700);
  });

  it("builds LINE push payload with group ID", () => {
    const p = buildPublishPayload("line", "T", "C", { lineGroupId: "G1" });
    expect(p?.endpoint).toBe("/v2/bot/message/push");
    expect(p?.body.to).toBe("G1");
  });

  it("builds note draft payload", () => {
    const p = buildPublishPayload("note", "T", "C");
    expect(p?.endpoint).toBe("/api/v2/notes");
    expect(p?.body.status).toBe("draft");
  });

  it("builds Mailchimp campaign payload with sender name", () => {
    const p = buildPublishPayload("mailchimp", "T", "C", { fromName: "Sender" });
    expect(p?.endpoint).toBe("/campaigns");
    expect((p?.body.settings as { from_name: string }).from_name).toBe("Sender");
  });

  it("returns null for unsupported platforms", () => {
    expect(buildPublishPayload("tiktok", "T", "C")).toBeNull();
  });
});

describe("publishToPlatform", () => {
  it("returns error for unsupported platform", async () => {
    const provider = new MockIntegrationProvider();
    const target = { platform: "tiktok" as "slack", connectionId: "c1" };
    const result = await publishToPlatform(provider, "t1", DRAFT, target);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未対応");
  });

  it("publishes to Slack via the provider (default channel)", async () => {
    const provider = new MockIntegrationProvider();
    const result = await publishToPlatform(provider, "t1", DRAFT, { platform: "slack", connectionId: "c1" });
    expect(result).toEqual({ ok: true, platform: "slack" });
    const call = provider.publishCalls[0];
    expect(call?.integrationId).toBe("slack");
    expect(call?.request.endpoint).toBe("/chat.postMessage");
    expect(call?.request.body?.channel).toBe("#general");
  });

  it("uses a custom Slack channel", async () => {
    const provider = new MockIntegrationProvider();
    await publishToPlatform(provider, "t1", DRAFT, {
      platform: "slack",
      connectionId: "c1",
      slackChannel: "#marketing",
    });
    expect(provider.publishCalls[0]?.request.body?.channel).toBe("#marketing");
  });

  it("respects the integrationId override", async () => {
    const provider = new MockIntegrationProvider();
    await publishToPlatform(provider, "t1", DRAFT, {
      platform: "wordpress",
      connectionId: "c-wp",
      integrationId: "wordpress-jp",
    });
    expect(provider.publishCalls[0]?.integrationId).toBe("wordpress-jp");
  });

  it("calls onPublished after a successful publish", async () => {
    const provider = new MockIntegrationProvider();
    const onPublished = vi.fn(async () => {});
    await publishToPlatform(provider, "t1", DRAFT, { platform: "slack", connectionId: "c1" }, onPublished);
    expect(onPublished).toHaveBeenCalledWith(DRAFT, "slack");
  });

  it("returns error when provider.publish returns null (no onPublished)", async () => {
    const provider = new MockIntegrationProvider();
    provider.publishResult = null;
    const onPublished = vi.fn(async () => {});
    const result = await publishToPlatform(provider, "t1", DRAFT, { platform: "slack", connectionId: "c1" }, onPublished);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("null");
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("returns error when provider.publish throws", async () => {
    const provider = new MockIntegrationProvider();
    provider.publish = async () => {
      throw new Error("Connection refused");
    };
    const result = await publishToPlatform(provider, "t1", DRAFT, { platform: "slack", connectionId: "c1" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Connection refused");
  });
});

describe("publishToMultiplePlatforms", () => {
  it("publishes to all targets in parallel and returns one result per target", async () => {
    const provider = new MockIntegrationProvider();
    const targets: PublishTarget[] = [
      { platform: "slack", connectionId: "c1" },
      { platform: "wordpress", connectionId: "c2" },
    ];
    const results = await publishToMultiplePlatforms(provider, "t1", DRAFT, targets);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(provider.publishCalls).toHaveLength(2);
  });
});
