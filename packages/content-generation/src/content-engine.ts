/**
 * コンテンツ生成エンジン。
 *
 * テンプレート定義・トーンガイド・SEO スコアリング・「LLM を呼んで下書きを作る」
 * パイプラインを集約。実運用SaaS の content-engine.ts を、LLM 呼び出しを
 * 注入（`GenerateText`）に置換して移植。
 */
import type {
  CrmContact,
  GenerateText,
  IntelligenceItem,
  KnowledgeItem,
} from "./types.js";
import { buildCompositeContext } from "./context.js";

// ─── テンプレート・トーン定義 ──────────────────────────────────────────────

export const CONTENT_TEMPLATES: Record<string, string> = {
  "trend-article": "トレンド解説記事: 導入→3ポイント解説→結論（2,500-3,500文字）",
  "thought-leadership": "ソートリーダーシップ: 反直感的主張→事例2つ→将来予測（3,000-4,000文字）",
  "how-to": "ハウツー: 問題提起→5-7ステップ→チェックリスト（2,000-3,000文字）",
  "x-thread": "Xスレッド: 7-10ツイート（各280文字以内）、フック→データ→教訓→CTA",
  "linkedin-post": "LinkedIn: パーソナルストーリー→3ポイント→問いかけ（1,000-1,500文字）",
  newsletter: "ニュースレター: 件名3案→挨拶→TOP3ニュース→深掘り→CTA",
  "meeting-notes": "議事録: 出席者→アジェンダ→議論内容→決定事項→アクションアイテム（担当者・期日付き）",
  "action-items": "アクションアイテム一覧: JSON配列 [{title, owner, due_date, priority}]",
  summary: "要約: 要点3〜5箇条（各100文字以内）",
  "competitive-report": "競合分析レポート: 市場ポジション→強み/弱み比較→機会/脅威→推奨アクション（3,000-4,000文字）",
  "seo-audit": "SEO監査レポート: サイト全体スコア→キーワード順位変動→改善提案5項目→優先度マトリクス（2,500-3,500文字）",
  "campaign-brief": "キャンペーンブリーフ: 目的→ターゲット→KPI→チャネル戦略→タイムライン→予算配分（2,000-3,000文字）",
  "roi-summary": "ROIサマリー: 投資総額→チャネル別リターン→アトリビューション分析→次月提案（2,000-2,500文字）",
  "weekly-digest": "週次ダイジェスト: 主要KPI変動→完了タスク→来週の重点→リスク項目（1,500文字以内）",
};

export const TONE_GUIDE: Record<string, string> = {
  professional: "プロフェッショナルで信頼性のあるトーン",
  casual: "親しみやすくカジュアルなトーン",
  technical: "技術的に正確で詳細なトーン",
  provocative: "挑発的で議論を呼ぶトーン",
  educational: "教育的で丁寧なトーン",
};

/** テンプレートキーから（DB 保存用の）コンテンツ種別を導出。 */
export function templateToContentType(template: string): string {
  if (template.includes("x-")) return "sns-x";
  if (template.includes("linkedin")) return "sns-linkedin";
  if (template.includes("newsletter")) return "email";
  if (template.includes("action-items")) return "action-items";
  if (template.includes("meeting-notes")) return "meeting-notes";
  if (template.includes("summary")) return "summary";
  if (template.includes("competitive-report")) return "report";
  if (template.includes("seo-audit")) return "report";
  if (template.includes("campaign-brief")) return "document";
  if (template.includes("roi-summary")) return "report";
  if (template.includes("weekly-digest")) return "report";
  return "article";
}

// ─── SEO スコアリング ──────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * targetKeyword のトークン（空白区切り）の出現回数を数える。
 * 各トークンを正規表現エスケープするため、`C++` や `(株)` のような
 * 正規表現メタ文字を含むキーワードでもクラッシュしない。
 */
function countKeywordHits(content: string, targetKeyword: string): number {
  const tokens = targetKeyword
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(escapeRegExp);
  if (tokens.length === 0) return 0;
  const matches = content.toLowerCase().match(new RegExp(tokens.join("|"), "g"));
  return matches ? matches.length : 0;
}

