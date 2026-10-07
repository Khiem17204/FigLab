import { describe, expect, it } from "vitest";
import {
  createTiffWorkerHandler,
  parseOmeXml,
  tiffCalibration,
  tiffPlaneLabels,
  validateTiffMetadata,
  verifyTiff,
} from "./index.js";

type Page = { width: number; height: number; samples: number[]; subfile?: number };

/** Writes an uncompressed 8-bit grayscale TIFF with one IFD per page. */
function multiPageTiff(
  pages: Page[],
  options: { description?: string; xResolution?: [number, number]; resolutionUnit?: number } = {},
): ArrayBuffer {
  type Entry = [tag: number, type: 2 | 3 | 4 | 5, values: number[] | string];
  const encoder = new TextEncoder();
  const blocks: { offset: number; bytes: Uint8Array }[] = [];
  let cursor = 8;
  const reserve = (bytes: Uint8Array) => {
    const offset = cursor;
    blocks.push({ offset, bytes });
    cursor += bytes.length + (bytes.length % 2);
    return offset;
  };
  const pixelOffsets = pages.map((page) => reserve(new Uint8Array(page.samples)));
  const ifdOffsets: number[] = [];
  const ifds: Entry[][] = pages.map((page, index) => {
    const entries: Entry[] = [
      [254, 4, [page.subfile ?? 0]],
      [256, 4, [page.width]],
      [257, 4, [page.height]],
      [258, 3, [8]],
      [259, 3, [1]],
      [262, 3, [1]],
      [273, 4, [pixelOffsets[index] ?? 0]],
      [277, 3, [1]],
      [278, 4, [page.height]],
      [279, 4, [page.width * page.height]],
    ];
    if (index === 0 && options.description) entries.push([270, 2, `${options.description}\0`]);
    if (index === 0 && options.xResolution) {
      entries.push([282, 5, options.xResolution], [283, 5, options.xResolution]);
      entries.push([296, 3, [options.resolutionUnit ?? 1]]);
    }
    return entries.sort((left, right) => left[0] - right[0]);
  });
  // Lay out external values, then IFDs.
  const external = ifds.map((entries) =>
    entries.map(([, type, values]) => {
      const size =
        typeof values === "string"
          ? values.length
          : values.length * (type === 3 ? 2 : type === 5 ? 4 : 4);
      if (size <= 4) return undefined;
      const bytes = new Uint8Array(size);
      const view = new DataView(bytes.buffer);
      if (typeof values === "string") bytes.set(encoder.encode(values));
      else for (const [index, value] of values.entries()) view.setUint32(index * 4, value, true);
      return reserve(bytes);
    }),
  );
  for (const entries of ifds) {
    ifdOffsets.push(cursor);
    cursor += 2 + entries.length * 12 + 4;
  }
  const output = new Uint8Array(cursor);
  const view = new DataView(output.buffer);
  output.set([0x49, 0x49], 0);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffsets[0] ?? 0, true);
  for (const block of blocks) output.set(block.bytes, block.offset);
  ifds.forEach((entries, page) => {
    const at = ifdOffsets[page] ?? 0;
    view.setUint16(at, entries.length, true);
    entries.forEach(([tag, type, values], index) => {
      const entry = at + 2 + index * 12;
      view.setUint16(entry, tag, true);
      view.setUint16(entry + 2, type, true);
      const count =
        typeof values === "string" ? values.length : type === 5 ? values.length / 2 : values.length;
      view.setUint32(entry + 4, count, true);
      const offset = external[page]?.[index];
      if (offset !== undefined) view.setUint32(entry + 8, offset, true);
      else if (typeof values === "string") output.set(encoder.encode(values), entry + 8);
      else if (type === 3)
        for (const [i, value] of values.entries()) view.setUint16(entry + 8 + i * 2, value, true);
      else view.setUint32(entry + 8, values[0] ?? 0, true);
    });
    view.setUint32(at + 2 + entries.length * 12, ifdOffsets[page + 1] ?? 0, true);
  });
  return output.buffer;
}

