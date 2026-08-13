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
      );
    const client = new FigLabClient(fetcher);
    const original = new Blob(["pixel-data"], { type: "image/png" });

    const result = await client.prepareAndUpload("project-1", original, "cells.png");

    expect(result).toEqual({ assetId: "asset-1", status: "ready" });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://minio.example/upload-1");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: { "x-amz-checksum-sha256": "signed" },
      body: original,
    });
  });
});
