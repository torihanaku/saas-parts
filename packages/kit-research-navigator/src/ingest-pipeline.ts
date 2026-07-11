/**
 * シグナル取り込みパイプライン (定期ジョブの中身)。
 *
 * ソース群からシグナルを収集 → 重複を除いて保存 → verdict 判定 →
 * context 保存 → "big_deal" は仮説カードを自動生成する。
 *
 * 出典: dev-dashboard-v2 server/jobs/nav-signals-ingest.ts
 */
import type {
  CardStore,
  ContextStore,
  Embedder,
  LlmClient,
  SignalSource,
  SignalStore,
} from "./ports";
import type { Card, Signal, UseCaseCard, Verdict } from "./types";
import { fetchAllSignals } from "./sources/index";
import { judgeVerdict } from "./verdict-engine";

export interface IngestDeps {
  signalStore: SignalStore;
  contextStore: ContextStore;
  cardStore: CardStore;
  /** null の場合、全シグナルが "meh" フォールバックになる。 */
  llm: LlmClient | null;
  embedder?: Embedder;
  /** verdict 判定に渡すユーザープロファイル文。 */
  userProfileContext?: string;
  /** この verdict のシグナルはカードを自動生成する。null で無効化。既定 "big_deal"。 */
  autoCardVerdict?: Verdict | null;
  now?: () => Date;
  onWarn?: (message: string, error?: unknown) => void;
}

export interface IngestResult {
  fetched: number;
  inserted: number;
  skippedDuplicates: number;
  cardsCreated: number;
  createdCards: Card[];
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function buildAutoCard(signal: Signal, verdict: {
  importanceScore: number;
  rationale: string;
}, nowIso: string): UseCaseCard {
  return {
    source: {
      kind: "manual",
      title: signal.title,
      url: signal.url,
      summary: verdict.rationale,
      capturedAt: nowIso,
    },
    tool: { kind: "saas", name: "TBD" },
    integration: { bridgeType: "manual", notes: "" },
    output: { kind: "internal_note", draftText: "" },
    meta: {
      // context の importanceScore (0-100) をカードのスケール (0-1) に正規化
      importanceScore: clamp01(verdict.importanceScore / 100),
      rationale: verdict.rationale,
      generatedBy: "llm-auto",
      sourceVersion: "v1",
    },
  };
}

export async function ingestSignals(
  userId: string,
  sources: SignalSource[],
  deps: IngestDeps,
): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date());
  const autoCardVerdict =
    deps.autoCardVerdict === undefined ? "big_deal" : deps.autoCardVerdict;
  const userProfileContext =
    deps.userProfileContext ?? "B2B SaaS startup focused on AI and DevTools.";

  const newSignals = await fetchAllSignals(sources, { userId }, {
    onSourceError: (name, e) =>
      deps.onWarn?.(`ingest: source "${name}" failed`, e),
  });

  const result: IngestResult = {
    fetched: newSignals.length,
    inserted: 0,
    skippedDuplicates: 0,
    cardsCreated: 0,
    createdCards: [],
  };

  for (const sig of newSignals) {
    const inserted = await deps.signalStore.insert(userId, sig);
    if (!inserted) {
      result.skippedDuplicates++;
      continue;
    }
    result.inserted++;

    const verdict = await judgeVerdict(inserted, userProfileContext, {
      llm: deps.llm,
      embedder: deps.embedder,
      signalStore: deps.signalStore,
      onWarn: deps.onWarn,
    });

    await deps.contextStore.insert(userId, {
      signalId: inserted.id,
      relatedSignalIds: verdict.relatedSignalIds,
      importanceScore: verdict.importanceScore,
      verdict: verdict.verdict,
      rationale: verdict.rationale,
    });

    if (autoCardVerdict && verdict.verdict === autoCardVerdict) {
      const nowIso = now().toISOString();
      const card = await deps.cardStore.insert(userId, {
        triggerSource: "signal",
        triggerSignalId: inserted.id,
        title: `[Auto] ${inserted.title}`,
        summary: verdict.rationale,
        status: "draft",
        cardData: buildAutoCard(inserted, verdict, nowIso),
      });
      result.cardsCreated++;
      result.createdCards.push(card);
    }
  }

  return result;
}
