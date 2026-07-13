/**
 * Unit tests for team member status derivation logic (fix for #739).
 * 移植元: 実運用SaaS tests/team-member-status.test.ts
 *
 * When a member logs in via SAML/OAuth (not through the invite-accept flow),
 * their team-member status stays "invited" even though they are clearly active.
 * The healer detects this by comparing last_active to joined_at and corrects
 * the status to "active".
 */
import { describe, it, expect } from "vitest";

import { healMemberStatuses } from "./member-status";

describe("team member status healing (#739)", () => {
  it("corrects 'invited' to 'active' when last_active differs from joined_at", () => {
    const members = [
      {
        id: "abc-123",
        email: "member@example.com",
        status: "invited",
        joined_at: "2026-04-12T00:00:00Z",
        last_active: "2026-04-16T04:15:00Z",
      },
    ];
    const { healed, staleIds } = healMemberStatuses(members);
    expect(healed[0]!.status).toBe("active");
    expect(staleIds).toEqual(["abc-123"]);
  });

  it("does NOT change status when last_active equals joined_at (freshly invited)", () => {
    const ts = "2026-04-16T00:00:00Z";
    const members = [
      {
        id: "def-456",
        email: "new@example.com",
        status: "invited",
        joined_at: ts,
        last_active: ts,
      },
    ];
    const { healed, staleIds } = healMemberStatuses(members);
    expect(healed[0]!.status).toBe("invited");
    expect(staleIds).toEqual([]);
  });

  it("does NOT change already-active members", () => {
    const members = [
      {
        id: "ghi-789",
        email: "active@example.com",
        status: "active",
        joined_at: "2026-01-01T00:00:00Z",
        last_active: "2026-04-16T00:00:00Z",
      },
    ];
    const { healed, staleIds } = healMemberStatuses(members);
    expect(healed[0]!.status).toBe("active");
    expect(staleIds).toEqual([]);
  });

  it("does NOT change inactive members", () => {
    const members = [
      {
        id: "jkl-012",
        email: "inactive@example.com",
        status: "inactive",
        joined_at: "2025-01-01T00:00:00Z",
        last_active: "2025-06-01T00:00:00Z",
      },
    ];
    const { healed, staleIds } = healMemberStatuses(members);
    expect(healed[0]!.status).toBe("inactive");
    expect(staleIds).toEqual([]);
  });

  it("handles mixed list with multiple stale members", () => {
    const members = [
      { id: "1", status: "active", joined_at: "2026-01-01T00:00:00Z", last_active: "2026-04-16T00:00:00Z" },
      { id: "2", status: "invited", joined_at: "2026-04-10T00:00:00Z", last_active: "2026-04-15T00:00:00Z" },
      { id: "3", status: "invited", joined_at: "2026-04-12T00:00:00Z", last_active: "2026-04-12T00:00:00Z" },
      { id: "4", status: "invited", joined_at: "2026-04-11T00:00:00Z", last_active: "2026-04-16T00:00:00Z" },
    ];
    const { healed, staleIds } = healMemberStatuses(members);
    expect(healed[0]!.status).toBe("active"); // already active
    expect(healed[1]!.status).toBe("active"); // healed
    expect(healed[2]!.status).toBe("invited"); // still genuinely invited
    expect(healed[3]!.status).toBe("active"); // healed
    expect(staleIds).toEqual(["2", "4"]);
  });

  it("handles members with missing last_active or joined_at gracefully", () => {
    const members = [
      { id: "5", status: "invited", joined_at: "2026-04-12T00:00:00Z", last_active: null },
      { id: "6", status: "invited", joined_at: null, last_active: "2026-04-16T00:00:00Z" },
    ];
    const { healed, staleIds } = healMemberStatuses(members);
    expect(healed[0]!.status).toBe("invited");
    expect(healed[1]!.status).toBe("invited");
    expect(staleIds).toEqual([]);
  });
});
