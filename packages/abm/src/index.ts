/**
 * @torihanaku/abm — Account-Based Marketing エンジン
 *
 * 連絡先を会社単位で ABM アカウントに集約し、tier 判定・エンゲージメント
 * スコア算出・パーソナライズ戦略生成（LLM）を行う。
 *
 * 出典: dev-dashboard-v2 server/lib/abm-service.ts
 *
 * 移植方針:
 * - Supabase 直呼び（supabaseGet/Insert/Patch）を `AbmStore` インターフェースに
 *   抽象化。in-memory 実装（`InMemoryAbmStore`）を同梱。
 * - LLM 呼び出し（generateJson）は注入式。
 * - env / tenant-secrets 依存の API キー解決を注入式 `resolveApiKey` に置換
 *   （省略時はキーゲートをスキップし空文字を渡す）。
 * - tier / engagement の閾値を `AbmThresholds` で config 化（原値をデフォルト）。
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ABMAccount {
  id: string;
  project_id: string;
  company_name: string;
  tier: "tier1" | "tier2" | "tier3";
  score: number;
  contacts_count: number;
  total_deal_value: number;
  engagement_level: "cold" | "warm" | "hot";
  strategy_notes: string;
  updated_at: string;
}

export interface ABMSegment {
  name: string;
  accounts: ABMAccount[];
  criteria: Record<string, unknown>;
}

/** CRM 連絡先（sync 入力）。 */
export interface CrmContact {
  id: string;
  company?: string;
  metadata?: Record<string, unknown>;
}

/** CRM 商談（sync 入力）。 */
export interface CrmDeal {
  amount?: number;
  contact_id?: string;
}

/**
 * 永続化の抽象。原典 Supabase テーブル（dd_abm_accounts / dd_crm_contacts /
 * dd_crm_deals）へのアクセスを最小 API に落とし込んだもの。
 */
export interface AbmStore {
  /** project の ABM アカウントを score 降順で返す。 */
  getAccountsByProject(projectId: string): Promise<ABMAccount[]>;
  /** id でアカウントを 1 件取得（無ければ null）。 */
  getAccountById(accountId: string): Promise<ABMAccount | null>;
  /** project + company で既存アカウントを取得（無ければ null）。 */
  getAccountByCompany(projectId: string, companyName: string): Promise<ABMAccount | null>;
  /** アカウントの部分更新。 */
  patchAccount(accountId: string, patch: Partial<ABMAccount>): Promise<void>;
  /** アカウント新規作成。 */
  insertAccount(account: ABMAccount): Promise<void>;
  /** project の CRM 連絡先を返す。 */
  getContactsByProject(projectId: string): Promise<CrmContact[]>;
  /** project の CRM 商談を返す。 */
  getDealsByProject(projectId: string): Promise<CrmDeal[]>;
}

/** tier / engagement 判定の閾値（原典のハードコード値をデフォルトに）。 */
export interface AbmThresholds {
  tier1MinScore: number;
  tier1MinDealValue: number;
  tier2MinScore: number;
  tier2MinDealValue: number;
  hotMinScore: number;
  hotMinContacts: number;
  warmMinScore: number;
  warmMinContacts: number;
}

export const DEFAULT_THRESHOLDS: AbmThresholds = {
  tier1MinScore: 80,
  tier1MinDealValue: 1_000_000,
  tier2MinScore: 50,
  tier2MinDealValue: 300_000,
  hotMinScore: 70,
  hotMinContacts: 3,
  warmMinScore: 40,
  warmMinContacts: 2,
};

/** LLM への構造化 JSON 生成（@torihanaku/claude-api の generateJson 互換）。 */
export type GenerateJson = <T>(
  apiKey: string,
  system: string,
  userPrompt: string,
  fallback: T,
  options?: { maxTokens?: number; timeout?: number },
) => Promise<T>;

/** ロガー（省略時は no-op）。 */
export type Logger = (level: string, message: string, detail?: string) => void;

/**
 * API キー解決。原典の tenant-secret → env fallback を注入式に。
 * 省略時は常に空文字を返す（キーゲートで fallback に落ちる）。
 */
export type ResolveApiKey = (tenantId: string | null) => Promise<string> | string;

