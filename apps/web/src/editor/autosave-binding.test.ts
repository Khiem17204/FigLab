import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it, vi } from "vitest";
import { AutosaveController } from "./autosave";
import { bindAutosave } from "./autosave-binding";
import { createEditorSession } from "./session-store";

describe("editor autosave binding", () => {
  it("persists an undo that returns history to zero after the idle delay", async () => {
    vi.useFakeTimers();
    const session = createEditorSession(createDefaultFigureDocument("board"));
    const save = vi.fn().mockResolvedValue(2);
    const autosave = new AutosaveController(
      save,
      () => session.getState().document,
      () => 1,
    );
    const unbind = bindAutosave(session, autosave);
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.5 });
    session.getState().commitCrop("asset", "view");
    session.getState().undo();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].objects).toEqual([]);
    unbind();
    vi.useRealTimers();
  });
});
