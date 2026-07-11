import { createHash } from "node:crypto";
import type { ChallengerInput, ChallengerProposal, GenerateJson } from "./types.js";
import type { ChallengerStore } from "./stores.js";

const CHALLENGER_SYSTEM = `You are the Active Learning Engine.
Your goal is to generate "Challenger" content proposals that intentionally deviate from brand guidelines to test the boundaries of brand compliance.

CRITICAL RULES:
1. CAMOUFLAGE PRINCIPLE: Never use meta-labels like "learning", "AI generated", "tuning", or "test" in the proposed content. It must look like a legitimate, high-stakes alternative proposal.
2. DIVERSIFICATION: Each challenger should deviate on a specific axis (e.g., tone, format, claim aggression).
3. RATIONALE: Explain the hypothesized upside (e.g., higher CPA, better engagement with Gen Z) and the risk.

Output must be valid JSON matching the following structure:
{
  "proposals": [
    {
      "content": "the proposed text content",
      "deviationAxis": "tone | format | claim_aggression | other",
      "hypothesizedUpside": "why we are trying this",
      "estimatedRisk": "low | medium | high",
      "rationale": "detailed explanation of the strategy"
    }
  ]
}`;

interface RawProposal {
  content: string;
  deviationAxis: string;
  hypothesizedUpside: string;
  estimatedRisk: string;
  rationale: string;
}

export interface ChallengerGeneratorDeps {
  store: ChallengerStore;
  generateJson: GenerateJson;
}

/**
 * Challenger 提案生成。
 * 本命案から意図的にブランドガイドラインを逸脱した「対抗案」を LLM で生成し、
 * 注入されたストアへ保存する。
 */
export async function generateChallengerProposals(
  input: ChallengerInput,
  deps: ChallengerGeneratorDeps,
  options: { count?: number } = { count: 1 },
): Promise<ChallengerProposal[]> {
  const userPrompt = `
Original Content:
"${input.originalContent}"

${input.originalCreativeBrief ? `Creative Brief:\n${input.originalCreativeBrief}\n` : ""}
${input.brandGuidelines ? `Brand Guidelines:\n${input.brandGuidelines}\n` : ""}

Generate ${options.count || 1} challenger proposal(s) that push the boundaries of these guidelines.
Ensure the content is distinct from the original and targets a potential growth opportunity by deviating from established norms.
`;

  const result = await deps.generateJson<{ proposals: RawProposal[] }>(
    CHALLENGER_SYSTEM,
    userPrompt,
    { proposals: [] },
  );

  if (!result.proposals || result.proposals.length === 0) {
    return [];
  }

  const contentHash = createHash("sha256").update(input.originalContent).digest("hex");
  const savedProposals: ChallengerProposal[] = [];

  for (const p of result.proposals) {
    const saved = await deps.store.saveProposal({
      tenant_id: input.tenantId,
      original_content_hash: contentHash,
      content: p.content,
      deviation_axis: p.deviationAxis,
      hypothesized_upside: p.hypothesizedUpside,
      estimated_risk: p.estimatedRisk,
      rationale: p.rationale,
      generated_by: "llm",
    });

    savedProposals.push({
      id: saved.id,
      content: saved.content,
      deviationAxis: saved.deviation_axis,
      hypothesizedUpside: saved.hypothesized_upside,
      estimatedRisk: saved.estimated_risk as "low" | "medium" | "high",
      rationale: saved.rationale,
    });
  }

  return savedProposals;
}
