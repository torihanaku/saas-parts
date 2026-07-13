/**
 * LP モック生成（施策ブリーフ → Tailwind スタイルの単一ページ HTML）。
 *
 * 実運用SaaS の prototype/lp-mock ルートから、サニタイズ・プロンプト・
 * 生成ロジックを抽出（Supabase 永続化と Hono ルーティングは除外）。
 */
import type { GenerateText } from "./types.js";

export const LP_MOCK_SYSTEM_PROMPT = `You are an expert front-end designer generating a SINGLE-PAGE landing-page mock as raw HTML for a CMO review.

Constraints:
1. Output ONLY one complete HTML document (no markdown, no surrounding text).
2. Include <!DOCTYPE html>, <html lang="ja">, <head>, <body>.
3. Use Tailwind CSS via the CDN <script src="https://cdn.tailwindcss.com"></script> in <head>.
4. Mobile-first responsive (sm:, md:, lg: breakpoints). Hero section + 3 features + CTA + footer minimum.
5. Japanese copy unless brief says otherwise. No real images — use placeholder divs with bg-gradient and labels.
6. Brand guidelines (when provided) MUST be respected: tone, forbidden phrases, color palette hints.
7. NEVER include external scripts other than tailwindcss CDN. NEVER include <iframe>, <object>, <embed>, or onclick=. Inline styles are fine.
8. Total HTML ≤ 12,000 characters.`;

export const LP_MOCK_FALLBACK_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8" /><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-100 text-slate-800">
<main class="max-w-3xl mx-auto p-8 space-y-6">
<h1 class="text-3xl font-bold">LP モック生成に失敗しました</h1>
<p class="text-slate-600">LLM が未設定か、 一時的なエラーです。 別の prompt で再試行してください。</p>
</main>
</body>
</html>`;

export function buildLpUserPrompt(brief: string, brandGuidelines?: string): string {
  const guidelines = brandGuidelines?.trim();
  const parts = ["Generate the LP mock HTML for the following brief.", "", "## Brief", brief.trim()];
  if (guidelines) {
    parts.push("", "## Brand Guidelines (must respect)", guidelines);
  }
  parts.push("", "Output the HTML document only.");
  return parts.join("\n");
}

/** 危険な要素（tailwind CDN 以外のスクリプト / iframe / onイベント）を除去。 */
export function sanitizeLpHtml(html: string): string {
  let sanitized = html.trim();
  // モデルがコードフェンスで包んだ場合は剥がす。
  sanitized = sanitized.replace(/^```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "");
  // tailwind CDN 以外の script を除去（プロンプトでも禁止しているが防御的に）。
  sanitized = sanitized.replace(
    /<script(?![^>]*src=["']https:\/\/cdn\.tailwindcss\.com["'])[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  // iframe / object / embed は閉じタグがあれば中身ごと、無ければ開きタグ単体でも除去。
  sanitized = sanitized.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  sanitized = sanitized.replace(/<object[\s\S]*?<\/object>/gi, "");
  sanitized = sanitized.replace(/<embed[\s\S]*?<\/embed>/gi, "");
  sanitized = sanitized.replace(/<(?:iframe|object|embed)\b[^>]*\/?>/gi, "");
  // インライン event handler（引用符あり・無し両対応）を除去。
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*[^\s"'>]+/gi, "");
  return sanitized;
}

export interface LpMockResult {
  html: string;
  source: "ai" | "fallback";
}

/**
 * LP モック HTML を生成。generateText 未指定 or 生成失敗時はフォールバック HTML。
 */
export async function generateLpMock(
  generateText: GenerateText | undefined,
  promptText: string,
  brandGuidelines?: string,
): Promise<LpMockResult> {
  if (!generateText) {
    return { html: LP_MOCK_FALLBACK_HTML, source: "fallback" };
  }
  const text = await generateText(
    LP_MOCK_SYSTEM_PROMPT,
    buildLpUserPrompt(promptText, brandGuidelines),
    { maxTokens: 4096 },
  );
  if (text && text.includes("<html")) {
    return { html: sanitizeLpHtml(text), source: "ai" };
  }
  return { html: LP_MOCK_FALLBACK_HTML, source: "fallback" };
}
