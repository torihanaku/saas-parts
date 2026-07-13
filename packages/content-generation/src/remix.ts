/**
 * 長文 → 各フォーマットへの原子化（atomize）ロジック。
 *
 * 実運用SaaS の content routes（atomize / remix）から、
 * インフラ（Supabase / Hono / rate-limiter / audit）に依存しない
 * フォーマット定義と純粋な変換パイプラインだけを抽出。
 */
import type { GenerateText } from "./types.js";
import { transformContent } from "./content-engine.js";

/** 対応するリミックス / 原子化フォーマット。 */
export const ALL_REMIX_FORMATS = [
  "x-thread",
  "linkedin",
  "email-newsletter",
  "note-summary",
  "slack-summary",
  "slide-deck",
  "blog-post",
] as const;

export type RemixFormat = (typeof ALL_REMIX_FORMATS)[number];

/** 各フォーマットへの変換指示プロンプト。 */
export const FORMAT_PROMPTS: Record<RemixFormat, string> = {
  "x-thread":
    "以下のコンテンツをTwitter/Xスレッド形式に変換してください。5〜8ツイートで構成し、各ツイート280文字以内。最初のツイートは強いフックで始め、ハッシュタグを適切に配置し、最後にCTAを入れてください。",
  linkedin:
    "以下のコンテンツをLinkedIn投稿に変換してください。プロフェッショナルなトーンで、キーインサイトを強調し、読者への問いかけ（CTA）で締めてください。1,000〜1,500文字程度。",
  "email-newsletter":
    "以下のコンテンツをメールニュースレターに変換してください。件名（3案）、プレビューテキスト、挨拶、本文（セクション分け）、CTAを含めてください。",
  "note-summary":
    "以下のコンテンツをnote.com用の要約記事に変換してください。簡潔にキーポイントをまとめ、読みやすい構成にしてください。2,000文字程度。",
  "slack-summary":
    "以下のコンテンツをSlack社内共有用の簡潔なサマリーに変換してください。500文字以内で、箇条書き中心。冒頭にワンライン要約、続けて主要ポイント3〜5個、最後に「詳しくはこちら」のCTAを入れてください。",
  "slide-deck":
    '以下のコンテンツをプレゼンテーションスライドに変換してください。JSON配列形式で出力: [{"slide":1,"title":"タイトル","content":"本文","notes":"発表者ノート"}]。3〜8枚構成。各スライドの本文は箇条書き3〜5個。最初はタイトルスライド、最後はまとめ・CTA。',
  "blog-post":
    "以下のコンテンツをブログ記事に変換してください。SEOを意識した構成で、見出し（H2/H3）を適切に配置し、導入→本文→まとめの流れで2,000〜3,000文字。読者を引き込む導入と明確なCTAを含めてください。",
};

/** リミックスフォーマット → コンテンツ種別。 */
export const FORMAT_TYPE_MAP: Record<RemixFormat, string> = {
  "x-thread": "sns-x",
  linkedin: "sns-linkedin",
  "email-newsletter": "email",
  "note-summary": "article",
  "slack-summary": "slack",
  "slide-deck": "slide",
  "blog-post": "article",
};

/** 有効なフォーマットかどうか。 */
export function isRemixFormat(format: string): format is RemixFormat {
  return (ALL_REMIX_FORMATS as readonly string[]).includes(format);
}

export interface AtomizeSource {
  title: string;
  content: string;
}

export interface AtomizeResult {
  format: RemixFormat;
  content: string;
  contentType: string;
}

/**
 * 1 つの元コンテンツを 1 フォーマットにリミックス（純粋変換）。
 */
export async function remixToFormat(
  generateText: GenerateText,
  source: AtomizeSource,
  format: RemixFormat,
  additionalContext?: string,
): Promise<AtomizeResult> {
  const extraContext = additionalContext ? `追加コンテキスト: ${additionalContext}` : "";
  const content = await transformContent(generateText, {
    sourceContent: `タイトル: ${source.title}\n\n${source.content}`,
    instruction: FORMAT_PROMPTS[format],
    extraContext,
  });
  return { format, content, contentType: FORMAT_TYPE_MAP[format] };
}

/**
 * 複数フォーマットへ並列に原子化。無効なフォーマットは除外。
 * 個別失敗は `failed` に集約し、成功分は `succeeded` に返す（部分成功可）。
 */
export async function atomizeContent(
  generateText: GenerateText,
  source: AtomizeSource,
  formats: string[] | undefined,
  additionalContext?: string,
): Promise<{
  succeeded: AtomizeResult[];
  failed: { format: string; error: string }[];
}> {
  const targetFormats: RemixFormat[] = formats?.length
    ? formats.filter(isRemixFormat)
    : [...ALL_REMIX_FORMATS];

  const results = await Promise.allSettled(
    targetFormats.map((format) => remixToFormat(generateText, source, format, additionalContext)),
  );

  const succeeded: AtomizeResult[] = [];
  const failed: { format: string; error: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      succeeded.push(r.value);
    } else {
      failed.push({
        format: targetFormats[i]!,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  return { succeeded, failed };
}
