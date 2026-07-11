/** テスト用のモック LLM / 同意チェッカー。 */
import type { ConsentChecker, LlmCaller } from "./types";

export function mockLlm(overrides: Partial<LlmCaller> = {}): LlmCaller {
  return {
    generateText: async () => "mock answer",
    generateJson: async <T>(_s: string, _p: string, fallback: T) => fallback,
    ...overrides,
  };
}

export const consentGranted: ConsentChecker = async () => true;
export const consentDenied: ConsentChecker = async () => false;
