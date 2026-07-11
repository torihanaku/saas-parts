import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transcribeAudio, TranscribeError, type TranscribeConfig } from "./index";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Instant sleep for tests — resolves immediately without advancing time. */
const noSleep = async (_ms: number) => {};

const baseConfig = (fetchImpl: typeof fetch): TranscribeConfig => ({
  apiKey: "test-key",
  fetchImpl,
});

describe("transcribeAudio — input validation", () => {
  it("throws when apiKey is missing", async () => {
    await expect(
      transcribeAudio({ url: "https://example.com/a.mp3" }, { apiKey: "" }, noSleep),
    ).rejects.toThrow(TranscribeError);
  });

  it("throws when url is not absolute http(s)", async () => {
    await expect(
      transcribeAudio({ url: "ftp://example.com/a.mp3" }, { apiKey: "test-key" }, noSleep),
    ).rejects.toThrow(/absolute http\(s\) URL/);
    await expect(
      transcribeAudio({ url: "" }, { apiKey: "test-key" }, noSleep),
    ).rejects.toThrow(TranscribeError);
  });
});

describe("transcribeAudio — submit", () => {
  it("sends audio_url with defaults (ja, speaker_labels) and auth header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "queued" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "t1", status: "completed", text: "hello", language_code: "ja" }),
      );

    await transcribeAudio(
      { url: "https://example.com/a.mp3" },
      baseConfig(fetchMock as unknown as typeof fetch),
      noSleep,
    );

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]!;
    expect(submitUrl).toBe("https://api.assemblyai.com/v2/transcript");
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers.authorization).toBe("test-key");
    expect(JSON.parse(submitInit.body)).toEqual({
      audio_url: "https://example.com/a.mp3",
      language_code: "ja",
      speaker_labels: true,
    });
  });

  it("throws TranscribeError when submit returns non-ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }));
    await expect(
      transcribeAudio(
        { url: "https://example.com/a.mp3" },
        baseConfig(fetchMock as unknown as typeof fetch),
        noSleep,
      ),
    ).rejects.toThrow(/AssemblyAI submit failed: 401/);
  });

  it("throws TranscribeError when submit returns no id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "queued" }));
    await expect(
      transcribeAudio(
        { url: "https://example.com/a.mp3" },
        baseConfig(fetchMock as unknown as typeof fetch),
        noSleep,
      ),
    ).rejects.toThrow(/no transcript id/);
  });
});

describe("transcribeAudio — polling", () => {
  it("polls until completed and maps the unified result shape", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "t2", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ id: "t2", status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "t2",
          status: "completed",
          text: "こんにちは 世界",
          language_code: "ja",
          utterances: [
            { speaker: "A", text: "こんにちは", start: 0, end: 900 },
            { speaker: "B", text: "世界", start: 1000, end: 1800 },
          ],
        }),
      );

    const result = await transcribeAudio(
      { url: "https://example.com/a.mp3" },
      baseConfig(fetchMock as unknown as typeof fetch),
      noSleep,
    );

    expect(result).toEqual({
      id: "t2",
      text: "こんにちは 世界",
      language: "ja",
      utterances: [
        { speaker: "A", text: "こんにちは", start: 0, end: 900 },
        { speaker: "B", text: "世界", start: 1000, end: 1800 },
      ],
    });
    // 1 submit + 2 polls
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.assemblyai.com/v2/transcript/t2");
  });

  it("applies backoff: 3s, then 4s, capped at 12s", async () => {
    const sleeps: number[] = [];
    const sleepSpy = async (ms: number) => {
      sleeps.push(ms);
    };
    const processing = () => jsonResponse({ id: "t3", status: "processing" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "t3", status: "queued" }));
    for (let i = 0; i < 12; i++) fetchMock.mockResolvedValueOnce(processing());
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "t3", status: "completed", text: "ok" }),
    );

    await transcribeAudio(
      { url: "https://example.com/a.mp3" },
      baseConfig(fetchMock as unknown as typeof fetch),
      sleepSpy,
    );

    expect(sleeps[0]).toBe(3_000);
    expect(sleeps[1]).toBe(4_000);
    expect(Math.max(...sleeps)).toBe(12_000);
    expect(sleeps[sleeps.length - 1]).toBe(12_000);
  });

  it("throws TranscribeError when poll returns non-ok", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "t4", status: "queued" }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(
      transcribeAudio(
        { url: "https://example.com/a.mp3" },
        baseConfig(fetchMock as unknown as typeof fetch),
        noSleep,
      ),
    ).rejects.toThrow(/AssemblyAI poll failed: 500/);
  });

  it("throws TranscribeError when job ends in error status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "t5", status: "queued" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "t5", status: "error", error: "unsupported codec" }),
      );
    await expect(
      transcribeAudio(
        { url: "https://example.com/a.mp3" },
        baseConfig(fetchMock as unknown as typeof fetch),
        noSleep,
      ),
    ).rejects.toThrow(/AssemblyAI returned error: unsupported codec/);
  });
});

describe("transcribeAudio — hard timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws after the 10-minute poll timeout", async () => {
    // Sleep mock advances fake time so Date.now() progresses past the cap.
    const fakeSleep = async (ms: number) => {
      vi.advanceTimersByTime(ms);
    };
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "t6", status: "processing" }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "t6", status: "queued" }));

    await expect(
      transcribeAudio(
        { url: "https://example.com/a.mp3" },
        baseConfig(fetchMock as unknown as typeof fetch),
        fakeSleep,
      ),
    ).rejects.toThrow(/poll exceeded 600000ms timeout/);
  });
});

describe("transcribeAudio — config injection", () => {
  it("respects a custom baseUrl", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "t7", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ id: "t7", status: "completed", text: "" }));

    await transcribeAudio(
      { url: "https://example.com/a.mp3", language: "en", speakerLabels: false },
      { apiKey: "test-key", baseUrl: "http://localhost:9999/v2", fetchImpl: fetchMock as unknown as typeof fetch },
      noSleep,
    );

    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:9999/v2/transcript");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      audio_url: "https://example.com/a.mp3",
      language_code: "en",
      speaker_labels: false,
    });
  });
});
