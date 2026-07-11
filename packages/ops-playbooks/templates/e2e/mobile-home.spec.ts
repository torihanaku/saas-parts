import { test, expect, BrowserContext } from "@playwright/test";

const BASE_URL = process.env.PREVIEW_URL || "http://localhost:5173";
const E2E_BYPASS_TOKEN = process.env.E2E_BYPASS_TOKEN || "test-bypass-token";

async function addMobileRoutes(context: BrowserContext) {
  const origin = new URL(BASE_URL).origin;
  await context.route(`${origin}/**`, (route) => {
    const url = route.request().url();
    if (url === `${origin}/api/config/features`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ pushNotifications: true }),
      });
    }
    if (url === `${origin}/api/user/me`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "e2e@example.com",
          role: "admin",
          plan: "team",
          limits: { contentPerDay: 100, intelligenceRefresh: 50, aiAnalysis: 50, channels: 10 },
          usage: {
            contentGenerate: { used: 0, limit: 100 },
            aiAnalysis: { used: 0, limit: 50 },
          },
          config: { keywords: [], industry: null, goal: null, channels: [] },
        }),
      });
    }
    if (url === `${origin}/api/user/usage/summary`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          plan: "team",
          content_generation: { used: 0, limit: 100 },
          ai_analysis: { used: 0, limit: 50 },
          api_calls: { used: 0, limit: 1000 },
        }),
      });
    }

    if (!E2E_BYPASS_TOKEN) return route.continue();
    route.continue({
      headers: { ...route.request().headers(), "X-E2E-Bypass": E2E_BYPASS_TOKEN },
    });
  });
}

test.describe("Mobile home", () => {
  test("shows PWA Home KPI cards and bottom nav on mobile", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    await addMobileRoutes(context);
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/mobile`, { waitUntil: "load", timeout: 30000 });

    await expect(page.getByTestId("mobile-home-page")).toBeVisible();
    await expect(page.getByTestId("mobile-kpi-card")).toHaveCount(4);
    await expect(page.getByText("Today's submissions")).toBeVisible();
    await expect(page.getByText("Pending approvals")).toBeVisible();
    await expect(page.getByText("Lint pass rate")).toBeVisible();
    await expect(page.getByText("Deploy count")).toBeVisible();
    await expect(page.getByRole("navigation", { name: /bottom navigation/i })).toBeVisible();

    await context.close();
  });
});
