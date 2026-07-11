import type { AdInsight, GuardrailStore, Proposal } from "./index";

/** Deterministic in-memory GuardrailStore for tests / demos. */
export class InMemoryGuardrailStore implements GuardrailStore {
  public proposals: Proposal[] = [];
  private seq = 0;

  constructor(
    private seed: {
      /** insights keyed by `${tenantId}:${date}`. */
      insights?: Record<string, AdInsight[]>;
      tenantIds?: string[];
    } = {},
  ) {}

  async getInsights(tenantId: string, date: string): Promise<AdInsight[]> {
    return this.seed.insights?.[`${tenantId}:${date}`] ?? [];
  }

  async insertProposal(proposal: Omit<Proposal, "id">): Promise<Proposal> {
    const row: Proposal = { id: `prop-${++this.seq}`, ...proposal };
    this.proposals.push(row);
    return row;
  }

  async listTenantIds(): Promise<string[]> {
    return this.seed.tenantIds ?? [];
  }
}
