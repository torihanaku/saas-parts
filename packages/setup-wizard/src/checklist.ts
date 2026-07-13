/**
 * Onboarding progress checklist.
 * Ported from 実運用SaaS `server/routes/setup-wizard.ts` (GET /api/setup/checklist).
 */

export interface ChecklistItem {
  key: string;
  label: string;
  completed: boolean;
  action_url: string;
}

export interface ChecklistResult {
  items: ChecklistItem[];
  completed_count: number;
  total_count: number;
}

/**
 * Data the checklist needs, injected (replaces direct Supabase row counts +
 * env reads). `hasRows(dataset)` returns whether the given dataset is non-empty.
 * Datasets: "content" | "report" | "backlog" | "knowledge" | "integration" | "crm".
 */
export interface ChecklistDataProvider {
  isDatabaseConfigured(): boolean | Promise<boolean>;
  isAiConfigured(): boolean | Promise<boolean>;
  hasRows(dataset: ChecklistDataset): boolean | Promise<boolean>;
}

export type ChecklistDataset =
  | "content"
  | "report"
  | "backlog"
  | "knowledge"
  | "integration"
  | "crm";

export async function computeChecklist(provider: ChecklistDataProvider): Promise<ChecklistResult> {
  const dbConfigured = await provider.isDatabaseConfigured();
  const aiConfigured = await provider.isAiConfigured();

  // Row-count checks only run when the DB is configured (mirrors original).
  const rows = async (ds: ChecklistDataset): Promise<boolean> =>
    dbConfigured ? await provider.hasRows(ds) : false;

  const items: ChecklistItem[] = [
    { key: "database_connected", label: "データベースを接続する", completed: dbConfigured, action_url: "/settings?tab=setup&step=database" },
    { key: "ai_configured", label: "Claude AI を設定する", completed: aiConfigured, action_url: "/settings?tab=setup&step=ai" },
    { key: "first_content", label: "最初のコンテンツを作成する", completed: await rows("content"), action_url: "/content-studio" },
    { key: "first_report", label: "レポートを生成する", completed: await rows("report"), action_url: "/metrics" },
    { key: "first_backlog_item", label: "バックログにタスクを追加する", completed: await rows("backlog"), action_url: "/backlog" },
    { key: "first_knowledge", label: "ナレッジを追加する", completed: await rows("knowledge"), action_url: "/knowledge-inbox" },
    { key: "first_integration", label: "外部ツールを連携する", completed: await rows("integration"), action_url: "/settings?tab=integrations" },
    { key: "first_crm_deal", label: "CRM案件を登録する", completed: await rows("crm"), action_url: "/crm-dashboard" },
  ];

  const completed_count = items.filter((i) => i.completed).length;
  return { items, completed_count, total_count: items.length };
}
