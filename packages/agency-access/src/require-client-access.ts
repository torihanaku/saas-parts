/**
 * requireClientAccess middleware — 複数クライアント委任のアクセス制御。
 *
 * 移植元: 実運用SaaS server/middleware/require-client-access.ts (#774 A-2)
 *
 * 3 層 role 評価 (A-1 Foundation で導入):
 *   - agency_admin: tenants.managed_clients に clientId 含む → pass
 *   - agency_member: team member の assigned_clients に clientId 含む → pass
 *   - client_viewer: member の tenant_id === clientId → pass
 *   - direct role (admin/editor/viewer/member): 自身の tenant_id === clientId → pass
 *   - それ以外 → 403 + audit log (risk_level: medium, action: access_denied)
 *
 * 使用例:
 *   const requireClientAccess = createRequireClientAccess({ store, getSessionEmail, getTenantId, logAudit });
 *   const forbidden = await requireClientAccess(req, targetClientId);
 *   if (forbidden) return forbidden;
 *
 * 依存の切り離し:
 *   - Supabase クエリ → AgencyAccessStore 注入
 *   - getSessionEmail / getTenantId (auth.ts) → コールバック注入
 *   - logAudit (audit.ts) → 任意コールバック注入 (未指定なら監査記録なし)
 */
import type { AgencyAccessStore, TeamMemberRow } from "./store";
import type { AuditRiskLevel, TeamMemberRole } from "./types";
import { isAgencyRole } from "./types";

/** 拒否時に監査コールバックへ渡すイベント (元: server/lib/audit.ts の AuditEvent 部分集合)。 */
export interface AccessDeniedAuditEvent {
  action: "access_denied";
  resourceType: "tenant";
  resourceId: string;
  riskLevel: AuditRiskLevel;
  changes: Record<string, unknown>;
}

export interface RequireClientAccessDeps<TReq = Request> {
  store: AgencyAccessStore;
  /** リクエストからセッション email を取り出す (元: getSessionEmail)。 */
  getSessionEmail: (req: TReq) => Promise<string | null>;
  /** member 行に tenant_id が無いときのフォールバック解決 (元: getTenantId)。 */
  getTenantId: (req: TReq) => Promise<string | null>;
  /** 403 時の監査記録 (元: logAudit)。省略可。 */
  logAudit?: (req: TReq, event: AccessDeniedAuditEvent) => Promise<void> | void;
}

export type RequireClientAccess<TReq = Request> = (
  req: TReq,
  clientId: string,
) => Promise<Response | null>;

/**
 * Return null if user has access to clientId, or 401/403 Response otherwise.
 * 403 時は logAudit (注入されていれば) に記録する。
 */
export function createRequireClientAccess<TReq = Request>(
  deps: RequireClientAccessDeps<TReq>,
): RequireClientAccess<TReq> {
  const { store, getSessionEmail, getTenantId, logAudit } = deps;

  async function checkAgencyAccess(
    role: TeamMemberRole,
    userTenantId: string | null,
    member: TeamMemberRow | null,
    clientId: string,
  ): Promise<boolean> {
    if (!userTenantId) return false;

    if (role === "agency_admin") {
      // agency tenant の managed_clients に含まれていれば pass
      const tenant = await store.findTenantById(userTenantId);
      if (!tenant || tenant.type !== "agency") return false;
      return (tenant.managed_clients ?? []).includes(clientId);
    }

    if (role === "agency_member") {
      // member 自身の tenant が実際に agency であることを必須にする
      // (agency_admin と同じ健全性チェック)。これが無いと、direct tenant に
      // 残った・誤設定された agency_member role の行が assigned_clients 経由で
      // 他テナントへアクセスできてしまう (tenant isolation gap)。
      const tenant = await store.findTenantById(userTenantId);
      if (!tenant || tenant.type !== "agency") return false;
      // assigned_clients に含まれていれば pass
      const assigned = member?.assigned_clients ?? [];
      return assigned.includes(clientId);
    }

    // client_viewer は tenant_id === clientId で既に pass しているはず
    return false;
  }

  return async function requireClientAccess(req: TReq, clientId: string): Promise<Response | null> {
    const email = await getSessionEmail(req);
    if (!email) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 1) user の role + tenant_id + assigned_clients を取得
    const member = await store.findMemberByEmail(email);
    const role = (member?.role ?? "member") as TeamMemberRole;
    const userTenantId = member?.tenant_id ?? (await getTenantId(req));

    // 2) 自身の tenant === client なら常に pass (direct role, client_viewer 両方)
    if (userTenantId && userTenantId === clientId) {
      return null;
    }

    // 3) agency role 評価
    if (isAgencyRole(role)) {
      const allowed = await checkAgencyAccess(role, userTenantId, member, clientId);
      if (allowed) return null;
    }

    // 4) 403 + audit
    await logAudit?.(req, {
      action: "access_denied",
      resourceType: "tenant",
      resourceId: clientId,
      riskLevel: "medium",
      changes: { role, userTenantId, attemptedClientId: clientId },
    });

    return Response.json(
      {
        error: "Forbidden: no access to this client",
        clientId,
      },
      { status: 403 },
    );
  };
}
