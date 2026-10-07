import { readFile } from "node:fs/promises";
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
    if (route.request().method() === "PUT") {
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
    if (route.request().method() !== "POST") return route.fulfill({ json: { exports: [] } });
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
  await move.scrollIntoViewIfNeeded();
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
  await resize.scrollIntoViewIfNeeded();
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

  await page.getByRole("button", { name: "Delete selected panel" }).click();
  await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(2);
  await page.keyboard.press("Delete");
  await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(2);

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

  await page.getByRole("button", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "Cell Atlas" })).toBeVisible();

  const recoveryDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my JSON" }).click();
  const recovery = await recoveryDownload;
  const recoveryPath = await recovery.path();
  if (!recoveryPath) throw new Error("recovery download has no local path");
  const recoveredDocument = JSON.parse(await readFile(recoveryPath, "utf8")) as {
    objects: { view: { display: { invert: boolean } } }[];
  };
  expect(recoveredDocument.objects.some((object) => object.view.display.invert)).toBe(true);

  await page.getByRole("button", { name: "Export PNG" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Save the project before exporting" }),
  ).toBeVisible();
  expect(exportMetadata).toBeUndefined();
});

test("exports the exact saved revision at the current artboard dimensions", async ({ page }) => {
  const landscape = {
    ...documentResponse,
    document: {
      ...documentResponse.document,
      artboards: [
        {
          ...documentResponse.document.artboards[0],
          widthPt: 400,
          heightPt: 200,
        },
      ],
    },
  };
  let savedBody: unknown;
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: landscape });
    savedBody = route.request().postDataJSON();
    return route.fulfill({ json: { ...landscape, revision: 4 } });
  });
  let exportMetadata: unknown;
  await page.route(`**/v1/projects/${project.id}/exports`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { exports: [] } });
    exportMetadata = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PNG" }).click();

  // 400 × 200 pt at the default 300 dpi.
  expect((await download).suggestedFilename()).toBe("cell-atlas-figure-1-300dpi.png");
  expect(savedBody).toMatchObject({
    baseRevision: 3,
    document: { ...landscape.document, schemaVersion: 3, sources: [] },
  });
  expect(exportMetadata).toMatchObject({
    format: "png",
    artboardId: "board-1",
    dpi: 300,
    revision: 4,
    widthPx: 1667,
    heightPx: 833,
  });
});

const twoPanels = {
  ...documentResponse,
  document: {
    ...documentResponse.document,
    schemaVersion: 2,
    objects: [
      ["view-a", 60, 120],
      ["view-b", 320, 150],
    ].map(([id, xPt, yPt]) => ({
      id,
      type: "image-view",
      artboardId: "board-1",
      transform: { xPt, yPt, widthPt: 200, heightPt: 150, rotationDeg: 0 },
      zIndex: id === "view-a" ? 0 : 1,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "asset-1",
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
      },
    })),
  },
};

type SavedDocument = {
  artboards: { id: string; widthPt: number }[];
  objects: {
    id: string;
    type: string;
    transform: { xPt: number; yPt: number };
    text?: { content: string };
    panelLabel?: { targetObjectId: string };
    line?: { heads: string };
  }[];
};

async function openWithSaves(page: import("@playwright/test").Page) {
  const saves: SavedDocument[] = [];
  let revision = 3;
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: twoPanels });
    const body = route.request().postDataJSON() as { document: SavedDocument };
    saves.push(body.document);
    revision += 1;
    return route.fulfill({ json: { ...twoPanels, revision, document: body.document } });
  });
  await page.route("**/v1/assets/asset-1", (route) =>
    route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Resource not found" } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();
  await expect(page.getByRole("button", { name: "Move view-a" })).toBeAttached();
  return { saves, latest: () => saves.at(-1) };
}

