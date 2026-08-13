import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it, vi } from "vitest";

import { exportPng } from "./export";

describe("PNG export", () => {
  it("records metadata for the CPU-rendered original-source PNG", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const sourceExporter = vi
      .fn()
      .mockResolvedValue(new Blob(["png-bytes"], { type: "image/png" }));
    const download = vi.fn();

    await exportPng({
      document: createDefaultFigureDocument("artboard-1"),
      revision: 4,
      widthPx: 1200,
      heightPx: 800,
      sourceExporter,
      record,
      download,
    });

    expect(sourceExporter).toHaveBeenCalledWith(expect.anything(), {
      widthPx: 1200,
      heightPx: 800,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ format: "png", revision: 4, widthPx: 1200, heightPx: 800 }),
    );
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "figlab-1200x800.png");
  });
});
