/**
 * CNAME verifier for customer custom domains.
 *
 * When a tenant adds a custom-domain record, the cron walks pending rows and
 * resolves the CNAME. If it points at the configured target, the row
 * transitions to `verified` and SSL provisioning can pick it up.
 * Misconfiguration is captured as an `error` string so a partner dashboard
 * can surface it.
 *
 * Ported from dev-dashboard-v2 `server/lib/white-label/cname-verifier.ts`
 * (#1340 WhiteLabel-3a). Decoupled: DNS resolution is injected (default is a
 * lazily-imported node:dns wrapper so edge runtimes can supply e.g. a
 * DNS-over-HTTPS resolver), storage is an injected {@link DomainStore}, and
 * the feature-flag kill switch became an injectable `enabled` callback.
 */

import type { DomainStore } from "./types";

export interface CnameVerifyResult {
  domain: string;
  ok: boolean;
  resolved?: string;
  error?: string;
}

export type CnameResolver = (domain: string) => Promise<string[]>;

export interface CnameVerifierOptions {
  resolver?: CnameResolver;
}

export interface CronSummary {
  processed: number;
  verified: number;
  failed: number;
  results: CnameVerifyResult[];
}

export async function verifyCname(
  domain: string,
  expectedTarget: string,
  opts: CnameVerifierOptions = {},
): Promise<CnameVerifyResult> {
  const resolver = opts.resolver ?? defaultResolver;
  try {
    const records = await resolver(domain);
    if (records.length === 0) {
      return { domain, ok: false, error: "no_cname_record" };
    }
    const resolved = records[0];
    if (!resolved) {
      return { domain, ok: false, error: "no_cname_record" };
    }
    const normalized = resolved.replace(/\.$/, "").toLowerCase();
    const expected = expectedTarget.replace(/\.$/, "").toLowerCase();
    if (normalized !== expected) {
      return {
        domain,
        ok: false,
        resolved: normalized,
        error: `cname_mismatch: expected ${expected}, got ${normalized}`,
      };
    }
    return { domain, ok: true, resolved: normalized };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code)
        : undefined;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { domain, ok: false, error: "nxdomain" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { domain, ok: false, error: `dns_error: ${message}` };
  }
}

export interface CnameCronOptions extends CnameVerifierOptions {
  store: DomainStore;
  /** CNAME target the customer must point at (e.g. "edge.your-saas.example"). */
  target: string;
  /** Kill switch — return false to make the cron a no-op. Default: enabled. */
  enabled?: () => boolean;
  /** Clock injection for tests. */
  now?: () => Date;
}

export async function runCnameVerificationCron(
  options: CnameCronOptions,
): Promise<CronSummary> {
  if (options.enabled && !options.enabled()) {
    return { processed: 0, verified: 0, failed: 0, results: [] };
  }
  const now = options.now ?? (() => new Date());

  let rows;
  try {
    rows = await options.store.listByState("pending");
  } catch {
    return { processed: 0, verified: 0, failed: 0, results: [] };
  }

  const results: CnameVerifyResult[] = [];
  let verified = 0;
  let failed = 0;
  for (const row of rows) {
    const target = row.cnameTarget ?? options.target;
    const result = await verifyCname(row.domain, target, options);
    results.push(result);
    const nowIso = now().toISOString();
    if (result.ok) {
      await options.store.update(row.id, {
        state: "verified",
        lastCheckedAt: nowIso,
        verifiedAt: nowIso,
        error: null,
      });
      verified += 1;
    } else {
      await options.store.update(row.id, {
        state: "failed",
        lastCheckedAt: nowIso,
        error: result.error ?? "unknown_error",
      });
      failed += 1;
    }
  }
  return { processed: rows.length, verified, failed, results };
}

/**
 * Default resolver: node:dns CNAME lookup, imported lazily so this module
 * stays importable on edge runtimes (inject your own resolver there).
 */
const defaultResolver: CnameResolver = async (domain) => {
  const { promises: dns } = await import("node:dns");
  return dns.resolveCname(domain);
};
