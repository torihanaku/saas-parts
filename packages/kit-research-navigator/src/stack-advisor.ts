/**
 * Stack Advisor — RAG パイプライン。
 *
 * 1. ユーザー状況 (現行スタック/規模/痛点) を埋め込み
 * 2. スタック DB から類似候補を取得 (2 件未満なら null)
 * 3. LLM に候補内から primary/alternative を選ばせ、warning も生成させる
 * 4. primary slug が候補外なら null (幻覚ガード)
 * 5. docs/warning の URL を UrlChecker で到達性フィルタ
 *
 * 出典: 実運用SaaS server/lib/navigator/stack-advisor.ts
 */
import type { Embedder, LlmClient, StackStore, UrlChecker } from "./ports";
import type {
  FailurePattern,
  FailureSeverity,
  StackMatch,
  StackRecommendation,
} from "./types";

export interface StackAdvisorInput {
  currentStack: string;
  scale: string;
  pains: string;
}

export interface StackAdvisorDeps {
  embedder: Embedder;
  stackStore: StackStore;
  llm: LlmClient;
  /** 省略時は全 URL 到達可能として扱う。 */
  checkUrls?: UrlChecker;
  /** 候補取得の閾値。既定 0.3。 */
  matchThreshold?: number;
  /** 候補数。既定 8。 */
  matchCount?: number;
  now?: () => Date;
  onWarn?: (message: string, error?: unknown) => void;
}

interface LlmRecommendationShape {
  primarySlug: string;
  primaryReasons: string[];
  migrationCostJpyPerMonth?: number;
  migrationEffortDays?: number;
  alternativeSlug?: string;
  alternativeReasons?: string[];
  unnecessary?: string[];
  warnings?: Array<{
    title: string;
    summary: string;
    rootCause?: string;
    mitigation?: string;
    sourceUrl?: string;
    severity: FailureSeverity;
  }>;
}

const SYSTEM_PROMPT = `You are a Stack Advisor. You help non-engineer solo operators choose the right stack.

Given the user's current stack, scale, and pain points, plus a shortlist of candidate stacks retrieved by semantic similarity, return exactly one primary recommendation and optionally one alternative. Be conservative: if the current stack is fine, say so in "unnecessary". Never recommend a stack absent from the shortlist.

Also generate 1-3 warnings (failure patterns) relevant to the recommended primary stack. Each warning must include a sourceUrl that is a real, public documentation or post-mortem URL — if you cannot supply a verified URL, set sourceUrl to an empty string (it will be filtered out). Do NOT invent blog post URLs.

Severity scale: low (cosmetic), medium (operational friction), high (meaningful risk), critical (data loss / security).

Respond in strict JSON matching the required shape.`;

function buildQueryText(input: StackAdvisorInput): string {
  return [
    `現在のスタック: ${input.currentStack}`,
    `利用規模: ${input.scale}`,
    `痛点: ${input.pains}`,
  ].join("\n");
}

function buildUserPrompt(
  input: StackAdvisorInput,
  candidates: StackMatch[],
): string {
  const shortlist = candidates
    .map(
      (s, i) =>
        `${i + 1}. [${s.category}] slug=${s.slug} name=${s.name} vendor=${s.vendor}\n   desc: ${s.description}\n   pros: ${s.pros.join(", ")}\n   cons: ${s.cons.join(", ")}\n   similarity: ${s.similarity.toFixed(3)}`,
    )
    .join("\n\n");

  return `## ユーザー状況
現在のスタック: ${input.currentStack}
利用規模: ${input.scale}
痛点: ${input.pains}

## 候補スタック (similarity 上位${candidates.length}件)
${shortlist}

## 指示
以下の JSON shape で返答してください。primarySlug は必ず上記候補の slug のうち 1 件から選ぶこと。
{
  "primarySlug": "...",
  "primaryReasons": ["...", "..."],
  "migrationCostJpyPerMonth": 0,
  "migrationEffortDays": 0,
  "alternativeSlug": "...",
  "alternativeReasons": ["..."],
  "unnecessary": ["..."],
  "warnings": [
    { "title": "...", "summary": "...", "rootCause": "...", "mitigation": "...", "sourceUrl": "https://...", "severity": "medium" }
  ]
}`;
}

