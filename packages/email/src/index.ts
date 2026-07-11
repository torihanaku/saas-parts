/**
 * @torihanaku/email — Resend API 経由のメール送信＋日本語HTMLテンプレートビルダー。
 *
 * 出典: dev-dashboard-v2/server/lib/email.ts（忠実移植）。
 * 元実装は Resend SDK ではなく素の fetch で https://api.resend.com/emails を叩く。
 * env 直読みを廃し、apiKey / from / fetch / logger を設定注入に変更。
 * APIキー未設定時はメール内容をログに出して graceful にスキップする（元実装と同じ）。
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface EmailLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface EmailClientConfig {
  /** Resend の API キー。未設定なら送信をスキップしてログに残す（開発用フォールバック）。 */
  apiKey?: string;
  /** From アドレス（元実装の EMAIL_FROM 相当）。 */
  from?: string;
  /** Resend API のエンドポイント（テスト時の差し替え用）。 */
  apiUrl?: string;
  /** fetch 実装の注入（省略時 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
  /** 構造化ログ出力先（省略時 console）。 */
  logger?: EmailLogger;
}

export interface EmailClient {
  sendEmail: (opts: SendEmailOptions) => Promise<SendEmailResult>;
}

export const RESEND_API_URL = "https://api.resend.com/emails";

// ─── Client ─────────────────────────────────────────────────────────────────

export function createEmailClient(config: EmailClientConfig = {}): EmailClient {
  const {
    apiKey,
    from = "noreply@yourdomain.com",
    apiUrl = RESEND_API_URL,
    logger = console,
  } = config;
  const fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
    if (!apiKey) {
      // NOTE: no API key — log the email body for local dev / manual sharing
      logger.log(JSON.stringify({
        severity: "INFO",
        message: "email_skipped_no_api_key",
        to: opts.to,
        subject: opts.subject,
      }));
      return { ok: false, error: "RESEND_API_KEY not configured" };
    }

    try {
      const res = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.html }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.warn(JSON.stringify({ severity: "WARNING", message: "resend_send_failed", status: res.status, body }));
        return { ok: false, error: `Resend error ${res.status}` };
      }

      const data = await res.json() as { id: string };
      return { ok: true, id: data.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(JSON.stringify({ severity: "ERROR", message: "resend_request_failed", error: msg }));
      return { ok: false, error: msg };
    }
  }

  return { sendEmail };
}

// ─── Shared template chrome ─────────────────────────────────────────────────

function wrapBody(inner: string): string {
  return `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 32px;">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 40px; box-shadow: 0 1px 4px rgba(0,0,0,.08);">
${inner}
  </div>
</body>
</html>`;
}

// ─── Invite email ───────────────────────────────────────────────────────────

/** 元実装の role → 日本語ラベル対応（デフォルト値）。 */
export const DEFAULT_ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  editor: "編集者",
  viewer: "閲覧者",
};

export interface InviteEmailStrings {
  /** 見出し。デフォルト: `${productName}への招待` */
  heading: string;
  /** ボタンラベル */
  buttonLabel: string;
  /** 有効期限の注意書き */
  expiryNote: string;
  /** フォールバックリンクの前置き */
  fallbackLinkLabel: string;
}

export interface InviteEmailOptions {
  inviterName: string;
  /** 招待先メールアドレス（元実装のシグネチャ互換。テンプレート内では未使用）。 */
  email?: string;
  role: string;
  inviteUrl: string;
  /** プロダクト名。デフォルトは元実装どおり「ダッシュボード」。 */
  productName?: string;
  /** role → 表示ラベル。未知の role はそのまま表示（元実装と同じ）。 */
  roleLabels?: Record<string, string>;
  strings?: Partial<InviteEmailStrings>;
}

export function buildInviteEmail(opts: InviteEmailOptions): string {
  const productName = opts.productName ?? "ダッシュボード";
  const roleLabels = opts.roleLabels ?? DEFAULT_ROLE_LABELS;
  const label = roleLabels[opts.role] ?? opts.role;
  const s: InviteEmailStrings = {
    heading: opts.strings?.heading ?? `${productName}への招待`,
    buttonLabel: opts.strings?.buttonLabel ?? "招待を受け入れる",
    expiryNote: opts.strings?.expiryNote ?? "このリンクは7日間有効です。心当たりがない場合はこのメールを無視してください。",
    fallbackLinkLabel: opts.strings?.fallbackLinkLabel ?? "ボタンが機能しない場合:",
  };
  return wrapBody(`    <h1 style="font-size: 20px; font-weight: 700; color: #111; margin: 0 0 8px;">${s.heading}</h1>
    <p style="color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      <strong>${opts.inviterName}</strong> さんから、${productName}へ <strong>${label}</strong> として招待が届きました。
    </p>
    <a href="${opts.inviteUrl}"
       style="display: inline-block; background: #111; color: #fff; text-decoration: none;
              font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px;">
      ${s.buttonLabel}
    </a>
    <p style="color: #999; font-size: 12px; margin: 24px 0 0; line-height: 1.6;">
      ${s.expiryNote}<br>
      ${s.fallbackLinkLabel} <a href="${opts.inviteUrl}" style="color: #555;">${opts.inviteUrl}</a>
    </p>`);
}

// ─── Trial-end email ────────────────────────────────────────────────────────

export interface TrialEndEmailStrings {
  heading: string;
  /** 本文（HTML可）。 */
  bodyHtml: string;
  buttonLabel: string;
  fallbackLinkLabel: string;
}

