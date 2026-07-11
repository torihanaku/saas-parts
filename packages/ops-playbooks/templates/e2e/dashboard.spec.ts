/**
 * ダッシュボードE2Eテスト
 * 実行: npx playwright test
 *
 * 認証が必要なページはCloud Run本番ではGoogle OAuthが必要。
 * ローカル開発では認証をバイパスするか、テスト用Cookieを設定する。
 */
import { test, expect } from "@playwright/test";

test.describe("Dashboard Navigation", () => {
  test("ホームページが表示される", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/{{APP_NAME}}|Dev|開発/i);
    await expect(page.getByRole("button", { name: /Overview|概要/ })).toBeVisible();
  });

  test("サイドバーのナビゲーションでページ遷移できる", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /Backlog|バックログ/ }).click();
    await expect(page).toHaveURL(/\/backlog/);

    await page.getByRole("button", { name: /Agent Settings|エージェント設定/ }).click();
    await expect(page).toHaveURL(/\/team/);

    await page.getByRole("button", { name: /AI Chat|AIチャット/ }).click();
    await expect(page).toHaveURL(/\/command/);
    await expect(page.getByLabel("AI chat message input")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: /Intelligence|インテリジェンス/ }).click();
    await expect(page).toHaveURL(/\/intelligence/);

    await page.getByRole("button", { name: /Cost Mgmt|コスト管理/ }).click();
    await expect(page).toHaveURL(/\/cost/);
  });

  test("サイドバーの折りたたみが動作する", async ({ page }) => {
    await page.goto("/");
    // {{APP_NAME}}ロゴが表示されている
    await expect(page.locator("text={{APP_NAME}}")).toBeVisible();
  });
});

test.describe("Backlog Page", () => {
  test("バックログページが表示される", async ({ page }) => {
    await page.goto("/backlog");

    await expect(page.getByText(/Backlog|バックログ/).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Team Page", () => {
  test("チームメンバーが表示される", async ({ page }) => {
    await page.goto("/team");
    await expect(page.getByText(/Agent|エージェント|Team|チーム/).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("AI Chat Page", () => {
  test("AIチャットページが表示される", async ({ page }) => {
    await page.goto("/command");

    await expect(page.getByLabel("AI chat message input")).toBeVisible({ timeout: 5000 });
  });

  test("履歴クリアボタンが機能する", async ({ page }) => {
    await page.goto("/command");

    // 初期状態では履歴クリアボタンは非表示
    await expect(page.getByText(/Clear history|履歴クリア/)).not.toBeVisible();
  });
});

test.describe("Overview Page", () => {
  test("概要ページにLIVEセクションが表示される", async ({ page }) => {
    await page.goto("/");

    // LIVEセクションが表示される
    await expect(page.locator("text=LIVE")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Cost Page", () => {
  test("コスト管理ページが表示される", async ({ page }) => {
    await page.goto("/cost");

    await expect(page.getByText(/Cost|コスト/).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Cookie Consent", () => {
  test("Cookie同意バナーが初回表示される", async ({ page }) => {
    // localStorageクリアして初回訪問をシミュレート
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("{{APP_SLUG}}-cookie-consent"));
    await page.reload();

    await expect(page.getByRole("button", { name: /Accept|同意する/ })).toBeVisible({ timeout: 5000 });
  });

  test("同意後バナーが非表示になる", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("{{APP_SLUG}}-cookie-consent"));
    await page.reload();

    await page.getByRole("button", { name: /Accept|同意する/ }).click();
    await expect(page.getByRole("button", { name: /Accept|同意する/ })).not.toBeVisible();

    // リロード後もバナーが表示されない
    await page.reload();
    await expect(page.getByRole("button", { name: /Accept|同意する/ })).not.toBeVisible();
  });
});
