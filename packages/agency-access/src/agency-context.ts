/**
 * Shared context helpers for agency-scoped routes.
 *
 * 移植元: dev-dashboard-v2 server/routes/agency-context.ts
 * (agency.ts から抽出 — 兄弟モジュールが循環依存なしに getAgencyContext を使うため)
 *
 * 依存の切り離し: supabaseGet → AgencyAccessStore、getTenantId → コールバック注入。
 */
import type { AgencyAccessStore, TeamMemberRow, TenantRow } from "./store";
import type { TeamMemberRole } from "./types";

export interface AgencyContext {
  role: TeamMemberRole;
  userTenantId: string | null;
  member: TeamMemberRow | null;
  agencyTenant: TenantRow | null;
}

export interface AgencyContextDeps<TReq = Request> {
  store: AgencyAccessStore;
  /** member 行に tenant_id が無いときのフォールバック解決 (元: getTenantId)。 */
  getTenantId: (req: TReq) => Promise<string | null>;
}

export function createGetAgencyContext<TReq = Request>(
  deps: AgencyContextDeps<TReq>,
): (req: TReq, email: string) => Promise<AgencyContext> {
  const { store, getTenantId } = deps;

  return async function getAgencyContext(req: TReq, email: string): Promise<AgencyContext> {
    const member = await store.findMemberByEmail(email);
    const role = (member?.role ?? "member") as TeamMemberRole;
    const userTenantId = member?.tenant_id ?? (await getTenantId(req));

    let agencyTenant: TenantRow | null = null;
    if (userTenantId) {
      agencyTenant = await store.findTenantById(userTenantId);
    }

    return { role, userTenantId, member, agencyTenant };
  };
}
