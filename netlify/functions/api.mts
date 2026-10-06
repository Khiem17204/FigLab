import { AsyncLocalStorage } from "node:async_hooks";
import type { Config, Context } from "@netlify/functions";
import type { FastifyInstance } from "fastify";
import { createAppFromEnv, handleFetchRequest } from "../dist/api.mjs";
import { triggerJobDrain } from "../lib/trigger-jobs.mjs";

// Requests carry their own origin and lifetime so a job trigger can outlive the response.
const invocation = new AsyncLocalStorage<{ origin: string; context: Context }>();
let app: Promise<FastifyInstance> | undefined;

function getApp(): Promise<FastifyInstance> {
  app ??= createAppFromEnv(process.env, {
    maxConnections: 3,
    onJobsEnqueued: () => {
      const current = invocation.getStore();
      if (current) current.context.waitUntil(triggerJobDrain(current.origin));
    },
  }).catch((error: unknown) => {
    app = undefined;
    throw error;
  });
  return app;
}

export default async (request: Request, context: Context): Promise<Response> => {
  const instance = await getApp();
  return invocation.run({ origin: new URL(request.url).origin, context }, () =>
    handleFetchRequest(instance, request),
  );
};

export const config: Config = {
  path: ["/v1/*", "/health"],
};
