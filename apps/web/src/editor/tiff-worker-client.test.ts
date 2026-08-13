import type { TiffWorkerRequest, TiffWorkerResponse } from "@figlab/image-processing";
import { describe, expect, it, vi } from "vitest";
import { TiffRasterWorkerClient } from "./tiff-worker-client";

describe("TiffRasterWorkerClient", () => {
  it("transfers TIFF bytes into the worker and preserves 16-bit region responses", async () => {
    const sent: { request: TiffWorkerRequest; transfer: Transferable[] }[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<TiffWorkerResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(request: TiffWorkerRequest, transfer: Transferable[]) {
        sent.push({ request, transfer });
      },
      terminate: vi.fn(),
    };
    const client = new TiffRasterWorkerClient(worker as unknown as Worker);
    const bytes = new ArrayBuffer(8);

    const opened = client.open("asset-1", bytes);
    worker.onmessage?.({
      data: {
        requestId: 1,
        kind: "opened",
        assetId: "asset-1",
        description: { widthPx: 20, heightPx: 10, bitDepth: 16, channels: 1 },
      },
    } as MessageEvent<TiffWorkerResponse>);
    await expect(opened).resolves.toEqual({ widthPx: 20, heightPx: 10, bitDepth: 16, channels: 1 });
    expect(sent[0]?.transfer).toEqual([bytes]);

    const sourceRect = { x: 2, y: 3, width: 4, height: 5 };
    const regionPromise = client.read("asset-1", sourceRect);
    const data = new Uint16Array(4 * 5);
    data.set([1, 32_768, 65_535]);
    worker.onmessage?.({
      data: {
        requestId: 2,
        kind: "region",
        assetId: "asset-1",
        region: {
          data,
          sourceRect,
          widthPx: 4,
          heightPx: 5,
          bitDepth: 16,
          channels: 1,
          pyramidLevel: 0,
        },
      },
    } as MessageEvent<TiffWorkerResponse>);

    const region = await regionPromise;
    expect(sent[1]?.request).toMatchObject({ kind: "read", assetId: "asset-1", sourceRect });
    expect(region.data).toBeInstanceOf(Uint16Array);
    expect(region.data).toBe(data);
  });
});
