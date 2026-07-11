/**
 * Tests for handoff-slack.ts. The Slack proxy is injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deliverViaSlack, type SlackProxy } from "./handoff-slack.js";

const request = vi.fn();
const proxy: SlackProxy = { request };

beforeEach(() => vi.clearAllMocks());

describe("deliverViaSlack", () => {
  it("returns missing_recipient for a blank recipient", async () => {
    const res = await deliverViaSlack("  ", "hi", { proxy });
    expect(res).toEqual({ ok: false, note: "missing_recipient" });
    expect(request).not.toHaveBeenCalled();
  });

  it("posts directly to a Slack user id", async () => {
    request.mockResolvedValueOnce({ data: { ok: true } });
    const res = await deliverViaSlack("U01ABCDEF", "hello", { proxy });
    expect(res.ok).toBe(true);
    const [method, path, body] = request.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/chat.postMessage");
    expect((body as { channel: string }).channel).toBe("U01ABCDEF");
  });

  it("resolves an email via lookupByEmail + conversations.open", async () => {
    request
      .mockResolvedValueOnce({ data: { ok: true, user: { id: "U999" } } }) // lookupByEmail
      .mockResolvedValueOnce({ data: { ok: true, channel: { id: "D123" } } }) // open
      .mockResolvedValueOnce({ data: { ok: true } }); // postMessage
    const res = await deliverViaSlack("a@b.com", "hi", { proxy });
    expect(res.ok).toBe(true);
    const postCall = request.mock.calls[2]!;
    expect((postCall[2] as { channel: string }).channel).toBe("D123");
  });

  it("returns unresolved when an email has no Slack user", async () => {
    request.mockResolvedValueOnce({ data: { ok: false } }); // lookupByEmail
    const res = await deliverViaSlack("nobody@b.com", "hi", { proxy });
    expect(res).toEqual({ ok: false, note: "slack_recipient_unresolved" });
  });

  it("surfaces a slack_post_failed note when the API returns an error", async () => {
    request.mockResolvedValueOnce({ data: { ok: false, error: "channel_not_found" } });
    const res = await deliverViaSlack("U01ABCDEF", "hi", { proxy });
    expect(res.ok).toBe(false);
    expect(res.note).toBe("slack_post_failed:channel_not_found");
  });

  it("never throws — returns slack_exception on proxy error", async () => {
    request.mockRejectedValueOnce(new Error("network"));
    const res = await deliverViaSlack("U01ABCDEF", "hi", { proxy });
    expect(res).toEqual({ ok: false, note: "slack_exception" });
  });

  it("truncates over-long markdown", async () => {
    request.mockResolvedValueOnce({ data: { ok: true } });
    const long = "x".repeat(40_000);
    await deliverViaSlack("U01ABCDEF", long, { proxy });
    const body = request.mock.calls[0]![2] as { text: string };
    expect(body.text.length).toBeLessThan(40_000);
    expect(body.text).toContain("truncated");
  });
});
