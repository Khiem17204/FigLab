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
                schemaVersion: 3, sources: [],
                artboards: [{ id: "board", name: "Figure 1", widthPt: 1, heightPt: 1, backgroundHex: "#000000" }],
                objects: [{
                  id: "view", type: "image-view", artboardId: "board",
                  transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
                  zIndex: 0, locked: false, hidden: false,
                  view: {
                    sourceAssetId: "asset", plane: 0, channel: null, rotationDeg: 0, flipX: false, flipY: false, 
                    viewport: { x: 0, y: 0, width: 1, height: 1 },
                    display: { levels: { black: 0, white: 1 }, brightness: 0, contrast: 1, gamma: 1, invert: false, lut: "none" }
                  }
                }],
                groups: [], constraints: [], styles: []
              };
              const resolver = {
                async describe() { return { widthPx: 1, heightPx: 1, bitDepth: 8, channels: 4 }; },
                async getRegion() {
                  return {
                    data: new Uint8Array([255, 0, 0, 0]),
                    sourceRect: { x: 0, y: 0, width: 1, height: 1 },
                    widthPx: 1, heightPx: 1, bitDepth: 8, channels: 4, pyramidLevel: 0
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

describe("vector export bundle", () => {
  it("bundles fontkit and pdf-lib for browsers and writes a PDF without Node globals", async () => {
    const entryId = "\0figlab-vector-smoke";
    const sourcePath = new URL("./vector.ts", import.meta.url).pathname;
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "figlab-vector-smoke",
          resolveId: (id) => (id === entryId ? entryId : undefined),
          load(id) {
            if (id !== entryId) return undefined;
            return `
              import { composeDocumentPdf, createFontMetrics } from ${JSON.stringify(sourcePath)};
              const faces = Object.fromEntries(
                Object.entries(globalThis.__fontBytes).map(([key, bytes]) => [key, new Uint8Array(bytes)]),
              );
              const document = {
                schemaVersion: 3, sources: [],
                artboards: [{ id: "board", name: "Figure 1", widthPt: 100, heightPt: 50, backgroundHex: "#FFFFFF" }],
                objects: [{
                  id: "label", type: "text", artboardId: "board",
                  transform: { xPt: 5, yPt: 5, widthPt: 40, heightPt: 12, rotationDeg: 0 },
                  zIndex: 0, locked: false, hidden: false,
                  text: { content: "A", style: { fontSizePt: 10, bold: true, italic: false, underline: false, colorHex: "#000000", align: "start", backgroundHex: null } }
                }],
                groups: [], constraints: [], styles: []
              };
              globalThis.__vectorSmoke = composeDocumentPdf(document, ["board"], {
                dpi: 300, resolver: {}, metrics: createFontMetrics(faces), fonts: faces,
              }).then((bytes) => String.fromCharCode(...bytes.slice(0, 5)));
            `;
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: entryId, output: { format: "iife", name: "FigLabVectorSmoke" } },
      },
    });
    if (Array.isArray(result)) throw new Error("expected one Vite browser bundle");
    const code = result.output
      .filter(
        (item): item is typeof item & { type: "chunk"; code: string } => item.type === "chunk",
      )
      .map((chunk) => chunk.code)
      .join("\n");
    // fontkit inlines a Buffer polyfill and its dependencies mention `require` in comments, so
    // instead of scanning text, run the bundle in a realm without Node globals.

    const { readFile } = await import("node:fs/promises");
    const fontBytes: Record<string, number[]> = {};
    for (const [key, file] of Object.entries({
      regular: "Arimo-Regular.ttf",
      bold: "Arimo-Bold.ttf",
      italic: "Arimo-Italic.ttf",
      boldItalic: "Arimo-BoldItalic.ttf",
    }))
      fontBytes[key] = [...(await readFile(new URL(`../fonts/${file}`, import.meta.url)))];
    // A fresh realm with browser-like globals only: no Buffer, process, or require.
    const vm = await import("node:vm");
    const sandbox: Record<string, unknown> = {
      __fontBytes: fontBytes,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      console,
      atob,
      btoa,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(code, sandbox);
    expect(sandbox.Buffer).toBeUndefined();
    await expect(sandbox.__vectorSmoke as Promise<string>).resolves.toBe("%PDF-");
  }, 60_000);
});
