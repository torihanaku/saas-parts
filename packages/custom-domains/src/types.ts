/**
 * Shared types for the BYOD (bring-your-own-domain) custom-domain lifecycle.
 *
 * State machine:
 *   pending → verified          (CNAME resolves to the expected target)
 *   pending → failed            (CNAME misconfigured / NXDOMAIN)
 *   verified → ssl_provisioning (certificate provisioning kicked off)
 *   ssl_provisioning → active   (certificate ready, domain serving)
 *   ssl_provisioning → error    (provider error or timeout)
 */

export type DomainState =
  | "pending"
  | "verified"
  | "failed"
  | "ssl_provisioning"
  | "active"
  | "error";

/** A customer custom-domain record, storage-agnostic. */
export interface DomainRecord {
  id: string;
  /** Owning tenant / customer id. */
  tenantId: string;
  /** The customer-owned domain, e.g. "app.customer.example". */
  domain: string;
  state: DomainState;
  /** Per-record CNAME target override (falls back to the cron-level target). */
  cnameTarget?: string | null;
  error?: string | null;
  lastCheckedAt?: string | null;
  verifiedAt?: string | null;
}

/** Patch applied by the lifecycle crons. */
export interface DomainUpdatePatch {
  state?: DomainState;
  error?: string | null;
  lastCheckedAt?: string;
  verifiedAt?: string;
}

/**
 * Storage boundary — implement against your DB (Supabase / Firestore / SQL…).
 * Both crons only need these two operations.
 *
 * `listByState` may throw; the SSL provisioner treats that as fail-closed
 * (notifies and rethrows without touching any domain).
 */
export interface DomainStore {
  listByState(state: DomainState): Promise<DomainRecord[]>;
  update(id: string, patch: DomainUpdatePatch): Promise<void>;
}

/**
 * Best-effort operational notifier (Slack / PagerDuty / log sink).
 * Failures inside the notifier are swallowed with a console.warn.
 */
export type DomainEventNotifier = (event: {
  type: string;
  tenantId: string;
  payload: Record<string, unknown>;
}) => Promise<void> | void;

/**
 * Cloud-provider boundary for SSL/domain-mapping provisioning.
 * The bundled default is the GCP Cloud Run `gcloud run domain-mappings`
 * implementation (see `createGcloudProvisioner`).
 */
export interface DomainMappingProvisioner {
  /** Kick off certificate provisioning for a domain. Must be idempotent. */
  create(domain: string): Promise<{ ok: boolean; error?: string }>;
  /** Check certificate status for a domain. */
  describe(
    domain: string,
  ): Promise<{ status: "active" | "provisioning" | "error"; error?: string }>;
}
