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
  await page.route("**/minio/upload-1", (route) => route.fulfill({ status: 200 }));
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
  await expect(page.getByRole("img", { name: "Original cells.png" })).toBeVisible();
  const source = page.getByTestId("source-canvas");
  const box = await source.boundingBox();
  if (!box) throw new Error("source canvas has no box");
  await source.dispatchEvent("pointerdown", {
    pointerId: 1,
    clientX: box.x + 10,
    clientY: box.y + 10,
  });
  await source.dispatchEvent("pointermove", {
    pointerId: 1,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await source.dispatchEvent("pointerup", {
    pointerId: 1,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });

  await expect(page.getByRole("button", { name: /Move view-/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resize view-.* from top left/ })).toBeVisible();
  await expect(page.getByText(/Source crop x /)).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByRole("button", { name: /Move view-/ })).toBeVisible();

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
