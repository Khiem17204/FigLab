import { createHash } from "node:crypto";
import {
  type FigureDocumentV1,
  migrateFigureDocument,
} from "../packages/figure-schema/src/index.ts";
import {
  composeArtboardPng,
  type RasterSourceResolver,
  type SourcePixelRect,
} from "../packages/image-processing/src/index.ts";

const sourcePixels = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0,
  255, 0, 255, 255, 255, 255, 0, 255, 255,
]);

const resolver: RasterSourceResolver = {
  async describe() {
    return { widthPx: 4, heightPx: 2, bitDepth: 8, channels: 4 };
  },
  async getRegion(_assetId: string, rect: SourcePixelRect) {
    const data = new Uint8Array(rect.width * rect.height * 4);
    for (let row = 0; row < rect.height; row += 1) {
      const start = ((rect.y + row) * 4 + rect.x) * 4;
      data.set(sourcePixels.subarray(start, start + rect.width * 4), row * rect.width * 4);
    }
    return {
      data,
      sourceRect: rect,
      widthPx: rect.width,
      heightPx: rect.height,
      bitDepth: 8 as const,
      channels: 4 as const,
      pyramidLevel: 0,
    };
  },
};

const input = JSON.parse(await readStandardInput()) as
  | { mode: "source" }
  | { mode: "export"; document: FigureDocumentV1; widthPx: number; heightPx: number };
const bytes =
  input.mode === "source"
    ? await sourcePng()
    : await composeArtboardPng(
        // The stack stores v1 documents here; export takes the current schema, as the app does.
        migrateFigureDocument(input.document),
        input.document.artboards[0]?.id ?? "missing-artboard",
        input.widthPx,
        input.heightPx,
        resolver,
      );
process.stdout.write(
  JSON.stringify({
    base64: Buffer.from(bytes).toString("base64"),
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  }),
);

async function sourcePng(): Promise<Uint8Array> {
  const document: FigureDocumentV1 = {
    schemaVersion: 1,
    artboards: [
      { id: "source-board", name: "Source", widthPt: 4, heightPt: 2, backgroundHex: "#FFFFFF" },
    ],
    objects: [
      {
        id: "source-view",
        type: "image-view",
        artboardId: "source-board",
        transform: { xPt: 0, yPt: 0, widthPt: 4, heightPt: 2, rotationDeg: 0 },
        zIndex: 0,
        locked: false,
        hidden: false,
        view: {
          sourceAssetId: "source-asset",
          viewport: { x: 0, y: 0, width: 1, height: 1 },
          display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
        },
      },
    ],
    groups: [],
    constraints: [],
    styles: [],
  };
  return composeArtboardPng(migrateFigureDocument(document), "source-board", 4, 2, resolver);
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
