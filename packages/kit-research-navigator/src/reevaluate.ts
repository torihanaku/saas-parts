/**
 * 週次再評価ジョブ (トレンドクラスタ検出 → 昇格 / ノイズ削除)。
 *
 * - 直近 windowDays 日の "worth_watching" context が promoteMinCount 件以上
 *   あればトレンドとみなし、importance 最上位のシグナルを代表として
 *   LLM で仮説カードを生成、クラスタ全 context を "big_deal" に昇格する。
 * - purgeDays 日より古い "meh" context を削除する。
 *
 * 代表選出は importance_score 降順 → signalId 昇順の決定的タイブレーク。
 *
 * 出典: dev-dashboard-v2 server/jobs/nav-weekly-reevaluate.ts
 */
import type { CardStore, ContextStore, LlmClient, SignalStore } from "./ports";
import type { Card, SignalContext } from "./types";

export interface ReevaluateDeps {
  signalStore: SignalStore;
  contextStore: ContextStore;
  cardStore: CardStore;
  /** null の場合は昇格をスキップ (purge のみ実行)。 */
  llm: LlmClient | null;
  now?: () => Date;
  onWarn?: (message: string, error?: unknown) => void;
}

export interface ReevaluateOptions {
  /** トレンド判定の観測窓 (日)。既定 7。 */
  windowDays?: number;
  /** この件数以上 worth_watching が溜まったら昇格。既定 3。 */
  promoteMinCount?: number;
  /** これより古い meh を削除 (日)。既定 30。 */
  purgeDays?: number;
}

export interface ReevaluateResult {
  promoted: number;
  purged: number;
  promotedCard: Card | null;
}

interface TrendCardDraft {
  title: string;
  summary: string;
  hypothesis: string;
  rationale: string;
}

function buildTrendPrompt(title: string, summary: string): string {
  return `You are a staff engineer analyzing a weekly trend of 'worth_watching' signals.
The following signal is representative of a recent cluster:
Title: ${title}
Summary: ${summary}

Generate a Hypothesis Card draft for this trend.
Output JSON:
{
  "title": "A concise title for the hypothesis",
  "summary": "A 1-2 sentence summary of the trend",
  "hypothesis": "The core hypothesis to test",
  "rationale": "Why this matters now based on the cluster of signals"
}`;
}

/** 決定的な代表選出: importance 降順 → signalId 昇順。 */
export function pickRepresentative(
  contexts: SignalContext[],
): SignalContext | null {
  if (contexts.length === 0) return null;
  const sorted = [...contexts].sort(
    (a, b) =>
      b.importanceScore - a.importanceScore ||
      a.signalId.localeCompare(b.signalId),
  );
  return sorted[0] ?? null;
}

export async function reevaluateSignals(
  userId: string,
  deps: ReevaluateDeps,
  options: ReevaluateOptions = {},
): Promise<ReevaluateResult> {
  const now = deps.now ?? (() => new Date());
  const windowDays = options.windowDays ?? 7;
  const promoteMinCount = options.promoteMinCount ?? 3;
  const purgeDays = options.purgeDays ?? 30;

  const nowMs = now().getTime();
  const windowStart = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const purgeBefore = new Date(nowMs - purgeDays * 86_400_000).toISOString();

  const result: ReevaluateResult = { promoted: 0, purged: 0, promotedCard: null };

  // 1. トレンド昇格
  const watching = await deps.contextStore.listByVerdictSince(
    userId,
    "worth_watching",
    windowStart,
  );

  if (watching.length >= promoteMinCount && deps.llm) {
    const representative = pickRepresentative(watching);
    const signal = representative
      ? await deps.signalStore.getById(userId, representative.signalId)
      : null;

    if (representative && signal) {
      const draft = await deps.llm.generateJson<TrendCardDraft>({
        user: buildTrendPrompt(signal.title, representative.rationale),
      });

      if (draft) {
        const card = await deps.cardStore.insert(userId, {
          triggerSource: "signal",
          triggerSignalId: signal.id,
          title: draft.title,
          summary: draft.summary,
          hypothesis: draft.hypothesis,
          status: "draft",
          cardData: {
            source: {
              kind: "manual",
              title: signal.title,
              url: signal.url,
              summary: draft.summary,
              capturedAt: now().toISOString(),
            },
            tool: { kind: "pattern", name: draft.title },
            integration: {
              bridgeType: "manual",
              notes: `Weekly trend cluster: ${watching
                .map((c) => c.signalId)
                .sort()
                .join(", ")}`,
            },
            output: { kind: "experiment_spec", draftText: draft.hypothesis },
            meta: {
              importanceScore: 0.7,
              rationale: draft.rationale,
              generatedBy: "llm-weekly-trend",
              sourceVersion: "v1",
            },
          },
        });
        result.promotedCard = card;
        result.promoted = 1;

        // 再処理を防ぐため、クラスタ全体を big_deal に更新
        for (const ctx of watching) {
          await deps.contextStore.updateVerdict(ctx.id, "big_deal");
        }
      } else {
        deps.onWarn?.("reevaluate: trend card generation returned null");
      }
    }
  }

  // 2. 古い meh を削除
  result.purged = await deps.contextStore.deleteOlderThan(
    userId,
    "meh",
    purgeBefore,
  );

  return result;
}
