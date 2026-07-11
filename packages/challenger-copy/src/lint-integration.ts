/**
 * Challenger lint 連携。
 *
 * 本命コンテンツ（A）と challenger 提案（B）の両方に lint を並列適用し、
 * 結果を永続化して、特別バッジ（本命は落ちるが challenger は通る）判定を返す。
 *
 * lint 実装は import せず、注入された述語 `LintCheck` を呼ぶ
 * （@torihanaku/brand-lint や @torihanaku/kit-approval-workflow が充足）。
 */
import type { LintCheck, LintOutcome } from "./types.js";
import type { ChallengerStore } from "./stores.js";

export interface ChallengerLintInput {
  tenantId: string;
  originalContent: string;
  proposals: Array<{ id: string; content: string }>;
}

export interface ChallengerLintResult {
  original: LintOutcome;
  challengers: Array<{ id: string; lintResult: LintOutcome; passed: boolean }>;
  onlyChallengerPassed: boolean;
}

export interface LintIntegrationDeps {
  store: ChallengerStore;
  lintCheck: LintCheck;
}

/** 本命 + 全 challenger に lint を適用し、結果を永続化して集約する。 */
export async function runChallengerLint(
  input: ChallengerLintInput,
  deps: LintIntegrationDeps,
): Promise<ChallengerLintResult> {
  // 1. 本命コンテンツ（A）を lint
  const originalLint = await deps.lintCheck({
    tenantId: input.tenantId,
    contentText: input.originalContent,
  });

  // 2. 各 challenger（B）を並列 lint
  const challengerResults = await Promise.allSettled(
    input.proposals.map(async (proposal) => {
      const lintResult = await deps.lintCheck({
        tenantId: input.tenantId,
        contentText: proposal.content,
      });

      const passed = lintResult.riskScore === 0;
      await deps.store.updateProposalLint(
        proposal.id,
        lintResult,
        passed ? new Date().toISOString() : null,
      );

      return { id: proposal.id, lintResult, passed };
    }),
  );

  // 3. 失敗を握りつぶして成功分だけ抽出
  const challengers = challengerResults
    .filter(
      (r): r is PromiseFulfilledResult<{ id: string; lintResult: LintOutcome; passed: boolean }> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);

  // 4. 「本命は落ちるが challenger は通る」特別バッジ
  const originalPassed = originalLint.riskScore === 0;
  const anyChallengerPassed = challengers.some((c) => c.passed);
  const onlyChallengerPassed = !originalPassed && anyChallengerPassed;

  return { original: originalLint, challengers, onlyChallengerPassed };
}