const page = (fill: number, extra: Partial<Page> = {}): Page => ({
  width: 2,
  height: 2,
  samples: [fill, fill + 1, fill + 2, fill + 3],
  ...extra,
});

describe("multi-page TIFF ingestion", () => {
  it("opens every full-resolution page, labels ImageJ channels, and reads ImageJ calibration", async () => {
    const bytes = multiPageTiff(
      [page(10), page(20), page(30), page(0, { width: 1, height: 1, samples: [9], subfile: 1 })],
      {
        description: "ImageJ=1.54f\nimages=3\nchannels=3\nunit=micron\n",
        xResolution: [4, 1],
      },
    );
    const description = await verifyTiff(bytes);
    expect(description).toMatchObject({
      widthPx: 2,
      heightPx: 2,
      planes: 3,
      planeLabels: ["C1", "C2", "C3"],
      calibration: { umPerPxX: 0.25, umPerPxY: 0.25, source: "imagej" },
      ome: false,
    });
    const handler = createTiffWorkerHandler();
    await handler.handle({ requestId: 1, kind: "open", assetId: "stack", bytes });
    const read = await handler.handle({
      requestId: 2,
      kind: "read",
      assetId: "stack",
      sourceRect: { x: 1, y: 0, width: 1, height: 2 },
      pyramidLevel: 0,
      plane: 2,
    });
    expect(read.response.kind === "region" && [...read.response.region.data]).toEqual([31, 33]);
  });

  it("rejects pages that disagree in geometry", async () => {
    const bytes = multiPageTiff([page(1), page(2, { width: 1, height: 4, samples: [1, 2, 3, 4] })]);
    await expect(verifyTiff(bytes)).rejects.toThrow(/pages differ/);
  });

  it("parses OME dimensions, channel names, and physical pixel size", () => {
    const ome =
      '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image><Pixels DimensionOrder="XYZCT" SizeC="2" SizeZ="2" SizeT="1" PhysicalSizeX="65" PhysicalSizeXUnit="nm" PhysicalSizeY="65" PhysicalSizeYUnit="nm"><Channel Name="DAPI"/><Channel Name="GFP"/></Pixels></Image></OME>';
    expect(parseOmeXml(ome)).toMatchObject({ sizeC: 2, sizeZ: 2, channelNames: ["DAPI", "GFP"] });
    expect(tiffPlaneLabels(4, ome)).toEqual([
      "C1 DAPI · Z1",
      "C1 DAPI · Z2",
      "C2 GFP · Z1",
      "C2 GFP · Z2",
    ]);
    expect(tiffCalibration({ imageDescription: ome })).toEqual({
      umPerPxX: 0.065,
      umPerPxY: 0.065,
      source: "ome",
    });
  });

  it("uses centimetre resolution units but ignores print DPI", () => {
    expect(tiffCalibration({ xResolution: [20_000, 1], resolutionUnit: 3 })).toEqual({
      umPerPxX: 0.5,
      umPerPxY: 0.5,
      source: "tiff-resolution",
    });
    expect(tiffCalibration({ xResolution: [300, 1], resolutionUnit: 2 })).toBeUndefined();
    expect(tiffPlaneLabels(2)).toEqual(["Page 1", "Page 2"]);
  });

  it("still rejects lossy or unusual sample layouts", () => {
    const base = {
      width: 4,
      height: 4,
      sampleFormats: [1],
      photometricInterpretation: 1,
      bitsPerSample: [8],
      samplesPerPixel: 1,
      compression: 1,
    };
    expect(
      validateTiffMetadata({ ...base, compression: 32946, isTiled: true, imageCount: 5 }),
    ).toMatchObject({ channels: 1 });
    expect(() => validateTiffMetadata({ ...base, compression: 7 })).toThrow(/lossless/);
  });
});
