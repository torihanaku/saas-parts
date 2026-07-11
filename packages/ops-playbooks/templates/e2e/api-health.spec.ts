import { test, expect } from "@playwright/test";

// PREVIEW_URL: CI では preview deployment の URL が設定される。
// ローカルでは http://localhost:5173 をデフォルトとして使用（bun run dev + server-prod.ts 起動が必要）。
// X-E2E-Bypass ヘッダーは playwright.config.ts の extraHTTPHeaders で一元管理。
const BASE_URL = process.env.PREVIEW_URL || "http://localhost:5173";

const ENDPOINTS = [
  {
    path: "/api/state",
    expectArray: false,
    expectKeys: ["tasks", "history"],
  },
  {
    path: "/api/backlog",
    expectArray: false,
    expectKeys: ["data", "pagination"],
  },
  {
    path: "/api/crm/deals",
    expectArray: true,
  },
  {
    path: "/api/crm/tasks",
    expectArray: true,
  },
  {
    path: "/api/crm/metrics",
    expectArray: false,
    expectKeys: ["totalPipeline", "activeDeals", "winRate"],
  },
];

test.describe("API Health", () => {
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.path} returns valid response`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${endpoint.path}`);

      expect(
        res.status(),
        `${endpoint.path} returned HTTP ${res.status()}`
      ).toBeLessThan(400);

      const body = await res.json();

      if (endpoint.expectArray) {
        expect(
          Array.isArray(body),
          `${endpoint.path} should return an array, got: ${JSON.stringify(body).slice(0, 100)}`
        ).toBe(true);
      }

      if (endpoint.path === "/api/backlog") {
        expect(
          Array.isArray(body.data),
          `${endpoint.path} data should be an array, got: ${JSON.stringify(body).slice(0, 100)}`
        ).toBe(true);
      }

      if (endpoint.expectKeys) {
        for (const key of endpoint.expectKeys) {
          expect(
            body,
            `${endpoint.path} missing required key: "${key}"`
          ).toHaveProperty(key);
        }
      }
    });
  }
});
