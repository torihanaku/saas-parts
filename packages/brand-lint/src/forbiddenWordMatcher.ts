import type { BrandViolation } from "./types.js";

/**
 * 禁止語マッチャー。
 * 文章を禁止語リスト（リテラル or 正規表現）に照合する純粋関数。
 */
export function matchForbiddenWords(
  content: string,
  forbiddenWords: string[],
): BrandViolation[] {
  const violations: BrandViolation[] = [];

  for (const pattern of forbiddenWords) {
    if (!pattern) continue;

    // 特殊文字を含む場合は正規表現、そうでなければリテラル扱い。
    const isRegex = /[\\^$.*+?()[\]{}|]/.test(pattern);

    let regex: RegExp;
    try {
      regex = new RegExp(isRegex ? pattern : escapeRegExp(pattern), "gi");
    } catch {
      // 正規表現として無効なパターンは、禁止語を取りこぼさないよう
      // リテラル文字列として再解釈してマッチする（安全側 = フラグ側に倒す）。
      // 例: 「C++」「お得(限定)」などブランド用語がメタ文字を含む場合。
      try {
        regex = new RegExp(escapeRegExp(pattern), "gi");
      } catch (e) {
        console.error(`Invalid forbidden word pattern: ${pattern}`, e);
        continue;
      }
    }

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      violations.push({
        type: "forbidden_word",
        severity: "error",
        message: `禁止語「${match[0]}」が含まれています。`,
        matchedText: match[0],
        span: [match.index, match.index + match[0].length],
      });
      // ゼロ幅マッチによる無限ループを防止。
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
  }

  return violations;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
