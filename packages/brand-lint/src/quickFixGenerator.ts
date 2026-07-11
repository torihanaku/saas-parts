import type { BrandViolation, GenerateJson, QuickFixResult } from "./types.js";
import type { BrandLintStore } from "./stores.js";

export interface QuickFixDeps {
  store: BrandLintStore;
  generateJson: GenerateJson;
}

/**
 * AI クイックフィックス生成。
 * DNA スナップショットの voice / tone を文脈に、違反箇所の修正案と理由を LLM で生成する。
 * 生成に失敗しても API 契約を保つため、フォールバック（原文そのまま）を返す。
 */
export async function generateQuickFix(
  tenantId: string,
  violation: BrandViolation,
  fullContent: string,
  deps: QuickFixDeps,
): Promise<QuickFixResult> {
  const snapshot = await deps.store.getLatestDnaSnapshot(tenantId);

  const brandContext = snapshot
    ? `
Brand Voice: ${JSON.stringify(snapshot.voice ?? {})}
Brand Tone: ${JSON.stringify(snapshot.tone ?? {})}
`
    : "No specific brand context available.";

  const system =
    "あなたはブランド専門のエディターです。ブランドガイドラインに違反した箇所を、ガイドラインに沿うように修正してください。修正案と、なぜそのように修正したかの理由（Rationale）を日本語で提供してください。";

  const userPrompt = `
${brandContext}

違反内容:
- 種類: ${violation.type}
- 内容: ${violation.message}
- 該当箇所: ${violation.matchedText || "（文章全体）"}

修正対象の文章全体:
---
${fullContent}
---

以下の JSON 形式で修正案を返してください:
{
  "before": "修正前の該当箇所",
  "after": "修正後の提案箇所",
  "rationale": "修正の理由とブランドへの適合性の説明"
}

JSON 以外のテキストは絶対に含めないでください。
`;

  try {
    return await deps.generateJson<QuickFixResult>(
      system,
      userPrompt,
      { before: violation.matchedText || "", after: "", rationale: "" },
      { maxTokens: 600 },
    );
  } catch (e) {
    console.error("[QuickFixGenerator] AI generation failed:", e);
    return {
      before: violation.matchedText || "",
      after: violation.matchedText || "",
      rationale: "AIによる自動修正案の生成に失敗しました。",
    };
  }
}
