import { redact } from "./events.ts";

/**
 * ERROR REPORTING.
 *
 * The audit's phrasing was exact: if the deployed app throws a 500, nobody
 * finds out; if a metric silently returns a wrong number, nobody finds out.
 * `/health` and the smoke test closed the liveness half — the app is reachable
 * and the schema is applied. Neither notices a handled error that produced a
 * wrong answer.
 *
 * There were sixteen `console.error` sites and nothing collecting them. On a
 * serverless platform those lines are ephemeral.
 *
 * Deliberately NOT a Sentry dependency at the import level. The reporter is an
 * interface with a structured-stdout default, so:
 *
 *   • The redaction is ours and is unit-tested, rather than trusting a vendor
 *     SDK's scrubber with Emirates IDs, IBANs and connection strings. This app
 *     renders financial data; an unredacted error payload is a PDPL exposure,
 *     not untidiness.
 *   • It works today with a log drain and no account.
 *   • Adding Sentry later is `setErrorSink(sentryAdapter)` in one place, and
 *     the redaction still runs first because it runs before the sink is called.
 */

export interface ErrorReport {
  at: string;
  kind: "unhandled" | "handled";
  where: string;
  message: string;
  /** Stable enough to group by, without leaking the message contents. */
  fingerprint: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export type ErrorSink = (report: ErrorReport) => void;

let sink: ErrorSink | null = null;

/**
 * Install a collector. Called once at boot from `apps/web/src/instrumentation.ts`.
 *
 * Two obligations on any sink, both of which fall out of `reportError` below:
 *
 *  1. **It must not throw.** Installing a sink replaces the stdout default —
 *     it is not an addition to it — so a sink that throws loses the report
 *     entirely: the catch swallows it, nothing reaches stdout, and
 *     `reportError` returns null. A sink is therefore responsible for its own
 *     durable write before it attempts anything remote. The boot adapter does
 *     exactly that: `console.error` first, network second.
 *
 *  2. **It must not call `reportError`.** There is no re-entrancy guard here.
 *     A sink that reports its own delivery failure through the reporter turns
 *     one failed POST into an unbounded loop at the worst possible moment.
 *
 * Left unset — development, scripts, tests — reports go to stdout.
 */
export function setErrorSink(next: ErrorSink | null): void {
  sink = next;
}

/**
 * Group key.
 *
 * Numbers, UUIDs and quoted strings are stripped so "Invoice 4f2a… not found"
 * and "Invoice 91bc… not found" are one issue rather than thousands. Without
 * this an alerting rule fires on volume that is really a single bug.
 */
function fingerprintOf(where: string, message: string): string {
  const shape = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b\d[\d,.]*\b/g, "<n>")
    .replace(/"[^"]*"/g, '"<s>"')
    .slice(0, 120);
  return `${where}:${shape}`;
}

/**
 * Strip anything that could carry a secret out of a message.
 *
 * A Postgres error can quote the failing statement, which in this codebase
 * means bind parameters — amounts, names, encrypted PII envelopes. A connection
 * string in a driver error carries the password outright.
 *
 * Exported because `redact` in events.ts is the wrong tool for a raw string: it
 * matches on object *keys* and cannot see a password embedded in free text. Any
 * code path that puts a driver error message into a security event needs this
 * one, not that one — the boot probe in instrumentation.ts is the first such
 * caller, and it reports a connection failure by definition.
 */
export function scrubMessage(message: string): string {
  return message
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://[redacted]")
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "[iban]")
    .replace(/\b784-?\d{4}-?\d{7}-?\d\b/g, "[emirates-id]")
    .replace(/\$argon2[^\s"']+/g, "[hash]")
    .replace(/\bp1\.[A-Za-z0-9+/=._-]+/g, "[encrypted]")
    .replace(/\b(sk-ant|nxk)[-_][A-Za-z0-9_-]+/g, "[key]")
    .slice(0, 500);
}

/**
 * Report an error.
 *
 * Never throws — a failure in the reporter must not become the incident. It is
 * the last thing standing between a bad request and silence.
 */
export function reportError(
  err: unknown,
  where: string,
  context?: Record<string, unknown>,
): ErrorReport | null {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    const message = scrubMessage(error.message);

    const report: ErrorReport = {
      at: new Date().toISOString(),
      kind: "handled",
      where,
      message,
      fingerprint: fingerprintOf(where, message),
      // Frames only — the message is already on the report and a stack can
      // repeat it verbatim, unredacted.
      stack: error.stack
        ?.split("\n")
        .slice(1, 8)
        .map((l) => scrubMessage(l.trim()))
        .join("\n"),
      context: context ? (redact(context) as Record<string, unknown>) : undefined,
    };

    if (sink) sink(report);
    else console.error(JSON.stringify({ type: "error", ...report }));

    return report;
  } catch {
    // Reporting failed. Say so in the crudest possible way and move on.
    console.error("[reporting] failed to report an error");
    return null;
  }
}
