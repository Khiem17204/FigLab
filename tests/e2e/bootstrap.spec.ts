import { expect, test } from "@playwright/test";

test("@visual renders the FigLab bootstrap shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveScreenshot("bootstrap-shell.png", { fullPage: true });
});
