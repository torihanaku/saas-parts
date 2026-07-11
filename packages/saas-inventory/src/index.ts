/**
 * @torihanaku/saas-inventory — 組織の SaaS 利用棚卸し
 *
 * プロジェクト（テナント）が使う SaaS ツールの一覧管理・コスト集計・自動検出・
 * 重複検知を行う。
 *
 * 出典: dev-dashboard-v2 server/lib/saas-inventory.ts。
 * 移植方針:
 * - DB アクセス (supabaseGet/Insert/Patch) は `InventoryStore` の注入に置換。
 * - integration 自動検出のソース (nango-sync getIntegrationStatus) は
 *   `IntegrationSource` の注入に置換。
 * - ロジック（CRUD・カテゴリ写像・spend 集計）は原文どおり (port; not rewrite)。
 */

export interface SaaSItem {
  id: string;
  project_id: string;
  tool_name: string;
  category: string;
  status: "active" | "inactive" | "trial";
  monthly_cost: number;
  integration_status: "connected" | "disconnected" | "partial";
  owner: string;
  renewal_date: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
}

/** 自動検出に使う integration の接続状態 (nango-sync getIntegrationStatus 相当)。 */
export interface IntegrationStatus {
  integration: string;
  sourceType: string;
  connected: boolean;
  connectionCount: number;
}

/** integration 接続状態を返すソース (注入式)。 */
export type IntegrationSource = () => Promise<IntegrationStatus[]>;

/**
 * SaaS インベントリの永続化ストア (注入式)。
 * dev-dashboard-v2 では Supabase (`dd_saas_inventory`) だった。
 */
export interface InventoryStore {
  /** project 内の全アイテムを tool_name 昇順で返す。 */
  list(projectId: string): Promise<SaaSItem[]>;
  /** (projectId, toolName) の既存アイテムを 1 件返す (無ければ null)。 */
  findByTool(projectId: string, toolName: string): Promise<SaaSItem | null>;
  /** 新規アイテムを保存する。 */
  insert(item: SaaSItem): Promise<void>;
  /** id 指定で部分更新する。 */
  patch(id: string, patch: Partial<SaaSItem>): Promise<void>;
}

/** 自動検出ツール → カテゴリの写像。 */
export const TOOL_CATEGORY_MAP: Record<string, string> = {
  hubspot: "crm",
  salesforce: "crm",
  slack: "communication",
  "microsoft-teams": "communication",
  "google-mail": "communication",
  "google-analytics": "analytics",
  "google-search-console": "analytics",
  "google-ads": "marketing",
  facebook: "marketing",
  instagram: "marketing",
  mailchimp: "marketing",
  notion: "development",
  jira: "development",
  asana: "development",
  linear: "development",
  github: "development",
  confluence: "development",
  "google-drive": "other",
  zoom: "communication",
  wordpress: "marketing",
  youtube: "marketing",
};

export interface SaaSInventoryDeps {
  store: InventoryStore;
  /** 自動検出のソース。detectSaaSFromIntegrations を使う場合のみ必須。 */
  integrations?: IntegrationSource;
  /** カテゴリ写像の差し替え (省略時は TOOL_CATEGORY_MAP)。 */
  categoryMap?: Record<string, string>;
  /** uuid 生成 (省略時は crypto.randomUUID)。 */
  newId?: () => string;
  /** now ISO 生成 (省略時は new Date().toISOString())。 */
  now?: () => string;
}

/** SaaS インベントリマネージャ。store / integrations を注入して生成する。 */
export function createSaaSInventory(deps: SaaSInventoryDeps) {
  const { store } = deps;
  const categoryMap = deps.categoryMap ?? TOOL_CATEGORY_MAP;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());

  async function getSaaSInventory(projectId: string): Promise<SaaSItem[]> {
    return store.list(projectId);
  }

  async function upsertSaaSItem(
    item: Partial<SaaSItem> & { project_id: string; tool_name: string },
  ): Promise<SaaSItem> {
    const ts = now();
    const existing = await store.findByTool(item.project_id, item.tool_name);

    if (existing) {
      const updateData = { ...item, updated_at: ts };
      await store.patch(existing.id, updateData);
      return { ...existing, ...updateData } as SaaSItem;
    }

    const newItem: SaaSItem = {
      id: newId(),
      project_id: item.project_id,
      tool_name: item.tool_name,
      category: item.category ?? "other",
      status: item.status ?? "active",
      monthly_cost: item.monthly_cost ?? 0,
      integration_status: item.integration_status ?? "disconnected",
      owner: item.owner ?? "",
      renewal_date: item.renewal_date ?? null,
      metadata: item.metadata ?? {},
      updated_at: ts,
    };
    await store.insert(newItem);
    return newItem;
  }

  async function detectSaaSFromIntegrations(projectId: string): Promise<SaaSItem[]> {
    if (!deps.integrations) {
      throw new Error("IntegrationSource not provided; pass `integrations` to createSaaSInventory");
    }
    const integrations = await deps.integrations();
    const detected: SaaSItem[] = [];

    for (const integration of integrations) {
      if (!integration.connected) continue;
      const category = categoryMap[integration.integration] ?? "other";
      const item = await upsertSaaSItem({
        project_id: projectId,
        tool_name: integration.integration,
        category,
        status: "active",
        integration_status: "connected",
        metadata: {
          auto_detected: true,
          source_type: integration.sourceType,
          connection_count: integration.connectionCount,
        },
      });
      detected.push(item);
    }
    return detected;
  }

  async function getSaaSSpendSummary(projectId: string): Promise<{
    total_monthly: number;
    by_category: Record<string, number>;
  }> {
    const items = await getSaaSInventory(projectId);
    const activeItems = items.filter((i) => i.status === "active");

    const byCategory: Record<string, number> = {};
    let totalMonthly = 0;
    for (const item of activeItems) {
      totalMonthly += item.monthly_cost;
      const cat = item.category || "other";
      byCategory[cat] = (byCategory[cat] ?? 0) + item.monthly_cost;
    }
    return { total_monthly: totalMonthly, by_category: byCategory };
  }

  /**
   * 重複検知: 同一 project 内で tool_name が重複する（大文字小文字・前後空白を無視して同一の）
   * アイテムをグループ化して返す。同名複数登録・表記ゆれの掃除に使う。
   */
  async function findDuplicates(
    projectId: string,
  ): Promise<Array<{ key: string; items: SaaSItem[] }>> {
    const items = await getSaaSInventory(projectId);
    const groups = new Map<string, SaaSItem[]>();
    for (const item of items) {
      const key = item.tool_name.trim().toLowerCase();
      const g = groups.get(key) ?? [];
      g.push(item);
      groups.set(key, g);
    }
    return [...groups.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([key, items]) => ({ key, items }));
  }

  return {
    getSaaSInventory,
    upsertSaaSItem,
    detectSaaSFromIntegrations,
    getSaaSSpendSummary,
    findDuplicates,
  };
}

export type SaaSInventory = ReturnType<typeof createSaaSInventory>;
