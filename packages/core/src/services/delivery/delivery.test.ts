import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@nexus/db";
import {
  buildMessage,
  consoleProvider,
  createEmailProvider,
  deliveryEnabledInEnvironment,
  describeSafely,
  readEmailEnv,
  resolveProvider,
  SmtpError,
  sendMail,
  type DeliveryProvider,
  type DeliveryResult,
  type OutboundMessage,
  type SmtpConfig,
} from "./index.ts";
import { dispatchOutbox, runOutboxCycle, type DispatchOptions } from "../outbox.ts";

/**
 * FR-P03 — ONE REAL DELIVERY CHANNEL, AND THE RAILS ROUND IT.
 *
 * The property under test throughout this file is not "does mail get sent". It
 * is the one the wave-1 audit found violated (H7): **the delivery log must
 * never assert a delivery that did not happen.** Every outbox case below
 * therefore asserts on the SQL that was issued — specifically on whether
 * `status = 'success'` appears — rather than on a summary counter, because a
 * counter is what the old code got right while the row was what it got wrong.
 *
 * The tests run against a stub transaction, as `users.test.ts` and
 * `invites.test.ts` do and for the same reason: the properties are decisions
 * made before and after SQL is issued, so proving them needs no Postgres and
 * they run in `test:unit` on every commit. The one exception is the SMTP suite
 * at the bottom, which speaks the real protocol over a real loopback socket to
 * a catcher started inside the test — a protocol client that has only ever been
 * tested against a mock of itself is not evidence of anything.
 */

// ── stub transaction ────────────────────────────────────────────────────────

/** The literal fragments of a drizzle `sql` template, parameters elided. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const c of nodes) {
      if (c === null || typeof c !== "object") continue;
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) out.push(v.join(" "));
      else if (Array.isArray((c as { queryChunks?: unknown[] }).queryChunks)) {
        walk((c as { queryChunks: unknown[] }).queryChunks);
      }
    }
  };
  walk(chunks);
  return out.join(" ");
}

/** The parameters bound into a drizzle `sql` template, in order. */
function sqlParams(query: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      if (chunk === null || chunk === undefined) continue;
      if (typeof chunk !== "object") {
        out.push(chunk);
        continue;
      }
      if (Array.isArray((chunk as { value?: unknown }).value)) continue; // StringChunk
      if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
        walk(chunk);
        continue;
      }
      out.push(chunk.valueOf());
    }
  };
  walk(query);
  return out;
}

type Row = Record<string, unknown>;

interface World {
  pending?: Row[];
  /** `tenants.settings->>'delivery_paused'`. */
  paused?: boolean;
  pausedReason?: string;
  /** External messages already delivered today, for the cap. */
  usedToday?: number;
}

function notification(over: Partial<Row> = {}): Row {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "email",
    recipient_address: "tenant@example.ae",
    recipient_party_id: "22222222-2222-4222-8222-222222222222",
    title: "Your rent is due",
    body: "AED 4,000 due on the 1st.",
    severity: "warning",
    is_marketing: false,
    attempts: 0,
    source_table: "automations",
    allows_transactional: true,
    allows_marketing: null,
    opted_out_at: null,
    party_phone: null,
    party_email: "tenant@example.ae",
    ...over,
  };
}

function stubTx(world: World = {}) {
  const statements: { text: string; params: unknown[] }[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query);
    statements.push({ text, params: sqlParams(query) });

    if (/FROM tenants/i.test(text) && /delivery_paused/i.test(text)) {
      return [
        {
          paused: world.paused ? "true" : "false",
          paused_reason: world.pausedReason ?? null,
        },
      ];
    }
    if (/COUNT\(\*\)::int AS used/i.test(text)) {
      return [{ used: world.usedToday ?? 0 }];
    }
    if (/FROM notifications n/i.test(text)) {
      return world.pending ?? [];
    }
    return [];
  };

  return {
    statements,
    tx: { execute } as unknown as Tx,
    /** Statements that changed something. */
    writes: () => statements.filter((s) => /^\s*(UPDATE|INSERT|DELETE)/i.test(s.text.trim())),
  };
}

