import { expect, test } from "@playwright/test";

test("@visual renders the FigLab bootstrap shell", async ({ page }) => {
  await page.route("**/v1/projects", (route) => route.fulfill({ json: { projects: [] } }));
  await page.goto("/");

  await expect(page).toHaveScreenshot("bootstrap-shell.png", { fullPage: true });
});
