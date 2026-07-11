/**
 * 永続化ポート + インメモリ参照実装。
 *
 * 原実装は Supabase テーブル（dd_challenger_proposals / dd_hard_negatives /
 * dd_challenger_metrics）と pgvector RPC（match_hard_negatives）に直接アクセス
 * していた。ここではその読み書きをインターフェース化し、任意のバックエンドを
 * 差し込めるようにしている。
 */
import type { BrandDnaContext } from "./types.js";

/** 保存する challenger 提案（DB 側スキーマに合わせた snake_case）。 */
export interface ChallengerProposalRow {
  tenant_id: string;
  original_content_hash: string;
  content: string;
  deviation_axis: string;
  hypothesized_upside: string;
  estimated_risk: string;
  rationale: string;
  generated_by: string;
}

/** 保存後に採番された challenger 提案。 */
export interface SavedChallengerProposalRow extends ChallengerProposalRow {
  id: string;
}

/** hard negative 挿入ペイロード。 */
export interface HardNegativeInsert {
  tenant_id: string;
  submission_id: string;
  content_text: string;
  rejection_reason_code: string | null;
  rejection_reason_text: string | null;
  source: string;
}

/** 類似 hard negative 検索の 1 行。 */
export interface HardNegativeMatchRow {
  id: string;
  similarity: number;
  rejection_reason_text?: string | null;
  source?: string;
}

/** 日次メトリクス upsert ペイロード。 */
export interface DailyMetricsRow {
  tenant_id: string;
  metric_date: string;
  challenger_proposed: number;
  challenger_accepted: number;
  hard_negative_added: number;
  lint_accuracy: number | null;
}

export interface ChallengerStore {
  /** 最新のブランド DNA 文脈（voice / tone）。 */
  getBrandDna(tenantId: string): Promise<BrandDnaContext | null>;

  /** challenger 提案を保存し、採番結果を返す。 */
  saveProposal(row: ChallengerProposalRow): Promise<SavedChallengerProposalRow>;

  /** challenger 提案の lint 結果を更新。 */
  updateProposalLint(id: string, lintResult: unknown, passedAtIso: string | null): Promise<void>;

  /** hard negative を挿入し、採番 ID を返す（失敗時 null）。 */
  insertHardNegative(row: HardNegativeInsert): Promise<string | null>;

  /** hard negative に embedding を後付け（失敗時 false）。 */
  patchHardNegativeEmbedding(id: string, embedding: number[]): Promise<boolean>;

  /** 類似 hard negative の pgvector 検索。 */
  matchHardNegatives(
    tenantId: string,
    embedding: number[],
    threshold: number,
    count: number,
  ): Promise<HardNegativeMatchRow[]>;

  /** 日次メトリクス集計に必要なカウント群。 */
  countMetrics(tenantId: string, startIso: string, endIso: string): Promise<{
    proposed: number;
    accepted: number;
    hardNegatives: number;
    lintPassed: number;
    approved: number;
  }>;

  /** 日次メトリクスを upsert。 */
  upsertDailyMetrics(row: DailyMetricsRow): Promise<void>;

  /** 直近 N 日の日次メトリクスを日付昇順で取得。 */
  listMetrics(tenantId: string, days: number): Promise<DailyMetricsRow[]>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* インメモリ参照実装（テスト / プロトタイプ用）                              */
/* ────────────────────────────────────────────────────────────────────────── */

export class InMemoryChallengerStore implements ChallengerStore {
  private dna = new Map<string, BrandDnaContext>();
  private proposals: (SavedChallengerProposalRow & { lint_result?: unknown; lint_passed_at?: string | null })[] = [];
  private hardNegatives: (HardNegativeInsert & { id: string; embedding?: number[] })[] = [];
  private metrics: DailyMetricsRow[] = [];
  private seq = 0;

  /** テスト補助: DNA 文脈を登録。 */
  setBrandDna(tenantId: string, ctx: BrandDnaContext): void {
    this.dna.set(tenantId, ctx);
  }

  get savedProposals(): readonly SavedChallengerProposalRow[] {
    return this.proposals;
  }

  get savedHardNegatives(): readonly (HardNegativeInsert & { id: string; embedding?: number[] })[] {
    return this.hardNegatives;
  }

  async getBrandDna(tenantId: string): Promise<BrandDnaContext | null> {
    return this.dna.get(tenantId) ?? null;
  }

  async saveProposal(row: ChallengerProposalRow): Promise<SavedChallengerProposalRow> {
    const saved: SavedChallengerProposalRow = { id: `prop-${++this.seq}`, ...row };
    this.proposals.push(saved);
    return saved;
  }

  async updateProposalLint(id: string, lintResult: unknown, passedAtIso: string | null): Promise<void> {
    const p = this.proposals.find((x) => x.id === id);
    if (p) {
      p.lint_result = lintResult;
      p.lint_passed_at = passedAtIso;
    }
  }

  async insertHardNegative(row: HardNegativeInsert): Promise<string | null> {
    const id = `hn-${++this.seq}`;
    this.hardNegatives.push({ id, ...row });
    return id;
  }

  async patchHardNegativeEmbedding(id: string, embedding: number[]): Promise<boolean> {
    const hn = this.hardNegatives.find((x) => x.id === id);
    if (!hn) return false;
    hn.embedding = embedding;
    return true;
  }

  async matchHardNegatives(
    _tenantId: string,
    _embedding: number[],
    _threshold: number,
    _count: number,
  ): Promise<HardNegativeMatchRow[]> {
    return [];
  }

  async countMetrics(
    _tenantId: string,
    _startIso: string,
    _endIso: string,
  ): Promise<{
    proposed: number;
    accepted: number;
    hardNegatives: number;
    lintPassed: number;
    approved: number;
  }> {
    return { proposed: 0, accepted: 0, hardNegatives: 0, lintPassed: 0, approved: 0 };
  }

  async upsertDailyMetrics(row: DailyMetricsRow): Promise<void> {
    const idx = this.metrics.findIndex(
      (m) => m.tenant_id === row.tenant_id && m.metric_date === row.metric_date,
    );
    if (idx >= 0) this.metrics[idx] = row;
    else this.metrics.push(row);
  }

  async listMetrics(tenantId: string, days: number): Promise<DailyMetricsRow[]> {
    return this.metrics
      .filter((m) => m.tenant_id === tenantId)
      .sort((a, b) => a.metric_date.localeCompare(b.metric_date))
      .slice(0, days);
  }
}
