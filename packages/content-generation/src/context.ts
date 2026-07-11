import type { CrmContact, IntelligenceItem, KnowledgeItem } from "./types.js";

/**
 * プロンプトへ差し込むコンテキスト素材を整形する純粋関数群。
 * dev-dashboard-v2 の context-builder から、コンテンツ生成で使う部分だけを抽出。
 */

export function formatIntelligenceContext(items: IntelligenceItem[], limit = 5): string {
  if (!items.length) return "";
  const lines = items.slice(0, limit).map((i) => `- ${i.title} (${i.source})`);
  return `\n参考ニュース:\n${lines.join("\n")}`;
}

export function formatKnowledgeContext(items: KnowledgeItem[], limit = 5): string {
  if (!items.length) return "";
  const lines = items.slice(0, limit).map(
    (i) => `- ${i.title}${i.summary ? `: ${i.summary.substring(0, 100)}` : ""}`,
  );
  return `\nナレッジベース:\n${lines.join("\n")}`;
}

export function formatCrmContext(contacts: CrmContact[], limit = 3): string {
  if (!contacts.length) return "";
  const lines = contacts.slice(0, limit).map(
    (c) => `- ${c.company ?? ""}（${c.industry ?? ""}、${c.stage ?? ""}）`,
  );
  return `\nターゲット顧客:\n${lines.join("\n")}`;
}

export interface CompositeContextOptions {
  extraContext?: string;
  intelligenceItems?: IntelligenceItem[];
  knowledgeItems?: KnowledgeItem[];
  crmContacts?: CrmContact[];
}

/** 複数のコンテキスト素材を 1 本のプロンプト文字列に結合。 */
export function buildCompositeContext(options: CompositeContextOptions = {}): string {
  const sections: string[] = [];
  const { extraContext = "" } = options;

  if (extraContext) sections.push(extraContext);
  if (options.intelligenceItems?.length) {
    sections.push(formatIntelligenceContext(options.intelligenceItems));
  }
  if (options.knowledgeItems?.length) {
    sections.push(formatKnowledgeContext(options.knowledgeItems));
  }
  if (options.crmContacts?.length) {
    sections.push(formatCrmContext(options.crmContacts));
  }

  return sections.filter(Boolean).join("");
}
