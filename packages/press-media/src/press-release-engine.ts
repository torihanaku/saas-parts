/**
 * Press Release generation engine.
 *
 * 構造化プレスリリースの生成、ブランドボイス準拠チェック、テキスト整形を提供する。
 * LLM 呼び出し（generateJson）は注入式。
 *
 * 出典: 実運用SaaS server/lib/press-release-engine.ts
 */

import type { GenerateJson } from "./llm";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PressReleaseStructure {
  title: string;
  subtitle: string;
  lead: string;        // リード文（5W1H含む）
  body: string;        // 本文
  companyInfo: string;  // 会社概要
  contact: string;      // お問い合わせ先
}

export type PRType = "new_product" | "event" | "earnings" | "partnership" | "other";

export interface BrandCheckResult {
  passed: boolean;
  violations: string[];
  score: number;
}

// ─── PR Type Templates ──────────────────────────────────────────────────────

const PR_TYPE_INSTRUCTIONS: Record<PRType, string> = {
  new_product: `新製品・新サービスの発表プレスリリースとして構成してください。
- リード文には製品名、提供開始日、主要機能、対象ユーザー、価格帯を含めてください
- 本文では製品の特長、開発背景、市場ニーズ、今後の展開を順に記載してください
- 「〇〇を〇月〇日より提供開始」という形式のタイトルが好まれます`,

  event: `イベント・セミナー告知のプレスリリースとして構成してください。
- リード文にはイベント名、日時、場所（会場名・所在地）、参加対象、申込方法を含めてください
- 本文ではイベントの概要、登壇者、プログラム内容、参加メリットを記載してください
- 申し込みURLや締切日を明記してください`,

  earnings: `決算・業績発表のプレスリリースとして構成してください。
- リード文には対象期間、売上高、営業利益、前年比を含めてください
- 本文では業績の要因分析、セグメント別実績、今期の見通しを記載してください
- 数値は具体的に、グラフでは表現できない背景情報を文章で補足してください`,

  partnership: `業務提携・パートナーシップ発表のプレスリリースとして構成してください。
- リード文には提携先企業名、提携内容、目的、開始時期を含めてください
- 本文では提携の背景、各社の強み、期待される相乗効果、今後の計画を記載してください
- 両社代表のコメントを含めると効果的です`,

  other: `一般的なプレスリリースとして構成してください。
- リード文には5W1H（誰が・何を・いつ・どこで・なぜ・どのように）を含めてください
- 本文は論理的に構成し、背景→詳細→今後の展開の順で記載してください`,
};

// ─── System Prompts ──────────────────────────────────────────────────────────

function buildGenerateSystemPrompt(prType: PRType, brandVoicePrompt?: string): string {
  const base = `あなたはプロのプレスリリースライターです。
日本のビジネスメディア向けの正式なプレスリリースを作成してください。

## 出力形式
必ず以下のJSON形式のみを返してください。JSON以外のテキストは含めないでください。
\`\`\`json
{
  "title": "プレスリリースのタイトル（簡潔で目を引くもの）",
  "subtitle": "サブタイトル（補足情報）",
  "lead": "リード文（5W1Hを含む1-2段落）",
  "body": "本文（3-5段落。段落間は改行2つで区切る）",
  "companyInfo": "会社概要（会社名、所在地、代表者、設立、事業内容）",
  "contact": "お問い合わせ先（部署名、担当者名、電話番号、メールアドレス）"
}
\`\`\`

## プレスリリースの種類別ガイドライン
${PR_TYPE_INSTRUCTIONS[prType]}

## 品質基準
- 客観的で正確な表現を使う（過度な形容詞は避ける）
- 専門用語には簡潔な説明を添える
- 数値や日付は具体的に記載する
- 各フィールドは適切な長さで（titleは40文字以内、leadは200-400文字）`;

  if (brandVoicePrompt) {
    return `${base}\n\n${brandVoicePrompt}`;
  }
  return base;
}

