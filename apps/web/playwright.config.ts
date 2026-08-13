import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
