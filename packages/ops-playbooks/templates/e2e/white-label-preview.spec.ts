import { test, expect, BrowserContext } from "@playwright/test";

const BASE_URL = process.env.PREVIEW_URL || "http://localhost:5173";
const E2E_BYPASS_TOKEN = process.env.E2E_BYPASS_TOKEN || "test-bypass-token";

let currentConfig = {
  tenant_id: "tenant-e2e",
  brand_name: "{{APP_NAME}}",
  logo_url: null as string | null,
  primary_color: "#4f46e5",
  favicon_url: null as string | null,
  custom_domain: null as string | null,
  custom_email_from: null as string | null,
  footer_html: null as string | null,
  created_at: "2026-05-06T00:00:00.000Z",
  updated_at: "2026-05-06T00:00:00.000Z",
};

async function addWhiteLabelRoutes(context: BrowserContext) {
  const origin = new URL(BASE_URL).origin;
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/config/features") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ whiteLabel: true }),
      });
    }

    if (url.pathname === "/api/user/me") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: "white-label-e2e@example.com",
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

    if (url.pathname === "/api/user/usage/summary") {
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

    if (url.pathname === "/api/white-label/config" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: true, config: currentConfig }),
      });
    }

    if (url.pathname === "/api/white-label/config" && route.request().method() === "PUT") {
      const payload = route.request().postDataJSON() as Partial<typeof currentConfig>;
      currentConfig = {
        ...currentConfig,
        ...payload,
        updated_at: "2026-05-06T01:00:00.000Z",
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, config: currentConfig }),
      });
    }

    return route.continue({
      headers: { ...route.request().headers(), "X-E2E-Bypass": E2E_BYPASS_TOKEN },
    });
  });
}

test.describe("White label preview", () => {
  test.beforeEach(() => {
    currentConfig = {
      tenant_id: "tenant-e2e",
      brand_name: "{{APP_NAME}}",
      logo_url: null,
      primary_color: "#4f46e5",
      favicon_url: null,
      custom_domain: null,
      custom_email_from: null,
      footer_html: null,
      created_at: "2026-05-06T00:00:00.000Z",
      updated_at: "2026-05-06T00:00:00.000Z",
    };
  });

  test("edits all tabs, saves, and reflects settings in the iframe preview", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem("app-onboarding-complete", "true");
      window.localStorage.setItem("onboarding_completed", "true");
      window.localStorage.setItem("cookie_consent", "accepted");
    });
    await addWhiteLabelRoutes(context);
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/settings/white-label`, { waitUntil: "load", timeout: 30000 });
    await expect(page.getByTestId("white-label-page")).toBeVisible();

    await page.getByRole("tab", { name: "Logo" }).click();
    await page.getByLabel("Logo URL").fill("https://example.com/acme-logo.png");
    await page.getByLabel("Favicon URL").fill("https://example.com/favicon.ico");

    await page.getByRole("tab", { name: "Color" }).click();
    await page.getByLabel("Brand name").fill("Acme Ops");
    await page.getByPlaceholder("#4f46e5").fill("#0f766e");

    await page.getByRole("tab", { name: "Footer" }).click();
    await page.getByLabel("Footer HTML").fill("<p>Acme confidential footer</p>");

    await page.getByRole("tab", { name: "Delivery" }).click();
    await page.getByLabel("Custom domain").fill("portal.acme.test");
    await page.getByLabel("Outbound email From address").fill("alerts@acme.test");

    const frame = page.frameLocator('iframe[title="White label dashboard preview"]');
    await expect(frame.getByText("Acme Ops")).toBeVisible();
    await expect(frame.getByText("portal.acme.test")).toBeVisible();
    await expect(frame.getByTestId("white-label-preview-footer")).toContainText("Acme confidential footer");

    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    await expect(frame.getByText("Acme Ops")).toBeVisible();
    await expect(frame.getByText("alerts@acme.test")).toBeVisible();

    await context.close();
  });
});
