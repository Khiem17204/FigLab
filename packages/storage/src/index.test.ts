import { describe, expect, it } from "vitest";
import { FakeObjectStore } from "./index.js";

describe("FakeObjectStore", () => {
  it("presigns immutable writes with the exact MIME type, length, and 600 second expiry", async () => {
    const store = new FakeObjectStore();
    const signed = await store.presignPut({
      key: "workspaces/w/projects/p/assets/a/original",
      contentType: "image/png",
      contentLength: 42,
    });
    expect(signed).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": "42" },
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
