/**
 * 共有型 + 注入ポート。
 *
 * dev-dashboard-v2 の Active Learning「Challenger」機構
 * （server/lib/challenger + server/services/challengerGenerator）から抽出。
 * LLM / embedding / lint / 永続化はすべて注入に置換。
 */

/* ── Challenger 生成 ─────────────────────────────────────────────────────── */

export interface ChallengerInput {
  tenantId: string;
  /** 本命案の本文 */
  originalContent: string;
  /** ターゲット・目的など */
  originalCreativeBrief?: string;
  /** DNA エンジンから引ける場合のブランドガイドライン */
  brandGuidelines?: string;
}

export interface ChallengerProposal {
  id: string;
  content: string;
  /** どの軸で逸脱したか（'tone' / 'format' / 'claim_aggression' など） */
  deviationAxis: string;
  /** 「CPA 改善」「若年層リーチ拡大」等の仮説 */
  hypothesizedUpside: string;
  estimatedRisk: "low" | "medium" | "high";
  rationale: string;
}

/** Safe / Edgy の 2 案生成結果。 */
export interface DualOptionsResult {
  safe: string;
  edgy: string;
  rationale: string;
}

/* ── ブランド DNA 文脈 ───────────────────────────────────────────────────── */

export interface BrandDnaContext {
  voice?: unknown;
  tone?: unknown;
}

/* ── 注入ポート（LLM / embedding / lint） ────────────────────────────────── */

/** JSON を返す LLM 呼び出し（失敗時に fallback を返す実装を想定）。 */
export type GenerateJson = <T>(
  system: string,
  user: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

/** テキストの embedding を返す関数。 */
export type EmbedText = (text: string) => Promise<number[]>;

/**
 * lint 判定の注入ポート（README: brand-lint / kit-approval-workflow が充足）。
 * import ではなく述語（predicate）として渡すことで疎結合を保つ。
 */
export interface LintOutcome {
  riskScore: number;
  [key: string]: unknown;
}

export type LintCheck = (input: { tenantId: string; contentText: string }) => Promise<LintOutcome>;
