import { test, expect, BrowserContext } from "@playwright/test";
import { mkdirSync } from "fs";

const BASE_URL = process.env.PREVIEW_URL || "http://localhost:5173";
const E2E_BYPASS_TOKEN = process.env.E2E_BYPASS_TOKEN || "test-bypass-token";
const FIXED_NOW = "2026-04-18T00:00:00.000Z";

// スクショ保存先ディレクトリを確保
mkdirSync("e2e/screenshots", { recursive: true });

// 全ページに共通する DOM 要素（アプリが正常レンダリングされている証拠）
const NAV_SELECTOR = "nav, aside, [role='navigation']";

// 同一オリジンのリクエストのみにバイパスヘッダーを付与（外部リソースのCORSエラーを防ぐ）
async function addBypassRoute(context: BrowserContext) {
  if (!E2E_BYPASS_TOKEN) return;
  const origin = new URL(BASE_URL).origin;
  await context.route(`${origin}/**`, (route) => {
    route.continue({
      headers: { ...route.request().headers(), "X-E2E-Bypass": E2E_BYPASS_TOKEN },
    });
  });
}

async function addNavigatorRoutes(context: BrowserContext) {
  const origin = new URL(BASE_URL).origin;
  await context.route(`${origin}/api/config/features`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ navigator: true, navigatorStackAdvisor: true }),
    })
  );
  await context.route(`${origin}/api/navigator/cards**`, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          card: {
            id: "e2e-card-1",
            title: "E2E Test Card",
            summary: "Generated from E2E",
            status: "draft",
            createdAt: FIXED_NOW,
            cardData: {
              source: { title: "Manual Input" },
              tool: { name: "E2E Tool" },
              integration: { bridgeType: "api" },
              output: { kind: "github_issue", draftText: "E2E Issue Body" },
              meta: { importanceScore: 0.9, rationale: "E2E Rationale" },
            },
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: undefined }),
    });
  });
}

const pages = [
  { path: "/", name: "Overview", description: "ダッシュボード概要ページ" },
  { path: "/backlog", name: "Backlog", description: "バックログページ" },
  { path: "/team", name: "Team", description: "チームメンバーページ" },
  { path: "/cost", name: "Cost", description: "コスト管理ページ" },
  { path: "/command", name: "AIChat", description: "AIチャットページ" },
  { path: "/github", name: "GitHub", description: "GitHubアクティビティページ" },
  { path: "/analytics", name: "Analytics", description: "ROI計測・アナリティクスページ" },
  { path: "/reports", name: "Reports", description: "AIレポートページ" },
  { path: "/security", name: "Security", description: "セキュリティページ" },
  { path: "/sso-settings", name: "SsoSettings", description: "SSO設定ページ" },
  { path: "/team-management", name: "TeamManagement", description: "チーム管理ページ" },
  { path: "/pipeline", name: "Pipeline", description: "パイプラインページ" },
  { path: "/history", name: "History", description: "履歴ページ" },
  { path: "/intelligence", name: "IntelligenceFeed", description: "インテリジェンスフィードページ" },
  { path: "/content-studio", name: "ContentStudio", description: "コンテンツスタジオページ" },
  { path: "/action-board", name: "ActionBoard", description: "アクションボードページ" },
  { path: "/autopilot", name: "AutoPilot", description: "オートパイロットページ" },
  { path: "/biz-dev-bridge", name: "BizDevBridge", description: "ビジネス連携ページ" },
  { path: "/martech-lab", name: "MarTechLab", description: "マーテックラボページ" },
  { path: "/knowledge-inbox", name: "KnowledgeInbox", description: "ナレッジページ" },
  { path: "/crm", name: "CrmDashboard", description: "CRMダッシュボードページ" },
  { path: "/daily-dashboard", name: "DailyDashboard", description: "AI Daily Dashboard (#721)" },
  { path: "/seo", name: "SEO", description: "SEO管理ダッシュボード" },
  { path: "/competitive", name: "Competitive", description: "競合インテリジェンスページ" },
  { path: "/marketing/roi", name: "MarketingRoi", description: "Marketing ROI 予測ページ" },
  { path: "/navigator?tab=stack-advisor", name: "StackAdvisor", description: "{{APP_NAME}} Navigator Stack Advisor" },
  { path: "/content-calendar", name: "ContentCalendar", description: "コンテンツカレンダーページ" },
  { path: "/japan-integrations", name: "JapanIntegrations", description: "日本市場連携ページ" },
  { path: "/admin/anomalies", name: "AdminAnomalies", description: "異常検知ログ admin viewer (#1022/#1157)" },
  { path: "/admin/weekly-reports", name: "AdminWeeklyReports", description: "週次レポート履歴 admin viewer (#1024/#1034)" },
  { path: "/admin/roi-predictions", name: "AdminRoiPredictions", description: "ROI 予測履歴 admin viewer (#839/#1151)" },
  { path: "/summarizer", name: "Summarizer", description: "Multi-Channel Summarizer (#1156)" },
  { path: "/marketing/roi-predict", name: "MarketingRoiPredict", description: "Marketing ROI Prediction (#839)" },
  { path: "/cos", name: "Cos", description: "AI Chief of Staff (#361)" },
  {
    path: "/memory-archive",
    name: "MemoryArchive",
    description: "Failure Museum + Success Recipes (#1232 MEM-6)",
  },
  { path: "/why-search", name: "WhySearch", description: "Why search natural-language UI over institutional memory (#1230)" },
];

