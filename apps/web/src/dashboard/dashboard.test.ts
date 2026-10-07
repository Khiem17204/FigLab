import { describe, expect, it } from "vitest";

import { PROJECT_NAME_MAX, projectNameError } from "./dashboard";

describe("projectNameError", () => {
  it("rejects blank names with an actionable message", () => {
    expect(projectNameError("   ")).toBe("Give your project a name to create it.");
    expect(projectNameError("", "save")).toBe("Give your project a name to save it.");
  });

  it("enforces the API length limit after trimming", () => {
    expect(projectNameError(` ${"a".repeat(PROJECT_NAME_MAX)} `)).toBeUndefined();
    expect(projectNameError("a".repeat(PROJECT_NAME_MAX + 1))).toMatch(/120 characters or fewer/);
  });
});
