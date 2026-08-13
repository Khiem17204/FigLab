import { expect, test } from "@playwright/test";

const project = {
  id: "project-42",
  workspaceId: "workspace-1",
  name: "Cell Atlas",
  status: "active",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const documentResponse = {
  projectId: project.id,
  revision: 3,
  updatedAt: "2026-08-12T00:00:00.000Z",
  document: {
    schemaVersion: 1,
    artboards: [
      { id: "board-1", name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" },
    ],
    objects: [],
    groups: [],
    constraints: [],
    styles: [],
  },
};

test.beforeEach(async ({ page }) => {
  await page.route(/\/v1\/projects$/, async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { projects: [project] } });
    else await route.fulfill({ json: project });
  });
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: documentResponse });
    else await route.fulfill({ json: { ...documentResponse, revision: 4 } });
  });
});

test("opens the real project and exposes rename and delete actions", async ({ page }) => {
  let renamedTo = "";
  let deleted = false;
  await page.route(new RegExp(`/v1/projects/${project.id}$`), async (route) => {
    if (route.request().method() === "PATCH") {
      renamedTo = route.request().postDataJSON().name;
      await route.fulfill({ json: { ...project, name: renamedTo } });
    } else {
      deleted = true;
      await route.fulfill({ status: 204 });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();

  await expect(page.getByRole("heading", { name: "Cell Atlas" })).toBeVisible();
  await page.getByRole("button", { name: "Projects" }).click();
  page.once("dialog", (dialog) => dialog.accept("Renamed Atlas"));
  await page.getByRole("button", { name: "Rename Cell Atlas" }).click();
  await expect.poll(() => renamedTo).toBe("Renamed Atlas");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Cell Atlas" }).click();
  await expect.poll(() => deleted).toBe(true);
});

test("uploads and verifies an original, then creates a crop with accessible handles", async ({
  page,
}) => {
  let assetPoll = 0;
  let putHeaders: Record<string, string> = {};
  await page.route(`**/v1/projects/${project.id}/uploads`, (route) =>
    route.fulfill({
      json: {
        uploadId: "upload-1",
        assetId: "asset-1",
        upload: {
          url: "http://127.0.0.1:4173/minio/upload-1",
          method: "PUT",
          headers: { "x-signed": "yes" },
          expiresAt: "later",
        },
      },
    }),
  );
  await page.route("**/minio/upload-1", (route) => {
    putHeaders = route.request().headers();
    return route.fulfill({ status: 200 });
  });
  await page.route("**/v1/uploads/upload-1/complete", (route) =>
    route.fulfill({ json: { assetId: "asset-1", status: "pending-verification" } }),
  );
  await page.route("**/v1/assets/asset-1", (route) => {
    assetPoll += 1;
    return route.fulfill({
      json: {
        id: "asset-1",
        projectId: project.id,
        filename: "cells.png",
        mimeType: "image/png",
        checksumSha256: "a".repeat(64),
        widthPx: 1,
        heightPx: 1,
        bitDepth: 8,
        channelCount: 3,
        status: assetPoll === 1 ? "pending-verification" : "ready",
        metadata: {},
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    });
  });
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 409,
        json: { code: "REVISION_CONFLICT", message: "changed", currentRevision: 9 },
      });
    } else {
      await route.fulfill({ json: documentResponse });
    }
  });
  let exportMetadata: unknown;
  await page.route(`**/v1/projects/${project.id}/exports`, async (route) => {
    exportMetadata = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();
  await page.getByLabel("Upload original").setInputFiles({
    name: "cells.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=",
      "base64",
    ),
  });

  await expect(page.getByRole("status").filter({ hasText: "completed" })).toBeVisible();
  expect(putHeaders["x-signed"]).toBe("yes");
  expect(putHeaders["content-type"]).toBeUndefined();
  await expect(page.getByRole("img", { name: "Original cells.png" })).toBeVisible();
  const source = page.getByTestId("source-canvas");
  const content = await source.evaluate((element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: target.clientWidth,
      height: target.clientHeight,
    };
  });
  const imageSize = Math.min(content.width, content.height);
  const imageLeft = content.left + (content.width - imageSize) / 2;
  const imageTop = content.top + (content.height - imageSize) / 2;
  await page.mouse.move(imageLeft + imageSize / 4, imageTop + imageSize / 4);
  await page.mouse.down();
  await page.mouse.move(imageLeft + imageSize / 2, imageTop + imageSize / 2);
  await page.mouse.up();

  await expect(page.getByRole("button", { name: /Move view-/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resize view-.* from top left/ })).toBeVisible();
  await expect(
    page.getByText(/Source crop x 0\.25, y 0\.25, width 0\.25, height 0\.25/),
  ).toBeVisible();

  const firstMove = page.getByRole("button", { name: /Move view-/ });
  const firstMoveLabel = await firstMove.getAttribute("aria-label");
  if (!firstMoveLabel) throw new Error("first image view has no move label");
  const firstViewId = firstMoveLabel.replace("Move ", "");

  await page.mouse.move(imageLeft + imageSize / 2, imageTop + imageSize / 2);
  await page.mouse.down();
  await page.mouse.move(imageLeft + (imageSize * 3) / 4, imageTop + (imageSize * 3) / 4);
  await page.mouse.up();
  await expect(page.getByText("Source crop x 0.5, y 0.5, width 0.25, height 0.25.")).toBeVisible();
  await expect(page.getByText(`Sibling panels: ${firstViewId}`)).toBeVisible();

  const moves = page.getByRole("button", { name: /Move view-/ });
  await expect(moves).toHaveCount(2);
  const move = moves.last();
  const selection = move.locator("..");
  const originalLeft = await selection.evaluate((element) => (element as HTMLElement).style.left);
  const moveBox = await move.boundingBox();
  if (!moveBox) throw new Error("move handle has no box");
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width / 2 + 20, moveBox.y + moveBox.height / 2 + 10);
  await expect
    .poll(() => selection.evaluate((element) => (element as HTMLElement).style.left))
    .not.toBe(originalLeft);
  await page.mouse.up();
  const movedLeft = await selection.evaluate((element) => (element as HTMLElement).style.left);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => selection.evaluate((element) => (element as HTMLElement).style.left))
    .toBe(originalLeft);
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(() => selection.evaluate((element) => (element as HTMLElement).style.left))
    .toBe(movedLeft);

  const resize = page.getByRole("button", { name: /Resize view-.* from bottom right/ }).last();
  const originalWidth = await selection.evaluate((element) => (element as HTMLElement).style.width);
  const resizeBox = await resize.boundingBox();
  if (!resizeBox) throw new Error("resize handle has no box");
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    resizeBox.x + resizeBox.width / 2 + 20,
    resizeBox.y + resizeBox.height / 2 + 10,
  );
  await expect
    .poll(() => selection.evaluate((element) => (element as HTMLElement).style.width))
    .not.toBe(originalWidth);
  await page.mouse.up();
  const resizedWidth = await selection.evaluate((element) => (element as HTMLElement).style.width);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => selection.evaluate((element) => (element as HTMLElement).style.width))
    .toBe(originalWidth);
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(() => selection.evaluate((element) => (element as HTMLElement).style.width))
    .toBe(resizedWidth);

  await page.getByRole("slider", { name: "Brightness" }).fill("0.5");
  await expect(page.getByRole("slider", { name: "Brightness" })).toHaveValue("0.5");
  await page.getByRole("checkbox", { name: "Invert" }).check();
  await expect(page.getByRole("checkbox", { name: "Invert" })).toBeChecked();
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("checkbox", { name: "Invert" })).not.toBeChecked();
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByRole("checkbox", { name: "Invert" })).toBeChecked();

  await expect(page.getByRole("alert")).toContainText("local work is retained", { timeout: 3000 });
  await expect(page.getByRole("button", { name: "Reload latest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download my JSON" })).toBeVisible();

  await page.getByRole("radio", { name: "Custom width" }).check();
  await page.getByRole("spinbutton", { name: "Custom width" }).fill("10");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PNG" }).click();
  expect((await download).suggestedFilename()).toBe("figlab-10x13.png");
  expect(exportMetadata).toMatchObject({ format: "png", revision: 3, widthPx: 10, heightPx: 13 });
});
