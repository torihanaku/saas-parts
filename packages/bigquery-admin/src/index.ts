/**
 * BigQuery client wrapper for multi-tenant credential management.
 *
 * SaaS mode: Service account keys stored per-tenant (encrypted) via injected store.
 * Self-hosted mode: Falls back to caller-supplied fallback credentials.
 *
 * Security: Decrypted credentials are NEVER returned from any exported function.
 * Routes must redact `service_account_key_encrypted` before sending to clients.
 *
 * 変更点（移植元: 実運用SaaS server/lib/bigquery-client.ts）:
 * - `@google-cloud/bigquery` 直接依存 → 構造的インターフェース `BigQueryLike` +
 *   `clientFactory` 注入（SDK 依存ゼロ）
 * - Supabase REST ヘルパー → `BigQuerySettingsStore` 注入
 * - token.ts の encrypt/decrypt → AES-256-GCM を crypto.ts にインライン移植し
 *   `encryptionSecret` から鍵派生
 * - env フォールバック → `fallback` オプション（呼び出し側が env から渡す）
 */
import { encrypt, decrypt } from "./crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BigQuerySettings {
  id?: string;
  tenant_id: string;
  service_account_key_encrypted: string;
  project_id: string;
  billing_dataset: string;
  billing_table: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ResolvedBigQueryConfig {
  credentials: Record<string, unknown>;
  projectId: string;
  billingDataset: string;
  billingTable: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  totalRows: number;
}

