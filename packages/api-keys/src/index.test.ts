/**
 * Ported from 実運用SaaS/tests/api-key-auth.test.ts, adapted from
 * Supabase mocks to the injected ApiKeyStore (in-memory implementation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createApiKeyManager,
  createInMemoryApiKeyStore,
  generateApiKey,
  hashKey,
  type ApiKeyManager,
  type InMemoryApiKeyStore,
} from "./index";

let store: InMemoryApiKeyStore;
let manager: ApiKeyManager;

beforeEach(() => {
  store = createInMemoryApiKeyStore();
  manager = createApiKeyManager({ store, logger: { error: vi.fn() } });
});

function reqWithKey(key?: string, bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (key) headers["x-api-key"] = key;
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return new Request("http://localhost/api/v1/me", { headers });
}

describe("authenticateApiKey", () => {
  it("returns null for requests without API key", async () => {
    const result = await manager.authenticateApiKey(reqWithKey());
    expect(result).toBeNull();
  });

  it("returns null for non-fla_ prefixed keys", async () => {
    const result = await manager.authenticateApiKey(reqWithKey("sk_test_12345"));
    expect(result).toBeNull();
  });

  it("returns record for valid API key (create → authenticate roundtrip)", async () => {
    const created = await manager.createApiKey("user@test.com", "Test Key");
    expect(created).not.toBeNull();

    const result = await manager.authenticateApiKey(reqWithKey(created!.key));
    expect(result).not.toBeNull();
    expect(result!.user_id).toBe("user@test.com");
    expect(result!.name).toBe("Test Key");
  });

  it("returns null for a wrong key of the right shape", async () => {
    await manager.createApiKey("user@test.com", "Test Key");
    const result = await manager.authenticateApiKey(reqWithKey(generateApiKey()));
    expect(result).toBeNull();
  });

  it("returns null for expired API key", async () => {
    const created = await manager.createApiKey("user@test.com", "Expired Key", ["read"], "2020-01-01T00:00:00Z");
    const result = await manager.authenticateApiKey(reqWithKey(created!.key));
    expect(result).toBeNull();
  });

  it("accepts a future expires_at", async () => {
    const created = await manager.createApiKey("user@test.com", "Future Key", ["read"], "2999-01-01T00:00:00Z");
    const result = await manager.authenticateApiKey(reqWithKey(created!.key));
    expect(result).not.toBeNull();
  });

  it("extracts key from Authorization Bearer header", async () => {
    const created = await manager.createApiKey("user@test.com", "Bearer Key");
    const result = await manager.authenticateApiKey(reqWithKey(undefined, created!.key));
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Bearer Key");
  });

  it("returns null after the key is revoked", async () => {
    const created = await manager.createApiKey("user@test.com", "Doomed Key");
    expect(await manager.authenticateApiKey(reqWithKey(created!.key))).not.toBeNull();
    await manager.revokeApiKey(created!.record.id, "user@test.com");
    expect(await manager.authenticateApiKey(reqWithKey(created!.key))).toBeNull();
  });

  it("tracks usage: sets last_used_at on successful auth", async () => {
    const created = await manager.createApiKey("user@test.com", "Used Key");
    await manager.authenticateApiKey(reqWithKey(created!.key));
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget touch
    const row = store.dump().find((r) => r.id === created!.record.id);
    expect(row!.last_used_at).not.toBeNull();
  });

  it("logs but still authenticates when touchLastUsed fails", async () => {
    const error = vi.fn();
    const failingStore: typeof store = {
      ...store,
      touchLastUsed: () => Promise.reject(new Error("db down")),
    };
    const m = createApiKeyManager({ store: failingStore, logger: { error } });
    const created = await m.createApiKey("user@test.com", "Key");
    const result = await m.authenticateApiKey(reqWithKey(created!.key));
    expect(result).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain("api_key_last_used_update_failed");
  });
});

describe("createApiKey", () => {
  it("returns key and record on success", async () => {
    const result = await manager.createApiKey("user@test.com", "My Key");
    expect(result).not.toBeNull();
    expect(result!.key).toMatch(/^fla_[0-9a-f]{64}$/);
    expect(result!.record.name).toBe("My Key");
    expect(result!.record.key_prefix).toBe(result!.key.slice(0, 12)); // "fla_" + 8 chars
  });

  it("stores only the SHA-256 hash, never the raw key", async () => {
    const result = await manager.createApiKey("user@test.com", "My Key");
    const rows = store.dump();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toBe(await hashKey(result!.key));
    expect(JSON.stringify(rows)).not.toContain(result!.key);
  });

  it("returns null when insert fails", async () => {
    const failingStore: typeof store = { ...store, insert: async () => null };
    const m = createApiKeyManager({ store: failingStore, logger: { error: vi.fn() } });
    const result = await m.createApiKey("user@test.com", "My Key");
    expect(result).toBeNull();
  });

  it("passes custom scopes and expiresAt to the store", async () => {
    const result = await manager.createApiKey("user@test.com", "My Key", ["read", "content"], "2027-01-01T00:00:00Z");
    expect(result).not.toBeNull();
    expect(result!.record.scopes).toEqual(["read", "content"]);
    expect(result!.record.expires_at).toBe("2027-01-01T00:00:00Z");
  });

  it("supports a configurable prefix", async () => {
    const m = createApiKeyManager({ store, prefix: "sk_live_", logger: { error: vi.fn() } });
    const created = await m.createApiKey("user@test.com", "Custom Prefix");
    expect(created!.key).toMatch(/^sk_live_[0-9a-f]{64}$/);
    // fla_-prefixed keys are rejected by this manager
    expect(await m.authenticateApiKey(reqWithKey(generateApiKey("fla_")))).toBeNull();
    // its own key authenticates
    expect(await m.authenticateApiKey(reqWithKey(created!.key))).not.toBeNull();
  });
});

describe("revokeApiKey", () => {
  it("revokes own key and returns true", async () => {
    const created = await manager.createApiKey("user@test.com", "Key");
    expect(await manager.revokeApiKey(created!.record.id, "user@test.com")).toBe(true);
    expect(store.dump()[0]!.enabled).toBe(false);
  });

  it("returns false when the key belongs to another user", async () => {
    const created = await manager.createApiKey("user@test.com", "Key");
    expect(await manager.revokeApiKey(created!.record.id, "attacker@test.com")).toBe(false);
    expect(store.dump()[0]!.enabled).toBe(true);
  });

  it("returns false when the store throws", async () => {
    const failingStore: typeof store = { ...store, revoke: () => Promise.reject(new Error("boom")) };
    const m = createApiKeyManager({ store: failingStore, logger: { error: vi.fn() } });
    expect(await m.revokeApiKey("key-1", "user@test.com")).toBe(false);
  });
});

describe("fetchApiKeysByUser", () => {
  it("returns the user's keys newest first", async () => {
    const nowRef = { t: 0 };
    const s = createInMemoryApiKeyStore({ now: () => new Date(1700000000000 + nowRef.t++ * 1000) });
    const m = createApiKeyManager({ store: s, logger: { error: vi.fn() } });
    await m.createApiKey("user@test.com", "Key 1");
    await m.createApiKey("user@test.com", "Key 2");
    await m.createApiKey("other@test.com", "Other");
    const result = await m.fetchApiKeysByUser("user@test.com");
    expect(result).toHaveLength(2);
    expect(result![0]!.name).toBe("Key 2");
    expect(result![1]!.name).toBe("Key 1");
  });

  it("returns null when the store throws", async () => {
    const failingStore: typeof store = { ...store, listByUser: () => Promise.reject(new Error("boom")) };
    const m = createApiKeyManager({ store: failingStore, logger: { error: vi.fn() } });
    expect(await m.fetchApiKeysByUser("user@test.com")).toBeNull();
  });
});
