/**
 * SSL Provisioner for customer custom domains.
 *
 * State machine:
 *   verified → ssl_provisioning  (provider.create kicks off cert)
 *   ssl_provisioning → active    (provider.describe shows certificate ready)
 *   ssl_provisioning → error     (provider error or timeout)
 *
 * Two phases are handled in a single cron run so a domain that was already
 * in ssl_provisioning from a previous tick gets re-checked each time.
 *
 * Ported from dev-dashboard-v2 `server/lib/white-label/ssl-provisioner.ts`
 * (#1341 WhiteLabel-3b). Decoupled: cloud calls go through an injected
 * {@link DomainMappingProvisioner} (gcloud default in
 * `gcloud-provisioner.ts`), storage is an injected {@link DomainStore},
 * Slack alerts became a generic {@link DomainEventNotifier}, and the
 * feature-flag kill switch is an injectable `enabled` callback.
 */

import type {
  DomainEventNotifier,
  DomainMappingProvisioner,
  DomainRecord,
  DomainState,
  DomainStore,
} from "./types";

export interface SslProvisionResult {
  domain: string;
  previousState: DomainState;
  nextState: DomainState;
  ok: boolean;
  error?: string;
}

export interface SslProvisionerDeps {
  store: DomainStore;
  provisioner: DomainMappingProvisioner;
  /** Best-effort operational alerting (Slack etc.). */
  notify?: DomainEventNotifier;
  /** Kill switch — return false to make the run a no-op. Default: enabled. */
  enabled?: () => boolean;
  /** Clock injection for tests. */
  now?: () => Date;
}

/**
 * Processes all `verified` domains by starting SSL provisioning, and
 * rechecks all `ssl_provisioning` domains to see if certificates are ready.
 */
export async function runSslProvisioner(
  deps: SslProvisionerDeps,
): Promise<SslProvisionResult[]> {
  if (deps.enabled && !deps.enabled()) return [];

  const results: SslProvisionResult[] = [];

  const verifiedDomains = await fetchDomainsByState(deps, "verified");
  const provisioningDomains = await fetchDomainsByState(deps, "ssl_provisioning");

  // Phase 1: verified → ssl_provisioning
  for (const domain of verifiedDomains) {
    const provision = await deps.provisioner.create(domain.domain);
    if (provision.ok) {
      await transitionState(deps, domain, "ssl_provisioning");
      results.push({
        domain: domain.domain,
        previousState: "verified",
        nextState: "ssl_provisioning",
        ok: true,
      });
    } else {
      await transitionState(deps, domain, "error", provision.error);
      await notifySslError(deps, domain, provision.error ?? "unknown error");
      results.push({
        domain: domain.domain,
        previousState: "verified",
        nextState: "error",
        ok: false,
        error: provision.error,
      });
    }
  }

  // Phase 2: ssl_provisioning → active | (stay ssl_provisioning)
  for (const domain of provisioningDomains) {
    const describe = await deps.provisioner.describe(domain.domain);
    if (describe.status === "active") {
      await transitionState(deps, domain, "active");
      results.push({
        domain: domain.domain,
        previousState: "ssl_provisioning",
        nextState: "active",
        ok: true,
      });
    } else if (describe.status === "error") {
      await transitionState(deps, domain, "error", describe.error);
      await notifySslError(deps, domain, describe.error ?? "unknown error");
      results.push({
        domain: domain.domain,
        previousState: "ssl_provisioning",
        nextState: "error",
        ok: false,
        error: describe.error,
      });
    }
    // "provisioning" → stay in ssl_provisioning, no result entry
  }

  return results;
}

// ── state machine ─────────────────────────────────────────────────────────────

async function transitionState(
  deps: SslProvisionerDeps,
  domain: DomainRecord,
  nextState: DomainState,
  error?: string,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  try {
    await deps.store.update(domain.id, {
      state: nextState,
      error: error ?? null,
      lastCheckedAt: now,
      ...(nextState === "active" ? { verifiedAt: now } : {}),
    });
  } catch (updateError) {
    const message = `failed to transition ${domain.domain} to ${nextState}: ${formatError(updateError)}`;
    await notifySslError(deps, domain, message);
    throw new Error(message);
  }
}

async function fetchDomainsByState(
  deps: SslProvisionerDeps,
  state: Extract<DomainState, "verified" | "ssl_provisioning">,
): Promise<DomainRecord[]> {
  try {
    return await deps.store.listByState(state);
  } catch (error) {
    const message = `failed to fetch ${state} custom domains: ${formatError(error)}`;
    await notifyProvisionerError(deps, "ssl_provisioner_db_error", message);
    throw new Error(message);
  }
}

async function notifySslError(
  deps: SslProvisionerDeps,
  domain: DomainRecord,
  errorMsg: string,
): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify({
      type: "ssl_provision_error",
      tenantId: domain.tenantId,
      payload: { domain: domain.domain, error: errorMsg },
    });
  } catch (err) {
    console.warn(
      "[ssl-provisioner] notify failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function notifyProvisionerError(
  deps: SslProvisionerDeps,
  type: string,
  errorMsg: string,
): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify({ type, tenantId: "system", payload: { error: errorMsg } });
  } catch (err) {
    console.warn(
      "[ssl-provisioner] notify failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
