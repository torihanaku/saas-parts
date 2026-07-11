/**
 * Tests for tenant-secrets.
 * 移植元: dev-dashboard-v2 tests/tenant-secrets.test.ts (supabase/env モック → 注入に置換)。
 * 追加: encrypt/decrypt roundtrip、legacy 平文互換パス。
 *
 * SECURITY: 全ての鍵値は明らかなダミー (fake/dummy/test)。実鍵は一切含めない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { deriveEncryptionKey, encryptWithKey, decryptWithKey, looksEncrypted } from "./crypto";
import {
  createTenantSecretVault,
  describeSecret,
  InMemorySecretStore,
  type SecretStore,
} from "./tenant-secrets";

const TEST_SECRET = "test-session-secret-with-enough-length-12345";
const TEST_KEY = deriveEncryptionKey(TEST_SECRET);

function makeVault(overrides: Partial<Parameters<typeof createTenantSecretVault>[0]> = {}) {
  return createTenantSecretVault({
    store: new InMemorySecretStore(),
    encryptionSecret: TEST_SECRET,
    env: { ANTHROPIC_API_KEY: "env-fake-claude-key", OPENAI_API_KEY: "", FAL_KEY: "" },
    ...overrides,
  });
}

describe("crypto roundtrip", () => {
  it("encrypt → decrypt returns the original text", () => {
    const ciphertext = encryptWithKey(TEST_KEY, "obviously-fake-value-1234");
    expect(ciphertext.split(":").length).toBe(3);
    expect(ciphertext).not.toContain("obviously-fake-value");
    expect(decryptWithKey(TEST_KEY, ciphertext)).toBe("obviously-fake-value-1234");
  });

  it("decrypt returns null for a wrong key", () => {
    const ciphertext = encryptWithKey(TEST_KEY, "obviously-fake-value");
    const otherKey = deriveEncryptionKey("another-test-secret-of-sufficient-length");
    expect(decryptWithKey(otherKey, ciphertext)).toBeNull();
  });

  it("decrypt returns null for malformed input", () => {
    expect(decryptWithKey(TEST_KEY, "not-valid-aes")).toBeNull();
  });

  it("looksEncrypted distinguishes ciphertext format from plaintext", () => {
    expect(looksEncrypted(encryptWithKey(TEST_KEY, "x"))).toBe(true);
    expect(looksEncrypted("sk-fake-legacy-plain-key")).toBe(false);
  });
});

describe("describeSecret (pure helper)", () => {
  it("returns not configured for empty input", () => {
    expect(describeSecret(null)).toEqual({ configured: false, last4: null });
  });
  it("returns last4 for normal key", () => {
    expect(describeSecret("sk-fake-12345abcd").last4).toBe("abcd");
  });
  it("masks short keys", () => {
    expect(describeSecret("ab").last4).toBe("****");
  });
});

describe("isSupportedKey", () => {
  it("accepts default provider keys", () => {
    const vault = makeVault();
    expect(vault.isSupportedKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(vault.isSupportedKey("OPENAI_API_KEY")).toBe(true);
    expect(vault.isSupportedKey("FAL_KEY")).toBe(true);
    expect(vault.isSupportedKey("SLACK_BOT_TOKEN")).toBe(true);
    expect(vault.isSupportedKey("STRIPE_SECRET_KEY")).toBe(true);
  });
  it("rejects unknown key", () => {
    expect(makeVault().isSupportedKey("UNKNOWN")).toBe(false);
  });
  it("honours a custom key list", () => {
    const vault = createTenantSecretVault<"MY_CUSTOM_KEY">({
      store: new InMemorySecretStore(),
      encryptionSecret: TEST_SECRET,
      keys: ["MY_CUSTOM_KEY"],
    });
    expect(vault.isSupportedKey("MY_CUSTOM_KEY")).toBe(true);
    expect(vault.isSupportedKey("ANTHROPIC_API_KEY")).toBe(false);
  });
});

describe("getSecret (fallback order)", () => {
  it("returns env value when no tenantId given", async () => {
    const store = new InMemorySecretStore();
    const findRow = vi.spyOn(store, "findRow");
    const vault = makeVault({ store });
    expect(await vault.getSecret(undefined, "ANTHROPIC_API_KEY")).toBe("env-fake-claude-key");
    expect(findRow).not.toHaveBeenCalled();
  });

  it("returns tenant override from the store (decrypted) before env", async () => {
    const store = new InMemorySecretStore();
    const vault = makeVault({ store });
    await vault.saveSecret("t1", "ANTHROPIC_API_KEY", "tenant-fake-claude-key-xyz");
    expect(await vault.getSecret("t1", "ANTHROPIC_API_KEY")).toBe("tenant-fake-claude-key-xyz");
  });

  it("falls back to env when no row exists", async () => {
    const vault = makeVault();
    expect(await vault.getSecret("t1", "ANTHROPIC_API_KEY")).toBe("env-fake-claude-key");
  });

  it("falls back to env when ciphertext is corrupted (undecryptable AES format)", async () => {
    const store = new InMemorySecretStore();
    await store.insertRow({
      tenant_id: "t1",
      key: "ANTHROPIC_API_KEY",
      encrypted_value: "00ff:00ff:00ff", // looks encrypted, but garbage
      last4: null,
      updated_by: null,
    });
    const vault = makeVault({ store });
    expect(await vault.getSecret("t1", "ANTHROPIC_API_KEY")).toBe("env-fake-claude-key");
  });

  it("returns null when no row and no env", async () => {
    const vault = makeVault();
    expect(await vault.getSecret("t1", "OPENAI_API_KEY")).toBeNull();
  });
});

describe("legacy plaintext backward compat", () => {
  async function storeWithLegacyRow(): Promise<SecretStore> {
    const store = new InMemorySecretStore();
    await store.insertRow({
      tenant_id: "t1",
      key: "ANTHROPIC_API_KEY",
      encrypted_value: "sk-fake-legacy-plain-key", // 暗号化導入以前の平文行
      last4: null,
      updated_by: null,
    });
    return store;
  }

  it("reads a legacy plaintext row as-is (default)", async () => {
    const vault = makeVault({ store: await storeWithLegacyRow() });
    expect(await vault.getSecret("t1", "ANTHROPIC_API_KEY")).toBe("sk-fake-legacy-plain-key");
  });

  it("describe reports legacy row as tenant source with computed last4", async () => {
    const vault = makeVault({ store: await storeWithLegacyRow() });
    expect(await vault.describeSecret("t1", "ANTHROPIC_API_KEY")).toEqual({
      configured: true,
      source: "tenant",
      last4: "-key",
    });
  });

  it("legacyPlaintext:false restores strict env-fallback behaviour of the source", async () => {
    const vault = makeVault({ store: await storeWithLegacyRow(), legacyPlaintext: false });
    expect(await vault.getSecret("t1", "ANTHROPIC_API_KEY")).toBe("env-fake-claude-key");
  });
});

describe("describeSecret (vault metadata)", () => {
  it("returns env source when only env is set", async () => {
    const vault = makeVault();
    expect(await vault.describeSecret(undefined, "ANTHROPIC_API_KEY")).toEqual({
      configured: true,
      source: "env",
      last4: null,
    });
  });

  it("returns tenant source with last4 when store is set", async () => {
    const vault = makeVault();
    await vault.saveSecret("t1", "ANTHROPIC_API_KEY", "tenant-fake-12345abcd");
    expect(await vault.describeSecret("t1", "ANTHROPIC_API_KEY")).toEqual({
      configured: true,
      source: "tenant",
      last4: "abcd",
    });
  });

  it("returns none when no store row and no env", async () => {
    const vault = makeVault();
    expect(await vault.describeSecret("t1", "OPENAI_API_KEY")).toEqual({
      configured: false,
      source: "none",
      last4: null,
    });
  });
});

describe("saveSecret encryption", () => {
  it("encrypts value before INSERT (never stores raw)", async () => {
    const store = new InMemorySecretStore();
    const insertSpy = vi.spyOn(store, "insertRow");
    const vault = makeVault({ store });

    expect(await vault.saveSecret("t1", "ANTHROPIC_API_KEY", "raw-fake-secret-1234abcd")).toBe(true);

    const [payload] = insertSpy.mock.calls[0]!;
    expect(payload.encrypted_value.split(":").length).toBe(3);
    expect(payload.encrypted_value).not.toContain("raw-fake-secret");
    expect(payload.last4).toBe("abcd");
  });

  it("encrypts on UPDATE path as well", async () => {
    const store = new InMemorySecretStore();
    await store.insertRow({
      tenant_id: "t1",
      key: "ANTHROPIC_API_KEY",
      encrypted_value: "old",
      last4: null,
      updated_by: null,
    });
    const updateSpy = vi.spyOn(store, "updateRow");
    const vault = makeVault({ store });

    expect(await vault.saveSecret("t1", "ANTHROPIC_API_KEY", "new-fake-secret-WXYZ")).toBe(true);

    const [, , patch] = updateSpy.mock.calls[0]!;
    expect(patch.encrypted_value.split(":").length).toBe(3);
    expect(patch.encrypted_value).not.toContain("new-fake-secret");
    expect(patch.last4).toBe("WXYZ");
  });

  it("rejects empty value", async () => {
    const store = new InMemorySecretStore();
    const insertSpy = vi.spyOn(store, "insertRow");
    const vault = makeVault({ store });
    expect(await vault.saveSecret("t1", "ANTHROPIC_API_KEY", "   ")).toBe(false);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("deleteSecret", () => {
  it("removes the row so resolution falls back to env", async () => {
    const store = new InMemorySecretStore();
    const deleteSpy = vi.spyOn(store, "deleteRow");
    const vault = makeVault({ store });
    await vault.saveSecret("t1", "ANTHROPIC_API_KEY", "tenant-fake-value");
    expect(await vault.deleteSecret("t1", "ANTHROPIC_API_KEY")).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith("t1", "ANTHROPIC_API_KEY");
    expect(await vault.getSecret("t1", "ANTHROPIC_API_KEY")).toBe("env-fake-claude-key");
  });
});

describe("pingProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects empty key without hitting network", async () => {
    const res = await makeVault().pingProvider("ANTHROPIC_API_KEY", "");
    expect(res.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ANTHROPIC: ok on 200", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    } as unknown as Response);
    const res = await makeVault().pingProvider("ANTHROPIC_API_KEY", "sk-ant-fake");
    expect(res.ok).toBe(true);
  });

  it("ANTHROPIC: not-ok on 401", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("invalid"),
    } as unknown as Response);
    const res = await makeVault().pingProvider("ANTHROPIC_API_KEY", "bad");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it("OPENAI: ok on /models 200", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    } as unknown as Response);
    const res = await makeVault().pingProvider("OPENAI_API_KEY", "sk-fake");
    expect(res.ok).toBe(true);
  });

  it("FAL: 401/403 → not ok", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    const res = await makeVault().pingProvider("FAL_KEY", "fake");
    expect(res.ok).toBe(false);
  });

  it("custom key without a handler returns an explanatory error", async () => {
    const vault = createTenantSecretVault<"MY_CUSTOM_KEY">({
      store: new InMemorySecretStore(),
      encryptionSecret: TEST_SECRET,
      keys: ["MY_CUSTOM_KEY"],
    });
    const res = await vault.pingProvider("MY_CUSTOM_KEY", "fake");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("MY_CUSTOM_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("custom ping handler is used when injected", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const vault = makeVault({ pingHandlers: { ANTHROPIC_API_KEY: handler } });
    const res = await vault.pingProvider("ANTHROPIC_API_KEY", "sk-ant-fake");
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith("sk-ant-fake");
    expect(fetch).not.toHaveBeenCalled();
  });
});
