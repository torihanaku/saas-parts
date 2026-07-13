/**
 * Reddit OAuth client_credentials + search.json wrapper.
 *
 * `CrisisSource` 注入 IF の一例。原典 実運用SaaS
 * `server/lib/brand-crisis/reddit-client.ts` を移植し、`env` 直参照と
 * グローバル fetch 依存を排除して factory 化した。
 *
 * graceful degradation:
 *   - clientId / clientSecret 未設定 → `[]` を返し warn ログのみ
 *   - OAuth トークン取得失敗 → `[]` を返し warn ログのみ
 *   - search API レート制限 / network 失敗 → `[]` を返し warn ログのみ
 *
 * トークンは factory インスタンス内で memoize し、 expires_in の 90% 経過で再取得する。
 */
import type { CrisisMention, CrisisSearchOptions, CrisisSource, Logger } from "./types";

/** DOM の fetch 互換シグネチャ（注入用。省略時は globalThis.fetch）。 */
export type FetchFn = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface RedditSourceConfig {
  clientId: string;
  clientSecret: string;
  userAgent?: string;
  /** fetch 実装（省略時は globalThis.fetch）。 */
  fetchFn?: FetchFn;
  logger?: Logger;
}

interface AccessToken {
  token: string;
  expiresAt: number;
}

interface RedditChild {
  kind: string;
  data: {
    id: string;
    title?: string;
    selftext?: string;
    body?: string;
    permalink?: string;
    subreddit?: string;
    author?: string;
    created_utc?: number;
  };
}

function toBase64(input: string): string {
  // Node/edge 両対応。Buffer があれば使う。
  const g = globalThis as unknown as { Buffer?: { from(s: string): { toString(enc: string): string } }; btoa?: (s: string) => string };
  if (g.Buffer) return g.Buffer.from(input).toString("base64");
  if (g.btoa) return g.btoa(input);
  throw new Error("No base64 encoder available");
}

/**
 * Reddit を監視ソースとして構築する。返り値は `CrisisSource`。
 * トークンキャッシュはこのインスタンスに閉じる（`__clearTokenCache` でリセット可）。
 */
export function createRedditSource(config: RedditSourceConfig): CrisisSource & { __clearTokenCache(): void } {
  const fetchFn: FetchFn = config.fetchFn ?? ((input, init) => (globalThis.fetch as unknown as FetchFn)(input, init));
  const userAgent = config.userAgent ?? "torihanaku-brand-crisis/1.0";
  const log: Logger = config.logger ?? (() => {});

  let cachedToken: AccessToken | null = null;

  async function fetchAccessToken(): Promise<AccessToken | null> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken;

    try {
      const basic = toBase64(`${config.clientId}:${config.clientSecret}`);
      const res = await fetchFn("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
        },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) {
        log("warn", `[Reddit] token request failed: ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) return null;
      const expiresMs = (json.expires_in ?? 3600) * 1000 * 0.9;
      cachedToken = { token: json.access_token, expiresAt: Date.now() + expiresMs };
      return cachedToken;
    } catch (err) {
      log("warn", "[Reddit] token request threw:", err);
      return null;
    }
  }

  async function search(keyword: string, options: CrisisSearchOptions = {}): Promise<CrisisMention[]> {
    if (!config.clientId || !config.clientSecret) return [];
    if (!keyword || keyword.trim().length === 0) return [];

    const access = await fetchAccessToken();
    if (!access) return [];

    const params = new URLSearchParams({
      q: keyword,
      limit: String(options.limit ?? 25),
      sort: options.sort ?? "new",
      t: options.time ?? "day",
      type: "link,sr",
      restrict_sr: "false",
    });

    try {
      const res = await fetchFn(`https://oauth.reddit.com/search.json?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${access.token}`,
          "User-Agent": userAgent,
        },
      });
      if (!res.ok) {
        log("warn", `[Reddit] search failed: ${res.status} for "${keyword}"`);
        return [];
      }
      const json = (await res.json()) as { data?: { children?: RedditChild[] } };
      const children = json.data?.children ?? [];
      return children
        .filter((c) => c.kind === "t3")
        .map<CrisisMention>((c) => ({
          external_id: `reddit:${c.data.id}`,
          content: [c.data.title ?? "", c.data.selftext ?? c.data.body ?? ""].filter(Boolean).join("\n\n"),
          permalink: c.data.permalink ? `https://www.reddit.com${c.data.permalink}` : "",
          metadata: {
            subreddit: c.data.subreddit ?? "",
            author: c.data.author ?? "",
            created_utc: c.data.created_utc ?? 0,
          },
        }))
        .filter((m) => m.content.length > 0);
    } catch (err) {
      log("warn", `[Reddit] search threw for "${keyword}":`, err);
      return [];
    }
  }

  return {
    name: "reddit",
    search,
    __clearTokenCache() {
      cachedToken = null;
    },
  };
}
