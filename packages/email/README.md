# @torihanaku/email

Resend API（素の fetch）でメールを送る薄いラッパー＋日本語HTMLテンプレートビルダー（招待／トライアル終了／オンボーディング・ドリップ）。APIキー未設定時は送信せずログに残す graceful フォールバックつき。

## 主要API

```ts
import {
  createEmailClient,
  buildInviteEmail,
  buildTrialEndEmail,
  buildOnboardingEmail,
} from "@torihanaku/email";

const email = createEmailClient({
  apiKey: config.resendApiKey,       // 未設定なら送信スキップ＋INFOログ
  from: "noreply@myapp.example",     // FROMはconfigで指定（env直読みしない）
});

// 招待メール（role→日本語ラベルはデフォルト同梱、上書き可）
await email.sendEmail({
  to: "bob@example.com",
  subject: "招待が届きました",
  html: buildInviteEmail({
    inviterName: "Alice",
    role: "editor",                  // 管理者/編集者/閲覧者（未知roleはそのまま表示）
    inviteUrl: "https://myapp.example/invite/token",
    productName: "MyApp",            // 省略時「ダッシュボード」
  }),
});

// トライアル終了通知
buildTrialEndEmail({ settingsUrl: "https://myapp.example/settings" });

// オンボーディング・ドリップ（day 0/3/7/13 キー付きテンプレート）
const { subject, html } = buildOnboardingEmail(3, {
  productName: "MyApp",
  dashboardUrl: "https://myapp.example/overview",
  settingsUrl: "https://myapp.example/settings",
  templates: { 3: { subject: "件名差し替え", body: "本文差し替え" } }, // 部分上書き可
});
```

## 依存

なし（Resend SDK は不使用。元実装どおり素の fetch で `https://api.resend.com/emails` を叩く）。

## 注入ポイント

- `apiKey` — Resend APIキー。未設定なら `email_skipped_no_api_key` をログして `{ ok: false }`
- `from` — FROMアドレス（デフォルト `noreply@yourdomain.com`）
- `apiUrl` / `fetchImpl` / `logger` — テスト・差し替え用
- テンプレート文言 — 全ビルダーで `strings` / `roleLabels` / `templates` により上書き可。デフォルトは元実装の日本語文言（HTML構造も維持）。オンボーディングのみ `productName` / `dashboardUrl` / `settingsUrl` が必須（元実装は "Folia" と dev.folia.la 固定だったため）

## 想定ランタイム

Node 18+ / Bun / Edge（`fetch` があればよい）。

## 出典

`実運用SaaS/server/lib/email.ts`（テスト: `tests/email.test.ts` を移植・拡張）