/** A provider that returns whatever the test tells it to, and counts calls. */
function scriptedProvider(...results: DeliveryResult[]): DeliveryProvider & { calls: OutboundMessage[] } {
  const calls: OutboundMessage[] = [];
  let i = 0;
  return {
    name: "scripted",
    channels: ["in_app", "email", "sms", "whatsapp", "push"],
    calls,
    async send(message) {
      calls.push(message);
      return results[Math.min(i++, results.length - 1)]!;
    },
  };
}

const ON: NodeJS.ProcessEnv = { NEXUS_DELIVERY_ENABLED: "true" };

function run(tx: Tx, opts: DispatchOptions = {}) {
  return dispatchOutbox(tx, { now: new Date("2026-08-21T10:00:00Z"), env: ON, ...opts });
}

let consoleErr: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // `reportError` writes structured JSON to stderr with no sink installed, and
  // the console provider writes to stdout. Both are asserted on where they
  // matter; elsewhere they are noise.
  consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  consoleErr.mockRestore();
  consoleLog.mockRestore();
});

// ── the lie, and its absence ────────────────────────────────────────────────

describe("the delivery log must not lie", () => {
  it("the console provider reports `simulated`, never a send", async () => {
    const result = await consoleProvider.send({
      id: "n1", channel: "email", address: "x@y.ae", title: "t", body: "b",
      severity: "info", isMarketing: false, partyId: null,
    });
    expect(result.outcome).toBe("simulated");
    expect(result.providerMessageId).toBeUndefined();
  });

  it("the console provider does not print the title or the address", async () => {
    await consoleProvider.send({
      id: "n1", channel: "sms", address: "+971501234567", title: "Visa expires — Rajesh Kumar",
      body: "b", severity: "info", isMarketing: false, partyId: null,
    });
    const printed = consoleLog.mock.calls.flat().join(" ");
    expect(printed).not.toContain("Rajesh");
    expect(printed).not.toContain("+971501234567");
    expect(printed).toContain("n1");
  });

  it("a simulated send leaves the row pending and never writes success", async () => {
    const { tx, writes } = stubTx({ pending: [notification()] });
    const summary = await run(tx, { commit: true, provider: consoleProvider });

    expect(summary.delivered).toBe(0);
    expect(summary.unconfigured).toBe(1);
    // The assertion that matters: nothing WRITTEN in the whole cycle said
    // success. (The cap's headroom query reads `status = 'success'`, hence
    // `writes()` rather than every statement.)
    expect(writes().some((s) => /status\s*=\s*'success'/i.test(s.text))).toBe(false);
    expect(writes().some((s) => /SET status = 'pending'/i.test(s.text))).toBe(true);
  });

  it("a configuration fault refunds the attempt it consumed at claim time", async () => {
    const { tx, writes } = stubTx({ pending: [notification({ attempts: 2 })] });
    await run(tx, { commit: true, provider: consoleProvider });

    // Claimed at 3, handed back at 2 — an unset SMTP_HOST must not spend a
    // message's retry budget.
    const settle = writes().find((s) => /SET status = 'pending'/i.test(s.text))!;
    expect(settle.params).toContain(2);
  });

  it("refuses `delivered` from a provider that cannot name the message", async () => {
    const { tx, writes } = stubTx({ pending: [notification()] });
    const liar = scriptedProvider({ outcome: "delivered" }); // no providerMessageId
    const summary = await run(tx, { commit: true, provider: liar });

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toBe(1);
    expect(writes().some((s) => /status\s*=\s*'success'/i.test(s.text))).toBe(false);
    expect(consoleErr.mock.calls.flat().join(" ")).toContain("provider-contract");
  });

  it("writes success exactly once, with the provider's own identifier", async () => {
    const { tx, writes } = stubTx({ pending: [notification()] });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "4Wq77x" });
    const summary = await run(tx, { commit: true, provider });

    expect(summary.delivered).toBe(1);
    const success = writes().filter((s) => /status\s*=\s*'success'/i.test(s.text));
    expect(success).toHaveLength(1);
    expect(success[0]!.params).toContain("4Wq77x");
    expect(success[0]!.params).toContain("scripted");
  });
});

