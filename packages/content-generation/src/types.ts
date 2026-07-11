/**
 * 共有型 + LLM 注入ポート。
 *
 * dev-dashboard-v2 の content-engine / prototype / content routes から抽出。
 * Claude クライアントは関数型 `GenerateText` / `GenerateJson` として注入する
 * （原実装の `generateText(apiKey, system, user, opts)` 等を汎用化）。
 */

/** テキストを返す LLM 呼び出し。 */
export type GenerateText = (
  system: string,
  user: string,
  options?: { maxTokens?: number },
) => Promise<string>;

/** JSON を返す LLM 呼び出し（失敗時に fallback を返す実装を想定）。 */
export type GenerateJson = <T>(
  system: string,
  user: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

/* ── コンテキスト素材（プロンプトへ差し込む外部情報） ────────────────────── */

export interface IntelligenceItem {
  title: string;
  source: string;
  summary?: string;
}

export interface KnowledgeItem {
  title: string;
  summary?: string;
  content?: string;
}

export interface CrmContact {
  company?: string;
  industry?: string;
  stage?: string;
}
