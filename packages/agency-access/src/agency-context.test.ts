/**
 * getAgencyContext tests (role / tenant コンテキスト解決)。
 * 元実装 (server/routes/agency-context.ts) の振る舞いを注入ストアで検証。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createGetAgencyContext } from "./agency-context";
import type { TeamMemberRow, TenantRow } from "./store";
import { isAgencyRole, isDirectRole } from "./types";

const mockFindMemberByEmail = vi.fn<() => Promise<TeamMemberRow | null>>();
const mockFindTenantById = vi.fn<() => Promise<TenantRow | null>>();
const mockGetTenantId = vi.fn<() => Promise<string | null>>();

const getAgencyContext = createGetAgencyContext<Request>({
  store: {
    findMemberByEmail: mockFindMemberByEmail,
    findTenantById: mockFindTenantById,
  },
  getTenantId: mockGetTenantId,
});

const req = new Request("https://example.com/api/agency/overview");
const AGENCY_TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTenantId.mockResolvedValue(null);
  mockFindTenantById.mockResolvedValue(null);
});

describe("getAgencyContext", () => {
  it("resolves role / tenant / agencyTenant from the member row", async () => {
    const memberRow: TeamMemberRow = {
      email: "boss@agency.test",
      role: "agency_admin",
      tenant_id: AGENCY_TENANT,
      assigned_clients: [],
    };
    const tenantRow: TenantRow = {
      id: AGENCY_TENANT,
      name: "Agency Inc",
      type: "agency",
      managed_clients: ["c-1", "c-2"],
    };
    mockFindMemberByEmail.mockResolvedValue(memberRow);
    mockFindTenantById.mockResolvedValue(tenantRow);

    const ctx = await getAgencyContext(req, "boss@agency.test");
    expect(ctx).toEqual({
      role: "agency_admin",
      userTenantId: AGENCY_TENANT,
      member: memberRow,
      agencyTenant: tenantRow,
    });
    expect(mockGetTenantId).not.toHaveBeenCalled();
  });

  it("defaults role to 'member' and falls back to getTenantId when no member row", async () => {
    mockFindMemberByEmail.mockResolvedValue(null);
    mockGetTenantId.mockResolvedValue("fallback-tenant");
    mockFindTenantById.mockResolvedValue({
      id: "fallback-tenant",
      name: "Direct Co",
      type: "direct",
      managed_clients: [],
    });

    const ctx = await getAgencyContext(req, "unknown@example.com");
    expect(ctx.role).toBe("member");
    expect(ctx.userTenantId).toBe("fallback-tenant");
    expect(ctx.member).toBeNull();
    expect(ctx.agencyTenant?.type).toBe("direct");
  });

  it("returns null agencyTenant when tenant cannot be resolved", async () => {
    mockFindMemberByEmail.mockResolvedValue(null);
    mockGetTenantId.mockResolvedValue(null);

    const ctx = await getAgencyContext(req, "nobody@example.com");
    expect(ctx.userTenantId).toBeNull();
    expect(ctx.agencyTenant).toBeNull();
    expect(mockFindTenantById).not.toHaveBeenCalled();
  });
});

describe("role guards", () => {
  it("isAgencyRole accepts the 3-layer agency roles only", () => {
    expect(isAgencyRole("agency_admin")).toBe(true);
    expect(isAgencyRole("agency_member")).toBe(true);
    expect(isAgencyRole("client_viewer")).toBe(true);
    expect(isAgencyRole("admin")).toBe(false);
  });

  it("isDirectRole accepts the direct roles only", () => {
    expect(isDirectRole("admin")).toBe(true);
    expect(isDirectRole("editor")).toBe(true);
    expect(isDirectRole("viewer")).toBe(true);
    expect(isDirectRole("member")).toBe(true);
    expect(isDirectRole("agency_admin")).toBe(false);
  });
});
