/**
 * AssemblyAI thin transcription wrapper.
 *
 * Submits an audio URL to AssemblyAI for diarized transcription, polls until
 * the job completes, and returns a unified transcript shape.
 *
 * Why a thin wrapper:
 *   - Centralising the AssemblyAI HTTP contract here lets multiple features
 *     (Slack huddle ingest, call recordings, ...) reuse the same client
 *     without re-implementing the polling loop.
 *
 * Operational notes:
 *   - All fetches use a private `fetchWithTimeout` to avoid instance hangs.
 *   - Polling backs off after each iteration up to a hard ceiling so we don't
 *     spin against the AssemblyAI API and exhaust per-minute quota.
 *   - Errors throw `TranscribeError` so callers can distinguish missing key vs
 *     transient API failure vs malformed audio URL.
 *
 * Ported from dev-dashboard-v2 `server/lib/transcribe-client.ts`.
 * Changes from source: API key is injected via `TranscribeConfig` (no env
 * reads), `fetchWithTimeout` is inlined, base URL / fetch impl are injectable.
 */

const DEFAULT_BASE_URL = "https://api.assemblyai.com/v2";
const POLL_INTERVAL_MS = 3_000;
const POLL_BACKOFF_MAX_MS = 12_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes hard cap

export class TranscribeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TranscribeError";
  }
}

export interface TranscribeConfig {
  /** AssemblyAI API key (required). Inject from your own config/secret layer. */
  apiKey: string;
  /** API base URL (default: "https://api.assemblyai.com/v2"). */
  baseUrl?: string;
  /** fetch implementation override for tests (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export interface TranscribeUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  /** Provider transcript id (for audit / re-fetch). */
  id: string;
  /** Concatenated full text. */
  text: string;
  /** Speaker-labelled utterances (empty array if diarization unavailable). */
  utterances: TranscribeUtterance[];
  /** Detected or requested language (BCP-47-ish, e.g. "ja"). */
  language: string;
}

export interface TranscribeOptions {
  /** Audio URL (https). AssemblyAI fetches it server-side. */
  url: string;
  /** Language code (default: "ja"). */
  language?: string;
  /** Enable speaker diarization (default: true). */
  speakerLabels?: boolean;
}

interface SubmitResponse {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  error?: string;
}

interface PollResponse extends SubmitResponse {
  text?: string;
  language_code?: string;
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
  }>;
}

/** Private copy of dev-dashboard-v2 helpers.fetchWithTimeout. */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: apiKey, "content-type": "application/json" };
}

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
}

async function submitTranscriptJob(
  config: ResolvedConfig,
  options: TranscribeOptions,
): Promise<string> {
  const body = {
    audio_url: options.url,
    language_code: options.language ?? "ja",
    speaker_labels: options.speakerLabels ?? true,
  };
  const res = await fetchWithTimeout(
    config.fetchImpl,
    `${config.baseUrl}/transcript`,
    {
      method: "POST",
      headers: authHeaders(config.apiKey),
      body: JSON.stringify(body),
    },
    30_000,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TranscribeError(
      `AssemblyAI submit failed: ${res.status} ${detail.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as SubmitResponse;
  if (!json.id) {
    throw new TranscribeError("AssemblyAI submit returned no transcript id");
  }
  return json.id;
}

async function pollTranscript(
  config: ResolvedConfig,
  transcriptId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<PollResponse> {
  const startedAt = Date.now();
  let interval = POLL_INTERVAL_MS;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await sleep(interval);
    const res = await fetchWithTimeout(
      config.fetchImpl,
      `${config.baseUrl}/transcript/${encodeURIComponent(transcriptId)}`,
      { headers: authHeaders(config.apiKey) },
      30_000,
    );
    if (!res.ok) {
      throw new TranscribeError(
        `AssemblyAI poll failed: ${res.status}`,
      );
    }
    const json = (await res.json()) as PollResponse;
    if (json.status === "completed") return json;
    if (json.status === "error") {
      throw new TranscribeError(
        `AssemblyAI returned error: ${json.error ?? "unknown"}`,
      );
    }
    // Linear backoff up to ceiling so we don't hammer the API on long jobs.
    interval = Math.min(interval + 1_000, POLL_BACKOFF_MAX_MS);
  }
  throw new TranscribeError(
    `AssemblyAI poll exceeded ${POLL_TIMEOUT_MS}ms timeout`,
  );
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Transcribe an audio URL using AssemblyAI with speaker diarization.
 *
 * Throws `TranscribeError` when:
 *   - `config.apiKey` is not configured
 *   - Submit / poll HTTP requests fail
 *   - The transcript job ends in `error` status
 *   - Polling exceeds the hard timeout
 *
 * @param sleep Override for testability (default uses setTimeout).
 */
export async function transcribeAudio(
  options: TranscribeOptions,
  config: TranscribeConfig,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<TranscribeResult> {
  if (!config.apiKey) {
    throw new TranscribeError("AssemblyAI API key is not configured");
  }
  if (!options.url || !/^https?:\/\//i.test(options.url)) {
    throw new TranscribeError("audio url must be an absolute http(s) URL");
  }

  const resolved: ResolvedConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    fetchImpl: config.fetchImpl ?? fetch,
  };

  const transcriptId = await submitTranscriptJob(resolved, options);
  const result = await pollTranscript(resolved, transcriptId, sleep);

  return {
    id: result.id,
    text: result.text ?? "",
    language: result.language_code ?? options.language ?? "ja",
    utterances: (result.utterances ?? []).map((u) => ({
      speaker: u.speaker,
      text: u.text,
      start: u.start,
      end: u.end,
    })),
  };
}
