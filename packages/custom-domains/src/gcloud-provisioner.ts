/**
 * Default {@link DomainMappingProvisioner} implementation: GCP Cloud Run
 * `gcloud run domain-mappings` via a subprocess.
 *
 * Ported from 実運用SaaS `server/lib/white-label/ssl-provisioner.ts`
 * (#1341). This is the documented source default — swap in your own
 * provisioner (Cloudflare for SaaS, AWS ACM + ALB, Caddy on-demand TLS, …)
 * by implementing the two-method interface.
 *
 * Requires the `gcloud` CLI to be available and authenticated in the runtime
 * (e.g. a Cloud Run job with an appropriately-scoped service account).
 */

import type { DomainMappingProvisioner } from "./types";

const DEFAULT_GCLOUD_TIMEOUT_MS = 120_000;
const GCLOUD_TIMEOUT_EXIT_CODE = 124;

/** Injectable spawn for tests. */
export type SpawnImpl = (
  cmd: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Starts SSL certificate provisioning via `gcloud run domain-mappings create`.
 * Returns true on exitCode 0. Already-exists (exit 1 + "already exists" in
 * stderr) is also treated as success so idempotent retries don't stall.
 */
export async function createDomainMapping(
  domain: string,
  service: string,
  region: string,
  spawn: SpawnImpl,
): Promise<{ ok: boolean; error?: string }> {
  const result = await spawn([
    "gcloud",
    "run",
    "domain-mappings",
    "create",
    `--domain=${domain}`,
    `--service=${service}`,
    `--region=${region}`,
    "--quiet",
  ]);
  if (result.exitCode === 0) return { ok: true };
  if (result.stderr.toLowerCase().includes("already exists")) return { ok: true };
  return { ok: false, error: result.stderr.trim() || "gcloud domain-mapping create failed" };
}

/**
 * Describes a domain mapping to check certificate status.
 * Returns "active" when ready, "provisioning" when still in progress.
 */
export async function describeDomainMapping(
  domain: string,
  region: string,
  spawn: SpawnImpl,
): Promise<{ status: "active" | "provisioning" | "error"; error?: string }> {
  const result = await spawn([
    "gcloud",
    "run",
    "domain-mappings",
    "describe",
    `--domain=${domain}`,
    `--region=${region}`,
    "--format=json",
    "--quiet",
  ]);
  if (result.exitCode !== 0) {
    return { status: "error", error: result.stderr.trim() || "gcloud describe failed" };
  }
  try {
    const data = JSON.parse(result.stdout) as {
      status?: { conditions?: Array<{ type: string; status: string }> };
    };
    const conditions = data?.status?.conditions ?? [];
    const certCondition = conditions.find((c) => c.type === "CertificateProvisioned");
    if (certCondition?.status === "True") return { status: "active" };
    return { status: "provisioning" };
  } catch {
    return { status: "error", error: "failed to parse gcloud describe output" };
  }
}

export interface GcloudProvisionerOptions {
  /** Cloud Run service the domain should map to. */
  service: string;
  /** GCP region. Default: "asia-northeast1" (Tokyo). */
  region?: string;
  commandTimeoutMs?: number;
  spawnImpl?: SpawnImpl;
}

export function createGcloudProvisioner(
  opts: GcloudProvisionerOptions,
): DomainMappingProvisioner {
  const region = opts.region ?? "asia-northeast1";
  const spawn =
    opts.spawnImpl ?? createTimedSpawn(opts.commandTimeoutMs ?? DEFAULT_GCLOUD_TIMEOUT_MS);
  return {
    create: (domain) => createDomainMapping(domain, opts.service, region, spawn),
    describe: (domain) => describeDomainMapping(domain, region, spawn),
  };
}

// ── default spawn ─────────────────────────────────────────────────────────────

interface BunProcessLike {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

interface BunLike {
  spawn(opts: { cmd: string[]; stdout: "pipe"; stderr: "pipe" }): BunProcessLike;
}

/**
 * Spawns a subprocess with a hard timeout (exit code 124 on timeout, like
 * coreutils `timeout`). Uses `Bun.spawn` when running under Bun (the source
 * runtime), otherwise falls back to node:child_process.
 */
export function createTimedSpawn(timeoutMs = DEFAULT_GCLOUD_TIMEOUT_MS): SpawnImpl {
  return async (cmd) => {
    const bun = (globalThis as { Bun?: BunLike }).Bun;
    if (bun) return bunSpawn(bun, cmd, timeoutMs);
    return nodeSpawn(cmd, timeoutMs);
  };
}

async function bunSpawn(
  bun: BunLike,
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const exitOrTimeout = await Promise.race([proc.exited, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (exitOrTimeout === "timeout") {
    proc.kill();
    const [stdout, stderr] = await Promise.all([
      settleText(stdoutPromise),
      settleText(stderrPromise),
    ]);
    return {
      exitCode: GCLOUD_TIMEOUT_EXIT_CODE,
      stdout,
      stderr: [stderr, `gcloud command timed out after ${timeoutMs}ms`]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { exitCode: exitOrTimeout, stdout, stderr };
}

async function nodeSpawn(
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  const [bin, ...args] = cmd;
  if (!bin) return { exitCode: 127, stdout: "", stderr: "empty command" };
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill();
      resolve({
        exitCode: GCLOUD_TIMEOUT_EXIT_CODE,
        stdout,
        stderr: [stderr, `gcloud command timed out after ${timeoutMs}ms`]
          .filter(Boolean)
          .join("\n"),
      });
    }, timeoutMs);
    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    proc.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: err.message });
    });
  });
}

async function settleText(promise: Promise<string>): Promise<string> {
  try {
    return await promise;
  } catch {
    return "";
  }
}