export async function generateStackRecommendation(
  input: StackAdvisorInput,
  deps: StackAdvisorDeps,
): Promise<StackRecommendation | null> {
  const now = deps.now ?? (() => new Date());
  const checkUrls: UrlChecker = deps.checkUrls ?? (async (urls) => urls);

  // 1. クエリを埋め込み (プロバイダ障害は null に落とす)
  let queryEmbedding: number[];
  try {
    queryEmbedding = await deps.embedder(buildQueryText(input));
  } catch (err) {
    deps.onWarn?.("stack-advisor: embedding unavailable", err);
    return null;
  }

  // 2. 候補取得
  const candidates = await deps.stackStore.matchByEmbedding(queryEmbedding, {
    matchThreshold: deps.matchThreshold ?? 0.3,
    matchCount: deps.matchCount ?? 8,
  });
  if (candidates.length < 2) {
    deps.onWarn?.(
      `stack-advisor: insufficient candidates (${candidates.length})`,
    );
    return null;
  }

  // 3. LLM 推薦
  const raw = await deps.llm.generateJson<LlmRecommendationShape>({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input, candidates),
  });
  if (!raw || !raw.primarySlug) return null;

  // 4. slug 解決 (候補外なら幻覚として棄却)
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const primary = bySlug.get(raw.primarySlug);
  if (!primary) {
    deps.onWarn?.(
      `stack-advisor: primary slug not in shortlist: ${raw.primarySlug}`,
    );
    return null;
  }
  const alternative =
    raw.alternativeSlug && raw.alternativeSlug !== raw.primarySlug
      ? bySlug.get(raw.alternativeSlug)
      : undefined;

  // 5. URL 到達性フィルタ
  const allUrls = [primary.docsUrl, primary.pricingUrl]
    .concat(alternative ? [alternative.docsUrl, alternative.pricingUrl] : [])
    .concat(
      (raw.warnings ?? [])
        .map((w) => w.sourceUrl ?? "")
        .filter((u) => u.length > 0),
    )
    .filter((u) => u && u.length > 0);
  const reachable = new Set(await checkUrls([...new Set(allUrls)]));

  // 6. 応答の組み立て
  const nowIso = now().toISOString();
  const warnings: FailurePattern[] = (raw.warnings ?? [])
    .map(
      (w, i): FailurePattern => ({
        id: `warning-${i}-${nowIso}`,
        title: w.title,
        summary: w.summary,
        rootCause: w.rootCause,
        mitigation: w.mitigation,
        sourceUrl: w.sourceUrl,
        severity: w.severity,
        createdAt: nowIso,
      }),
    )
    .map((fp) =>
      fp.sourceUrl && !reachable.has(fp.sourceUrl)
        ? { ...fp, sourceUrl: undefined }
        : fp,
    );

  const docs = [primary.docsUrl, primary.pricingUrl].filter((u) =>
    reachable.has(u),
  );

  const { similarity: _p, ...primaryStack } = primary;

  return {
    primary: {
      stack: primaryStack,
      reasons: raw.primaryReasons ?? [],
      migrationCostJpyPerMonth: raw.migrationCostJpyPerMonth,
      migrationEffortDays: raw.migrationEffortDays,
    },
    alternative: alternative
      ? (() => {
          const { similarity: _a, ...altStack } = alternative;
          return { stack: altStack, reasons: raw.alternativeReasons ?? [] };
        })()
      : {
          // alternative は型上必須。候補がなければ primary を再掲し明示的な理由を付す
          stack: { ...primaryStack },
          reasons: ["no viable alternative in shortlist"],
        },
    unnecessary: raw.unnecessary,
    warnings,
    docs,
  };
}
