/**
 * agency-access 共通ストア抽象。
 *
 * 元実装 (実運用SaaS) の Supabase REST クエリを 1:1 でメソッドに写像:
 *   - findMemberByEmail … dashboard_team_members?email=eq.{email}
 *                         &select=email,role,tenant_id,assigned_clients&limit=1
 *   - findTenantById    … tenants?id=eq.{id}&select=id,name,type,managed_clients&limit=1
 */

/** dashboard_team_members 相当の行。 */
export interface TeamMemberRow {
  email: string;
  role: string;
  tenant_id: string | null;
  assigned_clients: string[] | null;
}

/** tenants 相当の行。 */
export interface TenantRow {
  id: string;
  name: string;
  type: string;
  managed_clients: string[] | null;
}

export interface AgencyAccessStore {
  findMemberByEmail(email: string): Promise<TeamMemberRow | null>;
  findTenantById(tenantId: string): Promise<TenantRow | null>;
}
