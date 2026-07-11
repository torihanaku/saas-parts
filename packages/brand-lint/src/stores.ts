/**
 * 永続化ポート + インメモリ参照実装。
 *
 * 原実装は Supabase テーブル（dd_brand_dna_snapshots / dd_submissions /
 * dd_rule_proposals）と pgvector RPC（match_brand_dna_rejected）に直接アクセス
 * していた。ここではその読み書きをすべてインターフェース化し、任意のバックエンド
 * （Postgres / Firestore / インメモリ）を差し込めるようにしている。
 */
import type { BrandDnaSnapshot, SimilarityMatch } from "./types.js";

/** 却下された投稿（hard negative の元ネタ）。 */
export interface RejectedSubmission {
  id: string;
  tenant_id: string;
  content_text: string;
  rejection_reason_text?: string;
  decided_at?: string;
}

/** DNA スナップショット行（rejected hard negative を含む）。 */
export interface DnaSnapshotRow {
  id: string;
  tenant_id: string;
  source_id?: string;
  content_text: string;
  rejection_reason: string | null;
  created_at: string;
}

/** hard negative を挿入する際のペイロード。 */
export interface HardNegativeInsert {
  tenant_id: string;
  source_type: string;
  source_id: string;
  content_text: string;
  embedding: number[];
  approval_status: "rejected";
  rejection_reason: string;
}

/** 進化で生成されたルール提案。 */
export interface RuleProposalInsert {
  tenant_id: string;
  proposed_rule_key: string;
  description_ja: string;
  pattern: string;
  pattern_type: "keyword" | "regex" | "llm_prompt";
  severity: "error" | "warning" | "info";
  status: "pending";
  evidence_snapshot_ids: string[];
}

export interface BrandLintStore {
  /** 指定テナントの最新 DNA スナップショット（なければ null）。 */
  getLatestDnaSnapshot(tenantId: string): Promise<BrandDnaSnapshot | null>;

  /** pgvector 類似度検索（却下案件）。しきい値以上のトップ N。 */
  matchRejected(
    tenantId: string,
    embedding: number[],
    threshold: number,
    count: number,
  ): Promise<SimilarityMatch[]>;

  /** 指定日以降の却下投稿を取得（backfill 用）。 */
  listRecentRejections(sinceIso: string): Promise<RejectedSubmission[]>;

  /** 既に hard negative 化済みの source_id 集合（重複排除用）。 */
  listExistingHardNegativeSourceIds(sourceIds: string[]): Promise<string[]>;

  /** hard negative をまとめて挿入。 */
  insertHardNegatives(rows: HardNegativeInsert[]): Promise<void>;

  /** 全テナント ID の一覧（ルール進化ジョブ用）。 */
  listTenantIds(): Promise<string[]>;

  /** 指定テナントの rejected hard negative スナップショット（created_at 付き）。 */
  listRejectedSnapshots(tenantId: string, sinceIso: string): Promise<DnaSnapshotRow[]>;

  /** ルール提案を挿入。 */
  insertRuleProposal(row: RuleProposalInsert): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* インメモリ参照実装（テスト / プロトタイプ用）                              */
/* ────────────────────────────────────────────────────────────────────────── */

export class InMemoryBrandLintStore implements BrandLintStore {
  private snapshots = new Map<string, BrandDnaSnapshot>();
  private rejected: RejectedSubmission[] = [];
  private hardNegatives: (HardNegativeInsert & { id: string })[] = [];
  private ruleProposals: RuleProposalInsert[] = [];
  private tenants = new Set<string>();

  /** テスト補助: 最新 DNA スナップショットを登録。 */
  setDnaSnapshot(tenantId: string, snapshot: BrandDnaSnapshot): void {
    this.snapshots.set(tenantId, snapshot);
    this.tenants.add(tenantId);
  }

  /** テスト補助: 却下投稿を登録。 */
  addRejection(row: RejectedSubmission): void {
    this.rejected.push(row);
    this.tenants.add(row.tenant_id);
  }

  /** テスト補助: rejected スナップショットを登録（進化ジョブ用）。 */
  addRejectedSnapshot(row: DnaSnapshotRow): void {
    this.hardNegatives.push({
      id: row.id,
      tenant_id: row.tenant_id,
      source_type: "content",
      source_id: row.source_id ?? row.id,
      content_text: row.content_text,
      embedding: [],
      approval_status: "rejected",
      rejection_reason: row.rejection_reason ?? "",
    });
    this.snapshotMeta.set(row.id, row);
    this.tenants.add(row.tenant_id);
  }

  private snapshotMeta = new Map<string, DnaSnapshotRow>();

  get proposals(): readonly RuleProposalInsert[] {
    return this.ruleProposals;
  }

  async getLatestDnaSnapshot(tenantId: string): Promise<BrandDnaSnapshot | null> {
    return this.snapshots.get(tenantId) ?? null;
  }

  async matchRejected(
    _tenantId: string,
    _embedding: number[],
    _threshold: number,
    _count: number,
  ): Promise<SimilarityMatch[]> {
    return [];
  }

  async listRecentRejections(sinceIso: string): Promise<RejectedSubmission[]> {
    const since = Date.parse(sinceIso);
    return this.rejected.filter(
      (r) => !r.decided_at || Date.parse(r.decided_at) >= since,
    );
  }

  async listExistingHardNegativeSourceIds(sourceIds: string[]): Promise<string[]> {
    const set = new Set(sourceIds);
    return this.hardNegatives
      .filter((h) => set.has(h.source_id))
      .map((h) => h.source_id);
  }

  async insertHardNegatives(rows: HardNegativeInsert[]): Promise<void> {
    for (const row of rows) {
      this.hardNegatives.push({ id: crypto.randomUUID(), ...row });
    }
  }

  async listTenantIds(): Promise<string[]> {
    return [...this.tenants];
  }

  async listRejectedSnapshots(tenantId: string, sinceIso: string): Promise<DnaSnapshotRow[]> {
    const since = Date.parse(sinceIso);
    const out: DnaSnapshotRow[] = [];
    for (const h of this.hardNegatives) {
      if (h.tenant_id !== tenantId) continue;
      const meta = this.snapshotMeta.get(h.id);
      if (!meta) continue;
      if (Date.parse(meta.created_at) < since) continue;
      out.push(meta);
    }
    return out;
  }

  async insertRuleProposal(row: RuleProposalInsert): Promise<void> {
    this.ruleProposals.push(row);
  }
}