export interface AbmConfig {
  store: AbmStore;
  generateJson: GenerateJson;
  resolveApiKey?: ResolveApiKey;
  thresholds?: AbmThresholds;
  logger?: Logger;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function deriveTier(
  score: number,
  dealValue: number,
  t: AbmThresholds = DEFAULT_THRESHOLDS,
): ABMAccount["tier"] {
  if (score >= t.tier1MinScore || dealValue >= t.tier1MinDealValue) return "tier1";
  if (score >= t.tier2MinScore || dealValue >= t.tier2MinDealValue) return "tier2";
  return "tier3";
}

export function deriveEngagement(
  score: number,
  contactsCount: number,
  t: AbmThresholds = DEFAULT_THRESHOLDS,
): ABMAccount["engagement_level"] {
  if (score >= t.hotMinScore && contactsCount >= t.hotMinContacts) return "hot";
  if (score >= t.warmMinScore || contactsCount >= t.warmMinContacts) return "warm";
  return "cold";
}

function makeLog(logger?: Logger): Logger {
  return logger ?? (() => {});
}

// ─── Account CRUD ────────────────────────────────────────────────────────────

export async function getABMAccounts(config: AbmConfig, projectId: string): Promise<ABMAccount[]> {
  return config.store.getAccountsByProject(projectId);
}

// ─── Segment accounts ────────────────────────────────────────────────────────

export async function segmentAccounts(config: AbmConfig, projectId: string): Promise<ABMSegment[]> {
  const t = config.thresholds ?? DEFAULT_THRESHOLDS;
  const accounts = await getABMAccounts(config, projectId);

  const tier1 = accounts.filter((a) => a.tier === "tier1");
  const tier2 = accounts.filter((a) => a.tier === "tier2");
  const tier3 = accounts.filter((a) => a.tier === "tier3");

  return [
    {
      name: "Strategic Accounts (Tier 1)",
      accounts: tier1,
      criteria: { tier: "tier1", min_score: t.tier1MinScore, min_deal_value: t.tier1MinDealValue },
    },
    {
      name: "Growth Accounts (Tier 2)",
      accounts: tier2,
      criteria: { tier: "tier2", min_score: t.tier2MinScore, min_deal_value: t.tier2MinDealValue },
    },
    {
      name: "Nurture Accounts (Tier 3)",
      accounts: tier3,
      criteria: { tier: "tier3" },
    },
  ];
}

// ─── Generate ABM strategy ───────────────────────────────────────────────────

export async function generateABMStrategy(
  config: AbmConfig,
  accountId: string,
  tenantId: string | null = null,
): Promise<{ strategy: string; tactics: string[] }> {
  const account = await config.store.getAccountById(accountId);

  const fallback = { strategy: "", tactics: [] as string[] };
  if (!account) return fallback;

  const resolve = config.resolveApiKey ?? (() => "");
  const apiKey = (await resolve(tenantId)) || "";
  if (!apiKey) return fallback;

  const system =
    "You are a B2B account-based marketing strategist. Analyze the account data and generate a " +
    "personalized strategy. Return JSON with strategy (string, 2-3 paragraphs) and tactics (array of 3-5 actionable items).";

  const prompt = [
    "Generate an ABM strategy for this account:",
    `Company: ${account.company_name}`,
    `Tier: ${account.tier}`,
    `Score: ${account.score}`,
    `Contacts: ${account.contacts_count}`,
    `Deal Value: ¥${account.total_deal_value.toLocaleString()}`,
    `Engagement: ${account.engagement_level}`,
    account.strategy_notes ? `Previous Notes: ${account.strategy_notes}` : "",
  ].filter(Boolean).join("\n");

  const result = await config.generateJson<typeof fallback>(
    apiKey,
    system,
    prompt,
    fallback,
    { maxTokens: 1500 },
  );

  if (result.strategy) {
    await config.store.patchAccount(accountId, {
      strategy_notes: result.strategy,
      updated_at: new Date().toISOString(),
    });
  }

  return {
    strategy: result.strategy ?? "",
    tactics: result.tactics ?? [],
  };
}

// ─── Sync ABM accounts ──────────────────────────────────────────────────────

export async function syncABMAccounts(config: AbmConfig, projectId: string): Promise<{ synced: number }> {
  const t = config.thresholds ?? DEFAULT_THRESHOLDS;
  const log = makeLog(config.logger);

  const contacts = await config.store.getContactsByProject(projectId);

  if (!contacts || contacts.length === 0) {
    log("INFO", "syncABMAccounts", `No contacts for project ${projectId}`);
    return { synced: 0 };
  }

  const companyMap = new Map<string, { contactIds: string[]; metadata: Record<string, unknown>[] }>();
  for (const c of contacts) {
    const company = String(c.company ?? "").trim();
    if (!company) continue;
    const entry = companyMap.get(company) ?? { contactIds: [], metadata: [] };
    entry.contactIds.push(String(c.id));
    entry.metadata.push(c.metadata ?? {});
    companyMap.set(company, entry);
  }

  let synced = 0;

  for (const [companyName, data] of companyMap) {
    const deals = await config.store.getDealsByProject(projectId);

    const companyDealTotal = (deals ?? [])
      .filter((d) => data.contactIds.includes(String(d.contact_id)))
      .reduce((sum, d) => sum + Number(d.amount ?? 0), 0);

    const avgScore =
      data.metadata.reduce((sum, m) => sum + Number(m.lead_score ?? 0), 0) / data.metadata.length;
    const score = Math.min(100, Math.round(avgScore + data.contactIds.length * 5));
    const tier = deriveTier(score, companyDealTotal, t);
    const engagement = deriveEngagement(score, data.contactIds.length, t);
    const now = new Date().toISOString();

    const existing = await config.store.getAccountByCompany(projectId, companyName);

    const accountData = {
      project_id: projectId,
      company_name: companyName,
      tier,
      score,
      contacts_count: data.contactIds.length,
      total_deal_value: companyDealTotal,
      engagement_level: engagement,
      updated_at: now,
    };

    if (existing) {
      await config.store.patchAccount(existing.id, accountData);
    } else {
      await config.store.insertAccount({
        id: crypto.randomUUID(),
        ...accountData,
        strategy_notes: "",
      });
    }
    synced++;
  }

  log("INFO", "syncABMAccounts", `Synced ${synced} accounts for project ${projectId}`);
  return { synced };
}

// ─── In-memory store ─────────────────────────────────────────────────────────

/**
 * ストア注入の即戦力デフォルト。テスト・PoC 向けの完全 in-memory 実装。
 */
export class InMemoryAbmStore implements AbmStore {
  private accounts: ABMAccount[] = [];
  private contacts = new Map<string, CrmContact[]>();
  private deals = new Map<string, CrmDeal[]>();