// ── the kill switch ─────────────────────────────────────────────────────────

describe("kill switch", () => {
  it("requires the exact string `true` in the environment", () => {
    for (const value of [undefined, "", "1", "yes", "TRUE", "on"]) {
      expect(deliveryEnabledInEnvironment({ NEXUS_DELIVERY_ENABLED: value })).toBe(false);
    }
    expect(deliveryEnabledInEnvironment({ NEXUS_DELIVERY_ENABLED: "true" })).toBe(true);
  });

  it("with the environment switch off, nothing is sent and nothing is written", async () => {
    const { tx, writes } = stubTx({ pending: [notification()] });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "x" });
    const summary = await dispatchOutbox(tx, {
      commit: true, provider, env: {}, now: new Date("2026-08-21T10:00:00Z"),
    });

    expect(provider.calls).toHaveLength(0);
    expect(summary.held).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(summary.haltedReason).toContain("NEXUS_DELIVERY_ENABLED");
  });

  it("the per-tenant pause stops delivery without a redeploy", async () => {
    const { tx, writes } = stubTx({
      pending: [notification()], paused: true, pausedReason: "review automation ran away",
    });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "x" });
    const summary = await run(tx, { commit: true, provider });

    expect(provider.calls).toHaveLength(0);
    expect(summary.held).toBe(1);
    expect(writes()).toHaveLength(0);
    expect(summary.haltedReason).toContain("review automation ran away");
  });

  it("reports BOTH switches when both are holding the line", async () => {
    const { tx } = stubTx({ pending: [notification()], paused: true });
    const summary = await dispatchOutbox(tx, {
      commit: true, provider: consoleProvider, env: {}, now: new Date("2026-08-21T10:00:00Z"),
    });
    expect(summary.haltedReason).toContain("NEXUS_DELIVERY_ENABLED");
    expect(summary.haltedReason).toContain("paused for this tenant");
  });
});

// ── caps and approval ───────────────────────────────────────────────────────

describe("runaway guards", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      notification({
        id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
        recipient_party_id: `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`,
        recipient_address: `p${i}@example.ae`,
        title: `Reminder ${i}`,
      }),
    );

  it("stops at the daily external cap and leaves the rest pending", async () => {
    const { tx } = stubTx({ pending: many(5), usedToday: 3 });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "id" });
    const summary = await run(tx, {
      commit: true, provider,
      env: { ...ON, NEXUS_DELIVERY_DAILY_CAP: "4", NEXUS_DELIVERY_APPROVAL_THRESHOLD: "100" },
    });

    // 4 allowed today, 3 already spent → exactly one goes out.
    expect(provider.calls).toHaveLength(1);
    expect(summary.delivered).toBe(1);
    expect(summary.capped).toBe(4);
  });

  it("holds a batch above the approval threshold until an approver is named", async () => {
    const world = { pending: many(6) };
    const env = { ...ON, NEXUS_DELIVERY_APPROVAL_THRESHOLD: "5" };

    const first = stubTx(world);
    const p1 = scriptedProvider({ outcome: "delivered", providerMessageId: "id" });
    const held = await run(first.tx, { commit: true, provider: p1, env });

    expect(p1.calls).toHaveLength(0);
    expect(held.held).toBe(6);
    expect(held.haltedReason).toContain("6 distinct recipients");
    expect(first.writes()).toHaveLength(0);

    const second = stubTx(world);
    const p2 = scriptedProvider({ outcome: "delivered", providerMessageId: "id" });
    const released = await run(second.tx, {
      commit: true, provider: p2, env, approvedBy: "aaaa1111-1111-4111-8111-111111111111",
    });
    expect(p2.calls).toHaveLength(6);
    expect(released.delivered).toBe(6);
  });

  it("releases in-app alerts even while the external half is held", async () => {
    const pending = [...many(6), notification({
      id: "99999999-9999-4999-8999-999999999999",
      channel: "in_app", recipient_party_id: null, recipient_address: null,
      title: "Automation held for approval",
    })];
    const { tx, writes } = stubTx({ pending });
    const summary = await run(tx, {
      commit: true, provider: scriptedProvider({ outcome: "delivered", providerMessageId: "id" }),
      env: { ...ON, NEXUS_DELIVERY_APPROVAL_THRESHOLD: "5" },
    });

    expect(summary.held).toBe(6);
    expect(summary.delivered).toBe(1);
    expect(writes().some((s) => /provider = 'in_app'/.test(s.text))).toBe(true);
  });
});

