/**
 * Shared trigger for the scheduled jobs.
 *
 * The job logic lives in `apps/web/src/app/api/cron/[job]` and is NOT duplicated
 * here. There is one implementation of "run the automation sweep", called by
 * whichever scheduler the platform provides — Vercel Cron hits the route
 * directly, Netlify hits it through these functions. A second copy would drift.
 *
 * Netlify scheduled functions have a 30-second execution limit and the
 * automation sweep took 23 seconds in production. So this does NOT await the
 * job: it opens the request, waits only long enough to confirm the route
 * accepted it, and returns. The authoritative record of what happened is the
 * `job_runs` table the route writes, which /api/health already reports on — not
 * the HTTP response the scheduler never sees.
 */
export async function trigger(job: string): Promise<void> {
  const base = Netlify.env.get("URL") ?? Netlify.env.get("DEPLOY_URL");
  const secret = Netlify.env.get("CRON_SECRET");

  if (!base) {
    console.error(JSON.stringify({ type: "cron", job, error: "no site URL in env" }));
    return;
  }
  if (!secret) {
    // Same fail-closed posture as the route itself: without a secret the job
    // endpoint rejects us anyway, so say why rather than emitting a bare 401.
    console.error(JSON.stringify({ type: "cron", job, error: "CRON_SECRET not set" }));
    return;
  }

  const controller = new AbortController();
  // Long enough to be sure the route started and claimed its lock, short enough
  // to return well inside the 30s ceiling.
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${base}/api/cron/${job}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    console.log(JSON.stringify({ type: "cron", job, status: res.status }));
  } catch (err) {
    // An abort here means the job is still running server-side, which is the
    // expected case for the longer sweeps — not a failure.
    const aborted = err instanceof Error && err.name === "AbortError";
    console.log(
      JSON.stringify({
        type: "cron",
        job,
        status: aborted ? "detached (still running server-side)" : "trigger failed",
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}
