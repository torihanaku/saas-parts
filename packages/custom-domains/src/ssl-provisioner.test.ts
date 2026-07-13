/**
 * Ported from 実運用SaaS `tests/white-label/ssl-provisioner.test.ts`
 * (#1341 WhiteLabel-3b).
 *
 * Covers:
 *   - createDomainMapping: success, already-exists, gcloud failure
 *   - describeDomainMapping: active, provisioning, gcloud failure, parse failure
 *   - runSslProvisioner: kill switch, verified→ssl_provisioning,
 *     ssl_provisioning→active, error transitions, notifier on failure
 *   - createTimedSpawn: Bun-path timeout handling
 *
 * Supabase/feature-flag/Slack mocks replaced by the injected memory store,
 * `enabled` callback and `notify` callback.
 */
import { describe, it, expect, vi } from "vitest";

import {
  createDomainMapping,
  createGcloudProvisioner,
  createTimedSpawn,
  describeDomainMapping,
  type SpawnImpl,
} from "./gcloud-provisioner";
import { runSslProvisioner } from "./ssl-provisioner";
import { createMemoryDomainStore } from "./memory-store";
import type { DomainRecord, DomainStore } from "./types";

// ── spawn helpers ─────────────────────────────────────────────────────────────

const spawnCreateOk: SpawnImpl = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
const spawnCreateFail: SpawnImpl = vi
  .fn()
  .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "gcloud error" });
const spawnCreateAlreadyExists: SpawnImpl = vi
  .fn()
  .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "already exists" });

const spawnDescribeActive: SpawnImpl = vi.fn().mockResolvedValue({
  exitCode: 0,
  stdout: JSON.stringify({ status: { conditions: [{ type: "CertificateProvisioned", status: "True" }] } }),
  stderr: "",
});
const spawnDescribeProvisioning: SpawnImpl = vi.fn().mockResolvedValue({
  exitCode: 0,
  stdout: JSON.stringify({ status: { conditions: [{ type: "CertificateProvisioned", status: "False" }] } }),
  stderr: "",
});
const spawnDescribeFail: SpawnImpl = vi
  .fn()
  .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "describe error" });

const gcloud = (spawnImpl: SpawnImpl) =>
  createGcloudProvisioner({ service: "my-service", region: "asia-northeast1", spawnImpl });

const row = (over: Partial<DomainRecord>): DomainRecord => ({
  id: "d-001",
  tenantId: "t-1",
  domain: "app.test.jp",
  state: "verified",
  ...over,
});

// ── createDomainMapping ───────────────────────────────────────────────────────

describe("createDomainMapping", () => {
  it("returns ok=true on exitCode 0", async () => {
    const result = await createDomainMapping("app.example.com", "svc", "asia-northeast1", spawnCreateOk);
    expect(result.ok).toBe(true);
  });

  it("returns ok=true when stderr includes 'already exists' (idempotent)", async () => {
    const result = await createDomainMapping(
      "app.example.com",
      "svc",
      "asia-northeast1",
      spawnCreateAlreadyExists,
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with error message on gcloud failure", async () => {
    const result = await createDomainMapping("app.example.com", "svc", "asia-northeast1", spawnCreateFail);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gcloud error");
  });

  it("includes --domain and --service flags in the spawn command", async () => {
    const spawn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await createDomainMapping("my.domain.jp", "my-service", "us-central1", spawn);
    const cmd = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(cmd).toContain("--domain=my.domain.jp");
    expect(cmd).toContain("--service=my-service");
    expect(cmd).toContain("--region=us-central1");
  });
});

// ── describeDomainMapping ─────────────────────────────────────────────────────

describe("describeDomainMapping", () => {
  it("returns active when CertificateProvisioned=True", async () => {
    const result = await describeDomainMapping("app.example.com", "asia-northeast1", spawnDescribeActive);
    expect(result.status).toBe("active");
  });

  it("returns provisioning when CertificateProvisioned=False", async () => {
    const result = await describeDomainMapping(
      "app.example.com",
      "asia-northeast1",
      spawnDescribeProvisioning,
    );
    expect(result.status).toBe("provisioning");
  });

  it("returns error on gcloud describe failure", async () => {
    const result = await describeDomainMapping("app.example.com", "asia-northeast1", spawnDescribeFail);
    expect(result.status).toBe("error");
    expect(result.error).toContain("describe error");
  });

  it("returns error on unparseable JSON output", async () => {
    const badSpawn: SpawnImpl = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "not json{", stderr: "" });
    const result = await describeDomainMapping("app.example.com", "asia-northeast1", badSpawn);
    expect(result.status).toBe("error");
  });

  it("returns provisioning when conditions array is empty", async () => {
    const noCondSpawn: SpawnImpl = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ status: { conditions: [] } }),
      stderr: "",
    });
    const result = await describeDomainMapping("app.example.com", "asia-northeast1", noCondSpawn);
    expect(result.status).toBe("provisioning");
  });
});