export interface TrialEndEmailOptions {
  /** 送信先メールアドレス（元実装のシグネチャ互換。テンプレート内では未使用）。 */
  email?: string;
  settingsUrl: string;
  strings?: Partial<TrialEndEmailStrings>;
}

export function buildTrialEndEmail(opts: TrialEndEmailOptions): string {
  const s: TrialEndEmailStrings = {
    heading: opts.strings?.heading ?? "フリートライアル終了のお知らせ",
    bodyHtml: opts.strings?.bodyHtml ??
      "いつもご利用ありがとうございます。<br>\n      まもなくフリートライアル期間が終了し、本契約（課金）が開始されます。<br>\n      プランの確認やキャンセルを行う場合は、以下のボタンより設定画面へお進みください。",
    buttonLabel: opts.strings?.buttonLabel ?? "設定画面を開く",
    fallbackLinkLabel: opts.strings?.fallbackLinkLabel ?? "ボタンが機能しない場合:",
  };
  return wrapBody(`    <h1 style="font-size: 20px; font-weight: 700; color: #111; margin: 0 0 8px;">${s.heading}</h1>
    <p style="color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      ${s.bodyHtml}
    </p>
    <a href="${opts.settingsUrl}"
       style="display: inline-block; background: #111; color: #fff; text-decoration: none;
              font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px;">
      ${s.buttonLabel}
    </a>
    <p style="color: #999; font-size: 12px; margin: 24px 0 0; line-height: 1.6;">
      ${s.fallbackLinkLabel} <a href="${opts.settingsUrl}" style="color: #555;">${opts.settingsUrl}</a>
    </p>`);
}

// ─── Onboarding drip email (day-keyed) ──────────────────────────────────────

export type OnboardingDay = 0 | 3 | 7 | 13;

export interface OnboardingTemplate {
  subject: string;
  /** 本文（HTML可）。 */
  body: string;
}

/**
 * 元実装の day キー付き日本語テンプレート。プロダクト名のみパラメータ化
 * （元実装は "Folia" 固定だった）。文言・HTML構造はそのまま。
 */
export function defaultOnboardingTemplates(productName: string): Record<OnboardingDay, OnboardingTemplate> {
  return {
    0: {
      subject: `${productName} へようこそ！AI を活用した次世代ダッシュボードの第一歩`,
      body: `${productName} へのご登録ありがとうございます！<br><br>${productName} は、AI（Claude/Gemini）があなたのチームの一員として働き、インテリジェンスの収集からコンテンツ生成までを自動化するプラットフォームです。<br><br>まずは「インテリジェンス・フィード」を確認して、最新の市場動向を AI がどう分析しているか見てみましょう。`,
    },
    3: {
      subject: "インテリジェンス・フィードを使いこなしましょう",
      body: "ご利用開始から3日が経ちました。<br><br>キーワード設定はもうお済みですか？設定画面から関心のあるトピックを登録すると、AI が Hacker News や Zenn、GitHub からあなたに最適な情報をピックアップして要約します。",
    },
    7: {
      subject: "コンテンツ・スタジオでクリエイティブを加速する",
      body: "1週間ご利用いただきありがとうございます！<br><br>コンテンツ・スタジオでは、収集したインテリジェンスを元に、ブログ記事や SNS 投稿を 1-click で生成できます。AI とのコラボレーションをぜひ体験してください。",
    },
    13: {
      subject: `【重要】フリートライアル終了まであと1日`,
      body: `${productName} の使い心地はいかがでしょうか？<br><br>明日で無料枠が終了します。引き続き全ての機能をご利用いただくには、Pro プランへのアップグレードをご検討ください。`,
    },
  };
}

export interface OnboardingEmailOptions {
  /** プロダクト名（デフォルトテンプレートに補間される）。 */
  productName: string;
  /** CTAボタンの遷移先（元実装は https://dev.folia.la/overview 固定だった）。 */
  dashboardUrl: string;
  /** 配信停止リンク先（元実装は https://dev.folia.la/settings 固定だった）。 */
  settingsUrl: string;
  /** day キー付きテンプレートの差し替え（部分上書き可）。 */
  templates?: Partial<Record<OnboardingDay, OnboardingTemplate>>;
  /** CTAボタンのラベル。デフォルト「ダッシュボードを開く」。 */
  buttonLabel?: string;
  /** フッター（HTML可）。`{settingsUrl}` を含むデフォルト文をそのまま使う場合は省略。 */
  footerHtml?: string;
}

export function buildOnboardingEmail(
  day: OnboardingDay,
  opts: OnboardingEmailOptions,
): { subject: string; html: string } {
  const templates = { ...defaultOnboardingTemplates(opts.productName), ...opts.templates };
  const t = templates[day];
  const buttonLabel = opts.buttonLabel ?? "ダッシュボードを開く";
  const footerHtml = opts.footerHtml ??
    `配信停止をご希望の場合は <a href="${opts.settingsUrl}" style="color: #555;">設定画面</a> より変更してください。`;

  const html = wrapBody(`    <h1 style="font-size: 20px; font-weight: 700; color: #111; margin: 0 0 16px;">${t.subject}</h1>
    <p style="color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      ${t.body}
    </p>
    <a href="${opts.dashboardUrl}"
       style="display: inline-block; background: #1b3a6b; color: #fff; text-decoration: none;
              font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px;">
      ${buttonLabel}
    </a>
    <p style="color: #999; font-size: 12px; margin: 24px 0 0; line-height: 1.6;">
      ${footerHtml}
    </p>`);

  return { subject: t.subject, html };
}
