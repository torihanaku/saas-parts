/**
 * @torihanaku/api-keys — 公開APIキーのライフサイクル管理。
 * Keys are stored as SHA-256 hashes; the raw key is only returned once at creation.
 *
 * 出典: 実運用SaaS/server/lib/api-key-auth.ts（忠実移植）。
 * 変更点: Supabase REST 直叩き → 注入 `ApiKeyStore` インターフェース
 * （インメモリ実装同梱）、キープレフィックス `fla_` → 設定可能、
 * scopes は JSON 文字列化せず string[] のまま store に渡す（シリアライズは
 * store 実装の責務）。
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  rate_limit_tier: string;
  enabled: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** createApiKey が store.insert に渡す行。id/created_at 等の採番は store の責務。 */
export interface ApiKeyInsert {
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  rate_limit_tier: string;
  expires_at: string | null;
}

/**
 * 永続化の注入ポイント。元実装は Supabase REST（dd_api_keys テーブル）だった。
 */
export interface ApiKeyStore {
  /** 挿入して確定レコードを返す。失敗時は null。 */
  insert: (row: ApiKeyInsert) => Promise<ApiKeyRecord | null>;
  /** enabled=true かつ key_hash 一致のレコードを1件返す。無ければ null。 */
  findEnabledByHash: (keyHash: string) => Promise<ApiKeyRecord | null>;
  /** ユーザーのキー一覧（作成日時降順）。失敗時は null。 */
  listByUser: (userId: string) => Promise<ApiKeyRecord[] | null>;
  /** last_used_at を更新する（fire-and-forget で呼ばれる）。 */
  touchLastUsed: (id: string, lastUsedAt: string) => Promise<void>;
  /** enabled=false にする。対象が無い/失敗なら false。 */
  revoke: (keyId: string, userId: string) => Promise<boolean>;
}

export interface ApiKeyLogger {
  error: (message: string) => void;
}

export interface ApiKeyManagerOptions {
  store: ApiKeyStore;
  /** 生キーのプレフィックス。デフォルトは元実装どおり "fla_"。 */
  prefix?: string;
  /** createApiKey のデフォルトスコープ。デフォルト ["read"]。 */
  defaultScopes?: string[];
  /** デフォルトのレート制限ティア。デフォルト "standard"。 */
  rateLimitTier?: string;
  /** エラーログ出力先（省略時 console）。 */
  logger?: ApiKeyLogger;
  /** 現在時刻（テスト注入用）。 */
  now?: () => Date;
}

export interface ApiKeyManager {
  /** 生キーは作成時に一度だけ返る。以後はハッシュのみ保存。 */
  createApiKey: (
    userId: string,
    name: string,
    scopes?: string[],
    expiresAt?: string,
  ) => Promise<{ key: string; record: ApiKeyRecord } | null>;
  /** `x-api-key` または `Authorization: Bearer` から認証。無効なら null。 */
  authenticateApiKey: (req: Request) => Promise<ApiKeyRecord | null>;
  fetchApiKeysByUser: (userId: string) => Promise<ApiKeyRecord[] | null>;
  revokeApiKey: (keyId: string, userId: string) => Promise<boolean>;
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateApiKey(prefix = "fla_"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${raw}`;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export function createApiKeyManager(options: ApiKeyManagerOptions): ApiKeyManager {
  const {
    store,
    prefix = "fla_",
    defaultScopes = ["read"],
    rateLimitTier = "standard",
    logger = console,
    now = () => new Date(),
  } = options;

  async function createApiKey(
    userId: string,
    name: string,
    scopes: string[] = defaultScopes,
    expiresAt?: string,
  ): Promise<{ key: string; record: ApiKeyRecord } | null> {
    const rawKey = generateApiKey(prefix);
    const keyHash = await hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, prefix.length + 8);

    const row: ApiKeyInsert = {
      user_id: userId,
      name,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      scopes,
      rate_limit_tier: rateLimitTier,
      expires_at: expiresAt || null,
    };

    const record = await store.insert(row);
    if (!record) return null;

    return { key: rawKey, record };
  }

  async function authenticateApiKey(req: Request): Promise<ApiKeyRecord | null> {
    const header = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!header || !header.startsWith(prefix)) return null;

    const keyHash = await hashKey(header);

    try {
      const record = await store.findEnabledByHash(keyHash);
      if (!record) return null;

      if (record.expires_at && new Date(record.expires_at) < now()) {
        return null;
      }

      store.touchLastUsed(record.id, now().toISOString()).catch((err: unknown) => {
        logger.error(JSON.stringify({
          severity: "WARN",
          message: "api_key_last_used_update_failed",
          id: record.id,
          error: err instanceof Error ? err.message : String(err),
        }));
      });

      return record;
    } catch {
      return null;
    }
  }

  async function fetchApiKeysByUser(userId: string): Promise<ApiKeyRecord[] | null> {
    try {
      return await store.listByUser(userId);
    } catch {
      return null;
    }
  }

  async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
    try {
      return await store.revoke(keyId, userId);
    } catch {
      return false;
    }
  }

  return { createApiKey, authenticateApiKey, fetchApiKeysByUser, revokeApiKey };
}

// ─── In-memory store ────────────────────────────────────────────────────────

interface StoredRow extends ApiKeyRecord {
  key_hash: string;
}

export interface InMemoryApiKeyStore extends ApiKeyStore {
  /** 診断・テスト用スナップショット（key_hash を含む内部行）。 */
  dump: () => StoredRow[];
  clear: () => void;
}

export function createInMemoryApiKeyStore(options: { now?: () => Date } = {}): InMemoryApiKeyStore {
  const now = options.now ?? (() => new Date());
  const rows: StoredRow[] = [];
  let seq = 0;

  function toRecord(row: StoredRow): ApiKeyRecord {
    const { key_hash: _omit, ...record } = row;
    return { ...record, scopes: [...row.scopes] };
  }

  return {
    async insert(row) {
      const stored: StoredRow = {
        id: `key-${++seq}`,
        user_id: row.user_id,
        name: row.name,
        key_prefix: row.key_prefix,
        key_hash: row.key_hash,
        scopes: [...row.scopes],
        rate_limit_tier: row.rate_limit_tier,
        enabled: true,
        expires_at: row.expires_at,
        last_used_at: null,
        created_at: now().toISOString(),
      };
      rows.push(stored);
      return toRecord(stored);
    },
    async findEnabledByHash(keyHash) {
      const row = rows.find((r) => r.key_hash === keyHash && r.enabled);
      return row ? toRecord(row) : null;
    },
    async listByUser(userId) {
      return rows
        .filter((r) => r.user_id === userId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map(toRecord);
    },
    async touchLastUsed(id, lastUsedAt) {
      const row = rows.find((r) => r.id === id);
      if (row) row.last_used_at = lastUsedAt;
    },
    async revoke(keyId, userId) {
      const row = rows.find((r) => r.id === keyId && r.user_id === userId);
      if (!row) return false;
      row.enabled = false;
      return true;
    },
    dump: () => rows.map((r) => ({ ...r, scopes: [...r.scopes] })),
    clear: () => {
      rows.length = 0;
    },
  };
}
