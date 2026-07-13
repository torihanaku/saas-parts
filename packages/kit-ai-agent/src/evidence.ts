/**
 * Evidence Gathering Agent: collect supporting cases for an approval subject
 * (稟議・例外申請など) from N sources in parallel.
 *
 * 出典: 実運用SaaS server/services/evidenceAgent.ts
 * 変更点: 3つの固定ソース (dd_decision_log / dd_competitive_intel /
 *         dd_compliance_checks) → EvidenceSource[] 注入（並列 fetch は温存）/
 *         dd_submissions lookup → loadSubject 注入 / dd_decision_log insert →
 *         decisionLog 注入。
 */
import type { DecisionLogger } from "./planner";

export interface EvidenceCase {
  title: string;
  summary: string;
  /** e.g. "Institutional Memory" | "Competitive Intel" | "Legal Foundation" */
  source: string;
  url?: string;
  /** 0..1 */
  confidence: number;
}

export interface EvidenceQuery {
  tenantId: string;
  subjectId: string;
  /** Search key (元: submission title). */
  subjectTitle: string;
  subjectText?: string;
}

export interface EvidenceSource {
  /** Result-map key (e.g. "pastCases"). */
  name: string;
  fetch(query: EvidenceQuery): Promise<EvidenceCase[]>;
}

export interface EvidenceAgentConfig {
  sources: EvidenceSource[];
  /** Resolve the subject being justified. null → throw "subject_not_found". */
  loadSubject: (
    tenantId: string,
    subjectId: string,
  ) => Promise<{ title: string; text?: string } | null>;
  decisionLog?: DecisionLogger;
}

export type GatheredEvidence = Record<string, EvidenceCase[]>;

export interface EvidenceAgent {
  gather(tenantId: string, subjectId: string): Promise<GatheredEvidence>;
}

export function createEvidenceAgent(config: EvidenceAgentConfig): EvidenceAgent {
  return {
    async gather(tenantId, subjectId) {
      const subject = await config.loadSubject(tenantId, subjectId);
      if (!subject) throw new Error("subject_not_found");

      const query: EvidenceQuery = {
        tenantId,
        subjectId,
        subjectTitle: subject.title,
        ...(subject.text !== undefined ? { subjectText: subject.text } : {}),
      };

      // 並列 fetch（元実装の Promise.all を温存）
      const fetched = await Promise.all(
        config.sources.map(async (s) => [s.name, await s.fetch(query)] as const),
      );
      const result: GatheredEvidence = Object.fromEntries(fetched);

      await config.decisionLog?.({
        tenantId,
        decisionType: "change",
        subject: `Evidence Gathering: ${subjectId}`,
        context: `Gathering evidence for approval subject: ${subject.title}`,
        reason: "Automated evidence agent search",
        resourceType: "approval_subject",
        resourceId: subjectId,
        metadata: {
          method: "evidence_agent",
          result_summary: Object.fromEntries(
            fetched.map(([name, cases]) => [`${name}_count`, cases.length]),
          ),
        },
      });

      return result;
    },
  };
}
