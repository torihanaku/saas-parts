/**
 * Transcript file format parser.
 *
 * Converts .vtt (WebVTT) and .srt (SubRip) subtitle files into a clean,
 * speaker-aware plain text format that a multi-channel summarizer can
 * consume. Timing cues are stripped; speaker labels are preserved when
 * encoded in the cue body (e.g. "Bob: Hello world").
 *
 * Supports the formats produced by Tactiq, Otter, Zoom Cloud Recording,
 * and most common transcription tools.
 */

export type TranscriptFormat = "vtt" | "srt" | "plain" | "unknown";

export interface ParsedTranscript {
  /** Plain text with one cue per line, blank lines collapsed. */
  text: string;
  /** Number of cues parsed. 0 means the file looked empty / malformed. */
  cueCount: number;
  /** Detected format. `plain` means the parser did not need to strip timing. */
  format: TranscriptFormat;
}

/** Detect format from filename + first few lines of content. */
export function detectFormat(fileName: string, content: string): TranscriptFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".vtt")) return "vtt";
  if (lower.endsWith(".srt")) return "srt";
  // Sniff content
  const head = content.slice(0, 200);
  if (/^WEBVTT/.test(head)) return "vtt";
  // SRT: numbered cues "1\n00:00:01,000 --> 00:00:04,000"
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(head.trimStart())) return "srt";
  return "unknown";
}

const TIMING_LINE_RE = /^\d{2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?[.,]\d{1,3}/;
const SRT_INDEX_RE = /^\d+$/;
const VTT_NOTE_RE = /^(WEBVTT|NOTE|STYLE|REGION)\b/i;
const VTT_CUE_TAG_RE = /<[^>]+>/g; // strip <c.color>...</c> etc.

function cleanCueLine(line: string): string {
  return line.replace(VTT_CUE_TAG_RE, "").trim();
}

/**
 * Parse a vtt/srt blob to plain text. Lines that aren't timing / index /
 * meta become content lines, joined with newlines so the summarizer can
 * see "Bob: …", "Alice: …" format directly.
 */
export function parseTranscript(content: string, format: TranscriptFormat): ParsedTranscript {
  if (format === "plain" || format === "unknown") {
    const cleaned = content.trim();
    return {
      text: cleaned,
      cueCount: cleaned ? 1 : 0,
      format,
    };
  }

  const lines = content.split(/\r?\n/);
  const cues: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(" ").trim();
    if (joined) cues.push(joined);
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (format === "vtt" && VTT_NOTE_RE.test(line)) continue;
    if (TIMING_LINE_RE.test(line)) continue;
    if (format === "srt" && SRT_INDEX_RE.test(line)) continue;
    const cleaned = cleanCueLine(line);
    if (cleaned) buffer.push(cleaned);
  }
  flush();

  return {
    text: cues.join("\n"),
    cueCount: cues.length,
    format,
  };
}

/** Convenience: detect format then parse in a single call. */
export function parseTranscriptFile(fileName: string, content: string): ParsedTranscript {
  const format = detectFormat(fileName, content);
  return parseTranscript(content, format);
}
