import { describe, expect, it, vi } from "vitest";
import { SupabaseObjectStore } from "./supabase.js";

const KEY = "workspaces/w/projects/p/assets/a/original";

function storeWith(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, init });
    return handler(url, init);
  });
  const store = new SupabaseObjectStore({
    supabaseUrl: "https://ref.supabase.example/",
    secretKey: "sb_secret_test",
    bucket: "figlab",
    fetch: fetcher as unknown as typeof fetch,
  });
  return { store, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("SupabaseObjectStore", () => {
  it("issues non-overwriting signed uploads with only browser-settable headers", async () => {
    const { store, calls } = storeWith(() =>
      json({ url: `/object/upload/sign/figlab/${KEY}?token=signed-token` }),
    );

    const signed = await store.presignPut({
      key: KEY,
      contentType: "image/tiff",
      contentLength: 10,
      expiresInSeconds: 600,
    });

    expect(calls[0]?.url.pathname).toBe(`/storage/v1/object/upload/sign/figlab/${KEY}`);
    expect(new Headers(calls[0]?.init.headers).get("x-upsert")).toBeNull();
    expect(new Headers(calls[0]?.init.headers).get("apikey")).toBe("sb_secret_test");
    expect(signed).toMatchObject({
      url: `https://ref.supabase.example/storage/v1/object/upload/sign/figlab/${KEY}?token=signed-token`,
      method: "PUT",
      headers: { "content-type": "image/tiff", "x-upsert": "false" },
    });
    expect(new Date(signed.expiresAt).getTime() - Date.now()).toBeGreaterThan(599_000);
  });

  it("reports size and type from object info and treats a missing object as absent", async () => {
    const { store } = storeWith((url) =>
      url.pathname.endsWith("/missing")
        ? json({ statusCode: "404", error: "not_found", message: "Object not found" }, 404)
        : json({ id: "1", name: KEY, size: 42, content_type: "image/png" }),
    );
    expect(await store.stat(KEY)).toEqual({ contentLength: 42, contentType: "image/png" });
    expect(await store.stat("missing")).toBeUndefined();
  });

  it("signs downloads and streams object bytes to server code", async () => {
    const { store, calls } = storeWith((url) =>
      url.pathname.includes("/object/sign/")
        ? json({ signedURL: `/object/sign/figlab/${KEY}?token=get-token` })
        : new Response(new Uint8Array([1, 2, 3])),
    );
    const signed = await store.presignDownload(KEY, 120);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ expiresIn: 120 });
    expect(signed.url).toContain("token=get-token");

    const chunks: Uint8Array[] = [];
    for await (const chunk of await store.read(KEY)) chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it("writes derived previews with upsert and refuses original keys", async () => {
    const { store, calls } = storeWith(() => json({ Key: "figlab/x", Id: "1" }));
    const preview = KEY.replace(/original$/, "preview-1024.png");
    await store.putDerived(preview, new Uint8Array([9]), "image/png");
    expect(calls[0]?.url.pathname).toBe(`/storage/v1/object/figlab/${preview}`);
    expect(new Headers(calls[0]?.init.headers).get("x-upsert")).toBe("true");
    await expect(store.putDerived(KEY, new Uint8Array([9]), "image/png")).rejects.toThrow(
      "cannot be written over originals",
    );
    expect(calls).toHaveLength(1);
  });
});