/** A point at fractions of the figure canvas, scrolled to the middle of the viewport. */
async function canvasPoint(page: import("@playwright/test").Page, fx: number, fy: number) {
  const canvas = page.locator(".figure-canvas");
  const before = await canvas.boundingBox();
  if (!before) throw new Error("figure canvas has no box");
  await page.evaluate(
    (y) => window.scrollBy(0, y - window.innerHeight / 2),
    before.y + before.height * fy,
  );
  const box = await canvas.boundingBox();
  if (!box) throw new Error("figure canvas has no box");
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

test("draws text and arrows, with symbol shortcuts, and labels panels in reading order", async ({
  page,
}) => {
  const { latest } = await openWithSaves(page);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const textAt = await canvasPoint(page, 0.5, 0.15);
  await page.mouse.click(textAt.x, textAt.y);
  const content = page.getByLabel("Text content");
  await content.fill("TNF\\alpha 10 \\muM");
  await content.blur();
  await expect
    .poll(() => latest()?.objects.find((object) => object.type === "text")?.text?.content)
    .toBe("TNFα 10 μM");

  await page.getByRole("button", { name: "Arrow" }).click();
  const from = await canvasPoint(page, 0.7, 0.8);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 80, from.y - 20);
  await page.mouse.up();
  await expect
    .poll(() => latest()?.objects.find((object) => object.type === "line")?.line?.heads)
    .toBe("start");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Label panels" }).click();
  await expect
    .poll(() =>
      latest()
        ?.objects.filter((object) => object.panelLabel)
        .map((object) => [object.panelLabel?.targetObjectId, object.text?.content]),
    )
    .toEqual([
      ["view-a", "A"],
      ["view-b", "B"],
    ]);
});

test("multi-selects, aligns, and adds a journal-sized figure", async ({ page }) => {
  const { latest } = await openWithSaves(page);
  const layers = page.getByRole("group", { name: /Layers/ });
  await layers.getByRole("button", { name: "Image panel" }).first().click();
  await layers
    .getByRole("button", { name: "Image panel" })
    .last()
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Align top" }).click();
  await expect
    .poll(() => latest()?.objects.map((object) => object.transform.yPt))
    .toEqual([120, 120]);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => latest()?.objects.map((object) => object.transform.yPt))
    .toEqual([120, 150]);

  await page.getByRole("button", { name: "Add figure" }).click();
  await expect(page.getByRole("button", { name: "Figure 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Figure size").selectOption("nature-single");
  await expect
    .poll(() => latest()?.artboards.map((artboard) => Math.round(artboard.widthPt * 100) / 100))
    .toEqual([612, 252.28]);
  await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(0);
});

test("exports every figure as TIFF in one zip and records each figure", async ({ page }) => {
  const records: { format: string; artboardId: string; dpi: number }[] = [];
  await page.route(`**/v1/projects/${project.id}/exports`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { exports: [] } });
    records.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  const empty = {
    ...documentResponse,
    document: {
      ...documentResponse.document,
      schemaVersion: 2,
      artboards: [
        { id: "board-1", name: "Figure 1", widthPt: 144, heightPt: 72, backgroundHex: "#FFFFFF" },
        { id: "board-2", name: "Blots", widthPt: 72, heightPt: 72, backgroundHex: "#FFFFFF" },
      ],
    },
  };
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), async (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? empty : { ...empty, revision: 4 } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();
  await page.getByLabel("Format").selectOption("tiff");
  await page.getByLabel("Resolution").selectOption("150");
  await page.getByLabel(/All figures/).check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export TIFF" }).click();
  expect((await download).suggestedFilename()).toBe("cell-atlas-figures-150dpi-tiff.zip");
  expect(records).toEqual([
    expect.objectContaining({
      format: "tiff",
      artboardId: "board-1",
      dpi: 150,
      widthPx: 300,
      heightPx: 150,
    }),
    expect.objectContaining({
      format: "tiff",
      artboardId: "board-2",
      dpi: 150,
      widthPx: 150,
      heightPx: 150,
    }),
  ]);
});

