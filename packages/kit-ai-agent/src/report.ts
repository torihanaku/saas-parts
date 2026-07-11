/**
 * Cycle report: summarize one plan period (actions + execution results) into
 * a human-readable report via the injected LLM — team向け(400字ナラティブ) と
 * executive向け(200字3bullet) の2オーディエンス。
 *
 * 出典: dev-dashboard-v2 server/lib/agent/report-service.ts
 * 変更点: Supabase 3テーブル join → CycleDataLoader 注入 /
 *         generateText(apiKey,…) + BYOK 解決 → LlmCaller 注入 /
 *         プロンプトは差し替え可能（デフォルトは元実装の文言から製品名を除去）。
 */
import type { LlmCaller } from "./llm";
import type { AgentAction, AgentPlan } from "./types";

export type ReportAudience = "team" | "executive";

export interface CycleData {
  plan: AgentPlan | null;
  actions: AgentAction[];
  executions: Array<{ result: "success" | "failure" | "timeout" }>;
}

export type CycleDataLoader = (tenantId: string, period: string) => Promise<CycleData>;

export interface CycleSummary {
  period: string;
  actionCount: number;
  successCount: number;
  failureCount: number;
  actionsSummary: string;
}

export interface ReportPrompts {
  teamSystem: string;
  executiveSystem: string;
  buildTeamPrompt(summary: CycleSummary): string;
  buildExecutivePrompt(summary: CycleSummary): string;
}

export const DEFAULT_REPORT_PROMPTS: ReportPrompts = {
  teamSystem:
    "あなたはマーケティングと法務レビューに精通したエキスパートです。週次レポートの要約を作成してください。",
  executiveSystem:
    "あなたは経営陣向けの週次ステータスをドラフトする秘書です。200 字以内・3 bullet・誇張なし・課題は短く明示。",
  buildTeamPrompt: (s) =>
    `週次レポート生成:\n- 実行 action ${s.actionCount} 件 (成功 ${s.successCount} / 失敗 ${s.failureCount})\n- 主要施策:\n${s.actionsSummary}\n\n日本語 400 字程度で「今週の成果」と「来週への学び」を書いてください。数字は誇張せず、失敗は正直に。`,
  buildExecutivePrompt: (s) =>
    `経営陣向け週次ステータス (period ${s.period}):\n- 実行 action ${s.actionCount} 件 (成功 ${s.successCount} / 失敗 ${s.failureCount})\n- 主要施策:\n${s.actionsSummary}\n\n以下の形式で 200 字以内・3 bullet:\n• 進捗:\n• 課題:\n• 来週フォーカス:`,
};

export interface ReporterConfig {
  llm: LlmCaller;
  loadCycle: CycleDataLoader;
  prompts?: ReportPrompts;
}

export interface Reporter {
  generateCycleReport(
    tenantId: string,
    period: string,
    audience?: ReportAudience,
  ): Promise<string>;
}

export function createReporter(config: ReporterConfig): Reporter {
  const prompts = config.prompts ?? DEFAULT_REPORT_PROMPTS;

  return {
    async generateCycleReport(tenantId, period, audience = "team") {
      const { plan, actions, executions } = await config.loadCycle(tenantId, period);
      if (!plan) return `Period ${period}: プランが存在しませんでした。`;

      const summary: CycleSummary = {
        period,
        actionCount: actions.length,
        successCount: executions.filter((e) => e.result === "success").length,
        failureCount: executions.filter((e) => e.result === "failure").length,
        actionsSummary: actions
          .slice(0, 5)
          .map((a) => `  - ${a.action_type}: ${JSON.stringify(a.payload ?? {}).slice(0, 80)}`)
          .join("\n"),
      };

      const isExecutive = audience === "executive";
      try {
        const text = await config.llm.generateText(
          isExecutive ? prompts.executiveSystem : prompts.teamSystem,
          isExecutive ? prompts.buildExecutivePrompt(summary) : prompts.buildTeamPrompt(summary),
        );
        return text || "レポートの生成に失敗しました。";
      } catch (error) {
        return `レポート生成中にエラーが発生しました: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  };
}
