import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FigLabApp, FigLabEditor } from "./app";

describe("FigLab application shell", () => {
  it("provides named navigation and an accessible direct-upload control", () => {
    const html = renderToStaticMarkup(<FigLabApp />);

    expect(html).toContain('aria-label="Project navigation"');
    expect(html).toContain('type="file"');
    expect(html).toContain("Upload original");
  });

  it("offers 1x, 2x, and custom-width CPU export choices in the editor", () => {
    const html = renderToStaticMarkup(<FigLabEditor onBack={() => undefined} />);

    expect(html).toContain("1×");
    expect(html).toContain("2×");
    expect(html).toContain("Custom width");
    expect(html).toContain("Export PNG");
  });
});