// ── retry classification ────────────────────────────────────────────────────

describe("retry", () => {
  it("a transient failure backs off and stays pending", async () => {
    const { tx, writes } = stubTx({ pending: [notification({ attempts: 1 })] });
    const summary = await run(tx, {
      commit: true, provider: scriptedProvider({ outcome: "transient_failure", reason: "421 busy" }),
    });

    expect(summary.failed).toBe(1);
    const settle = writes().find((s) => /run_status/.test(s.text))!;
    expect(settle.params).toContain("pending");
    expect(settle.params).toContain(2);
    // 2 attempts → 4 minutes.
    expect(settle.params.some((p) => String(p).startsWith("2026-08-21T10:04"))).toBe(true);
  });

  it("a bad address does not retry forever — it spends the budget at once", async () => {
    const { tx, writes } = stubTx({ pending: [notification({ attempts: 0 })] });
    const summary = await run(tx, {
      commit: true,
      provider: scriptedProvider({ outcome: "permanent_failure", reason: "no such mailbox" }),
    });

    expect(summary.failed).toBe(1);
    const settle = writes().find((s) => /run_status/.test(s.text))!;
    expect(settle.params).toContain("failed");
    expect(settle.params).toContain(5); // MAX_ATTEMPTS — never selected again
    // next_attempt_at cleared: no retry instant was bound at all.
    expect(settle.params.some((p) => String(p).startsWith("2026-"))).toBe(false);
    expect(summary.detail[0]!.reason).toContain("permanent, not retrying");
  });

  it("a provider that throws is treated as transient, not as a verdict", async () => {
    const { tx, writes } = stubTx({ pending: [notification()] });
    const thrower: DeliveryProvider = {
      name: "boom", channels: ["email"],
      async send() { throw new Error("socket hang up talking to tenant@example.ae"); },
    };
    const summary = await run(tx, { commit: true, provider: thrower });

    expect(summary.failed).toBe(1);
    const settle = writes().find((s) => /run_status/.test(s.text))!;
    expect(settle.params).toContain("pending");
    // And the address does not survive into the column the inbox renders.
    expect(settle.params.join(" ")).not.toContain("tenant@example.ae");
  });
});

// ── credentials in bodies ───────────────────────────────────────────────────

describe("invite tokens", () => {
  it("clears the body of a delivered invite, keeping the evidence of the send", async () => {
    const { tx, writes } = stubTx({
      pending: [notification({
        source_table: "user_invites",
        title: "You have been invited to Nexus",
        body: "Accept: https://app/invite/9f3c…",
      })],
    });
    await run(tx, {
      commit: true, provider: scriptedProvider({ outcome: "delivered", providerMessageId: "q1" }),
    });

    const success = writes().find((s) => /status\s*=\s*'success'/i.test(s.text))!;
    expect(success.text).toMatch(/body =\s*NULL/);
  });

  it("keeps an ordinary notification's body", async () => {
    const { tx, writes } = stubTx({ pending: [notification({ source_table: "automations" })] });
    await run(tx, {
      commit: true, provider: scriptedProvider({ outcome: "delivered", providerMessageId: "q1" }),
    });
    const success = writes().find((s) => /status\s*=\s*'success'/i.test(s.text))!;
    expect(success.text).not.toMatch(/body =\s*NULL/);
  });
});

// ── existing gates still hold ───────────────────────────────────────────────

