import type { DualOptionsResult, GenerateJson } from "./types.js";
import type { ChallengerStore } from "./stores.js";

export interface DualOptionsDeps {
  store: ChallengerStore;
  generateJson: GenerateJson;
}

/**
 * Safe / Edgy 2 案生成。
 * 原稿とブランド DNA（voice / tone）から、ガイドライン遵守の Safe 案と
 * 意図的に少し逸脱した Edgy 案の 2 案を LLM で生成する。
 */
export async function generateDualOptions(
  tenantId: string,
  original: string,
  deps: DualOptionsDeps,
): Promise<DualOptionsResult> {
  const dna = await deps.store.getBrandDna(tenantId);
  const voice = dna?.voice ?? {};
  const tone = dna?.tone ?? {};

  const system = `あなたはプロのコピーライターであり、ブランド戦略家です。
与えられた原稿とブランドガイドラインをもとに、以下の2つの案を作成してください。

1. Safe案 (Compliant): ブランドガイドライン（Voice/Tone）を完全に遵守し、リスクを最小限に抑えた表現。
2. Edgy案 (Boundary-Pushing): ブランドガイドラインを意図的に少し逸脱し、新しいターゲット層へのリーチやエンゲージメント向上を狙った挑戦的な表現（ただし、炎上リスクが高すぎるものは避ける）。

出力は指定された JSON 形式のみとし、他のテキストは含めないでください。`;

  const userPrompt = `
ブランドガイドライン:
- Voice: ${JSON.stringify(voice)}
- Tone: ${JSON.stringify(tone)}

元の原稿:
---
${original}
---

以下の JSON 形式で結果を返してください:
{
  "safe": "ブランド遵守の無難な案",
  "edgy": "ガイドラインを少し逸脱した挑戦的な案",
  "rationale": "なぜこのように作成したか、特にEdgy案がどのようにガイドラインを破り、どんな効果を狙っているかの解説"
}
`;

  return deps.generateJson<DualOptionsResult>(
    system,
    userPrompt,
    { safe: original, edgy: original, rationale: "" },
    { maxTokens: 800 },
  );
}
