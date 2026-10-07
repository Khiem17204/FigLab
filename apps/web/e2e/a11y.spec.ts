import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

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
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=",
  "base64",
);

const personalWorkspace = {
  id: "workspace-1",
  name: "Personal workspace",
  kind: "personal",
  role: "owner",
  memberCount: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const labWorkspace = { ...personalWorkspace, id: "lab-1", name: "Ramos Lab", kind: "lab" };

async function mockLabs(page: Page) {
  await page.route(/\/v1\/me$/, (route) =>
    route.fulfill({
      json: {
        email: "pi@lab.test",
        role: "admin",
        userId: "user-1",
        personalWorkspaceId: "workspace-1",
      },
    }),
  );
  await page.route(/\/v1\/workspaces$/, (route) =>
    route.fulfill({ json: { workspaces: [personalWorkspace, labWorkspace] } }),
  );
  await page.route(/\/v1\/workspaces\/[^/]+\/folders$/, (route) =>
    route.fulfill({
      json: { folders: [{ id: "f1", name: "Paper 1", parentId: null, archived: false }] },
    }),
  );
  await page.route(/\/v1\/workspaces\/[^/]+\/templates$/, (route) =>
    route.fulfill({ json: { templates: [{ id: "t1", name: "4-panel blot" }] } }),
  );
  await page.route(/\/v1\/workspaces\/lab-1\/projects(\?.*)?$/, (route) =>
    route.fulfill({
      json: { projects: [{ ...project, id: "project-lab", workspaceId: "lab-1" }] },
    }),
  );
  await page.route(/\/v1\/workspaces\/lab-1\/members$/, (route) =>
    route.fulfill({
      json: {
        members: [
          {
            userId: "user-1",
            email: "pi@lab.test",
            role: "owner",
            joinedAt: "2026-10-02T00:00:00Z",
          },
          {
            userId: "user-2",
            email: "student@lab.test",
            role: "editor",
            joinedAt: "2026-10-03T00:00:00Z",
          },
        ],
      },
    }),
  );
  await page.route(/\/v1\/workspaces\/lab-1\/invites$/, (route) =>
    route.fulfill({ json: { invites: [] } }),
  );
}

async function mockApi(page: Page) {
  await page.route(/\/v1\/projects$/, (route) => route.fulfill({ json: { projects: [project] } }));
  await page.route(new RegExp(`/v1/projects/${project.id}/document$`), (route) =>
    route.fulfill({
      json:
        route.request().method() === "GET"
          ? documentResponse
          : { ...documentResponse, revision: 4 },
    }),
  );
  await page.route(`**/v1/projects/${project.id}/uploads`, (route) =>
    route.fulfill({
      json: {
        uploadId: "upload-1",
        assetId: "asset-1",
        upload: {
          url: "http://127.0.0.1:4173/minio/upload-1",
          method: "PUT",
          headers: {},
          expiresAt: "later",
        },
      },
    }),
  );
  await page.route("**/minio/upload-1", (route) => route.fulfill({ status: 200 }));
  await page.route("**/v1/uploads/upload-1/complete", (route) =>
    route.fulfill({ json: { assetId: "asset-1", status: "pending-verification" } }),
  );
  await page.route("**/v1/assets/asset-1", (route) =>
    route.fulfill({
      json: {
        id: "asset-1",
        projectId: project.id,
        filename: "cells.png",
        mimeType: "image/png",
        checksumSha256: "a".repeat(64),
        widthPx: 2,
        heightPx: 2,
        bitDepth: 8,
        channelCount: 3,
        status: "ready",
        metadata: {},
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    }),
  );
}

async function expectNoViolations(page: Page) {
  // Let entrance animations settle so colors are measured at rest.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} → ${violation.nodes.map((node) => `${node.target.join(" ")} [${node.failureSummary}]`).join(", ")}`,
  );
  expect(summary).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    // Measure settled colors: entrance animations fade in, and reduced motion skips them.
    test.use({ colorScheme, contextOptions: { reducedMotion: "reduce" } });

    test("dashboard, labs, dialogs and editor meet WCAG 2.2 AA checks", async ({ page }) => {
      await mockLabs(page);
      await mockApi(page);
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Open Cell Atlas" })).toBeVisible();
      await expectNoViolations(page);

      await page.getByLabel("Workspace").selectOption("lab-1");
      await page.getByRole("button", { name: "Lab members" }).click();
      await expect(page.getByRole("table", { name: "Members" })).toBeVisible();
      await expectNoViolations(page);
      await page.getByLabel("Workspace").selectOption("workspace-1");

      await page.getByRole("button", { name: "Rename Cell Atlas" }).click();
      await expect(page.getByRole("dialog", { name: "Rename project" })).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Open Cell Atlas" }).click();
      await page.getByLabel("Upload original").setInputFiles({
        name: "cells.png",
        mimeType: "image/png",
        buffer: png,
      });
      await expect(page.getByRole("img", { name: "Original cells.png" })).toBeVisible();
      const box = await page.getByTestId("source-canvas").boundingBox();
      if (!box) throw new Error("source canvas has no box");
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.7);
      await page.mouse.up();
      await expect(page.getByRole("slider", { name: "Brightness" })).toBeVisible();
      await expectNoViolations(page);

      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      await expectNoViolations(page);
    });
  });
}

test("editor panes and shortcuts work from the keyboard", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Cell Atlas" }).click();
  await expect(page.getByRole("complementary", { name: "Source library" })).toBeVisible();

  await page.keyboard.press("[");
  await expect(page.getByRole("complementary", { name: "Source library" })).toHaveCount(0);
  await page.keyboard.press("[");
  await expect(page.getByLabel("Upload original")).toBeAttached();

  const zoom = page.getByRole("button", { name: /^Zoom \d+%/ });
  const fitted = await zoom.textContent();
  await page.keyboard.press("Control+1");
  await expect(zoom).toHaveText("100%");
  await page.keyboard.press("Control+=");
  await expect(zoom).toHaveText("125%");
  await page.keyboard.press("Control+0");
  await expect(zoom).toHaveText(fitted ?? "");

  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toBeFocused();
});
