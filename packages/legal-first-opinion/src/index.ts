/**
 * Legal First-Opinion Agent — 契約・広告文の AI ファーストオピニオン
 *
 * 日本の 4 法令（薬機法 / 景表法 / 特商法 / 個情法）に対する **AI 一次見解**
 * （違反/非該当の判定 + 根拠）を生成する。免責事項を強制付与する。
 *
 * 出典: dev-dashboard-v2 server/lib/legal/first-opinion.ts
 *
 * 移植方針:
 * - LLM 呼び出し（generateJson）を注入式に。
 * - env / tenant-secrets 依存の API キー解決を注入式 `resolveApiKey` に置換
 *   （省略時はキー無し＝全件 fallback）。
 * - プロンプト原文・few-shot・免責文言・fallback 挙動は原典のまま。
 *
 * ⚠️ 免責: 本モジュールの出力は AI による一次判定であり、確定的な法的助言では
 * ありません。最終判断は必ず弁護士・社内法務に確認してください
 * （`STANDARD_DISCLAIMER` が全 opinion に強制付与されます）。
 */

export type JpLawCode = "yakki" | "keihyo" | "tokusho" | "kojinjoho";

export const SUPPORTED_LAWS: readonly JpLawCode[] = Object.freeze([
  "yakki",
  "keihyo",
  "tokusho",
  "kojinjoho",
]);

const LAW_LABEL: Record<JpLawCode, string> = {
  yakki: "薬機法",
  keihyo: "景品表示法",
  tokusho: "特定商取引法",
  kojinjoho: "個人情報保護法",
};

export const STANDARD_DISCLAIMER =
  "本見解は AI による一次判定であり、確定的な法的助言ではありません。最終判断は必ず弁護士・社内法務に確認してください。";

export interface LegalOpinion {
  law: JpLawCode;
  lawLabel: string;
  violated: boolean;
  reasoning: string;
  disclaimer: string;
}

export interface FirstOpinionInput {
  contentText: string;
  /** 既定: SUPPORTED_LAWS 全件。 部分指定で範囲を絞れる。 */
  laws?: readonly JpLawCode[];
  /**
   * テナント ID。`resolveApiKey` に渡され、BYOK（tenant secret 優先）解決に使う。
   * 未指定 / キー解決失敗なら全件 fallback。
   */
  tenantId?: string;
}

export interface FirstOpinionOutput {
  opinions: LegalOpinion[];
  /** Source of truth flag — true なら全件 AI 由来、 false なら 1 件以上 fallback。 */
  fromAi: boolean;
}

/** LLM 構造化 JSON 生成（@torihanaku/claude-api の generateJson 互換）。 */
export type GenerateJson = <T>(
  apiKey: string,
  system: string,
  userPrompt: string,
  fallback: T,
  options?: { maxTokens?: number; model?: string; timeout?: number },
) => Promise<T>;

/**
 * API キー解決。原典の tenant-secret → env fallback を注入式に。
 * 省略時は常に空文字（＝全件 fallback）。
 */
export type ResolveApiKey = (tenantId: string | undefined) => Promise<string> | string;

export type Logger = (message: string, detail?: unknown) => void;

export interface FirstOpinionDeps {
  generateJson: GenerateJson;
  resolveApiKey?: ResolveApiKey;
  logger?: Logger;
}

const FEW_SHOT_BY_LAW: Record<JpLawCode, string> = {
  yakki: `# 薬機法 過去判例の判定例
- 「シミが消える」「即効性で痩せる」 → 違反 (医薬品的効能効果の標榜)
- 「健やかな肌へ」「美容の習慣に」 → 非該当 (一般食品/化粧品の範囲)
判断軸: 効能効果が "医薬品の領域" に踏み込んでいるか。`,
  keihyo: `# 景品表示法 過去判例の判定例
- 「世界一」「業界 No.1」根拠なし → 違反 (優良誤認)
- 「当社調べ」明示 + 根拠データあり → 非該当
判断軸: 客観的根拠の有無 + 表示の打ち消し効果。`,
  tokusho: `# 特定商取引法 過去判例の判定例
- 通販で「事業者名・連絡先・返品条件」未記載 → 違反 (表示義務)
- 体験談中心で「個人の感想です」のみ → 違反 (打ち消し不十分)
判断軸: 通販三表示 (事業者/連絡先/返品) と体験談打ち消しの十分性。`,
  kojinjoho: `# 個人情報保護法 過去判例の判定例
- フォームで「同意なく第三者提供」 → 違反 (本人同意原則)
- 「目的外利用しない」明示 + opt-in チェック → 非該当
判断軸: 目的明示・本人同意・第三者提供の透明性。`,
};

