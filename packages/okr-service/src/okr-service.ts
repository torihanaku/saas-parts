/**
 * OKR Service — Objectives & Key Results management with auto-progress tracking.
 *
 * Ported from dev-dashboard-v2 `server/lib/okr-service.ts`.
 * Supabase calls (dd_okr_objectives / dd_okr_key_results) are replaced with an
 * injected {@link OkrStore}. Auto-source resolution (ga4:sessions, crm:mqls, …)
 * is replaced with an injected provider map; the original table-backed
 * resolvers are preserved via {@link createDefaultAutoSourceProviders} +
 * {@link OkrMetricsStore}.
 */

// ─── Types ─────────────────────────────────────────────────────

export interface KeyResult {
  id?: string;
  objective_id: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  /** Auto-source identifier, e.g. "ga4:sessions", "crm:mqls", "deals:pipeline" */
  auto_source?: string;
}

export interface Objective {
  id?: string;
  project_id: string;
  title: string;
  /** Quarter in "YYYY-QN" format, e.g. "2026-Q2" */
  quarter: string;
  /** Overall progress 0-100, calculated as avg of KR completion percentages */
  progress: number;
  key_results: KeyResult[];
}

// ─── Row types (snake_case, mirrors the original Supabase rows) ───────────────

export interface ObjectiveRow {
  id: string;
  project_id: string;
  title: string;
  quarter: string;
  progress: number;
  created_at: string;
  updated_at: string;
}

