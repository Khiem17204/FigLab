import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { type Browser, expect, type Page, test } from "@playwright/test";

// Live end-to-end check of a hosted FigLab deployment. Required environment:
//   LIVE_BASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
//   ADMIN_EMAIL, ADMIN_PASSWORD
// Optional: SIGNUP_EMAIL — a real inbox you control; the test submits the sign-up form for it
// (Supabase sends a verification email) and expects the "check your email" message.
// The secret key is used only by this test process to create and remove throwaway users.

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live test`);
  return value;
};
const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
const secret = env("SUPABASE_SECRET_KEY");
const publishable = env("SUPABASE_PUBLISHABLE_KEY");
const admin = { email: env("ADMIN_EMAIL"), password: env("ADMIN_PASSWORD") };
const runId = Date.now().toString(36);
const member = { email: `figlab-live-member-${runId}@example.com`, password: randomUUID() };
const unverified = { email: `figlab-live-unverified-${runId}@example.com`, password: randomUUID() };
const projectName = `Live smoke ${runId}`;
const createdUserIds: string[] = [];
let projectId = "";

const sharp = createRequire(new URL("../../apps/jobs/package.json", import.meta.url))(
  "sharp",
) as typeof import("sharp").default;

async function authAdmin(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: secret,
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ id: string }>;
}
async function accessToken(email: string, password: string): Promise<string> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishable, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.access_token;
}
async function api(path: string, token?: string, init: RequestInit = {}) {
  return fetch(new URL(path, env("LIVE_BASE_URL")), {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
}
async function listStorage(prefix: string): Promise<unknown[]> {
  const response = await fetch(`${supabaseUrl}/storage/v1/object/list/figlab`, {
    method: "POST",
    headers: {
      apikey: secret,
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prefix, limit: 100 }),
  });
  return (await response.json()) as unknown[];
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function images() {
  const width = 160;
  const height = 120;
  const rgb = Buffer.alloc(width * height * 3);
  const grey16 = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      rgb[offset] = Math.round((x / width) * 255);
      rgb[offset + 1] = Math.round((y / height) * 255);
      rgb[offset + 2] = (x + y) % 2 ? 200 : 40;
      grey16[y * width + x] = Math.round((x / (width - 1)) * 65_535);
    }
  const raw = { raw: { width, height, channels: 3 as const } };
  return {
    png: await sharp(rgb, raw).png().toBuffer(),
    jpeg: await sharp(rgb, raw).jpeg({ quality: 90 }).toBuffer(),
    tiff: await sharp(Buffer.from(grey16.buffer), {
      raw: { width, height, channels: 1, depth: "ushort" },
    })
      .toColourspace("grey16")
      .tiff({ compression: "lzw" })
      .toBuffer(),
  };
}

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByLabel("Upload original").setInputFiles({ name, mimeType, buffer });
}
const uploadStatus = (page: Page) => page.getByLabel("Source library").getByRole("status");

async function dragCrop(page: Page, aspect: number) {
  const canvas = page.getByTestId("source-canvas");
  await expect(canvas.locator("img")).toBeVisible();
  const box = await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: (element as HTMLElement).clientWidth,
      height: (element as HTMLElement).clientHeight,
    };
  });
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;
  await page.mouse.move(left + width * 0.2, top + height * 0.2);
  await page.mouse.down();
  await page.mouse.move(left + width * 0.6, top + height * 0.7, { steps: 5 });
  await page.mouse.up();
}

/** A point at fractions of the figure canvas, scrolled to the middle of the viewport. */
async function canvasPoint(page: Page, fx: number, fy: number) {
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

async function openProject(page: Page) {
  await page.getByRole("button", { name: `Open ${projectName}` }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
}

test.describe
  .serial("hosted FigLab", () => {
    test.beforeAll(async () => {
      createdUserIds.push(
        (
          await authAdmin("/users", {
            method: "POST",
            body: JSON.stringify({ ...member, email_confirm: true }),
          })
        ).id,
        (await authAdmin("/users", { method: "POST", body: JSON.stringify(unverified) })).id,
      );
    });
    test.afterAll(async () => {
      for (const id of createdUserIds) await authAdmin(`/users/${id}`, { method: "DELETE" });
    });

    test("API and app require a session", async ({ page }) => {
      expect((await api("/health")).status).toBe(200);
      const anonymous = await api("/v1/projects");
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "UNAUTHORIZED" });
      expect((await api("/v1/projects", "forged.token.value")).status).toBe(401);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    });

    test("unverified accounts are refused with a resend option", async ({ page }) => {
      await signIn(page, unverified.email, unverified.password);
      await expect(page.getByRole("alert")).toContainText("Verify your email");
      await expect(page.getByRole("button", { name: "Resend verification email" })).toBeVisible();
    });

    test("sign-up asks the user to verify their email", async ({ page }) => {
      const email = process.env.SIGNUP_EMAIL;
      test.skip(!email, "SIGNUP_EMAIL not set");
      await page.goto("/");
      await page.getByRole("button", { name: "Create one" }).click();
      await page.getByLabel("Email").fill(email ?? "");
      await page.getByLabel("Password").fill(randomUUID());
      await page.getByRole("button", { name: "Sign up" }).click();
      await expect(page.getByRole("status").filter({ hasText: "verification link" })).toBeVisible();
    });

    test("admin signs in, uploads originals, crops, adjusts, saves and exports", async ({
      page,
    }) => {
      const files = await images();
      await signIn(page, admin.email, admin.password);
      await expect(page.getByText(admin.email)).toBeVisible();
      await expect(page.getByText("Admin", { exact: true })).toBeVisible();

      await page.getByLabel("New project name").fill(projectName);
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith("/v1/projects") && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create project" }).click();
      projectId = ((await (await created).json()) as { id: string }).id;
      await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

      for (const [name, type, buffer] of [
        ["gradient.png", "image/png", files.png],
        ["gradient.jpg", "image/jpeg", files.jpeg],
        ["gradient-16bit.tif", "image/tiff", files.tiff],
      ] as const) {
        await upload(page, name, type, buffer);
        await expect(uploadStatus(page)).toHaveText("Upload completed and verified.", {
          timeout: 120_000,
        });
        await expect(page.getByRole("button", { name: `Original · ${name}` })).toBeVisible();
      }
      await upload(page, "corrupt.png", "image/png", Buffer.from("definitely not a png image"));
      await expect(uploadStatus(page)).toContainText("Upload rejected", { timeout: 120_000 });

      await page.getByRole("button", { name: "Original · gradient-16bit.tif" }).click();
      await dragCrop(page, 160 / 120);
      await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(1);
      await page.getByRole("button", { name: "Original · gradient.png" }).click();
      await dragCrop(page, 160 / 120);
      await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(2);

      await page.getByRole("slider", { name: "Brightness" }).fill("0.3");
      await page.getByRole("checkbox", { name: "Invert" }).check();
      await expect(page.getByRole("checkbox", { name: "Invert" })).toBeChecked();
      await page.getByRole("button", { name: "Show in Original" }).click();
      await expect(page.getByText(/Source crop x 0\.\d+/)).toBeVisible();
      await expect(page.locator(".editor-header").getByRole("status")).toHaveText("Saved", {
        timeout: 15_000,
      });

      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export PNG" }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^live-smoke-[a-z0-9]+-figure-1-300dpi\.png$/);
      const path = await file.path();
      const exported = await sharp(await readFile(path ?? "")).metadata();
      expect(exported.format).toBe("png");
      expect([exported.width, exported.height, exported.density]).toEqual([2550, 3300, 300]);
      await expect(
        page.getByText(/downloaded and provenance recorded for 1 figure\./),
      ).toBeVisible();

      // A fresh load restores the saved document and re-downloads originals from storage.
      await page.reload();
      await openProject(page);
      await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Original · gradient-16bit.tif" })).toBeVisible(
        {
          timeout: 30_000,
        },
      );
      await page
        .getByRole("button", { name: /Move view-/ })
        .last()
        .click();
      await expect(page.getByRole("checkbox", { name: "Invert" })).toBeChecked();
    });

    test("admin annotates, labels panels, adds a journal-sized figure, and exports TIFF and PDF", async ({
      page,
    }) => {
      await signIn(page, admin.email, admin.password);
      await openProject(page);
      await expect(page.getByRole("button", { name: /Move view-/ })).toHaveCount(2);

      await page.getByRole("button", { name: "Text", exact: true }).click();
      const at = await canvasPoint(page, 0.5, 0.08);
      await page.mouse.click(at.x, at.y);
      const content = page.getByLabel("Text content");
      await content.fill("IL-6 10 \\muM");
      await content.blur();
      await expect(content).toHaveValue("IL-6 10 μM");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Label panels" }).click();
      await expect(page.getByRole("button", { name: /Move label-/ })).toHaveCount(2);

      await page.getByRole("button", { name: "Add figure" }).click();
      await page.getByLabel("Figure size").selectOption("nature-double");
      await expect(page.getByLabel("Width (mm)")).toHaveValue("183");
      await page.getByRole("button", { name: "Figure 1", exact: true }).click();
      await expect(page.locator(".editor-header").getByRole("status")).toHaveText("Saved", {
        timeout: 15_000,
      });

      await page.getByLabel("Format").selectOption("tiff");
      const tiffDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export TIFF" }).click();
      const tiff = await sharp(
        await readFile((await (await tiffDownload).path()) ?? ""),
      ).metadata();
      expect([tiff.format, tiff.width, tiff.height, tiff.density]).toEqual([
        "tiff",
        2550,
        3300,
        300,
      ]);

      await page.getByLabel("Format").selectOption("pdf");
      await page.getByLabel(/All figures/).check();
      const pdfDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export PDF" }).click();
      const pdf = (await readFile((await (await pdfDownload).path()) ?? "")).toString("latin1");
      expect(pdf.startsWith("%PDF-")).toBe(true);
      expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(2);
      expect(pdf).toContain("/FontFile2");

      const trail = page.getByRole("list", { name: "Audit trail" });
      await expect(trail).toContainText("Exported: PDF at 300 dpi", { timeout: 15_000 });
      await expect(trail).toContainText(admin.email);

      const token = await accessToken(admin.email, admin.password);
      const events = (await (
        await api(`/v1/projects/${projectId}/audit-events?limit=200`, token)
      ).json()) as {
        events: { action: string; actor?: { email: string } }[];
      };
      const created = events.events.filter((event) => event.action === "OBJECT_CREATED");
      expect(created.length).toBeGreaterThanOrEqual(3);
      expect(created.every((event) => event.actor?.email === admin.email)).toBe(true);
      const exports = (await (await api(`/v1/projects/${projectId}/exports`, token)).json()) as {
        exports: { format: string; dpi?: number }[];
      };
      expect(exports.exports.filter((record) => record.format === "pdf")).toHaveLength(2);
      expect(exports.exports.some((record) => record.format === "tiff" && record.dpi === 300)).toBe(
        true,
      );
      const versions = (await (await api(`/v1/projects/${projectId}/versions`, token)).json()) as {
        versions: { revision: number }[];
      };
      const first = versions.versions.at(-1)?.revision ?? 1;
      const old = (await (
        await api(`/v1/projects/${projectId}/versions/${first}`, token)
      ).json()) as {
        document: { schemaVersion: number };
      };
      // Stored revisions are served migrated to the current schema.
      expect(old.document.schemaVersion).toBe(3);
    });

    test("admin band-crops a blot, calibrates, annotates, and gets integrity evidence", async ({
      page,
    }) => {
      await signIn(page, admin.email, admin.password);
      await openProject(page);
      await page.getByRole("button", { name: "Original · gradient.png" }).click();
      await page.getByRole("button", { name: "Band (line) crop" }).click();
      await page.getByLabel("Band height (px)").fill("20");
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
      const scale = Math.min(box.width / 160, box.height / 120);
      const at = (x: number, y: number) => ({
        x: box.left + (box.width - 160 * scale) / 2 + x * scale,
        y: box.top + (box.height - 120 * scale) / 2 + y * scale,
      });
      const from = at(30, 50);
      const to = at(130, 65);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
      await expect(
        page.getByRole("status").filter({ hasText: /Band crop rotated 8\.5/ }),
      ).toBeVisible();

      await page.getByLabel("Pixel size (µm/px)").fill("0.25");
      await page.getByRole("button", { name: "Set pixel size" }).click();
      await page
        .getByRole("button", { name: /Move view-/ })
        .last()
        .click();
      await page.getByRole("button", { name: "Add scale bar" }).click();
      await page
        .getByRole("button", { name: /Move view-/ })
        .last()
        .click();
      await page.getByRole("button", { name: "Add lane labels" }).click();
      await expect(page.locator(".editor-header").getByRole("status")).toHaveText("Saved", {
        timeout: 15_000,
      });

      await page.getByRole("button", { name: "Request server report" }).click();
      await expect(page.getByRole("list", { name: "Server reports" })).toBeVisible();
      await expect
        .poll(
          async () => {
            await page.getByRole("button", { name: "Refresh server reports" }).click();
            return page.getByRole("list", { name: "Server reports" }).innerText();
          },
          { timeout: 420_000, intervals: [5_000] },
        )
        .toMatch(/ready/);
      await page
        .getByRole("button", { name: /Open report for revision/ })
        .first()
        .click();
      const findings = page.getByRole("list", { name: "Integrity findings" });
      await expect(findings).toContainText("rotated 8.5° with bilinear resampling");
      await expect(findings).toContainText("manually entered pixel size");

      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download provenance bundle" }).click();
      const bundle = await readFile((await (await download).path()) ?? "");
      for (const name of [
        "README.txt",
        "figure.json",
        "figures.pdf",
        "integrity-report.json",
        "integrity-report.html",
        "crops.csv",
        "uncropped-originals.pdf",
      ])
        expect(bundle.includes(Buffer.from(name))).toBe(true);

      const token = await accessToken(admin.email, admin.password);
      const stored = (await (await api(`/v1/projects/${projectId}/document`, token)).json()) as {
        document: {
          sources: { calibration: { origin: string } | null }[];
          objects: { type: string }[];
        };
      };
      expect(
        stored.document.sources.some((source) => source.calibration?.origin === "manual"),
      ).toBe(true);
      expect(stored.document.objects.map((object) => object.type)).toEqual(
        expect.arrayContaining(["scale-bar", "lane-table"]),
      );
    });

    test("a stale tab gets a revision conflict and keeps local work", async ({ browser }) => {
      const context = await (browser as Browser).newContext();
      const first = await context.newPage();
      await signIn(first, admin.email, admin.password);
      await openProject(first);
      const second = await context.newPage();
      await second.goto("/");
      await openProject(second);

      await first
        .getByRole("button", { name: /Move view-/ })
        .last()
        .click();
      await first.getByRole("slider", { name: "Contrast" }).fill("1.5");
      await expect(first.locator(".editor-header").getByRole("status")).toHaveText("Saved", {
        timeout: 15_000,
      });
      await second
        .getByRole("button", { name: /Move view-/ })
        .last()
        .click();
      await second.getByRole("slider", { name: "Gamma" }).fill("2");
      await expect(second.getByRole("alert")).toContainText("Your local work is retained", {
        timeout: 15_000,
      });
      await second.getByRole("button", { name: "Reload latest" }).click();
      await expect(second.locator(".editor-header").getByRole("status")).toHaveText("Saved");
      await context.close();
    });

    test("other users cannot see or open the project", async () => {
      const token = await accessToken(member.email, member.password);
      expect(await (await api("/v1/me", token)).json()).toMatchObject({
        email: member.email,
        role: "member",
      });
      expect(await (await api("/v1/projects", token)).json()).toEqual({ projects: [] });
      expect((await api(`/v1/projects/${projectId}`, token)).status).toBe(404);
      expect((await api(`/v1/projects/${projectId}/document`, token)).status).toBe(404);
      const adminToken = await accessToken(admin.email, admin.password);
      expect(await (await api("/v1/me", adminToken)).json()).toMatchObject({
        email: admin.email,
        role: "admin",
      });
    });

    test("a lab shares a project by invite link with a view-only member who comments", async ({
      page,
      browser,
    }) => {
      const labName = `Live lab ${runId}`;
      const labProject = `Lab project ${runId}`;
      await signIn(page, admin.email, admin.password);
      await page.getByLabel("New lab name").fill(labName);
      await page.getByRole("button", { name: "Create lab" }).click();
      await expect(page.getByText(`Lab · ${labName}`)).toBeVisible();
      await page.getByLabel("New project name").fill(labProject);
      await page.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByRole("heading", { name: labProject })).toBeVisible();
      await page.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Lab members" }).click();
      await page.getByLabel("Invite role").selectOption("viewer");
      await page.getByLabel("Only for email (optional)").fill(member.email);
      await page.getByRole("button", { name: "Create invite link" }).click();
      const link = await page.getByLabel("Invite link").inputValue();
      expect(link).toMatch(/\?invite=[A-Za-z0-9_-]{43}$/);

      // The member opens the link signed out, signs in, and joins.
      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.goto(link);
      await memberPage.getByLabel("Email").fill(member.email);
      await memberPage.getByLabel("Password").fill(member.password);
      await memberPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(memberPage.getByRole("region", { name: "Lab invite" })).toContainText(
        `join ${labName} as viewer`,
      );
      await memberPage.getByRole("button", { name: `Join ${labName}` }).click();
      await expect(memberPage.getByText(`Lab · ${labName}`)).toBeVisible();
      await memberPage.getByRole("button", { name: `Open ${labProject}` }).click();
      await expect(memberPage.getByRole("note")).toContainText("View only");
      await memberPage.getByLabel("Comment", { exact: true }).fill(`Live comment ${runId}`);
      await memberPage.getByRole("button", { name: "Add comment" }).click();
      await expect(memberPage.getByRole("list", { name: "Comment threads" })).toContainText(
        `Live comment ${runId}`,
      );
      await memberContext.close();

      const memberToken = await accessToken(member.email, member.password);
      const adminToken = await accessToken(admin.email, admin.password);
      const workspaces = (await (await api("/v1/workspaces", adminToken)).json()) as {
        workspaces: { id: string; name: string }[];
      };
      const lab = workspaces.workspaces.find((workspace) => workspace.name === labName);
      if (!lab) throw new Error("lab missing");
      const projects = (await (
        await api(`/v1/workspaces/${lab.id}/projects`, adminToken)
      ).json()) as { projects: { id: string }[] };
      const sharedId = projects.projects[0]?.id ?? "";
      const document = await (await api(`/v1/projects/${sharedId}/document`, memberToken)).json();
      const save = await api(`/v1/projects/${sharedId}/document`, memberToken, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: document.revision, document: document.document }),
      });
      expect(save.status).toBe(403);
      const comments = (await (
        await api(`/v1/projects/${sharedId}/comments`, adminToken)
      ).json()) as { comments: { body: string; author: { email: string } }[] };
      expect(comments.comments).toEqual([
        expect.objectContaining({
          body: `Live comment ${runId}`,
          author: expect.objectContaining({ email: member.email }),
        }),
      ]);
      expect((await api("/v1/admin/overview", adminToken)).status).toBe(200);
      expect((await api("/v1/admin/overview", memberToken)).status).toBe(403);

      // Clean up: delete the project, then the lab once the deletion job has run.
      expect((await api(`/v1/projects/${sharedId}`, adminToken, { method: "DELETE" })).status).toBe(
        202,
      );
      await expect
        .poll(
          async () =>
            (await api(`/v1/workspaces/${lab.id}`, adminToken, { method: "DELETE" })).status,
          { timeout: 420_000, intervals: [5_000] },
        )
        .toBe(204);
      expect(
        ((await (await api("/v1/workspaces", memberToken)).json()) as { workspaces: unknown[] })
          .workspaces,
      ).toHaveLength(1);
    });

    test("rename and delete remove the project and its originals", async ({ page }) => {
      await signIn(page, admin.email, admin.password);
      const renamed = `${projectName} renamed`;
      page.once("dialog", (dialog) => void dialog.accept(renamed));
      await page.getByRole("button", { name: `Rename ${projectName}` }).click();
      await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

      const adminToken = await accessToken(admin.email, admin.password);
      const project = (await (await api(`/v1/projects/${projectId}`, adminToken)).json()) as {
        workspaceId: string;
      };
      const prefix = `workspaces/${project.workspaceId}/projects/${projectId}/assets`;
      expect((await listStorage(prefix)).length).toBeGreaterThanOrEqual(3);

      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: `Delete ${renamed}` }).click();
      await expect(page.getByRole("heading", { name: renamed })).toHaveCount(0);
      await expect
        .poll(async () => (await listStorage(prefix)).length, {
          timeout: 420_000,
          intervals: [5_000],
        })
        .toBe(0);
      await expect
        .poll(async () => (await api(`/v1/projects/${projectId}`, adminToken)).status, {
          timeout: 60_000,
        })
        .toBe(404);
      // The project is a tombstone now: its history is no longer reachable through the API.
      expect((await api(`/v1/projects/${projectId}/audit-events`, adminToken)).status).toBe(404);
    });
  });
