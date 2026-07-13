/**
 * Tests for the transcript parser (.vtt / .srt → plain text).
 * Ported from 実運用SaaS (tests/utils/transcriptParser.test.ts) plus golden cases.
 */
import { describe, it, expect } from "vitest";
import {
  detectFormat,
  parseTranscript,
  parseTranscriptFile,
} from "./index";

describe("detectFormat", () => {
  it("detects vtt by extension", () => {
    expect(detectFormat("meeting.vtt", "")).toBe("vtt");
    expect(detectFormat("Meeting.VTT", "")).toBe("vtt");
  });

  it("detects srt by extension", () => {
    expect(detectFormat("meeting.srt", "")).toBe("srt");
  });

  it("detects vtt by content header when extension is missing", () => {
    expect(detectFormat("notes.txt", "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello")).toBe("vtt");
  });

  it("detects srt by content shape", () => {
    expect(
      detectFormat("notes.txt", "1\n00:00:01,000 --> 00:00:04,000\nHello world"),
    ).toBe("srt");
  });

  it("returns unknown for arbitrary plain text", () => {
    expect(detectFormat("notes.md", "Bob: Hello\nAlice: Hi")).toBe("unknown");
  });
});

describe("parseTranscript (vtt)", () => {
  it("strips WEBVTT header, NOTE blocks, timing cues and inline tags", () => {
    const vtt = `WEBVTT

NOTE this is a note we want to drop

00:00:01.000 --> 00:00:04.000
<c.speaker>Bob:</c> Hello team

00:00:05.000 --> 00:00:09.000
Alice: Did we ship the deploy?
`;
    const out = parseTranscript(vtt, "vtt");
    expect(out.format).toBe("vtt");
    expect(out.cueCount).toBe(2);
    expect(out.text).toContain("Bob: Hello team");
    expect(out.text).toContain("Alice: Did we ship the deploy?");
    expect(out.text).not.toContain("WEBVTT");
    expect(out.text).not.toContain("NOTE");
    expect(out.text).not.toContain("-->");
  });

  it("joins multi-line cue bodies with a space", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
Bob:
This sentence
is split.
`;
    const out = parseTranscript(vtt, "vtt");
    expect(out.cueCount).toBe(1);
    expect(out.text).toBe("Bob: This sentence is split.");
  });

  it("returns empty text when only headers/timing", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
`;
    const out = parseTranscript(vtt, "vtt");
    expect(out.cueCount).toBe(0);
    expect(out.text).toBe("");
  });

  it("preserves <v Speaker> voice-tag labels instead of dropping them", () => {
    // Regression: Zoom / YouTube auto-captions encode the speaker as a WebVTT
    // voice tag `<v Bob>...</v>`. The generic `<...>` tag stripper used to
    // delete the whole tag, silently losing every speaker label and defeating
    // the diarized-summary use case.
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Bob>Hello world</v>

00:00:05.000 --> 00:00:08.000
<v.loud Alice Smith>Hi Bob, how are you?</v>
`;
    const out = parseTranscript(vtt, "vtt");
    expect(out.cueCount).toBe(2);
    expect(out.text).toBe("Bob: Hello world\nAlice Smith: Hi Bob, how are you?");
  });

  it("drops an empty voice span (no residual bare label)", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Bob></v>
`;
    const out = parseTranscript(vtt, "vtt");
    expect(out.cueCount).toBe(0);
    expect(out.text).toBe("");
  });
});

