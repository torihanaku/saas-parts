/**
 * Ported from 実運用SaaS `tests/audit.test.ts`, adapted to the
 * injected AuditStore/AuditContext, plus hash-chain verifier tests
 * (including tampered-row detection).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAuditLogger,
  verifyHashChain,
  InMemoryAuditStore,
  type AuditContext,
  type AuditStore,
} from "./index";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/test", { headers });
}

function makeContext(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    getCurrentUserRole: vi.fn().mockResolvedValue({ email: "audit@example.com", role: "admin" }),
    getTenantId: vi.fn().mockResolvedValue("test-tenant-id"),
    ...overrides,
  };
}

let store: InMemoryAuditStore;
let context: AuditContext;

beforeEach(() => {
  store = new InMemoryAuditStore();
  context = makeContext();
});

describe("logAudit", () => {
  it("is no longer fire-and-forget — returns a promise", async () => {
    const { logAudit } = createAuditLogger({ store, context });
    const result = logAudit(makeRequest(), { action: "create", resourceType: "backlog" });
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it("inserts correct fields including hashes", async () => {
    const insertSpy = vi.spyOn(store, "insert");
    const { logAudit } = createAuditLogger({ store, context });
    await logAudit(makeRequest({ "x-forwarded-for": "192.168.1.1" }), {
      action: "update",
      resourceType: "task",
      resourceId: "task-123",
      changes: { status: "done" },
    });

    expect(insertSpy).toHaveBeenCalled();
    const [data] = insertSpy.mock.calls[0]!;
    expect(data.tenant_id).toBe("test-tenant-id");
    expect(data.user_email).toBe("audit@example.com");
    expect(data.user_role).toBe("admin");
    expect(data.action).toBe("update");
    expect(data.resource_type).toBe("task");
    expect(data.resource_id).toBe("task-123");
    expect(data.changes).toEqual({ status: "done" });
    expect(data.ip_address).toBe("192.168.1.1");
    expect(data.entry_hash).toBeDefined();
  });

  it("extracts ip from x-forwarded-for (first ip in list)", async () => {
    const { logAudit } = createAuditLogger({ store, context });
    await logAudit(makeRequest({ "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" }), {
      action: "delete",
      resourceType: "document",
    });
    expect(store.rows[0]!.ip_address).toBe("10.0.0.1");
  });

  it("falls back to cf-connecting-ip when x-forwarded-for is absent", async () => {
    const { logAudit } = createAuditLogger({ store, context });
    await logAudit(makeRequest({ "cf-connecting-ip": "1.2.3.4" }), {
      action: "login",
      resourceType: "session",
    });
    expect(store.rows[0]!.ip_address).toBe("1.2.3.4");
  });

  it('uses "unknown" when no IP headers are present', async () => {
    const { logAudit } = createAuditLogger({ store, context });
    await logAudit(makeRequest(), { action: "logout", resourceType: "session" });
    expect(store.rows[0]!.ip_address).toBe("unknown");
  });

  it("sets resource_id to null when not provided", async () => {
    const { logAudit } = createAuditLogger({ store, context });
    await logAudit(makeRequest(), { action: "create", resourceType: "report" });
    expect(store.rows[0]!.resource_id).toBeNull();
    expect(store.rows[0]!.changes).toBeNull();
  });

  it("falls back to the default tenant id when context yields none", async () => {
    context = makeContext({ getTenantId: vi.fn().mockResolvedValue(null) });
    const { logAudit } = createAuditLogger({ store, context });
    await logAudit(makeRequest(), { action: "create", resourceType: "report" });
    expect(store.rows[0]!.tenant_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("throws when getCurrentUserRole fails", async () => {
    context = makeContext({
      getCurrentUserRole: vi.fn().mockRejectedValue(new Error("auth error")),
    });
    const insertSpy = vi.spyOn(store, "insert");
    const { logAudit } = createAuditLogger({ store, context });
    await expect(
      logAudit(makeRequest(), { action: "invite", resourceType: "member" }),
    ).rejects.toThrow("auth error");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("throws when store.insert fails", async () => {
    const failingStore: AuditStore = {
      getLastEntry: async () => null,
      insert: async () => ({ ok: false, error: "DB error" }),
      listEntries: async () => [],
    };
    const { logAudit } = createAuditLogger({ store: failingStore, context });
    await expect(
      logAudit(makeRequest(), { action: "update", resourceType: "config" }),
    ).rejects.toThrow("Audit log insertion failed: DB error");
  });

  it("supports arbitrary action strings via the generic parameter", async () => {
    const { logAudit } = createAuditLogger<"custom_action">({ store, context });
    await logAudit(makeRequest(), { action: "custom_action", resourceType: "thing" });
    expect(store.rows[0]!.action).toBe("custom_action");
  });
});

describe("logAuditSystem", () => {
  it("inserts with system defaults", async () => {
    const { logAuditSystem } = createAuditLogger({ store, context });
    await logAuditSystem("tenant-abc", {
      action: "agent_auto_halt",
      resourceType: "agent",
      resourceId: "agent-456",
      riskLevel: "high",
    });

    const data = store.rows[0]!;
    expect(data.tenant_id).toBe("tenant-abc");
    expect(data.user_email).toBe("system@local");
    expect(data.user_role).toBe("system");
    expect(data.action).toBe("agent_auto_halt");
    expect(data.risk_level).toBe("high");
    expect(data.actor_type).toBe("system");
    expect(data.ip_address).toBe("127.0.0.1");
  });

  it("allows overriding user_email and ip_address", async () => {
    const { logAuditSystem } = createAuditLogger({ store, context });
    await logAuditSystem("tenant-abc", {
      action: "login",
      resourceType: "session",
      user_email: "override@example.com",
      ip_address: "8.8.8.8",
    });
    const data = store.rows[0]!;
    expect(data.user_email).toBe("override@example.com");
    expect(data.ip_address).toBe("8.8.8.8");
  });
});

describe("hash chain + verifyHashChain", () => {
  async function logThree(): Promise<void> {
    const { logAudit, logAuditSystem } = createAuditLogger({ store, context });
    await logAudit(makeRequest({ "x-forwarded-for": "10.0.0.1" }), {
      action: "create",
      resourceType: "task",
      resourceId: "t-1",
      changes: { title: "hello" },
    });
    await logAudit(makeRequest(), { action: "update", resourceType: "task", resourceId: "t-1" });
    await logAuditSystem("test-tenant-id", { action: "agent_auto_halt", resourceType: "agent" });
  }

  it("links each entry to the previous entry's hash", async () => {
    await logThree();
    const rows = store.rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.prev_hash).toBeNull();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.entry_hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.entry_hash);
  });

  it("verifies an untampered chain", async () => {
    await logThree();
    await expect(verifyHashChain(store, "test-tenant-id")).resolves.toBe(true);
  });

  it("returns true for a tenant with no entries", async () => {
    await expect(verifyHashChain(store, "empty-tenant")).resolves.toBe(true);
  });

  it("detects a tampered row (content mutated after the fact)", async () => {
    await logThree();
    // Attacker flips an action on the middle row without recomputing hashes.
    store.rows[1]!.action = "delete";
    await expect(verifyHashChain(store, "test-tenant-id")).rejects.toThrow(/Hash mismatch/);
  });

  it("detects tampering of the changes payload", async () => {
    await logThree();
    store.rows[0]!.user_email = "attacker@example.com";
    await expect(verifyHashChain(store, "test-tenant-id")).rejects.toThrow(/Hash mismatch/);
  });

  it("detects tampering INSIDE the nested changes payload", async () => {
    // Regression: the old canonicalizer used JSON.stringify(obj, sortedKeys),
    // whose key-array replacer recursively stripped nested keys — so mutating
    // changes.title went undetected. The recursive canonicalizer must catch it.
    await logThree();
    const changes = store.rows[0]!.changes as Record<string, unknown>;
    expect(changes.title).toBe("hello");
    changes.title = "tampered";
    await expect(verifyHashChain(store, "test-tenant-id")).rejects.toThrow(/Hash mismatch/);
  });

  it("detects a broken chain (prev_hash relinked)", async () => {
    await logThree();
    store.rows[1]!.prev_hash = Buffer.from("00".repeat(32), "hex").toString("base64");
    await expect(verifyHashChain(store, "test-tenant-id")).rejects.toThrow(/Hash chain broken/);
  });

  it("detects a deleted row in the middle of the chain", async () => {
    await logThree();
    store.rows.splice(1, 1);
    await expect(verifyHashChain(store, "test-tenant-id")).rejects.toThrow(
      /Hash chain broken|Hash mismatch/,
    );
  });
});
