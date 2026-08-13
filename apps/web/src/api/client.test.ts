import { describe, expect, it, vi } from "vitest";

import { FigLabClient } from "./client";

describe("FigLabClient direct uploads", () => {
  it("puts original bytes to the reserved target using only the signed headers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: "upload-1",
            assetId: "asset-1",
            upload: {
              url: "https://minio.example/upload-1",
              method: "PUT",
              headers: { "x-amz-checksum-sha256": "signed" },
              expiresAt: "2026-08-12T00:00:00.000Z",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assetId: "asset-1", status: "ready" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "asset-1",
            projectId: "project-1",
            filename: "cells.png",
            mimeType: "image/png",
            checksumSha256: "a".repeat(64),
            widthPx: 10,
            heightPx: 8,
            bitDepth: 8,
            channelCount: 3,
            status: "ready",
            metadata: {},
            createdAt: "2026-08-12T00:00:00.000Z",
          }),
          { status: 200 },
        ),
      );
    const client = new FigLabClient(fetcher);
    const original = new Blob(["pixel-data"], { type: "image/png" });

    const result = await client.prepareAndUpload("project-1", original, "cells.png");

    expect(result).toMatchObject({ id: "asset-1", status: "ready" });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://minio.example/upload-1");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: { "x-amz-checksum-sha256": "signed" },
    });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
  });

  it("polls pending verification until ready and emits the verifying stage", async () => {
    const asset = {
      id: "asset-1",
      projectId: "project-1",
      filename: "cells.png",
      mimeType: "image/png",
      checksumSha256: "a".repeat(64),
      widthPx: 10,
      heightPx: 8,
      bitDepth: 8,
      channelCount: 3,
      status: "ready",
      metadata: {},
      createdAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: "upload-1",
            assetId: "asset-1",
            upload: {
              url: "https://minio.example/upload-1",
              method: "PUT",
              headers: {},
              expiresAt: "2026-08-12T00:00:00.000Z",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assetId: "asset-1", status: "pending-verification" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...asset, status: "pending-verification" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(asset)));
    const stages: string[] = [];
    const upload = new FigLabClient(fetcher, 0).prepareAndUpload(
      "project-1",
      new Blob(["pixels"], { type: "image/png" }),
      "cells.png",
      (stage) => stages.push(stage),
    );

    await expect(upload).resolves.toEqual(asset);
    expect(stages).toEqual(["reserved", "uploaded", "verifying", "completed"]);
  });

  it("returns the rejection reason after verification", async () => {
    const rejected = {
      id: "asset-1",
      projectId: "project-1",
      filename: "cells.tif",
      mimeType: "image/tiff",
      checksumSha256: "a".repeat(64),
      widthPx: 10,
      heightPx: 8,
      bitDepth: 8,
      channelCount: 3,
      status: "rejected",
      metadata: {},
      rejectionReason: "Unsupported compression",
      createdAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: "u",
            assetId: "asset-1",
            upload: { url: "https://minio/u", method: "PUT", headers: {}, expiresAt: "later" },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assetId: "asset-1", status: "pending-verification" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(rejected)));

    const upload = new FigLabClient(fetcher, 0).prepareAndUpload(
      "project-1",
      new Blob(["x"]),
      "cells.tif",
    );
    await expect(upload).resolves.toEqual(rejected);
  });

  it("preserves a non-JSON error body without reading the response twice", async () => {
    const client = new FigLabClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("MinIO unavailable", { status: 503 })),
    );

    await expect(client.listProjects()).rejects.toMatchObject({
      status: 503,
      body: "MinIO unavailable",
    });
  });

  it("downloads original bytes through the frozen asset download route", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://minio.example/asset", expiresAt: "later" })),
      )
      .mockResolvedValueOnce(
        new Response("original-bytes", { headers: { "content-type": "image/png" } }),
      );

    const result = await new FigLabClient(fetcher).downloadAsset("asset-1");

    expect(new TextDecoder().decode(result.bytes)).toBe("original-bytes");
    expect(result.mimeType).toBe("image/png");
  });
});
