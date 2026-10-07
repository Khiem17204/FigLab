import { describe, expect, it } from "vitest";

import { type UploadItem, updateUpload, uploadProgress, uploadStageLabel } from "./uploads";

describe("upload tracking", () => {
  const item: UploadItem = { key: "a", name: "cells.png", stage: "hashing", state: "active" };

  it("advances monotonically through the client stages", () => {
    const stages: UploadItem["stage"][] = [
      "hashing",
      "reserved",
      "uploaded",
      "verifying",
      "completed",
    ];
    const values = stages.map((stage) => uploadProgress({ ...item, stage }));
    expect(values).toEqual([...values].sort((left, right) => left - right));
    expect(values.at(-1)).toBe(1);
    expect(uploadStageLabel({ ...item, stage: "verifying" })).toMatch(/Verifying/);
  });

  it("patches only the matching upload", () => {
    const other = { ...item, key: "b" };
    const next = updateUpload([item, other], "b", { stage: "reserved" });
    expect(next[0]).toBe(item);
    expect(next[1]?.stage).toBe("reserved");
  });
});
