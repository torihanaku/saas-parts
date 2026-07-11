import { describe, expect, it } from "vitest";
import {
  EmailIngestService,
  buildEmailQuery,
  extractPlainText,
  type EmailSource,
  type MessageEnvelope,
} from "./email-ingest";
import { InMemoryDigestStore } from "./stores";
import { consentDenied, consentGranted, mockLlm } from "./test-helpers";

describe("buildEmailQuery", () => {
  const since = "2026-07-01T09:30:00Z";

  it("gmail: after + from + subject + label", () => {
    expect(
      buildEmailQuery(
        "google-mail",
        { fromDomain: "agency.co.jp", subjectContains: "レポート", labelIncludes: "marketing" },
        since,
      ),
    ).toBe("after:2026-07-01 from:@agency.co.jp subject:(レポート) label:marketing");
  });

  it("outlook: label は category になる", () => {
    expect(buildEmailQuery("outlook", { labelIncludes: "red" }, since)).toBe(
      "after:2026-07-01 category:(red)",
    );
  });
});

describe("extractPlainText", () => {
  it("ネストした parts から text/plain を base64url デコードして返す", () => {
    const data = Buffer.from("こんにちは", "utf-8").toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const message = {
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: "xxx" } },
          { mimeType: "text/plain", body: { data } },
        ],
      },
    };
    expect(extractPlainText(message)).toBe("こんにちは");
  });

  it("payload が無ければ snippet にフォールバック", () => {
    expect(extractPlainText({ snippet: "preview text" })).toBe("preview text");
  });

  it("何も無ければ空文字", () => {
    expect(extractPlainText({})).toBe("");
  });
});

describe("EmailIngestService", () => {
  const envelope: MessageEnvelope = {
    id: "m1",
    permalink: "https://mail.example/m1",
    from: "boss@agency.co.jp",
    subject: "広告レポート",
    body: "CTR は 2.1% でした",
  };

  function makeSource(envelopes: MessageEnvelope[]): EmailSource {
    return { listEnvelopes: async () => envelopes };
  }

  const baseInput = {
    tenantId: "t1",
    filterRules: [{ fromDomain: "agency.co.jp" }],
    sinceIso: "2026-07-01T00:00:00Z",
  };

  it("同意なしは skipped: -1", async () => {
    const svc = new EmailIngestService({
      source: makeSource([envelope]),
      digestStore: new InMemoryDigestStore(),
      consent: consentDenied,
      llm: mockLlm(),
    });
    expect(await svc.ingest(baseInput)).toEqual({ ingested: 0, skipped: -1 });
  });

  it("LLM 未注入は {0,0}（ingest せず）", async () => {
    const svc = new EmailIngestService({
      source: makeSource([envelope]),
      digestStore: new InMemoryDigestStore(),
      consent: consentGranted,
    });
    expect(await svc.ingest(baseInput)).toEqual({ ingested: 0, skipped: 0 });
  });

  it("relevant なメールを digest 化する（relevance 0.8 固定）", async () => {
    const store = new InMemoryDigestStore();
    const svc = new EmailIngestService({
      source: makeSource([envelope]),
      digestStore: store,
      consent: consentGranted,
      llm: mockLlm({
        generateJson: async <T>() =>
          ({ relevant: true, summary: "CTR 2.1% の報告", tags: ["report"] }) as T,
      }),
    });
    const res = await svc.ingest(baseInput);
    expect(res).toEqual({ ingested: 1, skipped: 0 });
    expect(store.items[0]).toMatchObject({
      sourceType: "email",
      sourceActor: "email:boss@agency.co.jp",
      summary: "CTR 2.1% の報告",
      relevanceScore: 0.8,
    });
  });

  it("relevant=false はスキップ", async () => {
    const store = new InMemoryDigestStore();
    const svc = new EmailIngestService({
      source: makeSource([envelope]),
      digestStore: store,
      consent: consentGranted,
      llm: mockLlm({ generateJson: async <T>() => ({ relevant: false }) as T }),
    });
    expect(await svc.ingest(baseInput)).toEqual({ ingested: 0, skipped: 1 });
    expect(store.items).toHaveLength(0);
  });

  it("要約が throw してもアイテム単位で skipped に数える", async () => {
    const svc = new EmailIngestService({
      source: makeSource([envelope, { ...envelope, id: "m2" }]),
      digestStore: new InMemoryDigestStore(),
      consent: consentGranted,
      llm: mockLlm({
        generateJson: async () => {
          throw new Error("llm down");
        },
      }),
    });
    expect(await svc.ingest(baseInput)).toEqual({ ingested: 0, skipped: 2 });
  });

  it("長文 body は preview 200 文字 + truncated", async () => {
    const store = new InMemoryDigestStore();
    const svc = new EmailIngestService({
      source: makeSource([{ ...envelope, body: "x".repeat(500) }]),
      digestStore: store,
      consent: consentGranted,
      llm: mockLlm({ generateJson: async <T>() => ({ relevant: true, summary: "s" }) as T }),
    });
    await svc.ingest(baseInput);
    expect(store.items[0]!.rawTextPreview).toHaveLength(200);
    expect(store.items[0]!.rawTextTruncated).toBe(true);
  });
});