function buildPrompt(law: JpLawCode, contentText: string): { system: string; user: string } {
  const system =
    "あなたは日本の広告法務に詳しい一次審査担当者です。提案文が指定された法令に違反するかを判定し、" +
    "違反/非該当のどちらに該当するか・その根拠を簡潔な日本語で答えてください。" +
    "断定調を避け、「〜の可能性がある」「〜と解釈し得る」など慎重な表現を用いてください。";

  const user = `${FEW_SHOT_BY_LAW[law]}

# 判定対象
法令: ${LAW_LABEL[law]}
提案文:
"""
${contentText}
"""

# 出力 (JSON のみ、 他のテキストを含めない)
{
  "violated": <true|false>,
  "reasoning": "<日本語で 80〜200 文字、 該当箇所と根拠を簡潔に>"
}`;

  return { system, user };
}

function ensureDisclaimer(reasoning: string): string {
  const trimmed = reasoning.trim();
  if (!trimmed) {
    return STANDARD_DISCLAIMER;
  }
  return trimmed;
}

interface AiOpinionShape {
  violated?: unknown;
  reasoning?: unknown;
}

/**
 * `violated` を安全側（フラグ側）に解釈する。LLM が boolean 契約を破って
 * 文字列 "true" / "yes" や数値 1 を返しても違反として扱い、コンプラ上の
 * 見逃し（false-negative）を防ぐ。判別不能な場合のみ false（非該当）。
 */
function coerceViolated(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1", "違反", "該当"].includes(s)) return true;
    if (["false", "no", "0", "非該当", "なし", ""].includes(s)) return false;
  }
  return false;
}

function asLegalOpinion(law: JpLawCode, raw: AiOpinionShape | null): LegalOpinion {
  const violated = coerceViolated(raw?.violated);
  const reasoning = typeof raw?.reasoning === "string" ? raw.reasoning : "";
  return {
    law,
    lawLabel: LAW_LABEL[law],
    violated,
    reasoning: ensureDisclaimer(reasoning),
    disclaimer: STANDARD_DISCLAIMER,
  };
}

function fallbackOpinion(law: JpLawCode): LegalOpinion {
  return {
    law,
    lawLabel: LAW_LABEL[law],
    violated: false,
    reasoning: "AI による一次見解の生成に失敗したため判定不能。原文を弁護士・社内法務に直接確認してください。",
    disclaimer: STANDARD_DISCLAIMER,
  };
}

/**
 * Generate a per-law first opinion. AI failures degrade gracefully to a
 * disclaimer-bearing fallback so callers never receive a mute success.
 *
 * @param deps  注入依存（LLM / API キー解決 / logger）
 * @param input 判定対象と対象法令
 */
export async function generateFirstOpinion(
  deps: FirstOpinionDeps,
  input: FirstOpinionInput,
): Promise<FirstOpinionOutput> {
  // BYOK: resolveApiKey に委譲（省略時はキー無し＝全件 fallback）。
  const resolve = deps.resolveApiKey ?? (() => "");
  const apiKey = (await resolve(input.tenantId)) || "";

  const laws = (input.laws && input.laws.length > 0
    ? input.laws
    : SUPPORTED_LAWS
  ).filter((l): l is JpLawCode => SUPPORTED_LAWS.includes(l));

  if (!apiKey) {
    return {
      opinions: laws.map((l) => fallbackOpinion(l)),
      fromAi: false,
    };
  }

  const log = deps.logger ?? (() => {});

  let allFromAi = true;
  const opinions: LegalOpinion[] = [];
  for (const law of laws) {
    const { system, user } = buildPrompt(law, input.contentText);
    try {
      const raw = await deps.generateJson<AiOpinionShape>(
        apiKey,
        system,
        user,
        { violated: false, reasoning: "" },
        { maxTokens: 500 },
      );
      opinions.push(asLegalOpinion(law, raw));
    } catch (err) {
      log(`[LegalFirstOpinion] ${law} generation failed:`, err);
      opinions.push(fallbackOpinion(law));
      allFromAi = false;
    }
  }

  return { opinions, fromAi: allFromAi };
}

/** Re-exported for tests + consumers needing localized labels. */
export const LAW_LABELS = LAW_LABEL;
