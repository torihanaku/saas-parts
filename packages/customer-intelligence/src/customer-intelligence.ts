/**
 * Customer Intelligence — unified customer profile, purchase intent, and churn prediction.
 *
 * Ported from 実運用SaaS `server/lib/customer-intelligence.ts`.
 * - Supabase calls (dd_customer_profiles / dd_crm_contacts / dd_crm_deals)
 *   → injected {@link CustomerIntelligenceStore}.
 * - `lead-scoring.getScoreBreakdown` import → minimal {@link LeadScoreProvider}
 *   injection (do not import a scoring package; any provider matching the
 *   summary shape works).
 * - Claude call (claude-api-client.generateJson + BYOK key resolution)
 *   → injected {@link JsonGenerator} callback. When absent, the heuristic
 *   fallback values are returned (mirrors the original "no API key" path).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CustomerProfile {
  id: string;
  project_id: string;
  contact_id: string;
  company_name: string;
  lifecycle_stage: "prospect" | "lead" | "opportunity" | "customer" | "churned";
  purchase_intent_score: number;
  churn_risk_score: number;
  churn_risk_level: "low" | "medium" | "high" | "critical";
  last_activity_at: string;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface ChurnSignal {
  signal_type: "inactivity" | "support_tickets" | "usage_decline" | "payment_failure" | "competitor_mention";
  severity: "low" | "medium" | "high";
  description: string;
  detected_at: string;
}

/** Minimal lead-score summary consumed by profile building. */
export interface LeadScoreSummary {
  total_score: number;
  engagement_score: number;
}

/** Replaces the original `lead-scoring.getScoreBreakdown` import. */
export type LeadScoreProvider = (contactId: string) => Promise<LeadScoreSummary | null>;

