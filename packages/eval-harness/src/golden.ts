/**
 * Golden-case runner: input → expected verdict, judged by an injected
 * callback (LLM judge, rule engine, classifier…).
 *
 * Generalized from dev-dashboard-v2's firewall eval flow (#1040), where the
 * ground-truth pairs were assembled from recent submissions. Here the golden
 * set is explicit and versionable, which is the pattern the Python
 * `tools/eval-lab` harness used for its query sets.
 */

import {
  computeClassificationMetrics,
  type ClassificationMetrics,
  type PredictionPair,
} from "./metrics";

export interface GoldenCase<I = string> {
  /** Stable case id (used in regression diffs). */
  id: string;
  input: I;
  /** Ground truth: should the system flag this input? */
  expected: boolean;
  /** Optional human note about why this case exists. */
  note?: string;
}

/**
 * Injected judge. Return the system's verdict for one input.
 * May be sync or async; throwing marks the case as errored
 * (counted as `predicted: false`, i.e. a miss — fail-visible, not fail-open).
 */
export type JudgeFn<I> = (input: I, goldenCase: GoldenCase<I>) => boolean | Promise<boolean>;

export interface GoldenCaseResult<I = string> {
  id: string;
  input: I;
  expected: boolean;
  predicted: boolean;
  pass: boolean;
  /** Present when the judge threw for this case. */
  error?: string;
}

export interface GoldenRunResult<I = string> {
  results: GoldenCaseResult<I>[];
  /** Only the failing cases (mismatch or judge error). */
  failures: GoldenCaseResult<I>[];
  pairs: PredictionPair[];
  metrics: ClassificationMetrics;
}

export async function runGoldenCases<I = string>(
  cases: GoldenCase<I>[],
  judge: JudgeFn<I>,
): Promise<GoldenRunResult<I>> {
  const results: GoldenCaseResult<I>[] = [];
  for (const c of cases) {
    let predicted = false;
    let error: string | undefined;
    try {
      predicted = await judge(c.input, c);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({
      id: c.id,
      input: c.input,
      expected: c.expected,
      predicted,
      pass: error === undefined && predicted === c.expected,
      ...(error !== undefined ? { error } : {}),
    });
  }
  const pairs: PredictionPair[] = results.map((r) => ({
    expected: r.expected,
    predicted: r.predicted,
  }));
  return {
    results,
    failures: results.filter((r) => !r.pass),
    pairs,
    metrics: computeClassificationMetrics(pairs),
  };
}
