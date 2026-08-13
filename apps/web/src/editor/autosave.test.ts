import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it, vi } from "vitest";

import { AutosaveController } from "./autosave";

describe("autosave conflict recovery", () => {
  it("returns the exact document and revision accepted by the server", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    const autosave = new AutosaveController(
      async () => 4,
      () => document,
      () => 3,
    );

    const saved = await autosave.saveNow();

    expect(saved).toEqual({ document, revision: 4 });
    expect(saved?.document).not.toBe(document);
  });

  it("coalesces an explicit flush with an in-flight save", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    let finishSave: ((revision: number) => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishSave = resolve;
        }),
    );
    const autosave = new AutosaveController(
      save,
      () => document,
      () => 3,
    );
    const pending = autosave.saveNow();

    const flush = autosave.flushBeforeNavigation();
    finishSave?.(4);

    await expect(pending).resolves.toEqual({ document, revision: 4 });
    await expect(flush).resolves.toEqual({ document, revision: 4 });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("resaves edits made while a save is in flight", async () => {
    let document = createDefaultFigureDocument("artboard-1");
    let revision = 3;
    let finishFirst: ((revision: number) => void) | undefined;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finishFirst = (nextRevision) => {
              revision = nextRevision;
              resolve(nextRevision);
            };
          }),
      )
      .mockImplementationOnce(async () => {
        revision = 5;
        return revision;
      });
    const autosave = new AutosaveController(
      save,
      () => document,
      () => revision,
    );
    const first = autosave.saveNow();
    const artboard = document.artboards[0];
    if (!artboard) throw new Error("default document has no artboard");
    document = { ...document, artboards: [{ ...artboard, name: "New name" }] };
    autosave.schedule();
    const flush = autosave.flushBeforeNavigation();
    finishFirst?.(4);

    await first;
    await expect(flush).resolves.toMatchObject({ revision: 5, document });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toBe(4);
    expect(save.mock.calls[1]?.[1]).toEqual(document);
  });

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

  it("returns no saved snapshot after a non-conflict save failure", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    const autosave = new AutosaveController(
      async () => {
        throw new Error("offline");
      },
      () => document,
      () => 3,
    );

    await expect(autosave.flushBeforeNavigation()).resolves.toBeUndefined();
    expect(autosave.getStatus()).toBe("error");
  });

  it("downloads the latest local edits made after a conflict", async () => {
    let document = createDefaultFigureDocument("artboard-1");
    const autosave = new AutosaveController(
      async () => {
        throw { status: 409 };
      },
      () => document,
      () => 3,
    );
    await autosave.saveNow();
    const artboard = document.artboards[0];
    if (!artboard) throw new Error("default document has no artboard");
    document = {
      ...document,
      artboards: [{ ...artboard, name: "Edited after conflict" }],
    };

    const downloaded = JSON.parse(await autosave.downloadMyJson().text()) as typeof document;

    expect(downloaded.artboards[0]?.name).toBe("Edited after conflict");
  });

  it("resumes after reloading the latest server document", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    const save = vi.fn().mockRejectedValueOnce({ status: 409 }).mockResolvedValue(4);
    const autosave = new AutosaveController(
      save,
      () => document,
      () => 3,
    );
    await autosave.saveNow();

    autosave.resetAfterReload();
    await autosave.saveNow();

    expect(autosave.getStatus()).toBe("saved");
    expect(save).toHaveBeenCalledTimes(2);
  });
});