  constructor(seed?: { accounts?: ABMAccount[]; contacts?: Record<string, CrmContact[]>; deals?: Record<string, CrmDeal[]> }) {
    if (seed?.accounts) this.accounts = [...seed.accounts];
    if (seed?.contacts) for (const [k, v] of Object.entries(seed.contacts)) this.contacts.set(k, v);
    if (seed?.deals) for (const [k, v] of Object.entries(seed.deals)) this.deals.set(k, v);
  }

  async getAccountsByProject(projectId: string): Promise<ABMAccount[]> {
    return this.accounts
      .filter((a) => a.project_id === projectId)
      .sort((a, b) => b.score - a.score)
      .map((a) => ({ ...a }));
  }

  async getAccountById(accountId: string): Promise<ABMAccount | null> {
    const found = this.accounts.find((a) => a.id === accountId);
    return found ? { ...found } : null;
  }

  async getAccountByCompany(projectId: string, companyName: string): Promise<ABMAccount | null> {
    const found = this.accounts.find((a) => a.project_id === projectId && a.company_name === companyName);
    return found ? { ...found } : null;
  }

  async patchAccount(accountId: string, patch: Partial<ABMAccount>): Promise<void> {
    const idx = this.accounts.findIndex((a) => a.id === accountId);
    if (idx >= 0) this.accounts[idx] = { ...this.accounts[idx], ...patch } as ABMAccount;
  }

  async insertAccount(account: ABMAccount): Promise<void> {
    this.accounts.push({ ...account });
  }

  async getContactsByProject(projectId: string): Promise<CrmContact[]> {
    return [...(this.contacts.get(projectId) ?? [])];
  }

  async getDealsByProject(projectId: string): Promise<CrmDeal[]> {
    return [...(this.deals.get(projectId) ?? [])];
  }

  /** テスト補助: 現在のアカウント一覧を読む。 */
  _allAccounts(): ABMAccount[] {
    return this.accounts.map((a) => ({ ...a }));
  }
}
