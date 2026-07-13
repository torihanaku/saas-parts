/**
 * Tests — ported from 実運用SaaS tests/bigquery-client.test.ts.
 * Supabase モック → インメモリ store、BigQuery SDK モック → clientFactory 注入。
 * 暗号化はモックではなく実 AES-256-GCM のラウンドトリップで検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBigQueryAdmin,
  type BigQueryAdmin,
  type BigQuerySettings,
  type BigQuerySettingsStore,
  type BigQueryLike,
  type ResolvedBigQueryConfig,
} from "./index";
import { encrypt, decrypt } from "./crypto";

const SECRET = "test-session-secret-at-least-32-characters-long";

function buildStore(initial: BigQuerySettings[] = []) {
  const rows = new Map<string, BigQuerySettings>(initial.map(r => [r.tenant_id, r]));
  const store: BigQuerySettingsStore = {
    get: vi.fn(async (tenantId: string) => rows.get(tenantId) ?? null),
    insert: vi.fn(async (row) => {
      rows.set(row.tenant_id, { ...row });
      return { ok: true };
    }),
    patch: vi.fn(async (tenantId, patch) => {
      const existing = rows.get(tenantId);
      if (existing) rows.set(tenantId, { ...existing, ...patch });
      return { ok: true };
    }),
    delete: vi.fn(async (tenantId) => {
      rows.delete(tenantId);
      return { ok: true };
    }),
  };
  return { store, rows };
}

const queryMock = vi.fn();

function buildAdmin(
  store: BigQuerySettingsStore,
  extra: Partial<Parameters<typeof createBigQueryAdmin>[0]> = {},
): BigQueryAdmin {
  return createBigQueryAdmin({
    store,
    clientFactory: () => ({ query: queryMock }) as BigQueryLike,
    encryptionSecret: SECRET,
    logError: () => {},
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue([[{ f0_: 1 }]]);
});

describe("crypto roundtrip (inlined AES-256-GCM)", () => {
  it("encrypts to iv:authTag:ciphertext and decrypts back", () => {
    const cipher = encrypt(SECRET, '{"type":"service_account"}');
    expect(cipher.split(":")).toHaveLength(3);
    expect(cipher).not.toContain("service_account");
    expect(decrypt(SECRET, cipher)).toBe('{"type":"service_account"}');
  });

  it("returns null for tampered or malformed ciphertext", () => {
    const cipher = encrypt(SECRET, "hello");
    expect(decrypt(SECRET, cipher.slice(0, -2) + "00")).toBeNull();
    expect(decrypt(SECRET, "not-a-cipher")).toBeNull();
    expect(decrypt("wrong-secret-of-sufficient-length!!", cipher)).toBeNull();
  });
});

describe("getSettings", () => {
  it("returns settings when found", async () => {
    const { store } = buildStore([{
      tenant_id: "t1", project_id: "proj", enabled: true,
      service_account_key_encrypted: "enc", billing_dataset: "ds", billing_table: "tbl",
    }]);
    const result = await buildAdmin(store).getSettings("t1");
    expect(result).toMatchObject({ tenant_id: "t1", project_id: "proj" });
  });

  it("returns null when not found", async () => {
    const { store } = buildStore();
    expect(await buildAdmin(store).getSettings("t1")).toBeNull();
  });

  it("returns null on store error", async () => {
    const { store } = buildStore();
    vi.mocked(store.get).mockRejectedValueOnce(new Error("DB error"));
    expect(await buildAdmin(store).getSettings("t1")).toBeNull();
  });
});

describe("saveSettings", () => {
  it("inserts new settings with encrypted key", async () => {
    const { store, rows } = buildStore();
    const result = await buildAdmin(store).saveSettings("t1", {
      service_account_key: '{"type":"service_account"}',
      project_id: "my-project",
    });
    expect(result).toBe(true);
    expect(store.insert).toHaveBeenCalledOnce();
    const saved = rows.get("t1")!;
    // stored value is encrypted, decryptable with the same secret
    expect(saved.service_account_key_encrypted).not.toContain("service_account");
    expect(decrypt(SECRET, saved.service_account_key_encrypted)).toBe('{"type":"service_account"}');
    // defaults applied
    expect(saved.billing_dataset).toBe("billing_export");
    expect(saved.billing_table).toBe("gcp_billing_export_v1_FULL");
    expect(saved.enabled).toBe(true);
  });

  it("updates existing settings via patch", async () => {
    const { store } = buildStore([{
      tenant_id: "t1", enabled: true, project_id: "old",
      service_account_key_encrypted: "x", billing_dataset: "ds", billing_table: "tbl",
    }]);
    const result = await buildAdmin(store).saveSettings("t1", {
      service_account_key: '{"type":"service_account"}',
      project_id: "my-project",
    });
    expect(result).toBe(true);
    expect(store.patch).toHaveBeenCalledOnce();
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("returns false on insert error", async () => {
    const { store } = buildStore();
    vi.mocked(store.insert).mockResolvedValueOnce({ ok: false });
    expect(await buildAdmin(store).saveSettings("t1", { service_account_key: "{}", project_id: "p" })).toBe(false);
  });
});

describe("resolveConfig", () => {
  it("resolves from tenant store settings (decrypting the stored key)", async () => {
    const { store } = buildStore([{
      tenant_id: "t1",
      service_account_key_encrypted: encrypt(SECRET, '{"type":"service_account","project_id":"db-proj"}'),
      project_id: "db-proj",
      billing_dataset: "my_dataset",
      billing_table: "my_table",
      enabled: true,
    }]);
    const config = await buildAdmin(store).resolveConfig("t1");
    expect(config).not.toBeNull();
    expect(config!.projectId).toBe("db-proj");
    expect(config!.billingDataset).toBe("my_dataset");
    expect(config!.billingTable).toBe("my_table");
    expect(config!.credentials).toMatchObject({ type: "service_account" });
  });

  it("falls back to injected fallback credentials when tenant has no settings", async () => {
    const { store } = buildStore();
    const admin = buildAdmin(store, {
      fallback: {
        serviceAccountKey: '{"type":"service_account","project_id":"env-proj"}',
        projectId: "env-proj",
      },
    });
    const config = await admin.resolveConfig("t1");
    expect(config).not.toBeNull();
    expect(config!.projectId).toBe("env-proj");
  });

  it("uses credentials.project_id when fallback projectId is omitted", async () => {
    const { store } = buildStore();
    const admin = buildAdmin(store, {
      fallback: { serviceAccountKey: '{"type":"service_account","project_id":"cred-proj"}' },
    });
    const config = await admin.resolveConfig();
    expect(config!.projectId).toBe("cred-proj");
  });

  it("returns null when nothing configured", async () => {
    const { store } = buildStore();
    expect(await buildAdmin(store).resolveConfig("t1")).toBeNull();
  });

  it("returns null when tenant settings are disabled", async () => {
    const { store } = buildStore([{
      tenant_id: "t1",
      service_account_key_encrypted: encrypt(SECRET, "{}"),
      project_id: "proj",
      billing_dataset: "ds",
      billing_table: "tbl",
      enabled: false,
    }]);
    expect(await buildAdmin(store).resolveConfig("t1")).toBeNull();
  });
});

const RESOLVED: ResolvedBigQueryConfig = {
  credentials: { type: "service_account" },
  projectId: "proj",
  billingDataset: "ds",
  billingTable: "tbl",
};

describe("testConnection", () => {
  it("returns ok on successful query", async () => {
    const { store } = buildStore();
    const result = await buildAdmin(store).testConnection(RESOLVED);
    expect(result.ok).toBe(true);
    expect(queryMock).toHaveBeenCalledWith({ query: "SELECT 1", timeoutMs: 10000 });
  });

  it("returns error on failed query", async () => {
    queryMock.mockRejectedValueOnce(new Error("Auth failed"));
    const { store } = buildStore();
    const result = await buildAdmin(store).testConnection(RESOLVED);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Auth failed");
  });
});

describe("runQuery", () => {
  it("executes query and returns rows", async () => {
    const { store } = buildStore();
    const result = await buildAdmin(store).runQuery(RESOLVED, "SELECT 1");
    expect(result.rows).toHaveLength(1);
    expect(result.totalRows).toBe(1);
  });

  it("throws wrapped error on query failure", async () => {
    queryMock.mockRejectedValueOnce(new Error("boom"));
    const { store } = buildStore();
    await expect(buildAdmin(store).runQuery(RESOLVED, "SELECT 1")).rejects.toThrow("BigQuery query failed: boom");
  });
});

describe("createClient", () => {
  it("creates client via injected factory with credentials and projectId", () => {
    const { store } = buildStore();
    const factory = vi.fn(() => ({ query: queryMock }) as BigQueryLike);
    const admin = buildAdmin(store, { clientFactory: factory });
    const client = admin.createClient({ ...RESOLVED, projectId: "my-proj" });
    expect(client).toBeDefined();
    expect(factory).toHaveBeenCalledWith({ credentials: { type: "service_account" }, projectId: "my-proj" });
  });
});

describe("deleteSettings", () => {
  it("delegates to store.delete", async () => {
    const { store, rows } = buildStore([{
      tenant_id: "t1", enabled: true, project_id: "p",
      service_account_key_encrypted: "x", billing_dataset: "ds", billing_table: "tbl",
    }]);
    const result = await buildAdmin(store).deleteSettings("t1");
    expect(result).toBe(true);
    expect(rows.has("t1")).toBe(false);
  });

  it("returns false on store error", async () => {
    const { store } = buildStore();
    vi.mocked(store.delete).mockRejectedValueOnce(new Error("network"));
    expect(await buildAdmin(store).deleteSettings("t1")).toBe(false);
  });
});
