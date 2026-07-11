import type { BrandViolation, BrandVoiceRules, GenerateJson } from "./types.js";
import type { BrandLintStore } from "./stores.js";
import { matchForbiddenWords } from "./forbiddenWordMatcher.js";

export interface ToneCheckOutput {
  violations: BrandViolation[];
}

export interface ToneCheckDeps {
  store: BrandLintStore;
  /** LLM 呼び出し（テナント別 API キー解決などは呼び出し側で closure に閉じ込める）。 */
  generateJson?: GenerateJson;
}

/**
 * トーンチェッカー。
 * 最新の DNA スナップショットから voice / tone / forbidden_words を取り出し、
 * 禁止語（正規表現）チェック＋（LLM が注入されていれば）voice/tone チェックを行う。
 */
export async function checkTone(
  tenantId: string,
  content: string,
  deps: ToneCheckDeps,
): Promise<BrandViolation[]> {
  const snapshot = await deps.store.getLatestDnaSnapshot(tenantId);
  if (!snapshot) {
    console.warn(`[ToneChecker] No DNA snapshot found for tenant ${tenantId}`);
    return [];
  }

  const voice = (snapshot.voice as BrandVoiceRules) || {};
  const tone = (snapshot.tone as BrandVoiceRules) || {};
  const forbiddenWords = (snapshot.forbidden_words as string[]) || [];

  const violations: BrandViolation[] = [];

  // 1. 禁止語チェック（正規表現ベース）
  violations.push(...matchForbiddenWords(content, forbiddenWords));

  // 2. voice / tone チェック（LLM ベース、注入時のみ）
  if (deps.generateJson && (Object.keys(voice).length > 0 || Object.keys(tone).length > 0)) {
    const llmViolations = await runLlmToneCheck(content, voice, tone, deps.generateJson);
    violations.push(...llmViolations);
  }

  return violations;
}

async function runLlmToneCheck(
  content: string,
  voice: BrandVoiceRules,
  tone: BrandVoiceRules,
  generateJson: GenerateJson,
): Promise<BrandViolation[]> {
  const system =
    "あなたはブランドトーンチェッカーです。与えられたブランドガイドライン（Voice/Tone）と照らし合わせ、提出された文章がブランドに合致しているか確認してください。不一致があれば指定された JSON スキーマで違反内容を返してください。違反がなければ {\"violations\": []} で返してください。";

  const userPrompt = `
ブランドガイドライン:
- Voice: ${JSON.stringify(voice)}
- Tone: ${JSON.stringify(tone)}

提出された文章:
---
${content}
---

違反がある場合は以下の JSON 形式で返してください:
{
  "violations": [
    {
      "type": "tone_mismatch" | "voice_mismatch",
      "severity": "error" | "warning",
      "message": "違反の説明（日本語）",
      "matchedText": "違反箇所",
      "suggestion": "修正案"
    }
  ]
}

不一致がない場合は {"violations": []} を返してください。
JSON 以外のテキストは絶対に含めないでください。
`;

  try {
    const response = await generateJson<{ violations: BrandViolation[] }>(
      system,
      userPrompt,
      { violations: [] },
      { maxTokens: 500 },
    );
    return response.violations || [];
  } catch (e) {
    console.error("[ToneChecker] LLM check failed:", e);
    return [];
  }
}
