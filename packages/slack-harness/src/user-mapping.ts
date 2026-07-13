/**
 * Slack ユーザーID → アプリユーザーID 解決。
 *
 * 戦略:
 *   1) Slack `users.info` で email を取得 (bot token graceful)
 *   2) 注入された lookupUserByEmail で email + tenantId から自アプリのユーザーIDを引く
 *
 * トークン / lookup / Slack API のどれかが欠けていても例外は投げず null を返す。
 * 結果は per-tenant in-process Map に 1h キャッシュする（TTL 変更可）。
 *
 * 変更点（移植元: 実運用SaaS server/lib/slack-user-mapping.ts）:
 * - module スコープの env / キャッシュ → `createSlackUserResolver` ファクトリに閉じ込め
 * - Supabase REST 直接 lookup → `lookupUserByEmail` 注入（元実装相当の
 *   `createRestEmailLookup` を組み込みで提供）
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  userId: string | null;
  expires: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

export interface SlackUserResolverOptions {
  /** Slack bot token（省略時は解決せず null を返しキャッシュする — graceful） */
  botToken?: string;
  /** email + tenantId → アプリユーザーID の解決関数（見つからなければ null） */
  lookupUserByEmail: (email: string, tenantId: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  /** キャッシュ TTL（default: 1時間） */
  cacheTtlMs?: number;
  /** 警告ログ出力先（default: console.warn） */
  logWarn?: (...args: unknown[]) => void;
}

export interface SlackUserResolver {
  resolve(slackUserId: string, tenantId: string): Promise<string | null>;
  /** Test-only helper to clear the cache between cases. */
  clearCache(): void;
}

export function createSlackUserResolver(options: SlackUserResolverOptions): SlackUserResolver {
  const cache = new Map<string, CacheEntry>();
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const logWarn = options.logWarn ?? ((...args: unknown[]) => console.warn(...args));

  function cacheKey(tenantId: string, slackUserId: string): string {
    return `${tenantId}:${slackUserId}`;
  }

  async function fetchSlackEmail(slackUserId: string, token: string): Promise<string | null> {
    try {
      const res = await doFetch(
        `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { ok?: boolean; user?: { profile?: { email?: string } } };
      if (!json?.ok) return null;
      const email = json.user?.profile?.email;
      return email && email.length > 0 ? email : null;
    } catch (err) {
      logWarn(`[SlackMapping] users.info failed for ${slackUserId}:`, err);
      return null;
    }
  }

  async function resolve(slackUserId: string, tenantId: string): Promise<string | null> {
    if (!slackUserId || !tenantId) return null;

    const key = cacheKey(tenantId, slackUserId);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.userId;
    }

    const token = options.botToken;
    if (!token) {
      cache.set(key, { userId: null, expires: Date.now() + ttl });
      return null;
    }

    const email = await fetchSlackEmail(slackUserId, token);
    if (!email) {
      cache.set(key, { userId: null, expires: Date.now() + ttl });
      return null;
    }

    let userId: string | null = null;
    try {
      userId = await options.lookupUserByEmail(email, tenantId);
    } catch (err) {
      logWarn(`[SlackMapping] user lookup failed for ${email}:`, err);
      userId = null;
    }
    cache.set(key, { userId, expires: Date.now() + ttl });
    return userId;
  }

  return { resolve, clearCache: () => cache.clear() };
}

// ─── Built-in lookup (source implementation) ────────────────────────────────

export interface RestEmailLookupOptions {
  /** PostgREST 互換の base URL（例: `https://xxxx.supabase.co`） */
  baseUrl: string;
  /** service role key（apikey + Bearer の両ヘッダに使用） */
  serviceKey: string;
  /** 参照テーブル名（default: "team_members"） */
  table?: string;
  fetchImpl?: FetchLike;
  logWarn?: (...args: unknown[]) => void;
}

/**
 * 移植元実装（Supabase REST で email + tenant_id から id を引く）の組み込み lookup。
 * `createSlackUserResolver({ lookupUserByEmail: createRestEmailLookup({...}) })` で使う。
 */
export function createRestEmailLookup(
  options: RestEmailLookupOptions,
): (email: string, tenantId: string) => Promise<string | null> {
  const table = options.table ?? "team_members";
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const logWarn = options.logWarn ?? ((...args: unknown[]) => console.warn(...args));

  return async (email: string, tenantId: string): Promise<string | null> => {
    if (!options.baseUrl || !options.serviceKey) return null;

    try {
      const url =
        `${options.baseUrl}/rest/v1/${table}` +
        `?email=eq.${encodeURIComponent(email)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
        `&select=id&limit=1`;
      const res = await doFetch(url, {
        headers: { apikey: options.serviceKey, Authorization: `Bearer ${options.serviceKey}` },
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as { id: string }[];
      return rows.length > 0 && rows[0] ? rows[0].id : null;
    } catch (err) {
      logWarn(`[SlackMapping] DB lookup failed for ${email}:`, err);
      return null;
    }
  };
}
