import type { Config, Context } from "@netlify/functions";
import { triggerJobDrain } from "../lib/trigger-jobs.mjs";

// Backstop for missed triggers and Graphile retries: wake the background drainer periodically.
// Draining here directly could be cut off by the scheduled-function time limit mid-job.
export default async (_request: Request, context: Context): Promise<void> => {
  await triggerJobDrain(context.site.url ?? process.env.URL ?? "");
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
