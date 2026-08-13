import { describe, expect, it } from "vitest";
import { FakeObjectStore, S3ObjectStore } from "./index.js";

describe("FakeObjectStore", () => {
  it("presigns immutable writes with browser-settable required headers and 600 second expiry", async () => {
    const store = new FakeObjectStore();
    const signed = await store.presignPut({
      key: "workspaces/w/projects/p/assets/a/original",
      contentType: "image/png",
      contentLength: 42,
    });
    expect(signed).toMatchObject({
      method: "PUT",
      headers: {
        "content-type": "image/png",
        "if-none-match": "*",
      },
    });
    expect(new Date(signed.expiresAt).getTime() - Date.now()).toBeGreaterThan(599_000);
  });

  it("keeps objects private while exposing stat and streaming reads to server code", async () => {
    const store = new FakeObjectStore();
    await store.putForTest("a", new Uint8Array([1, 2, 3]), "image/png");
    expect(await store.stat("a")).toEqual({ contentLength: 3, contentType: "image/png" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of await store.read("a")) chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
  });
});

describe("S3ObjectStore", () => {
  it("presigns browser uploads without content-length or default empty checksums", async () => {
    const store = new S3ObjectStore({
      bucket: "private",
      region: "us-east-1",
      internalEndpoint: "http://minio:9000",
      publicEndpoint: "http://localhost:9000",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
    });

    const signed = await store.presignPut({
      key: "workspaces/w/projects/p/assets/a/original",
      contentType: "image/png",
      contentLength: 42,
    });
    const url = new URL(signed.url);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];

    expect(signed.headers).toEqual({
      "content-type": "image/png",
      "if-none-match": "*",
    });
    expect(signedHeaders).toContain("if-none-match");
    expect(signedHeaders).not.toContain("content-length");
    expect([...url.searchParams.keys()].filter((key) => key.includes("checksum"))).toEqual([]);
  });
});
