/**
 * パーソナライズされたダッシュボード編成 (Stage 1: AI 構成判断)。
 * 出典: 実運用SaaS server/routes/daily-dashboard.ts の handleDailyCompose / handleShotCompose。
 *
 * 移植方針:
 * - HTTP ルーティング・認証・使用量制限・API キー解決は呼び出し側の責務として除外。
 * - LLM 構成呼び出し (`composeDashboard`) は `ComposeFn` の注入に置換。
 * - ユーザー文脈・シグナル・お気に入りの収集は注入式 provider に一般化。
 * - 永続化・キャッシュは @torihanaku/widget-store の store 対応 (README 参照、import なし)。
 */

/** LLM が構成した 1 ウィジェット (widget-store の WidgetSpec と互換の最小形)。 */
export interface WidgetSpec {
  id: string;
  type: string;
  title: string;
  params: Record<string, unknown>;
  size?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface DashboardSpec {
  id: string;
  kind: "daily" | "shot" | "stock";
  dateKey: string;
  generatedAt: string;
  tokensUsed?: number;
  widgets: WidgetSpec[];
}

/** LLM 構成呼び出しの入力 (実運用SaaS の ComposeInput 相当・最小形)。 */
export interface ComposeInput {
  apiKey: string;
  userContextText: string;
  signalSummary: string;
  favoriteWidgets?: WidgetSpec[];
  maxWidgets?: number;
  kind?: "daily" | "shot";
  question?: string;
  contextWidgets?: WidgetSpec[];
}

export interface ComposeOutput {
  widgets: WidgetSpec[];
  inputTokens: number;
  outputTokens: number;
}

/** 構成 LLM 呼び出し (注入式)。実運用SaaS の composeDashboard を充足する。 */
export type ComposeFn = (input: ComposeInput) => Promise<ComposeOutput>;

/** 編成に必要な文脈を集める provider 群 (注入式)。 */
export interface BriefingComposeDeps {
  compose: ComposeFn;
  /** ユーザーの操作履歴等を整形した文脈テキスト。 */
  getUserContext: () => Promise<string>;
  /** シグナル要約 (省略時は空文字)。 */
  getSignalSummary?: () => Promise<string>;
  /** お気に入りウィジェット (省略時は無し)。 */
  getFavorites?: () => Promise<WidgetSpec[]>;
  /** uuid 生成 (省略時は crypto.randomUUID)。 */
  newId?: () => string;
  /** 日付キー YYYY-MM-DD (省略時は今日 UTC)。 */
  dateKey?: () => string;
  /** 現在時刻 ISO (省略時は now)。 */
  now?: () => string;
}

export class ComposeError extends Error {
  constructor(
    public readonly code: "compose_failed" | "compose_returned_no_widgets",
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = "ComposeError";
  }
}

function defaultDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * デイリーブリーフィングの構成を生成する。
 *
 * キャッシュ判定・永続化は行わない (widget-store 側の責務)。
 * LLM が 0 ウィジェットを返した / 例外を投げた場合は `ComposeError` を throw。
 */
export async function composeDailyBriefing(
  apiKey: string,
  deps: BriefingComposeDeps,
): Promise<DashboardSpec> {
  const userContextText = await deps.getUserContext();
  const signalSummary = (await deps.getSignalSummary?.()) ?? "";
  const favoriteWidgets = (await deps.getFavorites?.()) ?? undefined;

  let composed: ComposeOutput;
  try {
    composed = await deps.compose({
      apiKey,
      userContextText,
      signalSummary,
      favoriteWidgets,
    });
  } catch (err) {
    throw new ComposeError("compose_failed", err);
  }

  if (composed.widgets.length === 0) {
    throw new ComposeError("compose_returned_no_widgets");
  }

  return {
    id: (deps.newId ?? crypto.randomUUID.bind(crypto))(),
    kind: "daily",
    dateKey: (deps.dateKey ?? defaultDateKey)(),
    generatedAt: (deps.now ?? (() => new Date().toISOString()))(),
    tokensUsed: composed.inputTokens + composed.outputTokens,
    widgets: composed.widgets,
  };
}

/**
 * ショット (ユーザー質問への回答ダッシュボード) の構成を生成する。
 */
export async function composeShot(
  apiKey: string,
  question: string,
  deps: BriefingComposeDeps,
  contextWidgets: WidgetSpec[] = [],
): Promise<DashboardSpec> {
  const userContextText = await deps.getUserContext();

  let composed: ComposeOutput;
  try {
    composed = await deps.compose({
      apiKey,
      userContextText,
      signalSummary: "",
      kind: "shot",
      question,
      contextWidgets,
    });
  } catch (err) {
    throw new ComposeError("compose_failed", err);
  }

  if (composed.widgets.length === 0) {
    throw new ComposeError("compose_returned_no_widgets");
  }

  return {
    id: (deps.newId ?? crypto.randomUUID.bind(crypto))(),
    kind: "shot",
    dateKey: (deps.dateKey ?? defaultDateKey)(),
    generatedAt: (deps.now ?? (() => new Date().toISOString()))(),
    tokensUsed: composed.inputTokens + composed.outputTokens,
    widgets: composed.widgets,
  };
}
