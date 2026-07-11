/**
 * Ported from dev-dashboard-v2 `tests/customer-intelligence.test.ts` — adapted
 * from supabase / claude-api-client / tenant-secrets mocks to the injected
 * InMemoryCustomerIntelligenceStore, LeadScoreProvider, and JsonGenerator.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CustomerIntelligence,
  InMemoryCustomerIntelligenceStore,
  deriveChurnRiskLevel,
  type CustomerProfile,
  type JsonGenerator,
} from "./customer-intelligence";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const projectId = "project-1";
const contactId = "contact-1";
const profileId = "profile-1";

let store: InMemoryCustomerIntelligenceStore;

function makeService(overrides: Partial<ConstructorParameters<typeof CustomerIntelligence>[0]> = {}) {
  return new CustomerIntelligence({
    store,
    now: () => NOW,
    logger: () => {},
    ...overrides,
  });
}

function seedProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  const profile: CustomerProfile = {
    id: profileId,
    project_id: projectId,
    contact_id: contactId,
    company_name: "Test",
    lifecycle_stage: "customer",
    purchase_intent_score: 40,
    churn_risk_score: 20,
    churn_risk_level: "low",
    last_activity_at: "2026-05-01T00:00:00.000Z",
    metadata: {},
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
  store.profiles.push(profile as CustomerProfile & Record<string, unknown>);
  return profile;
}

beforeEach(() => {
  store = new InMemoryCustomerIntelligenceStore();
});

describe("getCustomerProfiles", () => {
  it("returns rows for the project", async () => {
    seedProfile({ id: "p1" });
    const res = await makeService().getCustomerProfiles(projectId);
    expect(res).toHaveLength(1);
  });
});

describe("buildUnifiedProfile", () => {
  it("handles new profiles (insert path)", async () => {
    store.contacts.push({ id: contactId });
    const service = makeService({
      leadScoreProvider: async () => ({ total_score: 60, engagement_score: 0 }),
    });

    const profile = await service.buildUnifiedProfile(contactId, projectId);
    expect(profile).toBeDefined();
    expect(profile.lifecycle_stage).toBe("lead"); // total_score >= 50
    expect(store.profiles).toHaveLength(1);
  });

  it("updates the existing profile (patch path, id preserved)", async () => {
    store.contacts.push({ id: contactId });
    seedProfile({ id: "existing-1" });
    const service = makeService();

    const profile = await service.buildUnifiedProfile(contactId, projectId);
    expect(profile.id).toBe("existing-1");
    expect(store.profiles).toHaveLength(1);
  });

  it("derives lifecycle from deals (won → customer, negotiation → opportunity)", async () => {
    store.contacts.push({ id: contactId });
    store.deals.push({ contact_id: contactId, project_id: projectId, stage: "won" });
    const won = await makeService().buildUnifiedProfile(contactId, projectId);
    expect(won.lifecycle_stage).toBe("customer");

    store.deals[0]!.stage = "negotiation";
    const active = await makeService().buildUnifiedProfile(contactId, projectId);
    expect(active.lifecycle_stage).toBe("opportunity");
  });

  it("contact stage 'churned' overrides derived lifecycle", async () => {
    store.contacts.push({ id: contactId, lifecycle_stage: "churned" });
    store.deals.push({ contact_id: contactId, project_id: projectId, stage: "won" });
    const profile = await makeService().buildUnifiedProfile(contactId, projectId);
    expect(profile.lifecycle_stage).toBe("churned");
  });

  it("computes deterministic churn risk for inactive customers", async () => {
    // customer with: 90+ days inactive (+30 +20), low lead score (+25), >3 tickets (+25) = 100
    store.contacts.push({
      id: contactId,
      metadata: {
        last_activity_at: "2026-01-01T00:00:00.000Z", // 151 days before NOW
        support_tickets: 5,
      },
    });
    store.deals.push({ contact_id: contactId, project_id: projectId, stage: "won" });

    const profile = await makeService().buildUnifiedProfile(contactId, projectId);
    expect(profile.churn_risk_score).toBe(100);
    expect(profile.churn_risk_level).toBe("critical");
  });

  it("computes purchase intent from lead score + deals + engagement", async () => {
    store.contacts.push({ id: contactId });
    store.deals.push({ contact_id: contactId, project_id: projectId, stage: "proposal" });
    const service = makeService({
      leadScoreProvider: async () => ({ total_score: 50, engagement_score: 20 }),
    });
    const profile = await service.buildUnifiedProfile(contactId, projectId);
    // 50*0.4 + 30 + 20*0.3 = 56
    expect(profile.purchase_intent_score).toBe(56);
  });
});

describe("predictChurnRisk", () => {
  it("uses the LLM and updates the profile", async () => {
    seedProfile();
    const generateJson = vi.fn(async <T>(_s: string, _p: string, _f: T) =>
      ({ risk_score: 50, signals: [] }) as unknown as T) as JsonGenerator;
    const service = makeService({ generateJson });

    const result = await service.predictChurnRisk(profileId);
    expect(result.risk_score).toBe(50);
    expect(result.risk_level).toBe("medium");
    expect(store.profiles[0]!.churn_risk_score).toBe(50);
    expect(generateJson).toHaveBeenCalled();
  });

  it("clamps LLM scores to 0..100", async () => {
    seedProfile();
    const service = makeService({
      generateJson: (async <T>(_s: string, _p: string, _f: T) =>
        ({ risk_score: 250, signals: [] }) as unknown as T) as JsonGenerator,
    });
    const result = await service.predictChurnRisk(profileId);
    expect(result.risk_score).toBe(100);
    expect(result.risk_level).toBe("critical");
  });

  it("returns the heuristic fallback when no LLM callback is configured", async () => {
    seedProfile({ churn_risk_score: 33, churn_risk_level: "low" });
    const service = makeService(); // generateJson absent
    const result = await service.predictChurnRisk(profileId);
    expect(result.risk_score).toBe(33);
    expect(result.risk_level).toBe("low");
    // no patch performed
    expect(store.profiles[0]!.churn_risk_score).toBe(33);
  });

  it("returns zeros when the profile does not exist", async () => {
    const result = await makeService().predictChurnRisk("missing");
    expect(result).toEqual({ risk_score: 0, risk_level: "low", signals: [] });
  });
});

describe("calculatePurchaseIntent", () => {
  it("uses the LLM and updates the profile", async () => {
    seedProfile();
    const service = makeService({
      generateJson: (async <T>(_s: string, _p: string, _f: T) =>
        ({ intent_score: 80, signals: ["high activity"] }) as unknown as T) as JsonGenerator,
    });

    const result = await service.calculatePurchaseIntent(profileId);
    expect(result.intent_score).toBe(80);
    expect(result.signals).toEqual(["high activity"]);
    expect(store.profiles[0]!.purchase_intent_score).toBe(80);
  });

  it("falls back to the stored intent score without an LLM callback", async () => {
    seedProfile({ purchase_intent_score: 42 });
    const result = await makeService().calculatePurchaseIntent(profileId);
    expect(result.intent_score).toBe(42);
    expect(result.signals).toEqual([]);
  });
});

describe("syncAllProfiles", () => {
  it("iterates over contacts", async () => {
    store.contacts.push({ id: "c1", project_id: projectId }, { id: "c2", project_id: projectId });
    const result = await makeService().syncAllProfiles(projectId);
    expect(result.synced).toBe(2);
    expect(result.errors).toBe(0);
    expect(store.profiles).toHaveLength(2);
  });

  it("returns zeros when no contacts exist", async () => {
    const result = await makeService().syncAllProfiles(projectId);
    expect(result).toEqual({ synced: 0, errors: 0 });
  });

  it("counts errors without aborting the loop", async () => {
    store.contacts.push({ id: "c1", project_id: projectId }, { id: "c2", project_id: projectId });
    const original = store.getContact.bind(store);
    let calls = 0;
    store.getContact = async (id: string) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return original(id);
    };
    const result = await makeService().syncAllProfiles(projectId);
    expect(result.synced).toBe(1);
    expect(result.errors).toBe(1);
  });
});

describe("deriveChurnRiskLevel", () => {
  it("maps score tiers to levels", () => {
    expect(deriveChurnRiskLevel(0)).toBe("low");
    expect(deriveChurnRiskLevel(40)).toBe("medium");
    expect(deriveChurnRiskLevel(60)).toBe("high");
    expect(deriveChurnRiskLevel(80)).toBe("critical");
  });
});