describe("consent and quiet hours are unchanged", () => {
  it("an opted-out recipient is suppressed, never handed to a provider", async () => {
    const { tx } = stubTx({
      pending: [notification({ opted_out_at: "2026-01-01T00:00:00Z" })],
    });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "x" });
    const summary = await run(tx, { commit: true, provider });
    expect(provider.calls).toHaveLength(0);
    expect(summary.suppressed).toBe(1);
  });

  it("a non-critical customer message at 03:00 Gulf is deferred, not sent", async () => {
    const { tx } = stubTx({ pending: [notification()] });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "x" });
    const summary = await run(tx, {
      commit: true, provider, now: new Date("2026-08-21T23:00:00Z"), // 03:00 GST
    });
    expect(provider.calls).toHaveLength(0);
    expect(summary.deferred).toBe(1);
  });

  it("a dry run writes nothing and never counts a delivery", async () => {
    const { tx, writes } = stubTx({ pending: [notification()] });
    const provider = scriptedProvider({ outcome: "delivered", providerMessageId: "x" });
    const summary = await run(tx, { commit: false, provider });
    expect(provider.calls).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(summary.delivered).toBe(0);
    expect(summary.deliverable).toBe(1);
  });
});

// ── the transaction boundary ────────────────────────────────────────────────

describe("transaction boundary (audit M6)", () => {
  it("runOutboxCycle opens no transaction while the provider is working", async () => {
    const { tx } = stubTx({ pending: [notification()] });
    let open = 0;
    let maxOpenDuringSend = 0;

    const provider: DeliveryProvider = {
      name: "watcher", channels: ["email"],
      async send() {
        maxOpenDuringSend = Math.max(maxOpenDuringSend, open);
        return { outcome: "delivered", providerMessageId: "q" };
      },
    };

    const summary = await runOutboxCycle(
      async (fn) => {
        open++;
        try { return await fn(tx); } finally { open--; }
      },
      { commit: true, provider, env: ON, now: new Date("2026-08-21T10:00:00Z") },
    );

    expect(summary.delivered).toBe(1);
    expect(maxOpenDuringSend).toBe(0);
  });

  it("uses two transactions: one to claim, one to record", async () => {
    const { tx } = stubTx({ pending: [notification()] });
    let opened = 0;
    await runOutboxCycle(
      async (fn) => { opened++; return fn(tx); },
      {
        commit: true, env: ON, now: new Date("2026-08-21T10:00:00Z"),
        provider: scriptedProvider({ outcome: "delivered", providerMessageId: "q" }),
      },
    );
    expect(opened).toBe(2);
  });
});

// ── provider configuration ──────────────────────────────────────────────────

describe("configuration fails closed and names the variable", () => {
  it("an empty environment yields no configured channel and says why", () => {
    const resolved = resolveProvider({});
    expect(resolved.configured).toEqual([]);
    expect(resolved.issues.join(" ")).toContain("SMTP_HOST is not set");
  });

  it("does NOT silently fall back to the console provider", async () => {
    const resolved = resolveProvider({});
    const result = await resolved.provider.send({
      id: "n", channel: "email", address: "a@b.ae", title: "t", body: null,
      severity: "info", isMarketing: false, partyId: null,
    });
    expect(result.outcome).toBe("not_configured");
    expect(result.reason).toContain("SMTP_HOST");
  });

  it("has no provider for whatsapp, and says so rather than pretending", async () => {
    const resolved = resolveProvider({ SMTP_HOST: "localhost", SMTP_FROM: "a@b.ae" });
    expect(resolved.configured).toEqual(["email"]);
    const result = await resolved.provider.send({
      id: "n", channel: "whatsapp", address: "+9715…", title: "t", body: null,
      severity: "info", isMarketing: false, partyId: null,
    });
    expect(result.outcome).toBe("not_configured");
    expect(result.reason).toContain("whatsapp");
  });

  it("refuses the insecure escape hatch in production", () => {
    const { config, issues } = readEmailEnv({
      NODE_ENV: "production", SMTP_HOST: "relay", SMTP_FROM: "a@b.ae",
      SMTP_ALLOW_INSECURE: "true",
    });
    expect(config).toBeNull();
    expect(issues.map((i) => i.key)).toContain("SMTP_ALLOW_INSECURE");
  });

  it("never echoes a secret in an issue message", () => {
    const { issues } = readEmailEnv({ SMTP_USER: "postmaster", SMTP_PASSWORD: "" });
    expect(JSON.stringify(issues)).not.toContain("postmaster");
  });
});

