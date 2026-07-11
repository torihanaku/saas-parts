/** テスト用スタブ (LLM / fetch / 埋め込み)。 */
import type { LlmClient, LlmRequest } from "./ports";

/**
 * 呼び出し内容に応じて決定的な応答を返す LLM スタブ。
 * json/text それぞれ、固定値 or リクエストを受ける関数を指定できる。
 */
export function stubLlm(opts: {
  json?: ((req: LlmRequest) => unknown) | object | null;
  text?: string | ((req: LlmRequest) => string);
}): LlmClient {
  return {
    async generateJson<T>(req: LlmRequest): Promise<T | null> {
      const v =
        typeof opts.json === "function"
          ? (opts.json as (r: LlmRequest) => unknown)(req)
          : opts.json;
      return (v ?? null) as T | null;
    },
    async generateText(req: LlmRequest): Promise<string> {
      return typeof opts.text === "function"
        ? opts.text(req)
        : (opts.text ?? "");
    },
  };
}

/** generateJson を呼び出し順にキュー消化する LLM スタブ (リトライ検証用)。 */
export function queueLlm(jsonResponses: unknown[]): LlmClient & {
  calls: LlmRequest[];
} {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async generateJson<T>(req: LlmRequest): Promise<T | null> {
      calls.push(req);
      return (jsonResponses.shift() ?? null) as T | null;
    },
    async generateText(req: LlmRequest): Promise<string> {
      calls.push(req);
      return "";
    },
  };
}

/** JSON ボディを返す fetch スタブ。URL 部分一致でルーティングする。 */
export function stubFetch(
  routes: Array<{
    match: string | RegExp;
    status?: number;
    body: unknown | ((url: string) => unknown);
  }>,
): typeof fetch {
  const fn = async (input: unknown): Promise<Response> => {
    const url = String(input);
    for (const route of routes) {
      const hit =
        typeof route.match === "string"
          ? url.includes(route.match)
          : route.match.test(url);
      if (hit) {
        const body =
          typeof route.body === "function"
            ? (route.body as (u: string) => unknown)(url)
            : route.body;
        const status = route.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;
  };
  return fn as unknown as typeof fetch;
}

/** 40 文字以上の日本語ダミー文 (HypothesisDraftSchema の下限を満たす)。 */
export function longText(seed: string): string {
  return `${seed}についての検証内容である。`.repeat(4).slice(0, 120);
}