describe("parseTranscript (srt)", () => {
  it("strips index numbers and timing, preserves cue text", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Bob: Welcome

2
00:00:05,500 --> 00:00:08,000
Alice: Thanks for having us
`;
    const out = parseTranscript(srt, "srt");
    expect(out.format).toBe("srt");
    expect(out.cueCount).toBe(2);
    expect(out.text).toBe("Bob: Welcome\nAlice: Thanks for having us");
  });

  it("handles cues without trailing newlines", () => {
    const srt = `1\n00:00:01,000 --> 00:00:04,000\nHello\n2\n00:00:05,000 --> 00:00:09,000\nWorld`;
    const out = parseTranscript(srt, "srt");
    // No blank line separator → both cues collapse into single buffer entry,
    // but the timing lines are stripped so we get "Hello World" as one cue.
    expect(out.text).toBe("Hello World");
  });
});

describe("parseTranscript (plain / unknown)", () => {
  it("returns content as-is when format is plain", () => {
    const text = "Bob: hello\nAlice: hi";
    const out = parseTranscript(text, "plain");
    expect(out.format).toBe("plain");
    expect(out.text).toBe(text);
    expect(out.cueCount).toBe(1);
  });

  it("treats unknown format as raw text", () => {
    const text = "  some pasted content  ";
    const out = parseTranscript(text, "unknown");
    expect(out.format).toBe("unknown");
    expect(out.text).toBe("some pasted content");
  });

  it("zero cueCount when input is empty whitespace", () => {
    expect(parseTranscript("   ", "plain").cueCount).toBe(0);
  });
});

describe("parseTranscriptFile (convenience)", () => {
  it("auto-detects format and parses .vtt files", () => {
    const out = parseTranscriptFile(
      "meeting.vtt",
      "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nBob: hi\n",
    );
    expect(out.format).toBe("vtt");
    expect(out.text).toBe("Bob: hi");
  });

  it("falls back to unknown format for arbitrary text files", () => {
    const out = parseTranscriptFile("notes.txt", "raw notes");
    expect(out.format).toBe("unknown");
    expect(out.text).toBe("raw notes");
  });
});

// ---------------------------------------------------------------------------
// Golden fixtures (batch acceptance): full end-to-end format coverage.
// ---------------------------------------------------------------------------

describe("golden fixtures", () => {
  it("WEBVTT with timing cues + speaker labels → plain text, cueCount, format=vtt", () => {
    const vtt = `WEBVTT

NOTE recorded via Tactiq

00:00:00.500 --> 00:00:03.200
Bob: Hello

00:00:03.500 --> 00:00:06.000
Alice: Hi Bob, ready to start?

00:00:06.500 --> 00:00:10.000
Bob: Yes, let's go.
`;
    const out = parseTranscript(vtt, "vtt");
    expect(out.format).toBe("vtt");
    expect(out.cueCount).toBe(3);
    expect(out.text).toBe(
      "Bob: Hello\nAlice: Hi Bob, ready to start?\nBob: Yes, let's go.",
    );
    // Speaker labels preserved verbatim.
    expect(out.text).toContain("Bob: Hello");
  });

  it("SRT numbered blocks + timestamps → plain text, format=srt", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Bob: Hello

2
00:00:05,000 --> 00:00:09,000
Alice: Welcome everyone
`;
    const out = parseTranscript(srt, "srt");
    expect(out.format).toBe("srt");
    expect(out.cueCount).toBe(2);
    expect(out.text).toBe("Bob: Hello\nAlice: Welcome everyone");
    // "Bob: Hello" speaker label stays intact.
    expect(out.text).toContain("Bob: Hello");
  });

  it("plain-text fixture → format=plain, text preserved", () => {
    const plain = "Bob: Hello\nAlice: Hi there";
    const out = parseTranscript(plain, "plain");
    expect(out.format).toBe("plain");
    expect(out.text).toBe(plain);
    expect(out.text).toContain("Bob: Hello");
  });

  it("malformed / empty input → cueCount 0", () => {
    expect(parseTranscript("", "vtt").cueCount).toBe(0);
    expect(parseTranscript("WEBVTT\n\n", "vtt").cueCount).toBe(0);
    expect(parseTranscript("   \n\n  ", "srt").cueCount).toBe(0);
    expect(parseTranscript("", "plain").cueCount).toBe(0);
  });
});
