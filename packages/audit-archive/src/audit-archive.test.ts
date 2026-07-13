/**
 * Ported from 実運用SaaS tests/agency-audit-archive.test.ts.
 * GCS / Supabase mocks are replaced by injected structural fakes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  archiveAuditEvents,
  type ArchivableAuditEvent,
  type AuditEventSource,
  type ObjectStorage,
} from "./index";

function makeSource(events: ArchivableAuditEvent[]) {
  const fetchUnarchived = vi.fn().mockResolvedValue(events);
  const markArchived = vi.fn().mockResolvedValue(undefined);
  const source: AuditEventSource = { fetchUnarchived, markArchived };
  return { source, fetchUnarchived, markArchived };
}

function makeStorage() {
  const put = vi.fn().mockResolvedValue(undefined);
  const storage: ObjectStorage = { put };
  return { storage, put };
}

function isoYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
}

describe("Audit Archive Job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips if storage is not configured", async () => {
    const { source, fetchUnarchived } = makeSource([]);
    const result = await archiveAuditEvents({ source, storage: null });
    expect(result.skipped).toBe(true);
    expect(fetchUnarchived).not.toHaveBeenCalled();
  });

  it("archives old events and updates the source store", async () => {
    const { source, markArchived } = makeSource([
      { id: "ev1", tenant_id: "t1", occurred_at: isoYearsAgo(2) },
    ]);
    const { storage, put } = makeStorage();

    const result = await archiveAuditEvents({ source, storage });

    expect(put).toHaveBeenCalledOnce();
    expect(markArchived).toHaveBeenCalledWith("ev1", expect.stringContaining("t1/"));
    expect(result).toEqual({ skipped: false, archivedCount: 1, groupCount: 1 });
  });

  it("handles no events to archive gracefully", async () => {
    const { source } = makeSource([]);
    const { storage, put } = makeStorage();
    const result = await archiveAuditEvents({ source, storage });
    expect(put).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, archivedCount: 0, groupCount: 0 });
  });

  it("queries with a cutoff of retentionYears ago and the batch limit", async () => {
    const { source, fetchUnarchived } = makeSource([]);
    const { storage } = makeStorage();
    const fixedNow = new Date("2026-07-11T00:00:00.000Z");

    await archiveAuditEvents({
      source,
      storage,
      retentionYears: 1,
      batchLimit: 500,
      now: () => new Date(fixedNow),
    });

    expect(fetchUnarchived).toHaveBeenCalledWith("2025-07-11T00:00:00.000Z", 500);
  });

  it("groups events by tenant/year/month and writes JSONL per group", async () => {
    const { source, markArchived } = makeSource([
      { id: "a1", tenant_id: "t1", occurred_at: "2024-03-05T10:00:00.000Z", action: "login" },
      { id: "a2", tenant_id: "t1", occurred_at: "2024-03-20T10:00:00.000Z", action: "export" },
      { id: "b1", tenant_id: "t1", occurred_at: "2024-04-01T10:00:00.000Z" },
      { id: "c1", tenant_id: "t2", occurred_at: "2024-03-05T10:00:00.000Z" },
    ]);
    const { storage, put } = makeStorage();
    const fixedNow = new Date("2026-07-11T12:34:56.789Z");

    const result = await archiveAuditEvents({
      source,
      storage,
      now: () => new Date(fixedNow),
    });

    expect(result.groupCount).toBe(3);
    expect(result.archivedCount).toBe(4);

    const paths = put.mock.calls.map((c) => c[0] as string).sort();
    expect(paths).toEqual([
      "t1/2024/03/events_2026-07-11T12-34-56-789Z.jsonl",
      "t1/2024/04/events_2026-07-11T12-34-56-789Z.jsonl",
      "t2/2024/03/events_2026-07-11T12-34-56-789Z.jsonl",
    ]);

    // JSONL: one JSON object per line, trailing newline
    const t1MarchCall = put.mock.calls.find((c) => (c[0] as string).startsWith("t1/2024/03/"));
    const jsonl = t1MarchCall?.[1] as string;
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: "a1", action: "login" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: "a2", action: "export" });

    // Every event is marked with the path of its own group file
    expect(markArchived).toHaveBeenCalledTimes(4);
    expect(markArchived).toHaveBeenCalledWith(
      "c1",
      "t2/2024/03/events_2026-07-11T12-34-56-789Z.jsonl"
    );
  });

  it("groups by UTC month, not the host timezone (path determinism)", async () => {
    // 2023-12-31T23:00Z is still December in UTC, but January in JST.
    // The archive path must not depend on the server timezone.
    const prevTz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      const { source } = makeSource([
        { id: "boundary", tenant_id: "t1", occurred_at: "2023-12-31T23:00:00.000Z" },
      ]);
      const { storage, put } = makeStorage();
      await archiveAuditEvents({
        source,
        storage,
        retentionYears: 1,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });
      const path = put.mock.calls[0]![0] as string;
      expect(path.startsWith("t1/2023/12/")).toBe(true);
    } finally {
      process.env.TZ = prevTz;
    }
  });

  it("swallows errors and logs them instead of throwing (scheduler safety)", async () => {
    const { source } = makeSource([
      { id: "ev1", tenant_id: "t1", occurred_at: isoYearsAgo(2) },
    ]);
    const put = vi.fn().mockRejectedValue(new Error("gcs down"));
    const errors: Error[] = [];

    const result = await archiveAuditEvents({
      source,
      storage: { put },
      logger: { info: () => undefined, error: (_s, e) => errors.push(e) },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("gcs down");
    expect(result.skipped).toBe(false);
    expect(result.archivedCount).toBe(0);
  });

  it("does not mark events archived when the storage write fails", async () => {
    const { source, markArchived } = makeSource([
      { id: "ev1", tenant_id: "t1", occurred_at: isoYearsAgo(2) },
    ]);
    const put = vi.fn().mockRejectedValue(new Error("gcs down"));

    await archiveAuditEvents({ source, storage: { put } });

    expect(markArchived).not.toHaveBeenCalled();
  });
});