// ── PII ─────────────────────────────────────────────────────────────────────

describe("no PII escapes into logs or error columns", () => {
  it("scrubs addresses and phone numbers", () => {
    expect(describeSafely("550 5.1.1 <fatima@example.ae>: no such user")).not.toContain("fatima");
    expect(describeSafely("could not reach +971 50 123 4567")).not.toContain("4567");
  });

  it("truncates, so a relay cannot fill a column with its own banner", () => {
    expect(describeSafely("x".repeat(5000)).length).toBeLessThanOrEqual(200);
  });
});

// ── message construction ────────────────────────────────────────────────────

describe("message construction", () => {
  it("strips CR and LF out of a subject, so a title cannot inject headers", () => {
    const raw = buildMessage(
      {
        from: "no-reply@nexus.ae", to: "a@b.ae",
        subject: "Rent due\r\nBcc: everyone@example.ae", text: "hi",
      },
      "id@nexus",
    );
    const headers = raw.split("\r\n\r\n")[0]!;
    expect(headers).not.toMatch(/^Bcc:/mi);
    expect(headers).toContain("Subject: Rent due Bcc:");
  });

  it("base64s the body, so a line of `.` cannot terminate DATA early", () => {
    const raw = buildMessage(
      { from: "a@b.ae", to: "c@d.ae", subject: "s", text: "line\r\n.\r\nmore" },
      "id@nexus",
    );
    const [headers, body] = raw.split("\r\n\r\n");
    expect(headers).toContain("Content-Transfer-Encoding: base64");
    expect(body!.split("\r\n").some((l) => l.startsWith("."))).toBe(false);
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString()).toContain("more");
  });

  it("RFC 2047-encodes a non-ASCII subject", () => {
    const raw = buildMessage(
      { from: "a@b.ae", to: "c@d.ae", subject: "إيجار مستحق", text: "hi" },
      "id@nexus",
    );
    expect(raw).toContain("Subject: =?UTF-8?B?");
  });
});

// ── the email provider's own retry ──────────────────────────────────────────

describe("email provider retry", () => {
  const cfg: SmtpConfig = {
    host: "relay.test", port: 587, secure: false, clientName: "nexus",
    allowInsecureAuth: false, allowSelfSigned: false, timeoutMs: 100,
  };
  const msg: OutboundMessage = {
    id: "n1", channel: "email", address: "tenant@example.ae", title: "Rent due",
    body: "AED 4,000", severity: "warning", isMarketing: false, partyId: "p1",
  };

  it("retries a transient failure with backoff and then succeeds", async () => {
    const attempts: number[] = [];
    const slept: number[] = [];
    let n = 0;
    const provider = createEmailProvider({
      smtp: cfg, from: "no-reply@nexus.ae",
      sleep: async (ms) => { slept.push(ms); },
      transport: async () => {
        attempts.push(++n);
        if (n < 3) throw new SmtpError("421 service unavailable", "transient");
        return { queueId: "4Wq99", trace: [] };
      },
    });

    const result = await provider.send(msg);
    expect(result).toEqual({ outcome: "delivered", providerMessageId: "4Wq99" });
    expect(attempts).toEqual([1, 2, 3]);
    expect(slept).toHaveLength(2);
  });

  it("gives up after three in-process attempts and hands it back as transient", async () => {
    let n = 0;
    const provider = createEmailProvider({
      smtp: cfg, from: "no-reply@nexus.ae",
      sleep: async () => {},
      transport: async () => { n++; throw new SmtpError("connection refused", "transient"); },
    });
    const result = await provider.send(msg);
    expect(n).toBe(3);
    expect(result.outcome).toBe("transient_failure");
    expect(result.reason).toContain("after 3 attempts");
  });

  it("does not retry a permanent rejection", async () => {
    let n = 0;
    const provider = createEmailProvider({
      smtp: cfg, from: "no-reply@nexus.ae",
      sleep: async () => {},
      transport: async () => { n++; throw new SmtpError("550 no such user", "permanent"); },
    });
    const result = await provider.send(msg);
    expect(n).toBe(1);
    expect(result.outcome).toBe("permanent_failure");
  });

  it("treats rejected credentials as a configuration fault, loudly and once", async () => {
    let n = 0;
    const provider = createEmailProvider({
      smtp: cfg, from: "no-reply@nexus.ae",
      sleep: async () => {},
      transport: async () => { n++; throw new SmtpError("535 auth failed", "configuration"); },
    });
    const result = await provider.send(msg);
    expect(n).toBe(1);
    expect(result.outcome).toBe("not_configured");
    expect(consoleErr.mock.calls.flat().join(" ")).toContain("delivery/email");
  });

  it("refuses a malformed stored address without opening a socket", async () => {
    let n = 0;
    const provider = createEmailProvider({
      smtp: cfg, from: "no-reply@nexus.ae",
      transport: async () => { n++; return { queueId: "x", trace: [] }; },
    });
    const result = await provider.send({ ...msg, address: "not an address" });
    expect(n).toBe(0);
    expect(result.outcome).toBe("permanent_failure");
  });
});