/** LLM JSON generation callback (replaces claude-api-client.generateJson + key resolution). */
export type JsonGenerator = <T>(
  system: string,
  prompt: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

export type Logger = (level: string, message: string, detail?: string) => void;

// ─── Store interface (mirrors the original query shapes) ─────────────────────

export interface CustomerIntelligenceStore {
  /** `dd_customer_profiles?project_id=eq.{id}&order=updated_at.desc` */
  listProfiles(projectId: string): Promise<CustomerProfile[] | null>;
  /** `dd_customer_profiles?id=eq.{id}&limit=1` */
  getProfile(profileId: string): Promise<CustomerProfile | null>;
  /** `dd_crm_contacts?id=eq.{id}&select=*&limit=1` */
  getContact(contactId: string): Promise<Record<string, unknown> | null>;
  /** `dd_crm_deals?contact_id=eq.{id}&project_id=eq.{id}&select=*` */
  listDealsByContact(contactId: string, projectId: string): Promise<Array<Record<string, unknown>> | null>;
  /** `dd_customer_profiles?contact_id=eq.{id}&project_id=eq.{id}&select=id&limit=1` */
  findProfileId(contactId: string, projectId: string): Promise<string | null>;
  /** INSERT into dd_customer_profiles */
  insertProfile(row: Record<string, unknown>): Promise<void>;
  /** PATCH dd_customer_profiles?id=eq.{id} */
  patchProfile(profileId: string, patch: Record<string, unknown>): Promise<void>;
  /** `dd_crm_contacts?project_id=eq.{id}&select=id` */
  listContactIds(projectId: string): Promise<Array<{ id: string }> | null>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function deriveChurnRiskLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "low";
}

const defaultLogger: Logger = (level, message, detail) => {
  console.log(JSON.stringify({ severity: level, message: `customer-intelligence: ${message}`, ...(detail ? { detail } : {}) }));
};

// ─── Service ─────────────────────────────────────────────────────────────────

export interface CustomerIntelligenceOptions {
  store: CustomerIntelligenceStore;
  /** Lead-score lookup for profile building. Default: always null (score 0). */
  leadScoreProvider?: LeadScoreProvider;
  /** LLM callback. When absent, churn/intent analysis returns the heuristic fallback. */
  generateJson?: JsonGenerator | null;
  /** Clock injection for deterministic tests. Default: `() => new Date()`. */
  now?: () => Date;
  /** ID generator injection. Default: `crypto.randomUUID`. */
  uuid?: () => string;
  /** Structured logger. Default: JSON console.log (mirrors original). */
  logger?: Logger;
}

export class CustomerIntelligence {
  private readonly store: CustomerIntelligenceStore;
  private readonly leadScoreProvider: LeadScoreProvider;
  private readonly generateJson: JsonGenerator | null;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly log: Logger;

  constructor(options: CustomerIntelligenceOptions) {
    this.store = options.store;
    this.leadScoreProvider = options.leadScoreProvider ?? (async () => null);
    this.generateJson = options.generateJson ?? null;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.log = options.logger ?? defaultLogger;
  }

  // ─── Profile CRUD ────────────────────────────────────────────────────────

  async getCustomerProfiles(projectId: string): Promise<CustomerProfile[]> {
    const rows = await this.store.listProfiles(projectId);
    return rows ?? [];
  }

  async getCustomerProfile(profileId: string): Promise<CustomerProfile | null> {
    return this.store.getProfile(profileId);
  }

  // ─── Build unified profile ───────────────────────────────────────────────

  async buildUnifiedProfile(contactId: string, projectId: string): Promise<CustomerProfile> {
    const [contactRow, dealRows] = await Promise.all([
      this.store.getContact(contactId),
      this.store.listDealsByContact(contactId, projectId),
    ]);

    const contact = (contactRow ?? {}) as Record<string, unknown>;
    const deals = (dealRows ?? []) as Array<Record<string, unknown>>;
    const leadScore = await this.leadScoreProvider(contactId);

    const totalScore = leadScore?.total_score ?? 0;
    const hasDeal = deals.some((d) => d.stage === "won" || d.stage === "closed_won");
    const hasActiveDeal = deals.some((d) => d.stage === "negotiation" || d.stage === "proposal");

    let lifecycleStage: CustomerProfile["lifecycle_stage"] = "prospect";
    if (hasDeal) lifecycleStage = "customer";
    else if (hasActiveDeal) lifecycleStage = "opportunity";
    else if (totalScore >= 50) lifecycleStage = "lead";

    const contactStage = String(contact.lifecycle_stage ?? "");
    if (contactStage === "churned") lifecycleStage = "churned";

    const purchaseIntentScore = Math.min(100, Math.round(
      totalScore * 0.4 +
      (deals.length > 0 ? 30 : 0) +
      (leadScore?.engagement_score ?? 0) * 0.3,
    ));

    const meta = (contact.metadata as Record<string, unknown>) ?? {};
    const daysSinceActivity = meta.last_activity_at
      ? Math.floor((this.now().getTime() - new Date(String(meta.last_activity_at)).getTime()) / 86_400_000)
      : 90;

    let churnRiskScore = 0;
    if (lifecycleStage === "customer") {
      churnRiskScore = Math.min(100, Math.max(0, Math.round(
        (daysSinceActivity > 30 ? 30 : 0) +
        (daysSinceActivity > 60 ? 20 : 0) +
        (totalScore < 30 ? 25 : 0) +
        (Number(meta.support_tickets ?? 0) > 3 ? 25 : 0),
      )));
    }

    const now = this.now().toISOString();
    const profile: CustomerProfile = {
      id: this.uuid(),
      project_id: projectId,
      contact_id: contactId,
      company_name: String(contact.company ?? contact.name ?? ""),
      lifecycle_stage: lifecycleStage,
      purchase_intent_score: purchaseIntentScore,
      churn_risk_score: churnRiskScore,
      churn_risk_level: deriveChurnRiskLevel(churnRiskScore),
      last_activity_at: String(meta.last_activity_at ?? now),
      metadata: {
        lead_score: totalScore,
        deals_count: deals.length,
        contact_source: contact.source,
      },
      updated_at: now,
    };

    const existingId = await this.store.findProfileId(contactId, projectId);

    if (existingId) {
      profile.id = existingId;
      await this.store.patchProfile(existingId, {
        ...profile,
        updated_at: now,
      });
    } else {
      await this.store.insertProfile({
        ...profile,
        created_at: now,
      });
    }

    return profile;
  }

  // ─── Churn prediction ────────────────────────────────────────────────────

  async predictChurnRisk(profileId: string): Promise<{
    risk_score: number;
    risk_level: string;
    signals: ChurnSignal[];
  }> {
    const profile = await this.getCustomerProfile(profileId);
    if (!profile) {
      return { risk_score: 0, risk_level: "low", signals: [] };
    }

    const system =
      "You are a B2B SaaS churn prediction engine. Analyze the customer profile data and identify churn risk signals. " +
      "Return JSON with risk_score (0-100), risk_level (low|medium|high|critical), and signals array.";

    const prompt = [
      "Analyze this customer profile for churn risk:",
      `Company: ${profile.company_name}`,
      `Lifecycle: ${profile.lifecycle_stage}`,
      `Purchase Intent: ${profile.purchase_intent_score}`,
      `Current Churn Score: ${profile.churn_risk_score}`,
      `Last Activity: ${profile.last_activity_at}`,
      `Metadata: ${JSON.stringify(profile.metadata)}`,
    ].join("\n");

    const fallback = {
      risk_score: profile.churn_risk_score,
      risk_level: profile.churn_risk_level,
      signals: [] as ChurnSignal[],
    };

    if (!this.generateJson) return fallback;

    const result = await this.generateJson<typeof fallback>(
      system,
      prompt,
      fallback,
      { maxTokens: 1000 },
    );

    const riskScore = Math.min(100, Math.max(0, Number(result.risk_score ?? 0)));
    const riskLevel = deriveChurnRiskLevel(riskScore);

    await this.store.patchProfile(profileId, {
      churn_risk_score: riskScore,
      churn_risk_level: riskLevel,
      updated_at: this.now().toISOString(),
    });

    return {
      risk_score: riskScore,
      risk_level: riskLevel,
      signals: result.signals ?? [],
    };
  }

  // ─── Purchase intent ─────────────────────────────────────────────────────

  async calculatePurchaseIntent(profileId: string): Promise<{
    intent_score: number;
    signals: string[];
  }> {
    const profile = await this.getCustomerProfile(profileId);
    if (!profile) {
      return { intent_score: 0, signals: [] };
    }

    const system =
      "You are a B2B purchase intent analyzer. Analyze the customer data and return JSON with " +
      "intent_score (0-100) and signals (array of descriptive strings explaining intent indicators).";

    const prompt = [
      "Analyze purchase intent for this customer:",
      `Company: ${profile.company_name}`,
      `Lifecycle: ${profile.lifecycle_stage}`,
      `Current Intent Score: ${profile.purchase_intent_score}`,
      `Churn Risk: ${profile.churn_risk_level}`,
      `Last Activity: ${profile.last_activity_at}`,
      `Metadata: ${JSON.stringify(profile.metadata)}`,
    ].join("\n");

    const fallback = {
      intent_score: profile.purchase_intent_score,
      signals: [] as string[],
    };

    if (!this.generateJson) return fallback;

    const result = await this.generateJson<typeof fallback>(
      system,
      prompt,
      fallback,
      { maxTokens: 1000 },
    );

    const intentScore = Math.min(100, Math.max(0, Number(result.intent_score ?? 0)));

    await this.store.patchProfile(profileId, {
      purchase_intent_score: intentScore,
      updated_at: this.now().toISOString(),
    });

    return {
      intent_score: intentScore,
      signals: result.signals ?? [],
    };
  }

  // ─── Sync all profiles ───────────────────────────────────────────────────

  async syncAllProfiles(projectId: string): Promise<{ synced: number; errors: number }> {
    const contacts = await this.store.listContactIds(projectId);

    if (!contacts || contacts.length === 0) {
      this.log("INFO", "syncAllProfiles", `No contacts found for project ${projectId}`);
      return { synced: 0, errors: 0 };
    }

    let synced = 0;
    let errors = 0;

    for (const c of contacts) {
      const contactId = String(c.id ?? "");
      try {
        await this.buildUnifiedProfile(contactId, projectId);
        synced++;
      } catch (err: unknown) {
        errors++;
        this.log("ERROR", "syncAllProfiles", `Failed for contact ${contactId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.log("INFO", "syncAllProfiles", `Synced ${synced} profiles, ${errors} errors for project ${projectId}`);
    return { synced, errors };
  }
}

// ─── In-memory implementation ────────────────────────────────────────────────

/** In-memory CustomerIntelligenceStore mirroring the PostgREST query semantics. */
export class InMemoryCustomerIntelligenceStore implements CustomerIntelligenceStore {
  profiles: Array<CustomerProfile & Record<string, unknown>> = [];
  contacts: Array<Record<string, unknown> & { id: string; project_id?: string }> = [];
  deals: Array<Record<string, unknown> & { contact_id?: string; project_id?: string }> = [];

  async listProfiles(projectId: string): Promise<CustomerProfile[] | null> {
    return this.profiles
      .filter((p) => p.project_id === projectId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getProfile(profileId: string): Promise<CustomerProfile | null> {
    return this.profiles.find((p) => p.id === profileId) ?? null;
  }

  async getContact(contactId: string): Promise<Record<string, unknown> | null> {
    return this.contacts.find((c) => c.id === contactId) ?? null;
  }

  async listDealsByContact(contactId: string, projectId: string): Promise<Array<Record<string, unknown>> | null> {
    return this.deals.filter(
      (d) =>
        d.contact_id === contactId &&
        (d.project_id === undefined || d.project_id === projectId),
    );
  }

  async findProfileId(contactId: string, projectId: string): Promise<string | null> {
    return (
      this.profiles.find((p) => p.contact_id === contactId && p.project_id === projectId)?.id ??
      null
    );
  }

  async insertProfile(row: Record<string, unknown>): Promise<void> {
    this.profiles.push({ ...row } as CustomerProfile & Record<string, unknown>);
  }

  async patchProfile(profileId: string, patch: Record<string, unknown>): Promise<void> {
    const row = this.profiles.find((p) => p.id === profileId);
    if (row) Object.assign(row, patch);
  }

  async listContactIds(projectId: string): Promise<Array<{ id: string }> | null> {
    return this.contacts
      .filter((c) => c.project_id === undefined || c.project_id === projectId)
      .map((c) => ({ id: c.id }));
  }
}
