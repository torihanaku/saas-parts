/**
 * @torihanaku/channel-summarizer — マルチチャネル統合サマライザ
 *
 * Slack / Email / 会議録画 transcript などの生コンテンツを 1 リクエストで
 * LLM に渡し、統合された 200 字以内 summary + structured action items を
 * 抽出する。
 *
 * 失敗時 (LLM エラー / JSON parse 失敗 / API key 未解決) は **throw せず** に
 * 空の UnifiedSummary を返す。呼び出し側は sources を確認することで
 * 入力自体は失われていないことを保証できる。
 *
 * 出典: 実運用SaaS server/lib/multi-channel-summarizer.ts (#1031 / #1156)
 *
 * 移植方針:
 * - LLM 呼び出し (claude-api-client の generateJson) は注入式コールバックに置換。
 * - BYOK (tenant secret → env fallback) の解決は注入式 `resolveApiKey` に置換。
 *   省略時はキーゲートをスキップし、キー管理を LLM コールバック側へ委譲する。
 * - ChannelType は union → 汎用文字列に緩和。ラベルと文字数上限は
 *   既定値 (slack/email/transcript) を維持しつつ config で拡張可能。
 */

export type ChannelType = string;

export interface ChannelInput {
  type: ChannelType;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ActionItem {
  text: string;
  owner?: string;
  due?: string;
}

export interface UnifiedSummary {
  summary: string;
  actionItems: ActionItem[];
  sources: ChannelInput[];
}

interface AiPayload {
  summary?: unknown;
  actionItems?: unknown;
}

/**
 * LLM への JSON 生成呼び出し。@torihanaku/claude-api の generateJson 互換。
 * 実装は「失敗時に fallback を返す」ことが望ましい (throw しても本体が握る)。
 */
export type LlmJsonGenerator = <T>(
  apiKey: string,
  system: string,
  userPrompt: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

/** Hard cap per channel input — keep transcripts from blowing the prompt budget. (原典既定値) */
export const DEFAULT_MAX_CONTENT_CHARS: Record<string, number> = {
  slack: 4000,
  email: 4000,
  transcript: 6000,
};

/** 未知チャネルの文字数上限 (原典の `?? 4000`) */
export const DEFAULT_CONTENT_CHAR_CAP = 4000;

export const DEFAULT_CHANNEL_LABELS: Record<string, string> = {
  slack: "Slack",
  email: "Email",
  transcript: "Transcript (会議録画)",
};

export const DEFAULT_SYSTEM_PROMPT = [
  "Slack のスレッド・Email 本文・会議録画 transcript を一つに統合する熟練のオペレーション AI。",
  "出力は必ず以下の JSON のみ: ",
  '{"summary":"200字以内の日本語サマリ","actionItems":[{"text":"具体的なタスク","owner":"担当者名 or 省略","due":"YYYY-MM-DD or 省略"}]}',
  "- summary は重複情報を削り、決定事項と未解決論点を優先して 200 文字以内に圧縮する。",
  "- 会議 transcript には複数発言者の議論が含まれるため、 結論 / 決定 / 宿題 を抽出して短くまとめる。",
  "- actionItems は明示的に発生したタスクのみを抽出し、推測で増やさない。",
  "- 入力に該当情報が無ければ空配列 / 空文字を返す。",
].join("\n");

export interface ChannelSummarizerConfig {
  /** LLM への JSON 生成コールバック (必須) */
  generateJson: LlmJsonGenerator;
  /**
   * BYOK: tenantId → API key の解決。null / 空文字を返すと LLM を呼ばず
   * 空結果を返す (原典挙動)。throw した場合も空結果。
   * 省略時はゲートをスキップし、generateJson に空文字キーを渡す。
   */
  resolveApiKey?: (tenantId: string) => Promise<string | null>;
  /** チャネル種別 → prompt 内ラベル。既定値にマージされる */
  channelLabels?: Record<string, string>;
  /** チャネル種別 → 文字数上限。既定値にマージされる */
  maxContentChars?: Record<string, number>;
  /** system prompt の差し替え。既定は原典の日本語プロンプト */
  systemPrompt?: string;
  /** LLM の max tokens。既定 1200 (原典) */
  maxTokens?: number;
  /** 失敗ログ。省略時は console.error */
  logger?: (message: string, error: unknown) => void;
}

export interface ChannelSummarizer {
  /**
   * マルチチャネル入力を 200 字以内の統合サマリ + action items に要約する。
   * いかなる失敗でも throw せず空の UnifiedSummary を返す。
   */
  summarizeMultiChannel(inputs: ChannelInput[], tenantId: string): Promise<UnifiedSummary>;
}

/** Coerce arbitrary AI output into a strictly typed ActionItem[]. (原典そのまま) */
export function normaliseActionItems(raw: unknown): ActionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ActionItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text) continue;
    const item: ActionItem = { text };
    if (typeof rec.owner === "string" && rec.owner.trim()) item.owner = rec.owner.trim();
    if (typeof rec.due === "string" && rec.due.trim()) item.due = rec.due.trim();
    items.push(item);
  }
  return items;
}

