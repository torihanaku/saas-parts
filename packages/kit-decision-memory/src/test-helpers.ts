/**
 * test-helpers.ts — テスト用の決定的 ServiceContext とシード補助。
 */

import { InMemoryDecisionStore, InMemoryMemoryStore } from "./stores.js";
import type { ServiceContext } from "./types.js";

/** 固定時刻 + 連番 id（id-1, id-2, ...）の決定的コンテキスト。 */
export function fixedContext(iso = "2026-07-01T00:00:00.000Z"): ServiceContext {
  let seq = 0;
  return {
    now: () => new Date(iso),
    generateId: () => `id-${++seq}`,
  };
}

export const TENANT = "tenant-1";

export interface SeedDecision {
  id: string;
  subject: string;
  reason: string;
  context?: string;
  decisionType?: string;
  decidedAt?: string;
  source?: string;
  sourceRef?: string | null;
  decidedBy?: string | null;
}

export async function seedDecisions(
  store: InMemoryDecisionStore,
  rows: SeedDecision[],
  tenantId = TENANT,
): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await store.insert({
      id: r.id,
      tenantId,
      decisionType: r.decisionType ?? "start",
      subject: r.subject,
      context: r.context ?? "",
      reason: r.reason,
      alternativesConsidered: null,
      decidedBy: r.decidedBy ?? null,
      decidedAt: r.decidedAt ?? `2026-06-${String(30 - i).padStart(2, "0")}T00:00:00.000Z`,
      source: r.source ?? "manual",
      sourceRef: r.sourceRef ?? null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: null,
    });
  }
}

export interface SeedMemory {
  id: string;
  memType: string;
  subject: string;
  content: string;
  source?: string | null;
  decidedBy?: string | null;
  decidedAt?: string;
}

export async function seedMemories(
  store: InMemoryMemoryStore,
  rows: SeedMemory[],
  tenantId = TENANT,
): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await store.insert({
      id: r.id,
      tenantId,
      memType: r.memType,
      subject: r.subject,
      content: r.content,
      source: r.source ?? null,
      decidedBy: r.decidedBy ?? null,
      decidedAt: r.decidedAt ?? `2026-06-${String(30 - i).padStart(2, "0")}T00:00:00.000Z`,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  }
}
