/**
 * Audit logging — immutable operation logs for all data mutations.
 * Hash chain enforced to detect tampering (ISMAP/SOC2 CC7.2).
 *
 * Ported from 実運用SaaS `server/lib/audit.ts`.
 * The canonical JSON serialization is preserved byte-for-byte so that
 * chains written by the original implementation remain verifiable.
 */
import { createHash } from "node:crypto";
import type { AuditStore, AuditRow } from "./store";
import { canonicalPayload } from "./canonical";

/**
 * Action strings used by the source application, kept as the documented
 * default. Pass your own string union via the generic parameter of
 * `createAuditLogger<TAction>` to extend/replace it.
 */
export type DefaultAuditAction =
  | "create"
  | "update"
  | "delete"
  | "login"
  | "logout"
  | "invite"
  | "access_denied"
  | "client_switch"
  | "assigned_clients_changed"
  | "agent_plan_approved"
  | "agent_action_approved"
  | "agent_plan_rejected"
  | "agent_action_rejected"
  | "agent_auto_halt"
  | "agent_action_rolled_back"
  | "tenant_secret_updated"
  | "tenant_secret_deleted";

/** Risk level: medium+ surfaces in dashboards, high/critical require 2FA-like confirmation (source semantics). */
export type AuditRiskLevel = "low" | "medium" | "high" | "critical";

export interface AuditEvent<TAction extends string = DefaultAuditAction> {
  action: TAction;
  resourceType: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
  actorType?: string;
  /** base64 */
  approvalHash?: string;
  /** base64 */
  execHash?: string;
  /** Default: "low" */
  riskLevel?: AuditRiskLevel;
}

export interface AuditActor {
  email: string;
  role: string;
}

/**
 * Request-context provider — replaces the source's direct imports of
 * `getCurrentUserRole` / `getTenantId` from the auth module.
 */
export interface AuditContext {
  getCurrentUserRole(req: Request): Promise<AuditActor>;
  getTenantId(req: Request): Promise<string | null>;
}

const EMPTY = Buffer.alloc(0);

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export interface AuditLoggerOptions {
  store: AuditStore;
  context: AuditContext;
  /** Fallback tenant when the context yields none. Source default: all-zero UUID. */
  defaultTenantId?: string;
}

export interface AuditLogger<TAction extends string = DefaultAuditAction> {
  /** Log an audit event tied to an incoming Request. MUST BE AWAITED. */
  logAudit(req: Request, event: AuditEvent<TAction>): Promise<void>;
  /** Log a system-actor audit event (no Request available). */
  logAuditSystem(
    tenantId: string,
    event: AuditEvent<TAction> & { user_email?: string; ip_address?: string },
  ): Promise<void>;
}

export function createAuditLogger<TAction extends string = DefaultAuditAction>(
  options: AuditLoggerOptions,
): AuditLogger<TAction> {
  const { store, context } = options;
  const defaultTenantId = options.defaultTenantId ?? "00000000-0000-0000-0000-000000000000";

  async function getLastEntryHash(tenantId: string): Promise<Buffer | null> {
    const last = await store.getLastEntry(tenantId);
    if (last && typeof last.entry_hash === "string" && last.entry_hash) {
      return Buffer.from(last.entry_hash, "base64");
    }
    return null;
  }

  async function persist(entry: Record<string, unknown>, tenantId: string): Promise<void> {
    const prevHash = await getLastEntryHash(tenantId);
    const payload = canonicalPayload(entry);
    const entryHash = sha256(Buffer.concat([prevHash ?? EMPTY, payload]));

    const res = await store.insert({
      ...entry,
      prev_hash: prevHash ? prevHash.toString("base64") : null,
      entry_hash: entryHash.toString("base64"),
    } as AuditRow);

    if (!res.ok) {
      throw new Error(`Audit log insertion failed: ${res.error}`);
    }
  }

  async function logAudit(req: Request, event: AuditEvent<TAction>): Promise<void> {
    const { email, role } = await context.getCurrentUserRole(req);
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const tenantId = (await context.getTenantId(req)) || defaultTenantId;

    const entry = {
      tenant_id: tenantId,
      user_email: email,
      user_role: role,
      action: event.action,
      resource_type: event.resourceType,
      resource_id: event.resourceId || null,
      changes: event.changes || null,
      ip_address: ip,
      actor_type: event.actorType || "human",
      approval_hash: event.approvalHash ? Buffer.from(event.approvalHash, "base64") : null,
      exec_hash: event.execHash ? Buffer.from(event.execHash, "base64") : null,
      risk_level: event.riskLevel || "low",
      archived_to_gcs: false,
      occurred_at: new Date().toISOString(),
    };

    await persist(entry, tenantId);
  }

  async function logAuditSystem(
    tenantId: string,
    event: AuditEvent<TAction> & { user_email?: string; ip_address?: string },
  ): Promise<void> {
    const entry = {
      tenant_id: tenantId,
      user_email: event.user_email || "system@local",
      user_role: "system",
      action: event.action,
      resource_type: event.resourceType,
      resource_id: event.resourceId || null,
      changes: event.changes || null,
      ip_address: event.ip_address || "127.0.0.1",
      actor_type: event.actorType || "system",
      approval_hash: event.approvalHash ? Buffer.from(event.approvalHash, "base64") : null,
      exec_hash: event.execHash ? Buffer.from(event.execHash, "base64") : null,
      risk_level: event.riskLevel || "low",
      archived_to_gcs: false,
      occurred_at: new Date().toISOString(),
    };

    await persist(entry, tenantId);
  }

  return { logAudit, logAuditSystem };
}
