import { afterEach, describe, expect, it } from "vitest";
import { reportError, setErrorSink, type ErrorReport } from "./reporting.ts";

/**
 * The reporter is the one component whose whole job is to handle the worst
 * input in the system — a raw driver error, mid-incident. These assert the two
 * things that actually matter: it never leaks, and it never throws.
 */

afterEach(() => setErrorSink(null));

function capture(fn: () => void): ErrorReport[] {
  const seen: ErrorReport[] = [];
  setErrorSink((r) => seen.push(r));
  fn();
  return seen;
}

describe("redaction", () => {
  it("strips a connection string, password and all", () => {
    const [r] = capture(() =>
      reportError(
        new Error('connect failed: postgresql://user:hunter2@db.example.com:5432/nexus?sslmode=require'),
        "db",
      ),
    );
    expect(r!.message).not.toContain("hunter2");
    expect(r!.message).toContain("[redacted]");
  });

  it("strips an IBAN", () => {
    const [r] = capture(() =>
      reportError(new Error("invalid IBAN AE070331234567890123456 on payout"), "wps"),
    );
    expect(r!.message).not.toContain("AE070331234567890123456");
    expect(r!.message).toContain("[iban]");
  });

  it("strips an Emirates ID", () => {
    const [r] = capture(() =>
      reportError(new Error("duplicate national id 784-1990-1234567-1"), "hr"),
    );
    expect(r!.message).not.toMatch(/784-?1990/);
  });

  it("strips an argon2 hash and an encrypted PII envelope", () => {
    const [r] = capture(() =>
      reportError(new Error("mismatch $argon2id$v=19$m=65536 vs p1.AbCdEf0123456789"), "auth"),
    );
    expect(r!.message).not.toContain("$argon2id$v=19");
    expect(r!.message).not.toContain("p1.AbCdEf");
  });

  it("strips API keys", () => {
    const [r] = capture(() =>
      reportError(new Error("rejected key nxk_liveSecretValue123 and sk-ant-abc123"), "api"),
    );
    expect(r!.message).not.toContain("liveSecretValue123");
    expect(r!.message).not.toContain("sk-ant-abc123");
  });

  it("redacts the context object through the shared redactor", () => {
    const [r] = capture(() =>
      reportError(new Error("boom"), "action", { password: "hunter2", route: "/receivables" }),
    );
    expect(JSON.stringify(r!.context)).not.toContain("hunter2");
    expect(r!.context!.route).toBe("/receivables");
  });

  it("does not repeat the raw message inside the stack", () => {
    const err = new Error("postgresql://u:p@h/db");
    const [r] = capture(() => reportError(err, "db"));
    expect(r!.stack ?? "").not.toContain("u:p@h");
  });
});

describe("fingerprinting", () => {
  it("groups the same bug across different ids and amounts", () => {
    const reports = capture(() => {
      reportError(new Error("Invoice 4f2a1b3c-1111-4111-8111-111111111111 not found"), "svc");
      reportError(new Error("Invoice 91bc7d2e-2222-4222-8222-222222222222 not found"), "svc");
    });
    expect(reports[0]!.fingerprint).toBe(reports[1]!.fingerprint);
  });

  it("keeps genuinely different failures apart", () => {
    const reports = capture(() => {
      reportError(new Error("Invoice not found"), "svc");
      reportError(new Error("Journal does not balance"), "svc");
    });
    expect(reports[0]!.fingerprint).not.toBe(reports[1]!.fingerprint);
  });

  it("separates the same message from different places", () => {
    const reports = capture(() => {
      reportError(new Error("timeout"), "api/metrics");
      reportError(new Error("timeout"), "cron/outbox");
    });
    expect(reports[0]!.fingerprint).not.toBe(reports[1]!.fingerprint);
  });
});

describe("resilience", () => {
  it("accepts a non-Error throw", () => {
    const [r] = capture(() => reportError("just a string", "weird"));
    expect(r!.message).toBe("just a string");
  });

  it("never throws when the sink itself fails", () => {
    setErrorSink(() => {
      throw new Error("sink is down");
    });
    // A failure in the reporter must not become the incident.
    expect(() => reportError(new Error("original"), "somewhere")).not.toThrow();
  });

  it("returns null rather than throwing when reporting fails", () => {
    setErrorSink(() => {
      throw new Error("sink is down");
    });
    expect(reportError(new Error("original"), "somewhere")).toBeNull();
  });
});
