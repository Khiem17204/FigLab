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
      expect(file.suggestedFilename()).toMatch(/^figlab-\d+x\d+\.png$/);
      const path = await file.path();
      const exported = await sharp(await readFile(path ?? "")).metadata();
      expect(exported.format).toBe("png");
      await expect(page.getByText("PNG downloaded and provenance recorded.")).toBeVisible();

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
      expect(await (await api("/v1/me", token)).json()).toEqual({
        email: member.email,
        role: "member",
      });
      expect(await (await api("/v1/projects", token)).json()).toEqual({ projects: [] });
      expect((await api(`/v1/projects/${projectId}`, token)).status).toBe(404);
      expect((await api(`/v1/projects/${projectId}/document`, token)).status).toBe(404);
      const adminToken = await accessToken(admin.email, admin.password);
      expect(await (await api("/v1/me", adminToken)).json()).toEqual({
        email: admin.email,
        role: "admin",
      });
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
    });
  });
