/**
 * AI プロトタイプ生成 — コピー多変量スライス。
 *
 * 純粋な生成器: 施策案プロンプト + 任意のブランドボイス文脈から、N 件の
 * コピー案（{ headline, body, cta }）を返す。永続化は呼び出し側の責務。
 *
 * 失敗モード: LLM 呼び出しが失敗、または不正な JSON を返した場合は、決定的な
 * フォールバックに縮退して API 契約（必ず count 件）を守る。結果の `source`
 * フィールドで AI / フォールバックを判別できる。
 */
import type { GenerateJson } from "./types.js";

export interface CopyVariant {
  headline: string;
  body: string;
  cta: string;
}

export interface CopyVariantInput {
  promptText: string;
  brandVoiceContext?: string;
  /** 要求するバリアント数。[1, 5] にクランプ。既定 3。 */
  count?: number;
}

export interface CopyVariantOutput {
  variants: CopyVariant[];
  source: "ai" | "fallback";
}

const MIN_VARIANTS = 1;
const MAX_VARIANTS = 5;
const DEFAULT_COUNT = 3;

function clampCount(n: number | undefined): number {
  if (!Number.isFinite(n ?? NaN)) return DEFAULT_COUNT;
  return Math.max(MIN_VARIANTS, Math.min(MAX_VARIANTS, Math.floor(n as number)));
}

function buildSystem(brandVoiceContext?: string): string {
  const lines = [
    "あなたは日本市場に精通したコピーライターです。",
    "施策案を読み取り、見出し（headline）/ 本文（body）/ CTA の 3 要素から成る広告コピー案を生成してください。",
    "断定や誇張表現を避け、過去の Brand Firewall 違反パターン（最上級表現、無根拠の数値、医薬品的効能効果）を踏まないこと。",
  ];
  if (brandVoiceContext && brandVoiceContext.trim()) {
    lines.push("");
    lines.push("# Brand voice context");
    lines.push(brandVoiceContext.trim());
  }
  return lines.join("\n");
}

function buildUser(promptText: string, count: number): string {
  return [
    "# 施策案",
    promptText.trim(),
    "",
    `# 出力 (JSON のみ、 他のテキストを含めない。 variants 配列は厳密に ${count} 件)`,
    "{",
    `  "variants": [`,
    "    {",
    '      "headline": "<25 文字以内、 訴求点を端的に>",',
    '      "body": "<80〜140 文字、 具体的ベネフィット>",',
    '      "cta": "<10 文字以内、 動詞起点>"',
    "    }",
    `    // 合計 ${count} 件`,
    "  ]",
    "}",
  ].join("\n");
}

interface RawVariant {
  headline?: unknown;
  body?: unknown;
  cta?: unknown;
}

interface RawResponse {
  variants?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeVariant(raw: RawVariant): CopyVariant | null {
  const headline = asString(raw?.headline);
  const body = asString(raw?.body);
  const cta = asString(raw?.cta);
  if (!headline || !body || !cta) return null;
  return { headline, body, cta };
}

function fallbackVariants(promptText: string, count: number): CopyVariant[] {
  const trimmed = promptText.trim().slice(0, 40) || "施策";
  const out: CopyVariant[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      headline: `${trimmed} の提案 案${i + 1}`,
      body: "AI 生成に失敗したため、 担当者が手動でコピーを作成してください。 元の施策案テキストを参照してください。",
      cta: "詳細を見る",
    });
  }
  return out;
}

/**
 * コピー多変量を生成。
 * @param generateJson JSON を返す LLM。未指定（undefined）ならフォールバックを返す。
 */
export async function generateCopyVariants(
  generateJson: GenerateJson | undefined,
  input: CopyVariantInput,
): Promise<CopyVariantOutput> {
  const count = clampCount(input.count);
  const trimmedPrompt = (input.promptText ?? "").trim();
  if (!trimmedPrompt) {
    throw new Error("promptText is required");
  }

  if (!generateJson) {
    return { variants: fallbackVariants(trimmedPrompt, count), source: "fallback" };
  }

  const system = buildSystem(input.brandVoiceContext);
  const user = buildUser(trimmedPrompt, count);

  try {
    const raw = await generateJson<RawResponse>(system, user, { variants: [] }, { maxTokens: 1500 });

    const arr = Array.isArray(raw?.variants) ? raw.variants : [];
    const normalized: CopyVariant[] = [];
    for (const item of arr) {
      const v = normalizeVariant((item ?? {}) as RawVariant);
      if (v) normalized.push(v);
      if (normalized.length >= count) break;
    }

    if (normalized.length === 0) {
      return { variants: fallbackVariants(trimmedPrompt, count), source: "fallback" };
    }

    while (normalized.length < count) {
      // count を保証するため失敗時ではなくフォールバックでパディング。
      const pad = fallbackVariants(trimmedPrompt, 1)[0]!;
      normalized.push(pad);
    }

    return { variants: normalized, source: "ai" };
  } catch (err) {
    console.error("[PrototypeGenerator] copy variants generation failed:", err);
    return { variants: fallbackVariants(trimmedPrompt, count), source: "fallback" };
  }
}

export const COPY_VARIANT_LIMITS = Object.freeze({
  MIN: MIN_VARIANTS,
  MAX: MAX_VARIANTS,
  DEFAULT: DEFAULT_COUNT,
});
