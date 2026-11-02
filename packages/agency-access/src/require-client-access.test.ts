/**
 * requireClientAccess middleware tests.
 * 移植元: 実運用SaaS tests/agency-middleware.test.ts (#774 A-2)
 * — vi.mock によるモジュールモックを依存注入 (store / callbacks) に置換。
 *
 * 3 層 role × 境界ケースを網羅:
 *   - direct role: own tenant pass / other tenant 403
 *   - agency_admin: managed_clients に含まれる → pass / 含まれない → 403 / non-agency tenant → 403
 *   - agency_member: assigned_clients に含まれる → pass / 含まれない → 403
 *   - client_viewer: own tenant === clientId で pass
 *   - unauthorized (no session) → 401
 *
 * 403 時に logAudit が呼ばれることも検証。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createRequireClientAccess } from "./require-client-access";
import type { TeamMemberRow, TenantRow } from "./store";
// AC-43: 修正後の実物の resolver を注入する（workspace 依存は無いので相対パスで読む・design.md §④）
import { createTenantResolver, type TenantStore } from "../../tenant-resolver/src/index";

const mockSessionEmail = vi.fn<() => Promise<string | null>>();
const mockGetTenantId = vi.fn<() => Promise<string | null>>();
const mockFindMemberByEmail = vi.fn<() => Promise<TeamMemberRow | null>>();
const mockFindTenantById = vi.fn<() => Promise<TenantRow | null>>();
const mockLogAudit = vi.fn();

const requireClientAccess = createRequireClientAccess<Request>({
  store: {
    findMemberByEmail: mockFindMemberByEmail,
    findTenantById: mockFindTenantById,
  },
  getSessionEmail: mockSessionEmail,
  getTenantId: mockGetTenantId,
  logAudit: mockLogAudit,
});

function makeReq(): Request {
  return new Request("https://example.com/api/clients/xyz", {
    headers: { "x-forwarded-for": "1.2.3.4" },
  });
}

function member(row: Partial<TeamMemberRow>): TeamMemberRow {
  return { email: "someone@example.com", role: "member", tenant_id: null, assigned_clients: [], ...row };
}

const CLIENT_A = "11111111-1111-1111-1111-111111111111";
const CLIENT_B = "22222222-2222-2222-2222-222222222222";
const AGENCY_TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  mockLogAudit.mockResolvedValue(undefined);
  mockGetTenantId.mockResolvedValue(null);
  mockFindMemberByEmail.mockResolvedValue(null);
  mockFindTenantById.mockResolvedValue(null);
});

describe("requireClientAccess — unauthenticated", () => {
  it("returns 401 when no session email", async () => {
    mockSessionEmail.mockResolvedValue(null);
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});

describe("requireClientAccess — direct role", () => {
  it("passes when user.tenant_id === clientId", async () => {
    mockSessionEmail.mockResolvedValue("alice@direct.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "admin", tenant_id: CLIENT_A }));
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).toBeNull();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("403 when user.tenant_id !== clientId", async () => {
    mockSessionEmail.mockResolvedValue("alice@direct.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "admin", tenant_id: CLIENT_A }));
    const res = await requireClientAccess(makeReq(), CLIENT_B);
    expect(res!.status).toBe(403);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ action: "access_denied", riskLevel: "medium" }),
    );
  });
});

describe("requireClientAccess — agency_admin", () => {
  it("passes when managed_clients includes clientId", async () => {
    mockSessionEmail.mockResolvedValue("boss@agency.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "agency_admin", tenant_id: AGENCY_TENANT }));
    mockFindTenantById.mockResolvedValue({
      id: AGENCY_TENANT,
      name: "Agency",
      type: "agency",
      managed_clients: [CLIENT_A, CLIENT_B],
    });
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).toBeNull();
    expect(mockFindTenantById).toHaveBeenCalledWith(AGENCY_TENANT);
  });

  it("403 when clientId not in managed_clients", async () => {
    mockSessionEmail.mockResolvedValue("boss@agency.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "agency_admin", tenant_id: AGENCY_TENANT }));
    mockFindTenantById.mockResolvedValue({
      id: AGENCY_TENANT,
      name: "Agency",
      type: "agency",
      managed_clients: [CLIENT_A],
    });
    const res = await requireClientAccess(makeReq(), CLIENT_B);
    expect(res!.status).toBe(403);
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("403 when agency_admin's tenant is not actually type=agency", async () => {
    mockSessionEmail.mockResolvedValue("boss@mislabeled.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "agency_admin", tenant_id: AGENCY_TENANT }));
    mockFindTenantById.mockResolvedValue({
      id: AGENCY_TENANT,
      name: "Mislabeled",
      type: "direct",
      managed_clients: [CLIENT_A],
    });
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res!.status).toBe(403);
  });
});

describe("requireClientAccess — agency_member", () => {
  it("passes when assigned_clients includes clientId", async () => {
    mockSessionEmail.mockResolvedValue("manager@agency.test");
    mockFindMemberByEmail.mockResolvedValue(
      member({ role: "agency_member", tenant_id: AGENCY_TENANT, assigned_clients: [CLIENT_A] }),
    );
    mockFindTenantById.mockResolvedValue({
      id: AGENCY_TENANT,
      name: "Agency",
      type: "agency",
      managed_clients: null,
    });
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).toBeNull();
  });

  // Regression: an agency_member whose OWN tenant is NOT type=agency must be
  // denied even if assigned_clients lists the target — mirrors the agency_admin
  // guard. Without the tenant.type check this granted cross-tenant access.
  it("403 when member role is agency_member but own tenant is not an agency", async () => {
    const NOT_AGENCY = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    mockSessionEmail.mockResolvedValue("mislabeled@direct.test");
    mockFindMemberByEmail.mockResolvedValue(
      member({ role: "agency_member", tenant_id: NOT_AGENCY, assigned_clients: [CLIENT_B] }),
    );
    mockFindTenantById.mockResolvedValue({
      id: NOT_AGENCY,
      name: "Direct Co",
      type: "direct",
      managed_clients: null,
    });
    const res = await requireClientAccess(makeReq(), CLIENT_B);
    expect(res!.status).toBe(403);
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("403 when clientId not in assigned_clients", async () => {
    mockSessionEmail.mockResolvedValue("manager@agency.test");
    mockFindMemberByEmail.mockResolvedValue(
      member({ role: "agency_member", tenant_id: AGENCY_TENANT, assigned_clients: [CLIENT_A] }),
    );
    const res = await requireClientAccess(makeReq(), CLIENT_B);
    expect(res!.status).toBe(403);
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it("403 when assigned_clients is empty", async () => {
    mockSessionEmail.mockResolvedValue("manager@agency.test");
    mockFindMemberByEmail.mockResolvedValue(
      member({ role: "agency_member", tenant_id: AGENCY_TENANT, assigned_clients: [] }),
    );
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res!.status).toBe(403);
  });
});

describe("requireClientAccess — client_viewer", () => {
  it("passes when own tenant === clientId", async () => {
    mockSessionEmail.mockResolvedValue("viewer@client.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "client_viewer", tenant_id: CLIENT_A }));
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).toBeNull();
  });

  it("403 when tenant !== clientId", async () => {
    mockSessionEmail.mockResolvedValue("viewer@client.test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "client_viewer", tenant_id: CLIENT_A }));
    const res = await requireClientAccess(makeReq(), CLIENT_B);
    expect(res!.status).toBe(403);
  });
});

describe("requireClientAccess — audit log integration", () => {
  it("403 path records audit with risk_level=medium + attempted clientId", async () => {
    mockSessionEmail.mockResolvedValue("intruder@test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "member", tenant_id: CLIENT_A }));
    await requireClientAccess(makeReq(), CLIENT_B);

    expect(mockLogAudit).toHaveBeenCalledOnce();
    const [, evt] = mockLogAudit.mock.calls[0]!;
    expect(evt).toMatchObject({
      action: "access_denied",
      resourceType: "tenant",
      resourceId: CLIENT_B,
      riskLevel: "medium",
    });
  });

  it("pass path does NOT record audit", async () => {
    mockSessionEmail.mockResolvedValue("alice@test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "admin", tenant_id: CLIENT_A }));
    await requireClientAccess(makeReq(), CLIENT_A);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("403 still returned when logAudit is not injected", async () => {
    const withoutAudit = createRequireClientAccess<Request>({
      store: {
        findMemberByEmail: mockFindMemberByEmail,
        findTenantById: mockFindTenantById,
      },
      getSessionEmail: mockSessionEmail,
      getTenantId: mockGetTenantId,
    });
    mockSessionEmail.mockResolvedValue("intruder@test");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "member", tenant_id: CLIENT_A }));
    const res = await withoutAudit(makeReq(), CLIENT_B);
    expect(res!.status).toBe(403);
  });
});

describe("requireClientAccess — tenant fallback via getTenantId", () => {
  it("uses getTenantId when member row has no tenant_id", async () => {
    mockSessionEmail.mockResolvedValue("unmapped@example.com");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "member", tenant_id: null }));
    mockGetTenantId.mockResolvedValue(CLIENT_A);
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).toBeNull();
    expect(mockGetTenantId).toHaveBeenCalled();
  });
});

describe("requireClientAccess — member 行の無い利用者 (SA-0003, G10)", () => {
  it("AC-41: 未登録の email (member=null) は getTenantId が clientId を返しても 403", async () => {
    mockSessionEmail.mockResolvedValue("unregistered@evil.example");
    mockFindMemberByEmail.mockResolvedValue(null);
    mockGetTenantId.mockResolvedValue(CLIENT_A);
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(mockGetTenantId).not.toHaveBeenCalled();
  });

  it("AC-42: 未登録の email の 403 で logAudit が access_denied・resourceId=clientId で 1 回呼ばれる", async () => {
    mockSessionEmail.mockResolvedValue("unregistered@evil.example");
    mockFindMemberByEmail.mockResolvedValue(null);
    mockGetTenantId.mockResolvedValue(CLIENT_A);
    await requireClientAccess(makeReq(), CLIENT_A);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const [, evt] = mockLogAudit.mock.calls[0]!;
    expect(evt).toMatchObject({ action: "access_denied", resourceId: CLIENT_A });
  });

  // 監査 V2 #9 の再現テストを反転: 実物の resolver を挟んでも未登録者は tenant-admin に入れない
  function adminTenantStore(over: Partial<TenantStore> = {}): TenantStore {
    return {
      findMemberByEmail: async (e: string) => (e === "alice@acme.com" ? { tenant_id: "tenant-acme" } : null),
      findTenantByOwnerEmail: async () => null,
      findTenantBySlug: async (s: string) => (s === "admin" ? "tenant-admin" : null),
      findTenantByDomain: async () => null,
      createTenant: async () => "tenant-admin",
      ...over,
    };
  }

  it("AC-41: 監査再現 V2#9 の反転 — member 行の無い stranger は実物の resolver 経由でも tenant-admin に 403", async () => {
    const resolver = createTenantResolver<string>({
      store: adminTenantStore(),
      getSessionEmail: (e) => e,
      logWarn: () => {},
    });
    const rca = createRequireClientAccess<string>({
      store: { findMemberByEmail: async () => null, findTenantById: async () => null },
      getSessionEmail: async (e) => e,
      getTenantId: (e) => resolver.getTenantId(e),
    });
    const res = await rca("stranger@evil.example", "tenant-admin");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect((await rca("stranger@evil.example", "tenant-acme"))?.status).toBe(403);
  });

  it("AC-43: member 行はあるが tenant_id NULL の stranger は、修正後の実物の resolver を注入しても tenant-admin に 403", async () => {
    const resolver = createTenantResolver<string>({
      store: adminTenantStore({
        findMemberByEmail: async (e: string) =>
          e === "stranger@evil.example" ? { tenant_id: null } : e === "alice@acme.com" ? { tenant_id: "tenant-acme" } : null,
      }),
      getSessionEmail: (e) => e,
      logWarn: () => {},
    });
    const rca = createRequireClientAccess<string>({
      store: {
        findMemberByEmail: async (e: string) =>
          e === "stranger@evil.example" ? member({ email: e, role: "member", tenant_id: null }) : null,
        findTenantById: async () => null,
      },
      getSessionEmail: async (e) => e,
      getTenantId: (e) => resolver.getTenantId(e),
    });
    const res = await rca("stranger@evil.example", "tenant-admin");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("AC-44: member の tenant_id が null で getTenantId=CLIENT_A なら通す (null)", async () => {
    mockSessionEmail.mockResolvedValue("unlinked@example.com");
    mockFindMemberByEmail.mockResolvedValue(member({ role: "member", tenant_id: null }));
    mockGetTenantId.mockResolvedValue(CLIENT_A);
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).toBeNull();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("AC-45: getSessionEmail が null なら 401", async () => {
    mockSessionEmail.mockResolvedValue(null);
    const res = await requireClientAccess(makeReq(), CLIENT_A);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(mockFindMemberByEmail).not.toHaveBeenCalled();
  });
});
