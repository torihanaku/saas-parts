/**
 * Ported from 実運用SaaS `tests/lead-scoring.test.ts` — adapted from
 * supabase mocks to InMemoryLeadScoringStore, plus deterministic per-dimension
 * fixtures for the pure scoring helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  LeadScorer,
  InMemoryLeadScoringStore,
  getDefaultScoringConfig,
  calculateBehaviorScore,
  calculateFitScore,
  calculateEngagementScore,
} from "./lead-scorer";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const contactId = "contact-1";
const projectId = "project-1";

let store: InMemoryLeadScoringStore;
let scorer: LeadScorer;

beforeEach(() => {
  store = new InMemoryLeadScoringStore();
  scorer = new LeadScorer({ store, now: () => NOW });
});

describe("scoreContact", () => {
  it("calculates score and persists it", async () => {
    store.contacts.push({
      id: contactId,
      title: "CEO",
      lifecycle_stage: "lead",
      metadata: { company_size: 1000, industry: "technology", form_submissions: 1 },
    });
    store.deals.push({ contact_id: contactId });

    const score = await scorer.scoreContact(contactId, projectId);
    expect(score).not.toBeNull();
    expect(score!.total_score).toBeGreaterThan(0);
    expect(store.leadScores).toHaveLength(1);
  });

  it("produces a deterministic per-dimension breakdown", async () => {
    store.contacts.push({
      id: contactId,
      title: "CEO",
      lifecycle_stage: "lead",
      updated_at: "2026-05-31T00:00:00.000Z", // 1 day before NOW → +20 recency
      metadata: { company_size: 1000, industry: "technology", form_submissions: 1, site_visits: 2 },
    });
    store.deals.push({ contact_id: contactId });
    store.campaigns.push({
      metadata: {
        contact_interactions: {
          [contactId]: { opened: true, opens: 2, clicked: true, clicks: 1 },
        },
      },
    });

    const score = await scorer.scoreContact(contactId, projectId);
    // behavior: email_open 2*5=10, email_click 1*10=10, deal_created 1*30=30,
    //           form_submit 1*20=20, site_visit 2*3=6 → 76
    expect(score!.dimensions.email_open).toBe(10);
    expect(score!.dimensions.email_click).toBe(10);
    expect(score!.dimensions.deal_created).toBe(30);
    expect(score!.dimensions.form_submit).toBe(20);
    expect(score!.dimensions.site_visit).toBe(6);
    expect(score!.behavior_score).toBe(76);
    // fit: company_size>=1000 → 20, industry technology → 15, CEO → 15 = 50
    expect(score!.fit_score).toBe(50);
    // engagement: recency <=7d → 20, stage lead → 5 = 25
    expect(score!.engagement_score).toBe(25);
    expect(score!.total_score).toBe(151);
    expect(score!.is_mql).toBe(true);
    expect(score!.scored_at).toBe(NOW.toISOString());
  });

  it("returns null when contact not found", async () => {
    const score = await scorer.scoreContact("missing", projectId);
    expect(score).toBeNull();
  });

  it("updates the existing score row on re-score (upsert path)", async () => {
    store.contacts.push({ id: contactId, metadata: {} });
    await scorer.scoreContact(contactId, projectId);
    await scorer.scoreContact(contactId, projectId);
    expect(store.leadScores).toHaveLength(1);
  });

  it("respects a custom MQL threshold from config", async () => {
    store.contacts.push({ id: contactId, title: "CEO", metadata: { company_size: 1000 } });
    const strict = new LeadScorer({
      store,
      now: () => NOW,
      config: { ...getDefaultScoringConfig(), mql_threshold: 999 },
    });
    const score = await strict.scoreContact(contactId, projectId);
    expect(score!.is_mql).toBe(false);
  });
});

describe("bulkScoreContacts", () => {
  it("scores in batches", async () => {
    store.contacts.push({ id: "c1", project_id: projectId }, { id: "c2", project_id: projectId });
    const result = await scorer.bulkScoreContacts(projectId);
    expect(result.scored).toBe(2);
  });

  it("counts MQLs among scored contacts", async () => {
    store.contacts.push(
      { id: "c1", project_id: projectId, title: "CEO", metadata: { company_size: 1000, industry: "saas" } }, // fit 50 ≥ 50
      { id: "c2", project_id: projectId, metadata: {} }, // 0
    );
    const result = await scorer.bulkScoreContacts(projectId);
    expect(result.scored).toBe(2);
    expect(result.mqls).toBe(1);
  });

  it("handles zero contacts", async () => {
    const result = await scorer.bulkScoreContacts(projectId);
    expect(result.scored).toBe(0);
  });
});

describe("getScoreBreakdown", () => {
  it("returns lead score", async () => {
    store.leadScores.push({ id: "s1", contact_id: contactId, total_score: 100 });
    const result = await scorer.getScoreBreakdown(contactId);
    expect(result?.total_score).toBe(100);
  });

  it("returns null when no score row exists", async () => {
    expect(await scorer.getScoreBreakdown("missing")).toBeNull();
  });
});

describe("pure scoring helpers (deterministic fixtures)", () => {
  const config = getDefaultScoringConfig();

  it("calculateFitScore tiers company size / industry / title", () => {
    expect(calculateFitScore({ metadata: { company_size: 1000 } })).toBe(20);
    expect(calculateFitScore({ metadata: { company_size: 200 } })).toBe(15);
    expect(calculateFitScore({ metadata: { company_size: 50 } })).toBe(10);
    expect(calculateFitScore({ metadata: { company_size: 5 } })).toBe(5);
    expect(calculateFitScore({ metadata: { industry: "fintech" } })).toBe(15);
    expect(calculateFitScore({ title: "VP of Sales" })).toBe(15);
    expect(calculateFitScore({ title: "Marketing Manager" })).toBe(10);
    expect(calculateFitScore({ title: "Senior Analyst" })).toBe(5);
    expect(calculateFitScore({})).toBe(0);
  });

  it("calculateEngagementScore tiers recency and lifecycle stage", () => {
    const nowMs = NOW.getTime();
    const daysAgo = (d: number) => new Date(nowMs - d * 86_400_000).toISOString();
    expect(calculateEngagementScore({ updated_at: daysAgo(1) }, nowMs)).toBe(20);
    expect(calculateEngagementScore({ updated_at: daysAgo(10) }, nowMs)).toBe(15);
    expect(calculateEngagementScore({ updated_at: daysAgo(20) }, nowMs)).toBe(10);
    expect(calculateEngagementScore({ updated_at: daysAgo(45) }, nowMs)).toBe(5);
    expect(calculateEngagementScore({ updated_at: daysAgo(90) }, nowMs)).toBe(0);
    expect(calculateEngagementScore({ lifecycle_stage: "opportunity" }, nowMs)).toBe(15);
    expect(calculateEngagementScore({ lifecycle_stage: "SQL" }, nowMs)).toBe(12);
    expect(calculateEngagementScore({ lifecycle_stage: "MQL" }, nowMs)).toBe(10);
    expect(calculateEngagementScore({ lifecycle_stage: "lead" }, nowMs)).toBe(5);
  });

  it("calculateBehaviorScore applies configured weights per dimension", () => {
    const contact = { id: "c1", metadata: { form_submissions: 2, site_visits: 3, meetings_booked: 1 } };
    const { score, dimensions } = calculateBehaviorScore(contact, [{ contact_id: "c1" }], [], config);
    expect(dimensions.form_submit).toBe(40);
    expect(dimensions.site_visit).toBe(9);
    expect(dimensions.meeting_booked).toBe(25);
    expect(dimensions.deal_created).toBe(30);
    expect(score).toBe(104);
  });

  it("accumulates email dimensions across multiple campaigns (breakdown matches score)", () => {
    // Same contact interacts in two campaigns. Regression: the dimension
    // breakdown previously kept only the last campaign's value while the score
    // summed both, so breakdown != score.
    const contact = { id: "c1", metadata: {} };
    const campaigns = [
      { metadata: { contact_interactions: { c1: { opened: true, opens: 2, clicked: true, clicks: 1 } } } },
      { metadata: { contact_interactions: { c1: { opened: true, opens: 3, clicked: true, clicks: 4 } } } },
    ];
    const { score, dimensions } = calculateBehaviorScore(contact, [], campaigns, config);
    // opens: (2+3)*5 = 25 ; clicks: (1+4)*10 = 50
    expect(dimensions.email_open).toBe(25);
    expect(dimensions.email_click).toBe(50);
    // Breakdown sum must equal the reported score.
    expect(dimensions.email_open! + dimensions.email_click!).toBe(score);
    expect(score).toBe(75);
  });
});
