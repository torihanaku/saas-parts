/**
 * 仮説カードドラフト生成 — 任意コンテキスト文から
 * 仮説 / 前提 / 検証計画 / 破棄条件 の 4 項目を LLM に書かせ、
 * zod で検証。不合格ならエラー内容を添えて 1 回だけリトライする。
 *
 * 出典: dev-dashboard-v2 server/lib/navigator/hypothesis-drafter.ts
 */
import type { LlmClient } from "./ports";
import type { HypothesisDraft } from "./types";
import { HypothesisDraftSchema } from "./schemas";

const SYSTEM_PROMPT = `
あなたはシニアプロダクトマネージャー兼技術リサーチエンジニアです。
ユーザーから提供されたコンテキストを基に、新規技術やプロダクトの導入検証のための「仮説カード (Hypothesis Card)」のドラフトを作成してください。

以下の4つの詳細項目を必ず含めてください。
1. hypothesis (仮説): 「もし X なら Y という結果になる、なぜなら Z」という形式
2. assumption (前提条件): この仮説が成立するために必要な前提
3. testPlan (検証方法): 検証に必要な期間、追跡すべき指標、具体的な手順
4. invalidationCriteria (破棄条件): どのような結果が出たらこの仮説は「間違い」と判断するか

制約事項:
- 言語は日本語で、断定的な口調（「〜である」「〜する」）を使用してください。
- 曖昧な表現（「多分」「と思う」「かもしれない」）は禁止です。
- 各詳細項目 (hypothesis, assumption, testPlan, invalidationCriteria) は 80文字以上 200文字以下を目安とし、必ず 40文字以上 400文字以下に収めてください。
- レスポンスは必ず以下のJSON形式のみで出力してください。

{
  "title": "タイトル",
  "summary": "概要",
  "hypothesis": "仮説の内容",
  "assumption": "前提条件の内容",
  "testPlan": "検証方法の内容",
  "invalidationCriteria": "破棄条件の内容"
}
`;

export class HypothesisDraftError extends Error {
  constructor(
    message: string,
    public readonly kind: "generation_failed" | "validation_failed",
  ) {
    super(message);
    this.name = "HypothesisDraftError";
  }
}

export async function draftHypothesis(
  context: string,
  llm: LlmClient,
): Promise<{ draft: HypothesisDraft; elapsedMs: number }> {
  const startTime = Date.now();

  let draft = await llm.generateJson<HypothesisDraft>({
    system: SYSTEM_PROMPT,
    user: `以下のコンテキストを基にドラフトを作成してください:\n\n${context}`,
  });
  if (!draft) {
    throw new HypothesisDraftError(
      "Failed to generate draft",
      "generation_failed",
    );
  }

  let result = HypothesisDraftSchema.safeParse(draft);
  if (!result.success) {
    // バリデーションエラーを添えて 1 回だけリトライ
    const errorInfo = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    draft = await llm.generateJson<HypothesisDraft>({
      system: SYSTEM_PROMPT,
      user: `
前回の出力は以下のバリデーションエラーが発生しました:
${errorInfo}

特に文字数制限（各項目 40文字以上 400文字以下）を厳守し、再度生成してください。
コンテキスト:
${context}
`,
    });
    if (!draft) {
      throw new HypothesisDraftError(
        "Failed to generate draft on retry",
        "generation_failed",
      );
    }
    result = HypothesisDraftSchema.safeParse(draft);
    if (!result.success) {
      throw new HypothesisDraftError(
        "Validation failed after retry",
        "validation_failed",
      );
    }
  }

  return { draft: result.data, elapsedMs: Date.now() - startTime };
}

/**
 * 警告 (FailurePattern) → 仮説カードドラフトの変換プロンプトを組み立てる。
 * 出典: dev-dashboard-v2 server/routes/navigator/hypothesis-f2.ts
 */
export function buildWarningToHypothesisPrompt(input: {
  stackRef: string;
  warningId: string;
  title: string;
  severity: string;
  summary: string;
  sourceUrl?: string;
}): string {
  return `あなたは凄腕のテックリードです。以下の技術スタック構成に関する警告（Warning / Failure Pattern）を、開発チームが検証・対処するための「仮説カード」に変換してください。

【対象スタックID】
${input.stackRef}

【警告内容】
ID: ${input.warningId}
Title: ${input.title}
Severity: ${input.severity}
Summary: ${input.summary}
${input.sourceUrl ? `Source: ${input.sourceUrl}` : ""}

以下のJSONフォーマットで出力してください:
{
  "title": "カードのタイトル（短く明確に）",
  "summary": "概要",
  "rationale": "この仮説を検証する背景と理由（警告内容をベースに）",
  "hypothesis": "検証したい仮説（例：「〜を〜にすれば、〇〇の問題は回避できるはずだ」）",
  "testPlan": "具体的な検証・テスト計画（プロトタイプ実装やパフォーマンステストの手順）",
  "rejectionCriteria": "この仮説が失敗・棄却となる基準（例：「レイテンシが〇〇msを超えたら不採用」）",
  "impact": "high" | "medium" | "low"
}
`;
}
