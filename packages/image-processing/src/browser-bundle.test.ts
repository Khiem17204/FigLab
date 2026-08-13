import { describe, expect, it } from "vitest";
import { build } from "../../../apps/web/node_modules/vite/dist/node/index.js";

describe("browser bundle", () => {
  it("imports image processing and composes PNG bytes without Node util or Buffer", async () => {
    const entryId = "\0figlab-browser-smoke";
    const sourcePath = new URL("./index.ts", import.meta.url).pathname;
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "figlab-browser-smoke",
          resolveId(id) {
            return id === entryId ? entryId : undefined;
          },
          load(id) {
            if (id !== entryId) return undefined;
            return `
              import { composeArtboardPng } from ${JSON.stringify(sourcePath)};
              const document = {
                schemaVersion: 1,
                artboards: [{ id: "board", name: "Figure 1", widthPt: 1, heightPt: 1, backgroundHex: "#000000" }],
                objects: [{
                  id: "view", type: "image-view", artboardId: "board",
                  transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
                  zIndex: 0, locked: false, hidden: false,
                  view: {
                    sourceAssetId: "asset",
                    viewport: { x: 0, y: 0, width: 1, height: 1 },
                    display: { brightness: 0, contrast: 1, gamma: 1, invert: false }
                  }
                }],
                groups: [], constraints: [], styles: []
              };
              const resolver = {
                async describe() { return { widthPx: 1, heightPx: 1, bitDepth: 8, channels: 3 }; },
                async getRegion() {
                  return {
                    data: new Uint8Array([255, 0, 0]),
                    sourceRect: { x: 0, y: 0, width: 1, height: 1 },
                    widthPx: 1, heightPx: 1, bitDepth: 8, channels: 3, pyramidLevel: 0
                  };
                }
              };
              globalThis.__figlabBrowserSmoke = composeArtboardPng(document, "board", 1, 1, resolver)
                .then((bytes) => Array.from(bytes.slice(0, 8)));
            `;
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: entryId,
          output: { format: "iife", name: "FigLabBrowserSmoke" },
        },
      },
    });
    if (Array.isArray(result)) throw new Error("expected one Vite browser bundle");
    const code = result.output
      .filter(
        (item): item is typeof item & { type: "chunk"; code: string } => item.type === "chunk",
      )
      .map((chunk) => chunk.code)
      .join("\n");

    expect(code).not.toMatch(/\b(?:Buffer|node:util|util\.inherits)\b/);
    new Function(code)();
    const browserGlobal = globalThis as typeof globalThis & {
      __figlabBrowserSmoke?: Promise<number[]>;
    };
    await expect(browserGlobal.__figlabBrowserSmoke).resolves.toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    delete browserGlobal.__figlabBrowserSmoke;
  });
});