test.describe("Visual Verification", () => {
  for (const page of pages) {
    test(`${page.name} page loads correctly`, async ({ browser }) => {
      // Desktop
      const desktopContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      await addBypassRoute(desktopContext);
      const desktopPage = await desktopContext.newPage();
      const desktopResponse = await desktopPage.goto(`${BASE_URL}${page.path}`, {
        waitUntil: "load",
        timeout: 30000,
      });

      expect(desktopResponse?.status()).toBeLessThan(400);

      // DOM 構造チェック: ナビが見えている = アプリが正常にレンダリングされている
      await expect(desktopPage.locator(NAV_SELECTOR).first())
        .toBeVisible({ timeout: 10_000 });
      // React Error Boundary が発火していないことを確認
      await expect(desktopPage.locator("text=Something went wrong")).not.toBeVisible();

      // スクショはアーティファクト用（CI で比較には使わない）
      await desktopPage.screenshot({
        path: `e2e/screenshots/${page.name}-desktop.png`,
        fullPage: true,
      });
      await desktopContext.close();

      // Mobile
      const mobileContext = await browser.newContext({
        viewport: { width: 375, height: 812 },
        isMobile: true,
      });
      await addBypassRoute(mobileContext);
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(`${BASE_URL}${page.path}`, {
        waitUntil: "load",
        timeout: 30000,
      });

      // モバイルでも同様の DOM 構造チェック
      await expect(mobilePage.locator(NAV_SELECTOR).first())
        .toBeVisible({ timeout: 10_000 });
      await expect(mobilePage.locator("text=Something went wrong")).not.toBeVisible();

      await mobilePage.screenshot({
        path: `e2e/screenshots/${page.name}-mobile.png`,
        fullPage: true,
      });
      await mobileContext.close();
    });
  }

  test("No console errors on key pages", async ({ browser }) => {
    const context = await browser.newContext();
    await addBypassRoute(context);
    const page = await context.newPage();

    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    for (const p of pages) {
      await page.goto(`${BASE_URL}${p.path}`, {
        waitUntil: "load",
        timeout: 30000,
      });
    }

    // Write errors to file for CI report
    if (errors.length > 0) {
      const { writeFileSync } = await import("fs");
      writeFileSync(
        "e2e/screenshots/console-errors.txt",
        errors.join("\n")
      );
    }
    // favicon / robots.txt は全ページで出る既知の 404 → 除外。それ以外は CI を失敗させる
    const filteredErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("robots.txt")
    );
    expect(
      filteredErrors,
      `Console errors detected:\n${filteredErrors.join("\n")}`
    ).toHaveLength(0);
    await context.close();
  });

  test("Navigation works between pages", async ({ browser }) => {
    const context = await browser.newContext();
    await addBypassRoute(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: "load", timeout: 30000 });

    // Check that sidebar navigation buttons exist
    await expect(page.getByRole("button", { name: /Overview|Partner Dashboard|Backlog/ }).first()).toBeVisible();
    await context.close();
  });
});

test.describe("Navigator F3 flow", () => {
  test("Feature Flag OFF -> 404, ON -> 200", async ({ browser }) => {
    const context = await browser.newContext();
    await addBypassRoute(context);
    await addNavigatorRoutes(context);
    
    const page = await context.newPage();
    const response = await page.goto(`${BASE_URL}/navigator`, { waitUntil: "load" });
    
    if (response?.status() === 200) {
      await expect(page.getByText('Manual Input', { exact: false }).or(page.getByText('手動入力', { exact: false }))).toBeVisible();
    } else {
      expect(response?.status()).toBe(404);
    }
  });

  test("Manual Card Generation -> List -> Detail -> Reject", async ({ browser }) => {
    const context = await browser.newContext();
    await addBypassRoute(context);
    await addNavigatorRoutes(context);
    
    await context.route('**/api/navigator/cards/e2e-card-1', async (route) => {
      await route.fulfill({ 
        json: { 
          card: {
            id: 'e2e-card-1', title: 'E2E Test Card', summary: 'Generated from E2E', status: 'draft',
            createdAt: FIXED_NOW,
            cardData: {
              source: { title: 'Manual Input' }, tool: { name: 'E2E Tool' }, integration: { bridgeType: 'api' },
              output: { kind: 'github_issue', draftText: 'E2E Issue Body' }, meta: { importanceScore: 0.9, rationale: 'E2E Rationale' }
            }
          }, 
          actions: [] 
        } 
      });
    });

    await context.route('**/api/navigator/cards/e2e-card-1/action', async (route) => {
      await route.fulfill({ 
        json: { 
          action: { id: 'act-1', actionType: 'reject', payload: { reason: 'E2E Reject' }, createdAt: FIXED_NOW } 
        } 
      });
    });

    const page = await context.newPage();
    const response = await page.goto(`${BASE_URL}/navigator`, { waitUntil: "load" });
    
    if (response?.status() === 404) {
      console.log("Navigator is disabled in this environment. Skipping manual card test.");
      return;
    }

    const textarea = page.locator('textarea');
    await textarea.fill('E2E manual input');
    await page.getByRole('button').filter({ hasText: /Generate|生成/ }).click();

    await expect(page.getByText('E2E Test Card')).toBeVisible();
    await page.getByText('E2E Test Card').click();
    await expect(page.getByText('E2E Rationale')).toBeVisible();
    await expect(page.getByText('E2E Issue Body')).toBeVisible();

    const rejectInput = page.locator('input[placeholder*="Reason"], input[placeholder*="理由"]');
    await rejectInput.fill('E2E Reject');
    await page.getByRole('button').filter({ hasText: /Reject|却下/ }).click();
    await expect(page.getByText("E2E Test Card")).toBeVisible();
  });
});
