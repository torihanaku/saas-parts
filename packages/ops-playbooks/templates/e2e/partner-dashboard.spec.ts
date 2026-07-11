import { expect, test, type Page } from "@playwright/test";

async function stubPartnerDashboardApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("app-onboarding-complete", "true");
    localStorage.setItem("onboarding_completed", "true");
    localStorage.setItem("{{APP_SLUG}}-cookie-consent", "true");
  });

  await page.route("**/api/config/features", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ whiteLabel: true }),
    });
  });

  await page.route("**/api/user/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "partner-user-1",
        email: "partner@example.com",
        name: "Partner Operator",
        role: "partner_role",
        tenantId: "partner-tenant-1",
      }),
    });
  });

  await page.route("**/api/user/usage/summary", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plan: "partner", usage: {}, limits: {} }),
    });
  });

  await page.route("**/api/partner/customers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customers: [
          {
            clientTenantId: "client-tenant-acme",
            planTier: "growth",
            resellerPricingJpy: 100000,
            status: "active",
            startedAt: "2026-05-01T00:00:00Z",
            arrJpy: 1200000,
          },
        ],
      }),
    });
  });

  await page.route("**/api/partner/revenue", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        revenue: {
          totalArrJpy: 1200000,
          revenueShareJpy: 360000,
          revenueShareRate: 0.3,
          activeCustomers: 1,
        },
      }),
    });
  });
}

test.describe("Partner dashboard", () => {
  test("shows customer list and fixed 30 percent revenue share for a partner role user", async ({ page }) => {
    await stubPartnerDashboardApi(page);

    await page.goto("/partner");

    await expect(page.getByTestId("partner-dashboard-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Partner Dashboard|パートナーダッシュボード/ })).toBeVisible();
    await expect(page.getByText("client-tenant-acme")).toBeVisible();
    await expect(page.getByRole("cell", { name: "¥1,200,000" })).toBeVisible();
    await expect(page.getByText("¥360,000")).toBeVisible();
    await expect(page.getByText("30%")).toBeVisible();
  });
});
