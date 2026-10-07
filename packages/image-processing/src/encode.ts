const METERS_PER_INCH = 0.0254;

/**
 * Encodes non-premultiplied RGBA as an 8-bit RGBA PNG. With `dpi`, writes a `pHYs` chunk so
 * the file states its print resolution.
 */
export async function encodePngRgba(
  data: Uint8Array,
  widthPx: number,
  heightPx: number,
  dpi?: number,
): Promise<Uint8Array> {
  const rowByteLength = widthPx * 4;
  const scanlines = new Uint8Array((rowByteLength + 1) * heightPx);
  for (let y = 0; y < heightPx; y += 1) {
    const sourceOffset = y * rowByteLength;
    const targetOffset = y * (rowByteLength + 1);
    scanlines[targetOffset] = 0;
    scanlines.set(data.subarray(sourceOffset, sourceOffset + rowByteLength), targetOffset + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, widthPx, false);
  headerView.setUint32(4, heightPx, false);
  header[8] = 8;
  header[9] = 6;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header)];
  if (dpi !== undefined) {
    const physical = new Uint8Array(9);
    const physicalView = new DataView(physical.buffer);
    const pixelsPerMeter = Math.round(dpi / METERS_PER_INCH);
    physicalView.setUint32(0, pixelsPerMeter, false);
    physicalView.setUint32(4, pixelsPerMeter, false);
    physical[8] = 1;
    chunks.push(pngChunk("pHYs", physical));
  }
  chunks.push(pngChunk("IDAT", await deflate(scanlines)), pngChunk("IEND", new Uint8Array()));
  return concatenateBytes(chunks);
}

const TIFF_ROWS_PER_STRIP_TARGET_BYTES = 256 * 1024;

/**
 * Encodes RGBA as a baseline RGB TIFF (8 bits per sample, alpha composited on white, Adobe
 * Deflate strips) with X/Y resolution in pixels per inch.
 */
export async function encodeTiffRgb(
  data: Uint8Array,
  widthPx: number,
  heightPx: number,
  dpi: number,
): Promise<Uint8Array> {
  const rowBytes = widthPx * 3;
  const rowsPerStrip = Math.max(
    1,
    Math.min(heightPx, Math.floor(TIFF_ROWS_PER_STRIP_TARGET_BYTES / rowBytes)),
  );
  const strips: Uint8Array[] = [];
  for (let top = 0; top < heightPx; top += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, heightPx - top);
    const rgb = new Uint8Array(rows * rowBytes);
    for (let index = 0; index < rows * widthPx; index += 1) {
      const source = (top * widthPx + index) * 4;
      const alpha = (data[source + 3] ?? 255) / 255;
      for (let channel = 0; channel < 3; channel += 1)
        rgb[index * 3 + channel] = Math.round(
          (data[source + channel] ?? 0) * alpha + 255 * (1 - alpha),
        );
    }
    strips.push(await deflate(rgb));
  }

  type Entry = { tag: number; type: 3 | 4 | 5 | 2; values: number[] | string };
  const resolution = [Math.round(dpi * 1000), 1000];
  const software = "FigLab\0";
  const entries: Entry[] = [
    { tag: 256, type: 4, values: [widthPx] },
    { tag: 257, type: 4, values: [heightPx] },
    { tag: 258, type: 3, values: [8, 8, 8] },
    { tag: 259, type: 3, values: [8] },
    { tag: 262, type: 3, values: [2] },
    { tag: 273, type: 4, values: strips.map(() => 0) },
    { tag: 277, type: 3, values: [3] },
    { tag: 278, type: 4, values: [rowsPerStrip] },
    { tag: 279, type: 4, values: strips.map((strip) => strip.length) },
    { tag: 282, type: 5, values: resolution },
    { tag: 283, type: 5, values: resolution },
    { tag: 284, type: 3, values: [1] },
    { tag: 296, type: 3, values: [2] },
    { tag: 305, type: 2, values: software },
  ];
  const typeSize = { 2: 1, 3: 2, 4: 4, 5: 8 } as const;
  const count = (entry: Entry) =>
    typeof entry.values === "string"
      ? entry.values.length
      : entry.type === 5
        ? entry.values.length / 2
        : entry.values.length;
  const byteLength = (entry: Entry) => count(entry) * typeSize[entry.type];

  const ifdOffset = 8;
  const ifdLength = 2 + entries.length * 12 + 4;
  let cursor = ifdOffset + ifdLength;
  const external = new Map<number, number>();
  for (const entry of entries)
    if (byteLength(entry) > 4) {
      external.set(entry.tag, cursor);
      cursor += byteLength(entry) + (byteLength(entry) % 2);
    }
  const stripOffsets: number[] = [];
  for (const strip of strips) {
    stripOffsets.push(cursor);
    cursor += strip.length;
  }
  const offsetsEntry = entries.find((entry) => entry.tag === 273) as Entry;
  offsetsEntry.values = stripOffsets;

  const output = new Uint8Array(cursor);
  const view = new DataView(output.buffer);
  output.set([0x49, 0x49], 0);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  const writeValues = (entry: Entry, at: number) => {
    if (typeof entry.values === "string") {
      for (let index = 0; index < entry.values.length; index += 1)
        output[at + index] = entry.values.charCodeAt(index);
      return;
    }
    entry.values.forEach((value, index) => {
      if (entry.type === 3) view.setUint16(at + index * 2, value, true);
      else view.setUint32(at + index * 4, value, true);
    });
  };
  entries.forEach((entry, index) => {
    const at = ifdOffset + 2 + index * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, count(entry), true);
    const externalOffset = external.get(entry.tag);
    if (externalOffset === undefined) writeValues(entry, at + 8);
    else {
      view.setUint32(at + 8, externalOffset, true);
      writeValues(entry, externalOffset);
    }
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);
  for (const [index, strip] of strips.entries()) output.set(strip, stripOffsets[index] ?? 0);
  return output;
}

/** zlib-wrapped Deflate, as PNG IDAT and TIFF compression 8 both require. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("Export requires CompressionStream support");
  }
  const compression = new CompressionStream("deflate");
  const compressed = readStream(compression.readable);
  const writer = compression.writable.getWriter();
  const input = new Uint8Array(new ArrayBuffer(data.byteLength));
  input.set(data);
  await writer.write(input);
  await writer.close();
  return compressed;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return concatenateBytes(chunks);
    chunks.push(value);
  }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let index = 0; index < 4; index += 1) chunk[index + 4] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)), false);
  return chunk;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function concatenateBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
