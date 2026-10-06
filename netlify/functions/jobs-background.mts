import type { Config } from "@netlify/functions";
import { drainJobsOnce } from "../dist/jobs.mjs";
import { JOBS_SECRET_HEADER } from "../lib/trigger-jobs.mjs";

// Runs due Graphile jobs (asset verification, project deletion) for up to 15 minutes.
export default async (request: Request): Promise<void> => {
  const secret = process.env.JOBS_TRIGGER_SECRET;
  if (!secret || request.headers.get(JOBS_SECRET_HEADER) !== secret) return;
  await drainJobsOnce(process.env);
};

export const config: Config = {
  background: true,
};