export interface KeyResultRow {
  id: string;
  objective_id: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  auto_source: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Store interface (mirrors the original query shapes) ──────────────────────

export interface OkrStore {
  /** `dd_okr_objectives?project_id=eq.{id}[&quarter=eq.{q}]&order=created_at.desc` */
  listObjectives(projectId: string, quarter?: string): Promise<ObjectiveRow[] | null>;
  /** `dd_okr_key_results?objective_id=in.(…)&order=created_at.asc` */
  listKeyResults(objectiveIds: string[]): Promise<KeyResultRow[] | null>;
  /** INSERT into dd_okr_objectives */
  insertObjective(row: ObjectiveRow): Promise<boolean>;
  /** PATCH dd_okr_objectives?id=eq.{id} */
  patchObjective(id: string, patch: Partial<ObjectiveRow>): Promise<boolean>;
  /** INSERT into dd_okr_key_results */
  insertKeyResult(row: KeyResultRow): Promise<boolean>;
  /** PATCH dd_okr_key_results?id=eq.{id} */
  patchKeyResult(id: string, patch: Partial<KeyResultRow>): Promise<boolean>;
  /** `DELETE dd_okr_key_results?objective_id=eq.{id}` (cascade step 1) */
  deleteKeyResultsByObjective(objectiveId: string): Promise<boolean>;
  /** `DELETE dd_okr_objectives?id=eq.{id}` (cascade step 2) */
  deleteObjective(id: string): Promise<boolean>;
}

// ─── Auto-source providers ─────────────────────────────────────

/** Resolves the current numeric value for one auto-source, or null when unavailable. */
export type AutoSourceProvider = (projectId: string) => Promise<number | null>;

/** Keyed by the full source string, e.g. "ga4:sessions". */
export type AutoSourceProviderMap = Record<string, AutoSourceProvider>;

/**
 * Metrics read interface used by the default providers. Each method mirrors
 * the original Supabase query for that auto-source.
 */
export interface OkrMetricsStore {
  /** `dd_analytics_snapshots?project_id&metric_type=eq.sessions&select=value&order=period_start.desc&limit=12` */
  listSessionValues(projectId: string): Promise<Array<{ value: number }> | null>;
  /** `dd_lead_scores?project_id&is_mql=eq.true&select=id` */
  listMqlIds(projectId: string): Promise<Array<{ id: string }> | null>;
  /** `dd_crm_contacts?project_id&select=id` */
  listContactIds(projectId: string): Promise<Array<{ id: string }> | null>;
  /** `dd_crm_deals?project_id&select=amount` */
  listDealAmounts(projectId: string): Promise<Array<{ amount: number }> | null>;
  /** `dd_marketing_campaigns?project_id&select=subscriber_count&order=created_at.desc&limit=1` */
  latestCampaignSubscriberCounts(projectId: string): Promise<Array<{ subscriber_count: number }> | null>;
}

/**
 * Recreates the original built-in auto-source resolvers
 * (ga4:sessions / crm:mqls / crm:contacts / deals:pipeline / mailchimp:subscribers)
 * on top of an injected {@link OkrMetricsStore}.
 */
export function createDefaultAutoSourceProviders(metrics: OkrMetricsStore): AutoSourceProviderMap {
  return {
    "ga4:sessions": async (projectId) => {
      const rows = await metrics.listSessionValues(projectId);
      if (rows && rows.length > 0) {
        return rows.reduce((sum, r) => sum + (r.value || 0), 0);
      }
      return null;
    },
    "crm:mqls": async (projectId) => {
      const rows = await metrics.listMqlIds(projectId);
      return rows ? rows.length : null;
    },
    "crm:contacts": async (projectId) => {
      const rows = await metrics.listContactIds(projectId);
      return rows ? rows.length : null;
    },
    "deals:pipeline": async (projectId) => {
      const rows = await metrics.listDealAmounts(projectId);
      if (rows && rows.length > 0) {
        return rows.reduce((sum, r) => sum + (r.amount || 0), 0);
      }
      return null;
    },
    "mailchimp:subscribers": async (projectId) => {
      const rows = await metrics.latestCampaignSubscriberCounts(projectId);
      if (rows && rows.length > 0) {
        return rows[0]!.subscriber_count || 0;
      }
      return null;
    },
  };
}

// ─── Pure helpers ──────────────────────────────────────────────

/** Calculate objective progress as average of KR completion percentages (capped at 100). */
export function calculateProgress(keyResults: KeyResult[]): number {
  if (keyResults.length === 0) return 0;
  const total = keyResults.reduce((sum, kr) => {
    // Clamp each KR to [0, 100]. A KR below baseline (negative `current`, e.g.
    // a metric that regressed) previously produced a negative percentage that
    // dragged the objective's progress negative, violating the documented
    // 0-100 invariant on Objective.progress.
    const pct = kr.target > 0 ? Math.min(Math.max((kr.current / kr.target) * 100, 0), 100) : 0;
    return sum + pct;
  }, 0);
  return Math.round(total / keyResults.length);
}

// ─── Service ───────────────────────────────────────────────────

export interface OkrServiceOptions {
  store: OkrStore;
  /** Auto-source providers, keyed by source id (e.g. "ga4:sessions"). Default: none. */
  providers?: AutoSourceProviderMap;
  /** Clock injection for deterministic tests. Default: `() => new Date()`. */
  now?: () => Date;
  /** ID generator injection. Default: `crypto.randomUUID`. */
  uuid?: () => string;
}

export class OkrService {
  private readonly store: OkrStore;
  private readonly providers: AutoSourceProviderMap;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: OkrServiceOptions) {
    this.store = options.store;
    this.providers = options.providers ?? {};
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  /** Fetch objectives with their key results for a project, optionally filtered by quarter. */
  async getObjectives(projectId: string, quarter?: string): Promise<Objective[]> {
    const rows = await this.store.listObjectives(projectId, quarter);
    if (!rows || rows.length === 0) return [];

    const objectiveIds = rows.map((r) => r.id);
    const krRows = await this.store.listKeyResults(objectiveIds);

    const krMap = new Map<string, KeyResult[]>();
    for (const kr of krRows ?? []) {
      const list = krMap.get(kr.objective_id) ?? [];
      list.push({
        id: kr.id,
        objective_id: kr.objective_id,
        title: kr.title,
        target: kr.target,
        current: kr.current,
        unit: kr.unit,
        auto_source: kr.auto_source ?? undefined,
      });
      krMap.set(kr.objective_id, list);
    }

    return rows.map((obj) => ({
      id: obj.id,
      project_id: obj.project_id,
      title: obj.title,
      quarter: obj.quarter,
      progress: obj.progress,
      key_results: krMap.get(obj.id) ?? [],
    }));
  }

  /** Insert or update an objective. If id is provided, patches; otherwise inserts. */
  async upsertObjective(obj: Omit<Objective, "key_results">): Promise<boolean> {
    const now = this.now().toISOString();
    if (obj.id) {
      return this.store.patchObjective(obj.id, {
        title: obj.title,
        quarter: obj.quarter,
        progress: obj.progress,
        updated_at: now,
      });
    }
    return this.store.insertObjective({
      id: this.uuid(),
      project_id: obj.project_id,
      title: obj.title,
      quarter: obj.quarter,
      progress: obj.progress ?? 0,
      created_at: now,
      updated_at: now,
    });
  }

  /** Insert or update a key result. If id is provided, patches; otherwise inserts. */
  async upsertKeyResult(kr: KeyResult): Promise<boolean> {
    const now = this.now().toISOString();
    if (kr.id) {
      return this.store.patchKeyResult(kr.id, {
        title: kr.title,
        target: kr.target,
        current: kr.current,
        unit: kr.unit,
        auto_source: kr.auto_source ?? null,
        updated_at: now,
      });
    }
    return this.store.insertKeyResult({
      id: this.uuid(),
      objective_id: kr.objective_id,
      title: kr.title,
      target: kr.target,
      current: kr.current,
      unit: kr.unit,
      auto_source: kr.auto_source ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  /** Delete an objective and its key results via cascade (delete KRs first, then objective). */
  async deleteObjective(id: string): Promise<boolean> {
    try {
      await this.store.deleteKeyResultsByObjective(id);
      return await this.store.deleteObjective(id);
    } catch {
      return false;
    }
  }

  /** Auto-update KR progress from linked data sources, then recalculate objective progress. */
  async autoUpdateProgress(projectId: string): Promise<number> {
    const objectives = await this.getObjectives(projectId);
    let updated = 0;

    for (const obj of objectives) {
      let changed = false;

      for (const kr of obj.key_results) {
        if (!kr.auto_source || !kr.id) continue;

        const newValue = await this.resolveAutoSource(kr.auto_source, projectId);
        if (newValue !== null && newValue !== kr.current) {
          kr.current = newValue;
          await this.upsertKeyResult(kr);
          changed = true;
          updated++;
        }
      }

      if (changed && obj.id) {
        // Recalculate objective progress as average of KR completion percentages
        const progress = calculateProgress(obj.key_results);
        await this.store.patchObjective(obj.id, {
          progress,
          updated_at: this.now().toISOString(),
        });
      }
    }

    return updated;
  }

  /** Resolve a KR auto_source to a current numeric value via the injected provider map. */
  private async resolveAutoSource(source: string, projectId: string): Promise<number | null> {
    try {
      const provider = this.providers[source];
      if (!provider) return null;
      return await provider(projectId);
    } catch {
      // Data source unavailable — skip silently (mirrors original behavior)
      return null;
    }
  }
}

// ─── In-memory implementations ─────────────────────────────────

/** In-memory OkrStore mirroring the PostgREST query semantics used by the service. */
export class InMemoryOkrStore implements OkrStore {
  objectives: ObjectiveRow[] = [];
  keyResults: KeyResultRow[] = [];

  async listObjectives(projectId: string, quarter?: string): Promise<ObjectiveRow[] | null> {
    return this.objectives
      .filter((o) => o.project_id === projectId && (quarter === undefined || o.quarter === quarter))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listKeyResults(objectiveIds: string[]): Promise<KeyResultRow[] | null> {
    const set = new Set(objectiveIds);
    return this.keyResults
      .filter((kr) => set.has(kr.objective_id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async insertObjective(row: ObjectiveRow): Promise<boolean> {
    this.objectives.push({ ...row });
    return true;
  }

  async patchObjective(id: string, patch: Partial<ObjectiveRow>): Promise<boolean> {
    const row = this.objectives.find((o) => o.id === id);
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  }

  async insertKeyResult(row: KeyResultRow): Promise<boolean> {
    this.keyResults.push({ ...row });
    return true;
  }

  async patchKeyResult(id: string, patch: Partial<KeyResultRow>): Promise<boolean> {
    const row = this.keyResults.find((kr) => kr.id === id);
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  }

  async deleteKeyResultsByObjective(objectiveId: string): Promise<boolean> {
    this.keyResults = this.keyResults.filter((kr) => kr.objective_id !== objectiveId);
    return true;
  }

  async deleteObjective(id: string): Promise<boolean> {
    const before = this.objectives.length;
    this.objectives = this.objectives.filter((o) => o.id !== id);
    return this.objectives.length < before;
  }
}

/** In-memory metrics store mirroring the source tables the auto-sources read. */
export class InMemoryOkrMetricsStore implements OkrMetricsStore {
  analyticsSnapshots: Array<{ project_id: string; metric_type: string; value: number; period_start: string }> = [];
  leadScores: Array<{ id: string; project_id: string; is_mql: boolean }> = [];
  contacts: Array<{ id: string; project_id: string }> = [];
  deals: Array<{ project_id: string; amount: number }> = [];
  campaigns: Array<{ project_id: string; subscriber_count: number; created_at: string }> = [];

  async listSessionValues(projectId: string): Promise<Array<{ value: number }> | null> {
    return this.analyticsSnapshots
      .filter((s) => s.project_id === projectId && s.metric_type === "sessions")
      .sort((a, b) => b.period_start.localeCompare(a.period_start))
      .slice(0, 12)
      .map((s) => ({ value: s.value }));
  }

  async listMqlIds(projectId: string): Promise<Array<{ id: string }> | null> {
    return this.leadScores
      .filter((s) => s.project_id === projectId && s.is_mql)
      .map((s) => ({ id: s.id }));
  }

  async listContactIds(projectId: string): Promise<Array<{ id: string }> | null> {
    return this.contacts.filter((c) => c.project_id === projectId).map((c) => ({ id: c.id }));
  }

  async listDealAmounts(projectId: string): Promise<Array<{ amount: number }> | null> {
    return this.deals.filter((d) => d.project_id === projectId).map((d) => ({ amount: d.amount }));
  }

  async latestCampaignSubscriberCounts(projectId: string): Promise<Array<{ subscriber_count: number }> | null> {
    return this.campaigns
      .filter((c) => c.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 1)
      .map((c) => ({ subscriber_count: c.subscriber_count }));
  }
}
