import type { FastifyInstance } from "fastify";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Serves one WHATWG `Request` through Fastify's in-process injector, so the same app can run
 * behind fetch-style serverless runtimes (Netlify Functions) without binding a port.
 */
export async function handleFetchRequest(
  app: FastifyInstance,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const injected = await app.inject({
    method: request.method as "GET",
    url: `${url.pathname}${url.search}`,
    headers,
    ...(hasBody ? { payload: Buffer.from(await request.arrayBuffer()) } : {}),
  });
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(injected.headers)) {
    if (value === undefined || key === "content-length" || key === "transfer-encoding") continue;
    for (const item of Array.isArray(value) ? value : [value])
      responseHeaders.append(key, String(item));
  }
  const body = NULL_BODY_STATUSES.has(injected.statusCode)
    ? null
    : new Uint8Array(injected.rawPayload);
  return new Response(body, { status: injected.statusCode, headers: responseHeaders });
}