test("shows the audit trail with actors and restores an earlier version", async ({ page }) => {
  await page.route(`**/v1/projects/${project.id}/audit-events*`, (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: "e2",
            action: "DISPLAY_CHANGED",
            details: { objectId: "view-a", before: { gamma: 1 }, after: { gamma: 1.4 } },
            actor: { id: "u1", email: "pi@lab.example" },
            sequence: 2,
            createdAt: "2026-10-06T10:00:00.000Z",
          },
          {
            id: "e1",
            action: "CROP_CREATED",
            details: { objectId: "view-a" },
            sequence: 1,
            createdAt: "2026-10-06T09:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.route(new RegExp(`/v1/projects/${project.id}/versions(\\?.*)?$`), (route) =>
    route.fulfill({
      json: {
        versions: [
          { revision: 3, schemaVersion: 2, createdAt: "2026-10-06T10:00:00.000Z" },
          { revision: 2, schemaVersion: 1, createdAt: "2026-10-06T09:00:00.000Z" },
        ],
      },
    }),
  );
  await page.route(`**/v1/projects/${project.id}/versions/2`, (route) =>
    route.fulfill({
      json: {
        projectId: project.id,
        revision: 2,
        schemaVersion: 1,
        createdAt: "2026-10-06T09:00:00.000Z",
        document: { ...twoPanels.document, objects: twoPanels.document.objects.slice(0, 1) },
      },
    }),
  );
  const { latest } = await openWithSaves(page);
  const trail = page.getByRole("list", { name: "Audit trail" });
  await expect(trail).toContainText("Display adjusted: gamma 1 → 1.4");
  await expect(trail).toContainText("pi@lab.example");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Restore revision 2" }).click();
  await expect.poll(() => latest()?.objects.map((object) => object.id)).toEqual(["view-a"]);
});

const GRADIENT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAANklEQVR4AaXBAQ2AAAzAsJJcwCRcKs5BxNuH9wshhBBCCCGEEMJYJ2OdjHUy1slYJ2OdjHXyA8+XA21qw46BAAAAAElFTkSuQmCC";

type SavedV3 = {
  sources: {
    assetId: string;
    widthPx: number;
    calibration: { umPerPxX: number; origin: string } | null;
  }[];
  objects: {
    id: string;
    type: string;
    view?: { rotationDeg: number; flipX: boolean };
    laneTable?: { rows: { cells: { text: string; span: number; underline: boolean }[] }[] };
    scaleBar?: { lengthUm: number };
  }[];
};

/** Opens an empty project, uploads the 16 × 8 gradient, and records every saved document. */
async function openWithUploadedOriginal(page: import("@playwright/test").Page) {
  const saves: SavedV3[] = [];
  const exports: { format: string }[] = [];
  let revision = 3;
  const empty = {
    ...documentResponse,
    document: { ...documentResponse.document, schemaVersion: 3, sources: [] },
  };
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: empty });
    const body = route.request().postDataJSON() as { document: SavedV3 };
    saves.push(body.document);
    revision += 1;
    return route.fulfill({ json: { ...empty, revision, document: body.document } });
  });
  await page.route(`**/v1/projects/${project.id}/exports`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { exports: [] } });
    exports.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.route(`**/v1/projects/${project.id}/uploads`, (route) =>
    route.fulfill({
      json: {
        uploadId: "upload-g",
        assetId: "asset-g",
        upload: {
          url: "http://127.0.0.1:4173/minio/upload-g",
          method: "PUT",
          headers: {},
          expiresAt: "later",
        },
      },
    }),
  );
  await page.route("**/minio/upload-g", (route) => route.fulfill({ status: 200 }));
  await page.route("**/v1/uploads/upload-g/complete", (route) =>
    route.fulfill({ json: { assetId: "asset-g", status: "ready" } }),
  );
  await page.route("**/v1/assets/asset-g", (route) =>
    route.fulfill({
      json: {
        id: "asset-g",
        projectId: project.id,
        filename: "gradient.png",
        mimeType: "image/png",
        checksumSha256: "b".repeat(64),
        widthPx: 16,
        heightPx: 8,
        bitDepth: 8,
        channelCount: 4,
        status: "ready",
        metadata: {},
        createdAt: "2026-10-06T00:00:00.000Z",
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();
  await page.getByLabel("Upload original").setInputFiles({
    name: "gradient.png",
    mimeType: "image/png",
    buffer: Buffer.from(GRADIENT_PNG, "base64"),
  });
  await expect(page.getByRole("img", { name: "Original gradient.png" })).toBeVisible();
  return { saves, latest: () => saves.at(-1), exports };
}

/** A point at fractions of the displayed original (16 × 8, letterboxed in the source canvas). */
async function originalPoint(page: import("@playwright/test").Page, fx: number, fy: number) {
  const canvas = page.getByTestId("source-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: (element as HTMLElement).clientWidth,
      height: (element as HTMLElement).clientHeight,
    };
  });
  const scale = Math.min(box.width / 16, box.height / 8);
  const left = box.left + (box.width - 16 * scale) / 2;
  const top = box.top + (box.height - 8 * scale) / 2;
  return { x: left + fx * 16 * scale, y: top + fy * 8 * scale };
}

test("band-crops along a tilted line, then flips the panel", async ({ page }) => {
  const { latest } = await openWithUploadedOriginal(page);
  await page.getByRole("button", { name: "Band (line) crop" }).click();
  await page.getByLabel("Band height (px)").fill("2");
  const from = await originalPoint(page, 0.2, 0.4);
  const to = await originalPoint(page, 0.8, 0.6);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: /Band crop rotated/ })).toBeVisible();
  // 9.6 px across and 1.6 px down: atan(1.6 / 9.6) ≈ 9.46°.
  await expect.poll(() => latest()?.objects[0]?.view?.rotationDeg).toBeCloseTo(9.46, 1);
  expect(latest()?.sources).toEqual([expect.objectContaining({ assetId: "asset-g", widthPx: 16 })]);
  await page.getByLabel("Flip horizontally").check();
  await expect.poll(() => latest()?.objects[0]?.view?.flipX).toBe(true);
});