// ── runSslProvisioner ─────────────────────────────────────────────────────────

describe("runSslProvisioner — kill switch", () => {
  it("returns [] immediately when disabled", async () => {
    const store = createMemoryDomainStore([row({ state: "verified" })]);
    const results = await runSslProvisioner({
      store,
      provisioner: gcloud(spawnCreateOk),
      enabled: () => false,
    });
    expect(results).toEqual([]);
  });
});

describe("runSslProvisioner — verified → ssl_provisioning", () => {
  it("transitions verified domain to ssl_provisioning on success", async () => {
    const store = createMemoryDomainStore([row({ id: "d-001", state: "verified" })]);
    const results = await runSslProvisioner({ store, provisioner: gcloud(spawnCreateOk) });
    expect(results).toHaveLength(1);
    expect(results[0]?.nextState).toBe("ssl_provisioning");
    expect(results[0]?.ok).toBe(true);
    expect(store.get("d-001")?.state).toBe("ssl_provisioning");
  });

  it("fails closed and notifies when the verified-domain query fails", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();
    const store: DomainStore = {
      listByState: vi.fn().mockRejectedValue(new Error("db unavailable")),
      update: vi.fn(),
    };
    await expect(
      runSslProvisioner({
        store,
        provisioner: { create, describe: vi.fn() },
        notify,
      }),
    ).rejects.toThrow("failed to fetch verified custom domains");
    expect(create).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssl_provisioner_db_error",
        tenantId: "system",
        payload: expect.objectContaining({ error: expect.stringContaining("db unavailable") }),
      }),
    );
  });

  it("does not start provisioning when the recheck query fails", async () => {
    const create = vi.fn();
    const listByState = vi
      .fn()
      .mockResolvedValueOnce([row({ id: "d-006", domain: "hold.test.jp", state: "verified" })])
      .mockRejectedValueOnce(new Error("read failed"));
    const store: DomainStore = { listByState, update: vi.fn() };
    await expect(
      runSslProvisioner({ store, provisioner: { create, describe: vi.fn() } }),
    ).rejects.toThrow("failed to fetch ssl_provisioning custom domains");
    expect(create).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("surfaces update failures instead of reporting a successful transition", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const store = createMemoryDomainStore([
      row({ id: "d-007", tenantId: "t-7", domain: "stuck.test.jp", state: "verified" }),
    ]);
    store.update = vi.fn().mockRejectedValue(new Error("update rejected"));
    await expect(
      runSslProvisioner({ store, provisioner: gcloud(spawnCreateOk), notify }),
    ).rejects.toThrow("failed to transition stuck.test.jp");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssl_provision_error",
        tenantId: "t-7",
        payload: expect.objectContaining({ error: expect.stringContaining("update rejected") }),
      }),
    );
  });

  it("transitions verified domain to error on gcloud failure + notifies", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const store = createMemoryDomainStore([
      row({ id: "d-002", tenantId: "t-2", domain: "fail.test.jp", state: "verified" }),
    ]);
    const results = await runSslProvisioner({
      store,
      provisioner: gcloud(spawnCreateFail),
      notify,
    });
    expect(results[0]?.nextState).toBe("error");
    expect(results[0]?.ok).toBe(false);
    expect(store.get("d-002")?.state).toBe("error");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssl_provision_error",
        tenantId: "t-2",
        payload: expect.objectContaining({ domain: "fail.test.jp" }),
      }),
    );
  });
});