/** `client.query()` に渡すオプション（@google-cloud/bigquery 互換のサブセット） */
export interface BigQueryQueryOptions {
  query: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * BigQuery SDK の構造的インターフェース。
 * `new BigQuery({ credentials, projectId })` のインスタンスがそのまま適合する。
 */
export interface BigQueryLike {
  query(options: BigQueryQueryOptions): Promise<readonly [unknown[], ...unknown[]]>;
}

/** クライアント生成の注入点。例: `(o) => new BigQuery(o)` */
export type BigQueryClientFactory = (options: {
  credentials: Record<string, unknown>;
  projectId: string;
}) => BigQueryLike;

/** テナント別設定の永続化ストア（Supabase/PG/Firestore 等を呼び出し側で実装） */
export interface BigQuerySettingsStore {
  /** テナントの設定行を返す。無ければ null。 */
  get(tenantId: string): Promise<BigQuerySettings | null>;
  /** 新規行を挿入する。 */
  insert(row: Omit<BigQuerySettings, "id" | "created_at">): Promise<{ ok: boolean }>;
  /** 既存行を部分更新する。 */
  patch(tenantId: string, patch: Partial<BigQuerySettings>): Promise<{ ok: boolean }>;
  /** テナントの設定行を削除する。 */
  delete(tenantId: string): Promise<{ ok: boolean }>;
}

export interface BigQueryAdminOptions {
  store: BigQuerySettingsStore;
  clientFactory: BigQueryClientFactory;
  /** サービスアカウントキー暗号化の秘密鍵（例: SESSION_SECRET）。鍵は HMAC-SHA256 で派生。 */
  encryptionSecret: string;
  /** セルフホスト向けフォールバック（元実装の GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_CLOUD_PROJECT 相当） */
  fallback?: {
    serviceAccountKey?: string;
    projectId?: string;
  };
  defaults?: {
    billingDataset?: string;
    billingTable?: string;
  };
  /** エラーログ出力先（default: console.error） */
  logError?: (message: string) => void;
}

export interface BigQueryAdmin {
  getSettings(tenantId: string): Promise<BigQuerySettings | null>;
  saveSettings(
    tenantId: string,
    settings: {
      service_account_key: string;
      project_id: string;
      billing_dataset?: string;
      billing_table?: string;
    },
  ): Promise<boolean>;
  deleteSettings(tenantId: string): Promise<boolean>;
  resolveConfig(tenantId?: string): Promise<ResolvedBigQueryConfig | null>;
  createClient(config: ResolvedBigQueryConfig): BigQueryLike;
  testConnection(config: ResolvedBigQueryConfig): Promise<{ ok: boolean; error?: string }>;
  runQuery(
    config: ResolvedBigQueryConfig,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult>;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_BILLING_DATASET = "billing_export";
const DEFAULT_BILLING_TABLE = "gcp_billing_export_v1_FULL";

// ─── Factory ────────────────────────────────────────────────────────────────

export function createBigQueryAdmin(options: BigQueryAdminOptions): BigQueryAdmin {
  const { store, clientFactory, encryptionSecret } = options;
  const defaultDataset = options.defaults?.billingDataset ?? DEFAULT_BILLING_DATASET;
  const defaultTable = options.defaults?.billingTable ?? DEFAULT_BILLING_TABLE;
  const logError = options.logError ?? ((message: string) => console.error(message));

  /**
   * Fetch BigQuery settings for a tenant.
   * Returns raw row including encrypted key — callers must redact before exposing.
   */
  async function getSettings(tenantId: string): Promise<BigQuerySettings | null> {
    try {
      return await store.get(tenantId);
    } catch (e) {
      logError(`[BigQuery] getSettings error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Save (upsert) BigQuery settings for a tenant.
   * Encrypts the service account key before storing.
   */
  async function saveSettings(
    tenantId: string,
    settings: {
      service_account_key: string;
      project_id: string;
      billing_dataset?: string;
      billing_table?: string;
    },
  ): Promise<boolean> {
    try {
      const encryptedKey = encrypt(encryptionSecret, settings.service_account_key);
      const now = new Date().toISOString();
      const existing = await getSettings(tenantId);

      if (existing) {
        const result = await store.patch(tenantId, {
          service_account_key_encrypted: encryptedKey,
          project_id: settings.project_id,
          billing_dataset: settings.billing_dataset || defaultDataset,
          billing_table: settings.billing_table || defaultTable,
          enabled: true,
          updated_at: now,
        });
        return result.ok;
      }

      const result = await store.insert({
        tenant_id: tenantId,
        service_account_key_encrypted: encryptedKey,
        project_id: settings.project_id,
        billing_dataset: settings.billing_dataset || defaultDataset,
        billing_table: settings.billing_table || defaultTable,
        enabled: true,
        updated_at: now,
      });
      return result.ok;
    } catch (e) {
      logError(`[BigQuery] saveSettings error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Delete BigQuery settings for a tenant. */
  async function deleteSettings(tenantId: string): Promise<boolean> {
    try {
      const result = await store.delete(tenantId);
      return result.ok;
    } catch (e) {
      logError(`[BigQuery] deleteSettings error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Resolve BigQuery configuration for a tenant or fall back to caller-supplied
   * fallback credentials.
   *
   * Priority:
   * 1. Tenant-specific settings from store (decrypted)
   * 2. fallback.serviceAccountKey (+ fallback.projectId)
   * 3. null (not configured)
   */
  async function resolveConfig(tenantId?: string): Promise<ResolvedBigQueryConfig | null> {
    // Tenant-specific config from store
    if (tenantId) {
      try {
        const settings = await getSettings(tenantId);
        if (settings?.enabled && settings.service_account_key_encrypted) {
          const decrypted = decrypt(encryptionSecret, settings.service_account_key_encrypted);
          if (decrypted) {
            const credentials = JSON.parse(decrypted) as Record<string, unknown>;
            return {
              credentials,
              projectId: settings.project_id,
              billingDataset: settings.billing_dataset || defaultDataset,
              billingTable: settings.billing_table || defaultTable,
            };
          }
        }
      } catch (e) {
        logError(`[BigQuery] resolveConfig tenant error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Fallback: caller-supplied credentials (self-hosted mode)
    const fallbackKey = options.fallback?.serviceAccountKey;
    if (fallbackKey) {
      try {
        const credentials = JSON.parse(fallbackKey) as Record<string, unknown>;
        return {
          credentials,
          projectId: options.fallback?.projectId || (credentials.project_id as string) || "",
          billingDataset: defaultDataset,
          billingTable: defaultTable,
        };
      } catch (e) {
        logError(`[BigQuery] resolveConfig fallback parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return null;
  }

  /** Create a BigQuery client from resolved config. */
  function createClient(config: ResolvedBigQueryConfig): BigQueryLike {
    return clientFactory({
      credentials: config.credentials,
      projectId: config.projectId,
    });
  }

  /**
   * Test BigQuery connection by running a trivial query.
   * Returns { ok: true } on success or { ok: false, error: message } on failure.
   */
  async function testConnection(
    config: ResolvedBigQueryConfig,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = createClient(config);
      await client.query({ query: "SELECT 1", timeoutMs: 10000 });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`[BigQuery] testConnection failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Execute a SQL query against BigQuery.
   * Returns rows and totalRows count.
   */
  async function runQuery(
    config: ResolvedBigQueryConfig,
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult> {
    try {
      const client = createClient(config);
      const [rows] = await client.query({
        query: sql,
        params,
        timeoutMs: 30000,
      });
      return {
        rows: rows as Record<string, unknown>[],
        totalRows: rows.length,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`[BigQuery] runQuery failed: ${message}`);
      throw new Error(`BigQuery query failed: ${message}`, { cause: e });
    }
  }

  return {
    getSettings,
    saveSettings,
    deleteSettings,
    resolveConfig,
    createClient,
    testConnection,
    runQuery,
  };
}
