/**
 * In-memory DeployStore. テスト・PoC 向けの即戦力デフォルト実装。
 */
import type { DeployStep, SubmissionRecord } from "./types";
import type { DeployStore } from "./orchestrator";

export class InMemoryDeployStore implements DeployStore {
  private submissions = new Map<string, SubmissionRecord>();

  constructor(seed?: SubmissionRecord[]) {
    if (seed) for (const s of seed) this.submissions.set(s.id, { ...s });
  }

  async getSubmission(submissionId: string): Promise<SubmissionRecord | null> {
    const found = this.submissions.get(submissionId);
    return found ? { ...found, deploy_log: found.deploy_log ? [...found.deploy_log] : undefined } : null;
  }

  async saveDeployLog(submissionId: string, mergedLog: DeployStep[]): Promise<void> {
    const found = this.submissions.get(submissionId);
    if (found) found.deploy_log = [...mergedLog];
  }

  /** テスト補助: 現在の submission を読む。 */
  _get(submissionId: string): SubmissionRecord | undefined {
    const s = this.submissions.get(submissionId);
    return s ? { ...s } : undefined;
  }

  /** テスト補助: submission を差し込む。 */
  _put(submission: SubmissionRecord): void {
    this.submissions.set(submission.id, { ...submission });
  }
}