describe("runSslProvisioner — ssl_provisioning → active", () => {
  it("transitions ssl_provisioning domain to active when cert is ready", async () => {
    const store = createMemoryDomainStore([
      row({ id: "d-003", tenantId: "t-3", domain: "ready.test.jp", state: "ssl_provisioning" }),
    ]);
    const results = await runSslProvisioner({ store, provisioner: gcloud(spawnDescribeActive) });
    expect(results[0]?.previousState).toBe("ssl_provisioning");
    expect(results[0]?.nextState).toBe("active");
    expect(results[0]?.ok).toBe(true);
    const record = store.get("d-003");
    expect(record?.state).toBe("active");
    expect(record?.verifiedAt).toBeTruthy();
  });

  it("leaves ssl_provisioning domain untouched when cert still provisioning", async () => {
    const store = createMemoryDomainStore([
      row({ id: "d-004", tenantId: "t-4", domain: "pending.test.jp", state: "ssl_provisioning" }),
    ]);
    const results = await runSslProvisioner({
      store,
      provisioner: gcloud(spawnDescribeProvisioning),
    });
    expect(results).toHaveLength(0); // no result entry for "still provisioning"
    expect(store.get("d-004")?.state).toBe("ssl_provisioning");
  });

  it("transitions ssl_provisioning to error on describe failure + notifies", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const store = createMemoryDomainStore([
      row({ id: "d-005", tenantId: "t-5", domain: "err.test.jp", state: "ssl_provisioning" }),
    ]);
    const results = await runSslProvisioner({
      store,
      provisioner: gcloud(spawnDescribeFail),
      notify,
    });
    expect(results[0]?.nextState).toBe("error");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssl_provision_error",
        tenantId: "t-5",
        payload: expect.objectContaining({ domain: "err.test.jp" }),
      }),
    );
  });
});

describe("runSslProvisioner — empty state", () => {
  it("returns [] when no verified or provisioning domains exist", async () => {
    const store = createMemoryDomainStore();
    const results = await runSslProvisioner({ store, provisioner: gcloud(spawnCreateOk) });
    expect(results).toEqual([]);
  });
});

// ── createTimedSpawn ──────────────────────────────────────────────────────────

describe("createTimedSpawn", () => {
  it("kills a hanging gcloud command and returns a timeout result (Bun path)", async () => {
    const encoder = new TextEncoder();
    const stream = (value: string) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(value));
          controller.close();
        },
      });
    const kill = vi.fn();
    const spawn = vi.fn().mockReturnValue({
      stdout: stream("partial stdout"),
      stderr: stream("partial stderr"),
      exited: new Promise<number>(() => undefined),
      kill,
    });
    vi.stubGlobal("Bun", { spawn });

    const result = await createTimedSpawn(1)(["gcloud", "run"]);

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toContain("partial stdout");
    expect(result.stderr).toContain("partial stderr");
    expect(result.stderr).toContain("timed out after 1ms");
    expect(kill).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("runs a real command via node:child_process fallback", async () => {
    const result = await createTimedSpawn(5_000)([
      process.execPath,
      "-e",
      "process.stdout.write('hello'); process.exit(0)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("returns exit code 127 when the binary does not exist", async () => {
    const result = await createTimedSpawn(5_000)(["definitely-not-a-real-binary-xyz"]);
    expect(result.exitCode).toBe(127);
  });
});