// ── the real protocol, over a real socket ───────────────────────────────────

interface CatcherOptions {
  /** Reply codes to substitute, e.g. { "RCPT TO": "550 no such user" }. */
  reject?: Record<string, string>;
  /** Advertise AUTH in the EHLO response. */
  offerAuth?: boolean;
}

interface Catcher {
  port: number;
  /** Complete DATA payloads the server accepted. */
  received: string[];
  /** Commands the server saw, verbatim (test-local, never logged). */
  commands: string[];
  close(): Promise<void>;
}

/**
 * A local SMTP catcher.
 *
 * Deliberately a real TCP server speaking real RFC 5321 rather than a mocked
 * `sendMail`. The bugs this file's client can plausibly have — a continuation
 * line mistaken for a complete reply, a missing dot terminator, a command
 * written before the previous reply arrived — are all invisible to a mock,
 * because a mock cannot desynchronise.
 */
function startCatcher(options: CatcherOptions = {}): Promise<Catcher> {
  const received: string[] = [];
  const commands: string[] = [];

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let payload = "";
    socket.setEncoding("utf8");
    socket.write("220 catcher.test ESMTP ready\r\n");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(payload);
            payload = "";
            socket.write("250 2.0.0 Ok: queued as CATCH42\r\n");
          } else {
            // RFC 5321 §4.5.2 un-stuffing. Base64 bodies never need it, which
            // is the point of using base64 — but a catcher that ignored the
            // rule would hide a client that got it wrong.
            payload += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        commands.push(line);
        const verb = line.split(":")[0]!.split(" ").slice(0, 2).join(" ").toUpperCase();
        const override =
          options.reject?.[verb] ?? options.reject?.[line.split(" ")[0]!.toUpperCase()];
        if (override) {
          socket.write(`${override}\r\n`);
          continue;
        }

        if (/^EHLO/i.test(line)) {
          // A genuinely multi-line reply — the shape that breaks a naive parser.
          socket.write("250-catcher.test greets you\r\n");
          socket.write("250-SIZE 10485760\r\n");
          if (options.offerAuth) socket.write("250-AUTH PLAIN LOGIN\r\n");
          socket.write("250 8BITMIME\r\n");
        } else if (/^MAIL FROM/i.test(line) || /^RCPT TO/i.test(line)) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (/^AUTH/i.test(line)) {
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("500 5.5.2 Unrecognised command\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        received,
        commands,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function catcherConfig(port: number, over: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: "127.0.0.1", port, secure: false, clientName: "nexus-erp",
    // The catcher is plaintext on loopback. This is the exact case
    // SMTP_ALLOW_INSECURE exists for, and it is refused in production.
    allowInsecureAuth: true, allowSelfSigned: true, timeoutMs: 3_000,
    ...over,
  };
}

describe("SMTP against a real local catcher", () => {
  it("delivers a message and returns the relay's queue id", async () => {
    const catcher = await startCatcher();
    try {
      const { queueId, trace } = await sendMail(catcherConfig(catcher.port), {
        from: "Nexus ERP <no-reply@nexus.ae>",
        to: "tenant@example.ae",
        subject: "Your rent is due",
        text: "AED 4,000 due on 1 September.",
      });

      expect(queueId).toBe("CATCH42");
      expect(catcher.commands).toContain("MAIL FROM:<no-reply@nexus.ae>");
      expect(catcher.commands).toContain("RCPT TO:<tenant@example.ae>");
      expect(catcher.received).toHaveLength(1);

      const [headers, body] = catcher.received[0]!.split("\r\n\r\n");
      expect(headers).toContain("Subject: Your rent is due");
      expect(headers).toContain("From: Nexus ERP <no-reply@nexus.ae>");
      expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString())
        .toBe("AED 4,000 due on 1 September.");

      // The trace records verbs and codes, never arguments.
      expect(trace.join(" ")).not.toContain("tenant@example.ae");
      expect(trace).toContain("RCPT TO -> 250");
    } finally {
      await catcher.close();
    }
  });

  it("classifies a 550 on RCPT as permanent", async () => {
    const catcher = await startCatcher({ reject: { "RCPT TO": "550 5.1.1 no such user" } });
    try {
      await expect(
        sendMail(catcherConfig(catcher.port), {
          from: "no-reply@nexus.ae", to: "gone@example.ae", subject: "s", text: "t",
        }),
      ).rejects.toMatchObject({ kind: "permanent", code: 550 });
    } finally {
      await catcher.close();
    }
  });

  it("classifies a 451 as transient", async () => {
    const catcher = await startCatcher({ reject: { "MAIL FROM": "451 4.3.0 try later" } });
    try {
      await expect(
        sendMail(catcherConfig(catcher.port), {
          from: "no-reply@nexus.ae", to: "a@b.ae", subject: "s", text: "t",
        }),
      ).rejects.toMatchObject({ kind: "transient", code: 451 });
    } finally {
      await catcher.close();
    }
  });

  it("classifies rejected credentials as a configuration fault", async () => {
    const catcher = await startCatcher({
      offerAuth: true, reject: { AUTH: "535 5.7.8 bad credentials" },
    });
    try {
      await expect(
        sendMail(catcherConfig(catcher.port, { user: "postmaster", password: "wrong" }), {
          from: "no-reply@nexus.ae", to: "a@b.ae", subject: "s", text: "t",
        }),
      ).rejects.toMatchObject({ kind: "configuration" });
    } finally {
      await catcher.close();
    }
  });

  it("refuses to authenticate over an unencrypted connection", async () => {
    const catcher = await startCatcher({ offerAuth: true });
    try {
      await expect(
        sendMail(
          catcherConfig(catcher.port, {
            user: "postmaster", password: "hunter2", allowInsecureAuth: false,
          }),
          { from: "no-reply@nexus.ae", to: "a@b.ae", subject: "s", text: "t" },
        ),
      ).rejects.toMatchObject({ kind: "configuration" });
      expect(catcher.commands.some((c) => /^AUTH/i.test(c))).toBe(false);
    } finally {
      await catcher.close();
    }
  });

  it("reports an unreachable relay as transient, not as a bad address", async () => {
    const catcher = await startCatcher();
    const port = catcher.port;
    await catcher.close();
    await expect(
      sendMail(catcherConfig(port), {
        from: "no-reply@nexus.ae", to: "a@b.ae", subject: "s", text: "t",
      }),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("delivers end to end through the outbox, and the row says so", async () => {
    const catcher = await startCatcher();
    try {
      const provider = createEmailProvider({
        smtp: catcherConfig(catcher.port),
        from: "Nexus ERP <no-reply@nexus.ae>",
      });
      const { tx, writes } = stubTx({ pending: [notification()] });
      const summary = await run(tx, { commit: true, provider });

      expect(summary.delivered).toBe(1);
      expect(catcher.received).toHaveLength(1);
      const success = writes().find((s) => /status\s*=\s*'success'/i.test(s.text))!;
      expect(success.params).toContain("CATCH42");
      expect(success.params).toContain("smtp");
    } finally {
      await catcher.close();
    }
  });
});
