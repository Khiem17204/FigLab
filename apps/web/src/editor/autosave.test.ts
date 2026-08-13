import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it, vi } from "vitest";

import { AutosaveController } from "./autosave";

describe("autosave conflict recovery", () => {
  it("retains local state and stops saving after a revision conflict", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    const save = vi.fn().mockRejectedValue({ status: 409 });
    const autosave = new AutosaveController(
      save,
      () => document,
      () => 3,
    );

    await autosave.saveNow();

    expect(autosave.getStatus()).toBe("conflict");
    expect(autosave.getLocalDocument()).toEqual(document);
    await autosave.saveNow();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
