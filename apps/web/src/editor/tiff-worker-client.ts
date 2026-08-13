import type {
  RasterDescription,
  RasterRegion,
  SourcePixelRect,
  TiffWorkerRequest,
  TiffWorkerResponse,
} from "@figlab/image-processing";

export interface TiffRasterClient {
  open(assetId: string, bytes: ArrayBuffer): Promise<RasterDescription>;
  read(assetId: string, sourceRect: SourcePixelRect, pyramidLevel?: number): Promise<RasterRegion>;
  preview(assetId: string, maxEdge?: number): Promise<RasterRegion>;
  terminate(): void;
}

type PendingRequest = {
  resolve(response: TiffWorkerResponse): void;
  reject(error: Error): void;
};
type WithoutRequestId<T> = T extends { requestId: number } ? Omit<T, "requestId"> : never;
type TiffWorkerRequestWithoutId = WithoutRequestId<TiffWorkerRequest>;

export class TiffRasterWorkerClient implements TiffRasterClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly worker: Worker = new Worker(
      new URL("./tiff-raster.worker.ts", import.meta.url),
      {
        type: "module",
      },
    ),
  ) {
    this.worker.onmessage = (event: MessageEvent<TiffWorkerResponse>) => {
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      this.pending.delete(event.data.requestId);
      if (event.data.kind === "error") pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "TIFF worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  async open(assetId: string, bytes: ArrayBuffer): Promise<RasterDescription> {
    const response = await this.request({ kind: "open", assetId, bytes }, [bytes]);
    if (response.kind !== "opened")
      throw new Error("TIFF worker returned an invalid open response");
    return response.description;
  }

  async read(
    assetId: string,
    sourceRect: SourcePixelRect,
    pyramidLevel = 0,
  ): Promise<RasterRegion> {
    const response = await this.request({ kind: "read", assetId, sourceRect, pyramidLevel });
    if (response.kind !== "region")
      throw new Error("TIFF worker returned an invalid read response");
    return response.region;
  }

  async preview(assetId: string, maxEdge = 1_024): Promise<RasterRegion> {
    const response = await this.request({ kind: "preview", assetId, maxEdge });
    if (response.kind !== "region")
      throw new Error("TIFF worker returned an invalid preview response");
    return response.region;
  }

  terminate(): void {
    this.worker.terminate();
    const error = new Error("TIFF worker terminated");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request(
    request: TiffWorkerRequestWithoutId,
    transfer: Transferable[] = [],
  ): Promise<TiffWorkerResponse> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...request, requestId } as TiffWorkerRequest, transfer);
    });
  }
}

export const createTiffRasterWorkerClient = (): TiffRasterClient => new TiffRasterWorkerClient();
