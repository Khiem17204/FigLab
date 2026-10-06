export const JOBS_SECRET_HEADER = "x-figlab-jobs-secret";

/** Asks the background function to drain the durable Graphile job queue; never throws. */
export async function triggerJobDrain(origin: string): Promise<void> {
  const secret = process.env.JOBS_TRIGGER_SECRET;
  if (!secret) return;
  try {
    await fetch(new URL("/.netlify/functions/jobs-background", origin), {
      method: "POST",
      headers: { [JOBS_SECRET_HEADER]: secret },
    });
  } catch (error) {
    console.error("Could not trigger job drain", error);
  }
}