test("calibrates by hand, adds a scale bar and lane labels, and checks integrity", async ({
  page,
}) => {
  const { latest, exports } = await openWithUploadedOriginal(page);
  const from = await originalPoint(page, 0, 0);
  const to = await originalPoint(page, 1, 1);
  await page.mouse.move(from.x + 1, from.y + 1);
  await page.mouse.down();
  await page.mouse.move(to.x - 1, to.y - 1, { steps: 4 });
  await page.mouse.up();
  await page.getByLabel("Pixel size (µm/px)").fill("0.5");
  await page.getByRole("button", { name: "Set pixel size" }).click();
  await expect
    .poll(() => latest()?.sources[0]?.calibration)
    .toEqual({ umPerPxX: 0.5, umPerPxY: 0.5, origin: "manual" });

  const panel = page.getByRole("button", { name: /Move view-/ });
  await panel.scrollIntoViewIfNeeded();
  await panel.click();
  await page.getByRole("button", { name: "Add scale bar" }).click();
  await expect
    .poll(() => latest()?.objects.find((object) => object.type === "scale-bar")?.scaleBar?.lengthUm)
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: /Move view-/ }).click();
  await page.getByLabel("Lanes", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Add lane labels" }).click();
  const rows = page.getByLabel(/Rows \(one per line/);
  await rows.fill("_HeLa*2 | _HEK*2\n+ | − | + | −");
  await rows.blur();
  await expect
    .poll(
      () =>
        latest()?.objects.find((object) => object.type === "lane-table")?.laneTable?.rows[0]?.cells,
    )
    .toEqual([
      { text: "HeLa", span: 2, underline: true },
      { text: "HEK", span: 2, underline: true },
    ]);

  await page.getByRole("button", { name: "Check integrity" }).click();
  await expect(page.getByRole("list", { name: "Integrity findings" })).toContainText(
    "manually entered pixel size",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download provenance bundle" }).click();
  expect((await download).suggestedFilename()).toMatch(/^cell-atlas-provenance-r\d+\.zip$/);
  expect(exports).toEqual([expect.objectContaining({ format: "pdf", dpi: 300 })]);
});

const INVITE_TOKEN = "A".repeat(43);
const personalWorkspace = {
  id: "workspace-1",
  name: "Personal workspace",
  kind: "personal",
  role: "owner",
  memberCount: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const labWorkspace = {
  id: "lab-1",
  name: "Ramos Lab",
  kind: "lab",
  role: "viewer",
  memberCount: 3,
  createdAt: "2026-10-02T00:00:00.000Z",
};
const labProject = { ...project, id: "project-lab", workspaceId: "lab-1", name: "Lab blots" };

/** Mocks the lab routes for a user who is owner of their personal workspace. */
async function mockLabs(page: import("@playwright/test").Page, labRole = "owner") {
  // "none": not a member until the invite is accepted, then a viewer.
  const lab = { ...labWorkspace, role: labRole === "none" ? "viewer" : labRole };
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let joined = false;
  await page.route(/\/v1\/me$/, (route) =>
    route.fulfill({
      json: {
        email: "pi@lab.test",
        role: "member",
        userId: "user-1",
        personalWorkspaceId: personalWorkspace.id,
      },
    }),
  );
  await page.route(/\/v1\/workspaces$/, (route) =>
    route.fulfill({
      json: {
        workspaces: joined || labRole !== "none" ? [personalWorkspace, lab] : [personalWorkspace],
      },
    }),
  );
  await page.route(/\/v1\/workspaces\/[^/]+\/(folders|templates)$/, (route) =>
    route.fulfill({ json: { folders: [], templates: [] } }),
  );
  await page.route(/\/v1\/workspaces\/lab-1\/projects(\?.*)?$/, (route) =>
    route.fulfill({ json: { projects: [labProject] } }),
  );
  await page.route(/\/v1\/workspaces\/lab-1\/members$/, (route) =>
    route.fulfill({
      json: {
        members: [
          {
            userId: "user-1",
            email: "pi@lab.test",
            role: labRole === "none" ? "viewer" : labRole,
            joinedAt: "2026-10-02T00:00:00.000Z",
          },
          {
            userId: "user-2",
            email: "student@lab.test",
            role: "editor",
            joinedAt: "2026-10-03T00:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.route(/\/v1\/workspaces\/lab-1\/invites$/, async (route) => {
    const method = route.request().method();
    calls.push({
      method,
      url: route.request().url(),
      body: route.request().postDataJSON() ?? undefined,
    });
    if (method === "GET") return route.fulfill({ json: { invites: [] } });
    return route.fulfill({
      status: 201,
      json: {
        token: INVITE_TOKEN,
        invite: {
          id: "invite-1",
          workspaceId: "lab-1",
          role: "viewer",
          createdBy: { id: "user-1", email: "pi@lab.test" },
          status: "pending",
          expiresAt: "2026-10-14T00:00:00.000Z",
          createdAt: "2026-10-07T00:00:00.000Z",
        },
      },
    });
  });
  await page.route(new RegExp(`/v1/invites/${INVITE_TOKEN}$`), (route) =>
    route.fulfill({
      json: {
        workspaceId: "lab-1",
        workspaceName: "Ramos Lab",
        role: "viewer",
        status: "pending",
        expiresAt: "2026-10-14T00:00:00.000Z",
      },
    }),
  );
  await page.route(new RegExp(`/v1/invites/${INVITE_TOKEN}/accept$`), (route) => {
    joined = true;
    calls.push({ method: "POST", url: route.request().url() });
    return route.fulfill({ json: { ...lab, role: "viewer" } });
  });
  return calls;
}

test("switches to a lab and creates a copyable invite link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const calls = await mockLabs(page);
  await page.goto("/");
  await page.getByLabel("Workspace").selectOption("lab-1");
  await expect(page.getByText("Lab · Ramos Lab")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Lab blots" })).toBeVisible();
  await page.getByRole("button", { name: "Lab members" }).click();
  await expect(page.getByRole("table", { name: "Members" })).toContainText("student@lab.test");
  await page.getByLabel("Invite role").selectOption("viewer");
  await page.getByLabel("Only for email (optional)").fill("new@lab.test");
  await page.getByRole("button", { name: "Create invite link" }).click();
  await expect(page.getByLabel("Invite link")).toHaveValue(
    `http://127.0.0.1:4273/?invite=${INVITE_TOKEN}`.replace("4273", new URL(page.url()).port),
  );
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    role: "viewer",
    email: "new@lab.test",
  });
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invite link copied." })).toBeVisible();
});

test("joins a lab from an invite link and opens its projects view-only with comments", async ({
  page,
}) => {
  const calls = await mockLabs(page, "none");
  const comments: { body: string; anchor?: unknown }[] = [];
  await page.route(/\/v1\/projects\/project-lab\/document$/, (route) =>
    route.fulfill({ json: { ...documentResponse, projectId: "project-lab" } }),
  );
  await page.route(/\/v1\/projects\/project-lab\/comments$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { body: string; anchor?: unknown };
      comments.push(body);
      return route.fulfill({
        status: 201,
        json: {
          id: `comment-${comments.length}`,
          projectId: "project-lab",
          author: { id: "user-1", email: "pi@lab.test" },
          body: body.body,
          ...(body.anchor ? { anchor: body.anchor } : {}),
          createdAt: "2026-10-07T00:00:00.000Z",
          updatedAt: "2026-10-07T00:00:00.000Z",
        },
      });
    }
    return route.fulfill({
      json: {
        comments: comments.map((comment, index) => ({
          id: `comment-${index + 1}`,
          projectId: "project-lab",
          author: { id: "user-1", email: "pi@lab.test" },
          body: comment.body,
          ...(comment.anchor ? { anchor: comment.anchor } : {}),
          createdAt: "2026-10-07T00:00:00.000Z",
          updatedAt: "2026-10-07T00:00:00.000Z",
        })),
      },
    });
  });
  let saves = 0;
  await page.route(/\/v1\/projects\/project-lab\/document$/, async (route) => {
    if (route.request().method() === "PUT") saves += 1;
    return route.fulfill({ json: { ...documentResponse, projectId: "project-lab" } });
  });

  await page.goto(`/?invite=${INVITE_TOKEN}`);
  await expect(page.getByRole("region", { name: "Lab invite" })).toContainText(
    "You are invited to join Ramos Lab as viewer.",
  );
  await page.getByRole("button", { name: "Join Ramos Lab" }).click();
  await expect.poll(() => calls.some((call) => call.url.endsWith("/accept"))).toBe(true);
  await expect(page.getByText("Lab · Ramos Lab")).toBeVisible();
  expect(new URL(page.url()).search).toBe("");

  await page.getByRole("button", { name: "Open Lab blots" }).click();
  await expect(page.getByRole("note")).toContainText("View only");
  await expect(page.getByLabel("Upload original")).toBeHidden();
  await expect(page.getByRole("region", { name: "Template" })).toHaveCount(0);
  await page.getByLabel("Comment", { exact: true }).fill("Lane 3 looks saturated");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByRole("list", { name: "Comment threads" })).toContainText(
    "Lane 3 looks saturated",
  );
  expect(comments).toEqual([{ body: "Lane 3 looks saturated", anchor: { artboardId: "board-1" } }]);
  await page.getByRole("button", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  expect(saves).toBe(0);
});
