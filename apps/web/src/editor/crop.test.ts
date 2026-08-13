import { describe, expect, it } from "vitest";

import { cropFromPointer } from "./crop";

describe("source crop pointers", () => {
  it("turns source-local pointer movement into a normalized crop bounded by the image", () => {
    expect(
      cropFromPointer({ x: 80, y: 90 }, { x: 140, y: 150 }, { width: 100, height: 100 }),
    ).toEqual({
      x: 0.8,
      y: 0.9,
      width: 0.2,
      height: 0.1,
    });
  });
});