/** 生成 Markdown の簡易 SEO スコア（0–100）。 */
export function computeSeoScore(content: string, targetKeyword?: string): number {
  const wordCount = content.length;
  const h2Count = (content.match(/^##\s/gm) ?? []).length;
  const keywordCount = targetKeyword ? countKeywordHits(content, targetKeyword) : 0;

  const lengthScore = wordCount >= 2000 ? 25 : Math.round(wordCount / 80);
  const headingScore = h2Count >= 3 ? 25 : h2Count * 8;
  const keywordScore = targetKeyword ? Math.min(25, keywordCount * 5) : 15;
  const baseScore = 25;

  return Math.min(100, lengthScore + headingScore + keywordScore + baseScore);
}

// ─── 生成オプション ────────────────────────────────────────────────────────

export interface ContentGenerateOptions {
  template: string;
  topic: string;
  tone?: string;
  targetKeyword?: string;
  extraContext?: string;
  brandVoicePrompt?: string;
  intelligenceItems?: IntelligenceItem[];
  knowledgeItems?: KnowledgeItem[];
  crmContacts?: CrmContact[];
  /** 最大出力トークン。既定: 6000 */
  maxTokens?: number;
}

export interface GeneratedContent {
  content: string;
  wordCount: number;
  seoScore: number;
  contentType: string;
}

// ─── コア生成器 ────────────────────────────────────────────────────────────

/** テンプレートとコンテキストを与えて LLM でコンテンツを生成。 */
export async function generateContent(
  generateText: GenerateText,
  options: ContentGenerateOptions,
): Promise<GeneratedContent> {
  const {
    template,
    topic,
    tone = "professional",
    targetKeyword,
    extraContext = "",
    brandVoicePrompt = "",
    intelligenceItems = [],
    knowledgeItems = [],
    crmContacts = [],
    maxTokens = 6000,
  } = options;

  const compositeContext = buildCompositeContext({
    intelligenceItems,
    knowledgeItems,
    crmContacts,
    extraContext,
  });

  const system = [
    "プロのコンテンツライター（19年のマーケ経験）。AI生成っぽい表現禁止。具体的データ必須。SEO意識。",
    `トーン: ${TONE_GUIDE[tone] ?? TONE_GUIDE.professional}`,
    targetKeyword ? `キーワード: ${targetKeyword}（自然に3-5回）` : "",
    compositeContext,
    brandVoicePrompt,
  ]
    .filter(Boolean)
    .join("\n");

  const templatePrompt = CONTENT_TEMPLATES[template] ?? CONTENT_TEMPLATES["trend-article"];
  const userPrompt = `${templatePrompt}\n\nトピック: ${topic}`;

  const content = await generateText(system, userPrompt, { maxTokens });
  const wordCount = content.length;
  const seoScore = computeSeoScore(content, targetKeyword);
  const contentType = templateToContentType(template);

  return { content, wordCount, seoScore, contentType };
}

// ─── 専用生成器 ────────────────────────────────────────────────────────────

export interface ReportGenerateOptions {
  template: string;
  dateFrom: string;
  dateTo: string;
  focusAreas?: string[];
  repos?: string[];
  contextInfo?: string;
}

const REPORT_TEMPLATE_LABELS: Record<string, string> = {
  "weekly-summary": "週次サマリー",
  "monthly-review": "月次レビュー",
  "sprint-retro": "スプリント振り返り",
  "release-notes": "リリースノート",
  "incident-report": "インシデントレポート",
};

/** 構造化 Markdown レポートを生成。 */
export async function generateReport(
  generateText: GenerateText,
  options: ReportGenerateOptions,
): Promise<string> {
  const { template, dateFrom, dateTo, focusAreas = [], repos = [], contextInfo = "" } = options;

  const label = REPORT_TEMPLATE_LABELS[template] ?? template;

  const system =
    "あなたはプロジェクトレポート生成AIです。Markdownフォーマットで構造化されたレポートを日本語で生成してください。";

  const userPrompt = [
    `「${label}」を生成。`,
    `期間: ${dateFrom}〜${dateTo}`,
    focusAreas.length ? `フォーカス: ${focusAreas.join(", ")}` : "",
    repos.length ? `リポ: ${repos.join(", ")}` : "",
    contextInfo,
  ]
    .filter(Boolean)
    .join("\n");

  return generateText(system, userPrompt, { maxTokens: 4000 });
}

export interface TransformOptions {
  /** 変換元コンテンツ */
  sourceContent: string;
  /** リミックス指示、例「Xスレッドに変換して」 */
  instruction: string;
  extraContext?: string;
}

/** 既存コンテンツを別フォーマットに変換 / リミックス。 */
export async function transformContent(
  generateText: GenerateText,
  options: TransformOptions,
): Promise<string> {
  const { sourceContent, instruction, extraContext = "" } = options;

  const system = [
    "プロのコンテンツライター（19年のマーケ経験）。",
    "元のコンテンツのエッセンスを保ちながら、指定されたフォーマットに変換してください。",
    extraContext,
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = `${instruction}\n\n---\n${sourceContent}`;

  return generateText(system, userPrompt, { maxTokens: 4000 });
}

/** ミーティング書き起こし等から構造化アクションアイテムを抽出。 */
export async function extractActionItems(
  generateText: GenerateText,
  text: string,
): Promise<Array<{ title: string; owner?: string; due_date?: string; priority?: string }>> {
  const system =
    'ミーティング音声・チャットからアクションアイテムを抽出するAI。必ず JSON 配列で返すこと: [{"title":"...","owner":"...","due_date":"YYYY-MM-DD","priority":"high|medium|low"}]';
  const content = await generateText(system, text, { maxTokens: 2000 });
  try {
    return JSON.parse(content) as Array<{
      title: string;
      owner?: string;
      due_date?: string;
      priority?: string;
    }>;
  } catch {
    return [];
  }
}
