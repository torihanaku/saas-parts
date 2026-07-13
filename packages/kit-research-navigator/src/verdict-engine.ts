/**
 * Verdict エンジン — 取り込んだシグナル 1 件の重要度を LLM で判定する。
 *
 * 1. シグナル本文を埋め込み → 既存シグナルから類似シグナルを検索 (関連付け)
 * 2. ユーザーコンテキスト + 関連シグナルを添えて LLM に 3 値判定させる
 * 3. LLM 不在・失敗時は "meh" (score 0) にフォールバック
 *
 * 出典: 実運用SaaS server/lib/navigator/verdict-engine.ts
 */
import type { LlmClient, Embedder, SignalStore } from "./ports";
import type { ContextVerdict, Signal } from "./types";
import { ContextVerdictLlmSchema } from "./schemas";

export interface VerdictEngineDeps {
  /** null の場合は常にフォールバック verdict を返す。 */
  llm: LlmClient | null;
  /** 省略時は類似検索をスキップ (relatedSignalIds は空)。 */
  embedder?: Embedder;
  signalStore: SignalStore;
  /** 類似判定の閾値。既定 0.7。 */
  matchThreshold?: number;
  /** 関連シグナルの最大件数。既定 10。 */
  matchCount?: number;
  /** LLM に渡す任意のモデル指定。 */
  model?: string;
  onWarn?: (message: string, error?: unknown) => void;
}

const FALLBACK: Omit<ContextVerdict, "relatedSignalIds"> = {
  verdict: "meh",
  rationale: "LLM processing failed or unavailable",
  importanceScore: 0,
};

function buildPrompt(
  signal: Signal,
  related: Signal[],
  userProfileCtx: string,
): string {
  return `You are an expert AI navigator for a B2B SaaS startup.
Analyze the following incoming signal and judge its importance.

<user_context>
${userProfileCtx}
</user_context>

<recent_related_signals>
${related.map((s) => `- ${s.title}`).join("\n")}
</recent_related_signals>

<signal>
Title: ${signal.title}
Body: ${signal.body || "N/A"}
Source: ${signal.source}
</signal>

You must categorize the signal into one of three verdicts:
- 'big_deal': High impact. Needs an action card (e.g. issue, social post draft).
- 'worth_watching': Keep an eye on it.
- 'meh': Noise or irrelevant.

Output a JSON object matching this schema:
{
  "verdict": "big_deal" | "worth_watching" | "meh",
  "rationale": "Short explanation",
  "importance_score": 0-100
}`;
}

export async function judgeVerdict(
  signal: Signal,
  userProfileCtx: string,
  deps: VerdictEngineDeps,
): Promise<ContextVerdict> {
  // 1. 埋め込み + 類似シグナル検索
  let relatedIds: string[] = [];
  if (deps.embedder) {
    try {
      const embedding = await deps.embedder(
        `${signal.title}\n\n${signal.body || ""}`,
      );
      await deps.signalStore.saveEmbedding(signal.id, embedding);
      const related = await deps.signalStore.findRelated(
        signal.userId,
        embedding,
        {
          matchThreshold: deps.matchThreshold ?? 0.7,
          matchCount: deps.matchCount ?? 10,
        },
      );
      relatedIds = related.map((s) => s.id).filter((id) => id !== signal.id);
    } catch (e) {
      deps.onWarn?.("verdict-engine: embedding/related search failed", e);
    }
  }

  // 2. LLM 判定
  if (!deps.llm) {
    return { ...FALLBACK, relatedSignalIds: relatedIds };
  }

  let relatedSignals: Signal[] = [];
  if (relatedIds.length > 0) {
    relatedSignals = await deps.signalStore.listByIds(signal.userId, relatedIds);
  }

  try {
    const raw = await deps.llm.generateJson<unknown>({
      user: buildPrompt(signal, relatedSignals, userProfileCtx),
      model: deps.model,
    });
    const parsed = ContextVerdictLlmSchema.safeParse(raw);
    if (parsed.success) {
      return {
        verdict: parsed.data.verdict,
        rationale: parsed.data.rationale,
        importanceScore: parsed.data.importance_score,
        relatedSignalIds: relatedIds,
      };
    }
    deps.onWarn?.(
      `verdict-engine: LLM output failed validation: ${parsed.error.message}`,
    );
  } catch (e) {
    deps.onWarn?.("verdict-engine: generateJson failed", e);
  }

  return { ...FALLBACK, relatedSignalIds: relatedIds };
}
