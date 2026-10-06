import { defineConfig, devices } from "@playwright/test";

// Drives a real hosted FigLab (Supabase Auth/Storage/Postgres). Requires LIVE_BASE_URL and the
// variables listed in hosted.spec.ts; never mocks the network.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.LIVE_BASE_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
});
