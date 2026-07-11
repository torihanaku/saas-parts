/**
 * 課題トラッカー突合 — 仮説カードと既存 open issue の意味的類似度を
 * LLM に採点させ、直接一致 (サブ課題化候補) と関連候補を返す。
 *
 * GitHub API 直接呼び出しは IssueProvider 注入に一般化した。
 *
 * 出典: dev-dashboard-v2 server/lib/navigator/github-subissue-matcher.ts
 */
import type { IssueProvider, LlmClient } from "./ports";
import type { Card, ExternalIssue } from "./types";

export interface IssueMatchOptions {
  /** これを超えたら直接一致 (サブ課題にすべき)。既定 0.85。 */
  directMatchThreshold?: number;
  /** これ以上なら関連候補として提示。既定 0.60。 */
  relatedThreshold?: number;
  onWarn?: (message: string, error?: unknown) => void;
}

export interface IssueMatchResult {
  directMatch: ExternalIssue | null;
  suggestedIssues: ExternalIssue[];
}

const EMPTY: IssueMatchResult = { directMatch: null, suggestedIssues: [] };

function buildPrompt(card: Card, issues: ExternalIssue[]): string {
  return `You are an AI assistant helping a software team organize their work.
We have a new 'Hypothesis Card' representing a task or investigation:
Title: ${card.title}
Summary: ${card.summary}
Hypothesis: ${card.hypothesis ?? ""}

And we have the following open issues:
${issues.map((i) => `[Issue #${i.number}] ${i.title}\n${i.body}`).join("\n\n")}

Analyze the semantic similarity between the Hypothesis Card and the open issues.
For each issue, assign a similarity score from 0.0 to 1.0.
- If score > 0.85, it's a direct match and should be a sub-issue.
- If score between 0.60 and 0.85, it's related but might need manual review.
- If score < 0.60, it's unrelated.

Output a JSON array of objects, e.g. [{"number": 101, "score": 0.9}, {"number": 102, "score": 0.2}]
`;
}

export async function suggestRelatedIssues(
  card: Card,
  deps: { issueProvider: IssueProvider; llm: LlmClient },
  options: IssueMatchOptions = {},
): Promise<IssueMatchResult> {
  const directMatchThreshold = options.directMatchThreshold ?? 0.85;
  const relatedThreshold = options.relatedThreshold ?? 0.6;

  try {
    const issues = await deps.issueProvider.listOpenIssues();
    if (issues.length === 0) return EMPTY;

    const resultText = await deps.llm.generateText({
      user: buildPrompt(card, issues),
    });

    let scores: { number: number; score: number }[];
    try {
      const jsonStr = resultText.substring(
        resultText.indexOf("["),
        resultText.lastIndexOf("]") + 1,
      );
      scores = JSON.parse(jsonStr) as { number: number; score: number }[];
    } catch (_e) {
      options.onWarn?.("issue-matcher: failed to parse LLM similarity response");
      return EMPTY;
    }

    const direct = scores.find((s) => s.score > directMatchThreshold);
    const relatedMatches = scores.filter((s) => s.score >= relatedThreshold);

    const directMatch = direct
      ? (issues.find((i) => i.number === direct.number) ?? null)
      : null;
    const suggestedIssues = issues.filter((i) =>
      relatedMatches.some((r) => r.number === i.number),
    );

    return { directMatch, suggestedIssues };
  } catch (err) {
    options.onWarn?.("issue-matcher: failed", err);
    return EMPTY;
  }
}

/**
 * カードに既存 issue を手動リンクする (cardData.meta.linkedIssueNumber を更新)。
 * 出典: dev-dashboard-v2 server/routes/navigator/subissues.ts handleLinkIssue
 */
export async function linkIssueToCard(
  userId: string,
  cardId: string,
  issueNumber: number,
  deps: {
    cardStore: {
      getById(userId: string, id: string): Promise<Card | null>;
      update(
        userId: string,
        id: string,
        patch: Partial<Pick<Card, "cardData">>,
      ): Promise<Card | null>;
    };
  },
): Promise<Card | null> {
  const card = await deps.cardStore.getById(userId, cardId);
  if (!card) return null;

  return deps.cardStore.update(userId, cardId, {
    cardData: {
      ...card.cardData,
      meta: { ...card.cardData.meta, linkedIssueNumber: issueNumber },
    },
  });
}
