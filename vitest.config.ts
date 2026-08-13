import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    include: ["{apps,packages}/**/*.test.ts", "{apps,packages}/**/*.test.tsx"],
    passWithNoTests: true,
  },
});
