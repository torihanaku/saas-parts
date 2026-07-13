/**
 * Ported from dev-dashboard-v2/tests/email.test.ts, adapted to config injection
 * (createEmailClient) instead of env mocking. Template tests extended for
 * trial-end / onboarding builders.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createEmailClient,
  buildInviteEmail,
  buildTrialEndEmail,
  buildOnboardingEmail,
  defaultOnboardingTemplates,
  escapeHtml,
  RESEND_API_URL,
} from "./index";

const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("sendEmail", () => {
  it("sends email and returns ok:true with id on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email-id-123" }), { status: 200 }),
    );
    const client = createEmailClient({ apiKey: "test-resend-api-key", from: "test@example.com", fetchImpl, logger: noopLogger });
    const result = await client.sendEmail({ to: "user@example.com", subject: "Test Subject", html: "<p>Hello</p>" });
    expect(result.ok).toBe(true);
    expect(result.id).toBe("email-id-123");
  });

  it("returns ok:false on HTTP error from Resend", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("invalid_api_key", { status: 401 }));
    const client = createEmailClient({ apiKey: "test-resend-api-key", fetchImpl, logger: noopLogger });
    const result = await client.sendEmail({ to: "user@example.com", subject: "Test", html: "<p>Test</p>" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("returns ok:false on network exception", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    const client = createEmailClient({ apiKey: "test-resend-api-key", fetchImpl, logger: noopLogger });
    const result = await client.sendEmail({ to: "user@example.com", subject: "Test", html: "<p>Test</p>" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("connection refused");
  });

  it("includes correct headers, from address and API URL in the fetch call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    );
    const client = createEmailClient({ apiKey: "test-resend-api-key", from: "sender@example.com", fetchImpl, logger: noopLogger });
    await client.sendEmail({ to: "user@example.com", subject: "Test", html: "<p>Test</p>" });
    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-resend-api-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(opts.body)) as { from: string; to: string };
    expect(body.from).toBe("sender@example.com");
    expect(body.to).toBe("user@example.com");
  });
});

describe("sendEmail without API key", () => {
  it("skips sending, logs the skip, and returns ok:false", async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();
    const client = createEmailClient({ fetchImpl, logger: { log, warn: vi.fn(), error: vi.fn() } });
    const result = await client.sendEmail({ to: "a@b.com", subject: "S", html: "H" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(log.mock.calls[0]![0] as string) as { message: string; to: string };
    expect(entry.message).toBe("email_skipped_no_api_key");
    expect(entry.to).toBe("a@b.com");
  });
});

describe("buildInviteEmail", () => {
  it("generates valid HTML with invite details", () => {
    const html = buildInviteEmail({
      inviterName: "Alice",
      email: "bob@example.com",
      role: "editor",
      inviteUrl: "https://app.example.com/invite/token-abc",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Alice");
    expect(html).toContain("編集者"); // 'editor' maps to '編集者'
    expect(html).toContain("https://app.example.com/invite/token-abc");
    expect(html).toContain("ダッシュボードへの招待"); // default productName preserved
  });

  it("shows correct role label for admin and viewer", () => {
    const admin = buildInviteEmail({ inviterName: "A", role: "admin", inviteUrl: "https://x.example/i" });
    const viewer = buildInviteEmail({ inviterName: "A", role: "viewer", inviteUrl: "https://x.example/i" });
    expect(admin).toContain("管理者");
    expect(viewer).toContain("閲覧者");
  });

  it("falls back to role string for unknown role", () => {
    const html = buildInviteEmail({ inviterName: "A", role: "superuser", inviteUrl: "https://x.example/i" });
    expect(html).toContain("superuser");
  });

  it("includes invite URL in both button and plain text link", () => {
    const url = "https://app.example.com/invite/xyz";
    const html = buildInviteEmail({ inviterName: "A", role: "editor", inviteUrl: url });
    const occurrences = (html.match(new RegExp(url, "g")) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  // Regression: caller-supplied data (inviter name, role, product name, URL)
  // must be HTML-escaped so it cannot break out of its element / attribute.
  it("escapes HTML in inviterName to prevent markup injection", () => {
    const html = buildInviteEmail({
      inviterName: "Eve</strong><img src=x onerror=alert(1)>",
      role: "editor",
      inviteUrl: "https://app.example.com/invite/abc",
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes quotes in inviteUrl so it cannot break out of the href attribute", () => {
    const html = buildInviteEmail({
      inviterName: "A",
      role: "editor",
      inviteUrl: 'https://app.example.com/i" onclick="steal()',
    });
    // The raw attribute-breaking sequence must not appear
    expect(html).not.toContain('i" onclick="steal()');
    expect(html).toContain("&quot;");
  });

  it("escapes HTML in an unknown role label", () => {
    const html = buildInviteEmail({
      inviterName: "A",
      role: "<script>x</script>",
      inviteUrl: "https://x.example/i",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("supports productName and custom role labels", () => {
    const html = buildInviteEmail({
      inviterName: "A",
      role: "owner",
      inviteUrl: "https://x.example/i",
      productName: "MyApp",
      roleLabels: { owner: "オーナー" },
    });
    expect(html).toContain("MyAppへの招待");
    expect(html).toContain("オーナー");
  });
});

describe("buildTrialEndEmail", () => {
  it("renders default Japanese strings and settings URL", () => {
    const html = buildTrialEndEmail({ settingsUrl: "https://app.example.com/settings" });
    expect(html).toContain("フリートライアル終了のお知らせ");
    expect(html).toContain("設定画面を開く");
    const occurrences = (html.match(/https:\/\/app\.example\.com\/settings/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2); // button + fallback link
  });

  it("allows overriding strings", () => {
    const html = buildTrialEndEmail({
      settingsUrl: "https://x.example/s",
      strings: { heading: "Trial ending", buttonLabel: "Open settings" },
    });
    expect(html).toContain("Trial ending");
    expect(html).toContain("Open settings");
  });

  it("escapes quotes in settingsUrl (href attribute safety)", () => {
    const html = buildTrialEndEmail({ settingsUrl: 'https://x.example/s" onclick="x()' });
    expect(html).not.toContain('s" onclick="x()');
    expect(html).toContain("&quot;");
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
  it("leaves ordinary text and URLs unchanged", () => {
    expect(escapeHtml("Alice")).toBe("Alice");
    expect(escapeHtml("https://app.example.com/x/y")).toBe("https://app.example.com/x/y");
  });
});

describe("buildOnboardingEmail", () => {
  const opts = {
    productName: "MyApp",
    dashboardUrl: "https://app.example.com/overview",
    settingsUrl: "https://app.example.com/settings",
  };

  it("interpolates productName into day-0 template", () => {
    const { subject, html } = buildOnboardingEmail(0, opts);
    expect(subject).toContain("MyApp へようこそ");
    expect(html).toContain(subject);
    expect(html).toContain("https://app.example.com/overview");
    expect(html).toContain("https://app.example.com/settings");
    expect(html).not.toContain("folia.la"); // source hardcoded URLs must be gone
  });

  it("returns the day-keyed subject for each drip day", () => {
    expect(buildOnboardingEmail(3, opts).subject).toContain("インテリジェンス・フィード");
    expect(buildOnboardingEmail(7, opts).subject).toContain("コンテンツ・スタジオ");
    expect(buildOnboardingEmail(13, opts).subject).toContain("フリートライアル終了まであと1日");
  });

  it("escapes quotes in dashboardUrl / settingsUrl (href attribute safety)", () => {
    const { html } = buildOnboardingEmail(0, {
      productName: "MyApp",
      dashboardUrl: 'https://x.example/d" onclick="a()',
      settingsUrl: 'https://x.example/s" onclick="b()',
    });
    expect(html).not.toContain('d" onclick="a()');
    expect(html).not.toContain('s" onclick="b()');
  });

  it("allows partial template override", () => {
    const { subject, html } = buildOnboardingEmail(7, {
      ...opts,
      templates: { 7: { subject: "Custom day 7", body: "Custom body" } },
    });
    expect(subject).toBe("Custom day 7");
    expect(html).toContain("Custom body");
    // other days keep defaults
    expect(defaultOnboardingTemplates("MyApp")[3].subject).toContain("インテリジェンス");
  });
});
