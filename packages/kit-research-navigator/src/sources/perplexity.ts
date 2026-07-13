/**
 * Perplexity (chat/completions 互換 API) にニュース集約を依頼し、
 * JSON 配列で返させてシグナル化するソース実装例。
 * 元実装は Nango プロキシ経由だったが、API キー注入の直接呼び出しに一般化。
 * 出典: 実運用SaaS server/lib/navigator/ingestion/perplexity.ts
 */
import type { NewSignal } from "../types";
import type { SignalSource } from "../ports";

export interface PerplexityNewsSourceOptions {
  /** API キー (値は呼び出し側の設定機構から渡す。ハードコード禁止)。 */
  apiKey: string;
  fetchFn?: typeof fetch;
  /** 既定: https://api.perplexity.ai */
  baseUrl?: string;
  /** 既定 "sonar"。 */
  model?: string;
  /** ユーザープロンプト (何のニュースを集めるか)。 */
  userPrompt?: string;
  /** シグナルの source ラベル。既定 "news_digest"。 */
  sourceLabel?: string;
  now?: () => Date;
}

const SYSTEM_PROMPT =
  "You are a tech news aggregator. Return a JSON array of the top 5 most important tech announcements today. Format: [{ title, url, body }]";

/** ```json フェンス付きでも生 JSON でもパースする。 */
export function extractJsonArray(text: string): unknown {
  let jsonString = text;
  if (jsonString.includes("```json")) {
    jsonString = jsonString.split("```json")[1]?.split("```")[0] ?? "[]";
  } else if (jsonString.includes("```")) {
    jsonString = jsonString.split("```")[1]?.split("```")[0] ?? "[]";
  }
  return JSON.parse(jsonString);
}

export function createPerplexityNewsSource(
  opts: PerplexityNewsSourceOptions,
): SignalSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.perplexity.ai").replace(/\/$/, "");
  const model = opts.model ?? "sonar";
  const userPrompt =
    opts.userPrompt ??
    "What are the latest VC announcements and product launches today?";
  const sourceLabel = opts.sourceLabel ?? "news_digest";
  const now = opts.now ?? (() => new Date());

  return {
    name: sourceLabel,
    async fetch(): Promise<NewSignal[]> {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content || "[]";

      let parsed: unknown;
      try {
        parsed = extractJsonArray(text);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];

      return (parsed as { title?: string; url?: string; body?: string }[])
        .filter((item) => typeof item.title === "string" && typeof item.url === "string")
        .map((item) => ({
          source: sourceLabel,
          url: item.url as string,
          title: item.title as string,
          body: item.body || null,
          fetchedAt: now().toISOString(),
        }));
    },
  };
}