/** Truncate summary to 200 chars (defensive — AI may overshoot). (原典そのまま) */
export function clampSummary(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.trim();
  if (cleaned.length <= 200) return cleaned;
  return `${cleaned.slice(0, 199)}…`;
}

function emptyResult(inputs: ChannelInput[]): UnifiedSummary {
  return { summary: "", actionItems: [], sources: inputs };
}

export function createChannelSummarizer(config: ChannelSummarizerConfig): ChannelSummarizer {
  const labels = { ...DEFAULT_CHANNEL_LABELS, ...config.channelLabels };
  const caps = { ...DEFAULT_MAX_CONTENT_CHARS, ...config.maxContentChars };
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxTokens = config.maxTokens ?? 1200;
  const logger =
    config.logger ?? ((message: string, error: unknown) => console.error(message, error));

  /** Build the user prompt by labelling each channel for clarity. (原典そのまま) */
  function buildPrompt(inputs: ChannelInput[]): string {
    if (inputs.length === 0) return "(入力なし)";
    return inputs
      .map((input, idx) => {
        const label = labels[input.type] ?? input.type;
        const cap = caps[input.type] ?? DEFAULT_CONTENT_CHAR_CAP;
        const raw = input.content?.trim() ?? "";
        const trimmed = raw.length > cap ? `${raw.slice(0, cap)}…(以下省略)` : raw;
        return `### Source ${idx + 1} — ${label}\n${trimmed || "(空)"}`;
      })
      .join("\n\n");
  }

  async function summarizeMultiChannel(
    inputs: ChannelInput[],
    tenantId: string,
  ): Promise<UnifiedSummary> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return emptyResult(inputs ?? []);
    }

    let apiKey = "";
    if (config.resolveApiKey) {
      let resolved: string | null;
      try {
        resolved = await config.resolveApiKey(tenantId);
      } catch (error) {
        logger("[channel-summarizer] api key lookup failed:", error);
        return emptyResult(inputs);
      }
      if (!resolved) return emptyResult(inputs);
      apiKey = resolved;
    }

    const userPrompt = buildPrompt(inputs);
    const fallback: AiPayload = { summary: "", actionItems: [] };

    let payload: AiPayload;
    try {
      payload = await config.generateJson<AiPayload>(apiKey, systemPrompt, userPrompt, fallback, {
        maxTokens,
      });
    } catch (error) {
      // generateJson 実装が fallback を返す想定だが、defence-in-depth。
      logger("[channel-summarizer] generateJson threw:", error);
      return emptyResult(inputs);
    }

    return {
      summary: clampSummary(payload?.summary),
      actionItems: normaliseActionItems(payload?.actionItems),
      sources: inputs,
    };
  }

  return { summarizeMultiChannel };
}