const BRAND_CHECK_SYSTEM_PROMPT = `あなたはブランドボイスの品質管理担当者です。
与えられたプレスリリースがブランドガイドラインに準拠しているか評価してください。

必ず以下のJSON形式のみを返してください。JSON以外のテキストは含めないでください。
\`\`\`json
{
  "passed": true/false,
  "violations": ["違反事項1", "違反事項2"],
  "score": 0-100
}
\`\`\`

## 評価基準
- トーン・語調がブランドガイドラインと一致しているか
- 使用禁止ワードが含まれていないか
- ナラティブスタイル（一人称/三人称等）が適切か
- ブランド価値が反映されているか
- ターゲットオーディエンスに適切な表現か

scoreは0-100で、80以上をpassed: trueとしてください。
violationsは具体的な箇所と改善提案を含めてください。`;

// ─── Functions ───────────────────────────────────────────────────────────────

const EMPTY_STRUCTURE: PressReleaseStructure = {
  title: "",
  subtitle: "",
  lead: "",
  body: "",
  companyInfo: "",
  contact: "",
};

const EMPTY_BRAND_CHECK: BrandCheckResult = {
  passed: false,
  violations: ["ブランドチェックの実行に失敗しました"],
  score: 0,
};

/**
 * Generate a press release via the injected LLM.
 * Returns a structured PressReleaseStructure with all fields populated.
 */
export async function generatePressRelease(
  generateJson: GenerateJson,
  apiKey: string,
  params: {
    topic: string;
    prType: PRType;
    context?: string;
    brandVoicePrompt?: string;
  },
): Promise<PressReleaseStructure> {
  const { topic, prType, context, brandVoicePrompt } = params;

  const system = buildGenerateSystemPrompt(prType, brandVoicePrompt);

  let userPrompt = `以下のトピックについてプレスリリースを作成してください。\n\nトピック: ${topic}`;
  if (context) {
    userPrompt += `\n\n補足情報:\n${context}`;
  }

  const result = await generateJson<PressReleaseStructure>(
    apiKey,
    system,
    userPrompt,
    EMPTY_STRUCTURE,
    { maxTokens: 4000, timeout: 60_000 },
  );

  // Validate that at least title and lead were generated
  if (!result.title && !result.lead) {
    return EMPTY_STRUCTURE;
  }

  return result;
}

/**
 * Check a press release against brand voice guidelines via the injected LLM.
 * Returns pass/fail, violations list, and a 0-100 score.
 */
export async function brandCheckPressRelease(
  generateJson: GenerateJson,
  apiKey: string,
  structure: PressReleaseStructure,
  brandVoicePrompt: string,
): Promise<BrandCheckResult> {
  const userPrompt = `以下のプレスリリースをブランドガイドラインに照らして評価してください。

## ブランドガイドライン
${brandVoicePrompt}

## プレスリリース
タイトル: ${structure.title}
サブタイトル: ${structure.subtitle}
リード文: ${structure.lead}
本文: ${structure.body}
会社概要: ${structure.companyInfo}
お問い合わせ先: ${structure.contact}`;

  const result = await generateJson<BrandCheckResult>(
    apiKey,
    BRAND_CHECK_SYSTEM_PROMPT,
    userPrompt,
    EMPTY_BRAND_CHECK,
    { maxTokens: 2000, timeout: 30_000 },
  );

  // Clamp score to valid range
  if (typeof result.score === "number") {
    result.score = Math.max(0, Math.min(100, result.score));
    result.passed = result.score >= 80;
  }

  return result;
}

/**
 * Format a PressReleaseStructure as plain text suitable for download.
 */
export function formatPressReleaseAsText(structure: PressReleaseStructure): string {
  const divider = "─".repeat(60);
  const sections: string[] = [];

  sections.push(divider);
  sections.push(`【プレスリリース】`);
  sections.push(divider);
  sections.push("");

  if (structure.title) {
    sections.push(structure.title);
  }
  if (structure.subtitle) {
    sections.push(`― ${structure.subtitle}`);
  }
  sections.push("");

  if (structure.lead) {
    sections.push(structure.lead);
    sections.push("");
  }

  if (structure.body) {
    sections.push(structure.body);
    sections.push("");
  }

  if (structure.companyInfo) {
    sections.push(divider);
    sections.push("【会社概要】");
    sections.push(structure.companyInfo);
    sections.push("");
  }

  if (structure.contact) {
    sections.push(divider);
    sections.push("【お問い合わせ先】");
    sections.push(structure.contact);
    sections.push("");
  }

  sections.push(divider);

  return sections.join("\n");
}
