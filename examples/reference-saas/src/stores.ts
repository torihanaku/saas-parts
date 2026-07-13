/**
 * デモ用のインメモリ実装。本番では、これらを saas-parts の想定どおり
 * Postgres/Supabase 実装に差し替える（テナント分離は sql-templates の RLS ＋
 * rls-jwt で DB 層に効かせる）。
 */
import type { TenantStore, TenantMemberRow, CreateTenantInput } from "@torihanaku/tenant-resolver";

/** email → tenant_id を引くだけの最小テナントストア（2テナントをシード）。 */
export class InMemoryTenantStore implements TenantStore {
  private readonly members = new Map<string, string>([
    ["alice@acme.com", "tenant-acme"],
    ["bob@globex.com", "tenant-globex"],
  ]);

  async findMemberByEmail(email: string): Promise<TenantMemberRow | null> {
    const tenant_id = this.members.get(email);
    return tenant_id ? { tenant_id } : null;
  }
  async findTenantByOwnerEmail(): Promise<string | null> {
    return null;
  }
  async findTenantBySlug(slug: string): Promise<string | null> {
    return slug === "admin" ? "tenant-admin" : null;
  }
  async findTenantByDomain(): Promise<string | null> {
    return null;
  }
  async createTenant(_input: CreateTenantInput): Promise<string | null> {
    return "tenant-admin";
  }
}

export interface Widget {
  id: string;
  tenant_id: string;
  name: string;
}

/**
 * テナントスコープの widget ストア。read/write/list すべてに tenant_id を通す。
 * ここを外すとクロステナント漏洩になる — アプリ層でも必ずスコープすること。
 */
export class WidgetStore {
  private readonly rows: Widget[] = [];
  private seq = 0;

  create(tenantId: string, name: string): Widget {
    const w: Widget = { id: `w${++this.seq}`, tenant_id: tenantId, name };
    this.rows.push(w);
    return w;
  }
  list(tenantId: string): Widget[] {
    return this.rows.filter((r) => r.tenant_id === tenantId);
  }
}
