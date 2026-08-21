import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { describeSafely } from "./types.ts";

/**
 * A MINIMAL SMTP CLIENT, ON NODE'S OWN SOCKETS.
 *
 * WHY NO DEPENDENCY. The brief permits "a small, well-established SMTP
 * library"; this takes the other option and the reason is specific to this
 * tree, not a general preference. Thirty agents are editing this working tree
 * concurrently and `package-lock.json` is a single file: an `npm install` here
 * is a guaranteed merge conflict against everyone else's landing, and a lockfile
 * conflict resolved badly is a silently different dependency graph in CI. The
 * protocol needed to hand one message to one relay is roughly two hundred lines
 * of line-oriented text — RFC 5321 §4.1 command sequence, RFC 3207 STARTTLS,
 * RFC 4954 AUTH — and Node ships `net`, `tls` and base64. Nodemailer earns its
 * keep on the features NOT used here: attachments, DKIM signing, connection
 * pooling, OAuth2, calendar parts. If any of those become requirements this
 * file should be deleted and replaced with nodemailer rather than grown.
 *
 * WHY SMTP AT ALL, rather than an HTTP webhook. FR-P03's first consumer is the
 * user invite (`services/users.ts`), and an invite has to reach a person who by
 * definition has no account in this system yet — a webhook can only reach a
 * system that is already integrated. Email is also the only channel that needs
 * no vendor account, no UAE TDRA sender registration and no WhatsApp Business
 * template approval, all of which are weeks of paperwork the product does not
 * have. The `DeliveryProvider` seam is unchanged, so an SMS or WhatsApp
 * provider is an additional file in this directory, not a rewrite.
 *
 * WHAT THIS FILE REFUSES TO DO
 *
 *   • It will not send a password over an unencrypted socket. If the relay
 *     offers no STARTTLS and the connection is not already TLS, `AUTH` is
 *     skipped and the send is abandoned as a configuration fault — credentials
 *     leaked to a passive observer are worse than an undelivered reminder.
 *     `allowInsecureAuth` exists for a local catcher and is refused when
 *     NODE_ENV is production (see email.ts).
 *   • It will not log a body, an address, or a header. The trace it keeps is
 *     command verbs and reply codes only, and even the reply TEXT is scrubbed
 *     before it escapes, because a 550 quotes the envelope back verbatim.
 *   • It will not let a caller inject headers. Subject and addresses are
 *     stripped of CR and LF before they are written; without that, a display
 *     name of "Ahmed\r\nBcc: everyone@…" is a mail relay for whoever can name
 *     a notification.
 *
 * TRANSIENT vs PERMANENT is the whole point of the return type. SMTP encodes it
 * in the first digit — 4yz means "try later", 5yz means "never" (RFC 5321
 * §4.2.1) — which is exactly the distinction the outbox needs to stop a dead
 * mailbox from consuming a retry budget forever. Socket-level failures are
 * transient by construction: a refused connection is an outage, not a verdict
 * on the address.
 */

export type SmtpFailureKind = "transient" | "permanent" | "configuration";

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly kind: SmtpFailureKind,
    /** The SMTP reply code, when the failure came from the far side. */
    readonly code?: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is used. */
  secure: boolean;
  user?: string;
  password?: string;
  /** Name presented in EHLO. Bare hostname; never a body or an address. */
  clientName: string;
  /** Permit AUTH and delivery over an unencrypted socket. Local catchers only. */
  allowInsecureAuth: boolean;
  /** Accept a self-signed relay certificate. Local catchers only. */
  allowSelfSigned: boolean;
  /** Per-command deadline, milliseconds. */
  timeoutMs: number;
}

export interface SmtpEnvelope {
  from: string;
  to: string;
  subject: string;
  text: string;
}

interface Reply {
  code: number;
  /** Joined text of a multi-line reply. Scrub before it leaves this file. */
  text: string;
}

/**
 * One line-oriented SMTP conversation over one socket.
 *
 * Written as an explicit read/write pair rather than a state machine because
 * the sequence is fixed and linear, and a linear read of the sequence is what
 * makes it reviewable against RFC 5321 §4.1.
 */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pending: {
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private fatal: Error | null = null;
  /** Command verbs and reply codes only. Never arguments. */
  readonly trace: string[] = [];

  constructor(
    socket: net.Socket | tls.TLSSocket,
    private readonly cfg: SmtpConfig,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err: Error) => this.onFatal(err));
    // A relay that hangs up mid-conversation is an outage, not a rejection of
    // this message. Saying so explicitly stops it being reported as a mystery.
    socket.on("close", () =>
      this.onFatal(new SmtpError("connection closed by the relay", "transient")),
    );
  }

  private onFatal(err: Error): void {
    const wrapped =
      err instanceof SmtpError
        ? err
        : new SmtpError(describeSafely(err), "transient");
    this.fatal ??= wrapped;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const { reject } = this.pending;
      this.pending = null;
      reject(wrapped);
    }
  }

  /**
   * Assemble replies from the stream.
   *
   * A reply is one or more lines of `NNN<sep>text`; the separator is `-` on
   * every line but the last, where it is a space (RFC 5321 §4.2). Treating a
   * continuation line as a complete reply is the classic bug here: the client
   * runs ahead of the server, sends MAIL FROM while the server is still
   * listing EHLO capabilities, and the whole session desynchronises into
   * "503 bad sequence" with no obvious cause.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.lines.push(line);
      this.buffer = this.buffer.slice(end + 2);

      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) {
        this.onFatal(new SmtpError("unparseable reply from the relay", "transient"));
        return;
      }
      if (match[2] === "-") continue; // continuation; keep reading

      const code = Number(match[1]); // money-guard-ignore: a three-digit SMTP reply code, not an amount.
      const text = this.lines
        .map((l) => l.slice(4))
        .join(" ")
        .trim();
      this.lines = [];
      const waiter = this.pending;
      if (!waiter) continue; // unsolicited; nothing to hand it to
      clearTimeout(waiter.timer);
      this.pending = null;
      waiter.resolve({ code, text });
    }
  }

  private lines: string[] = [];

  private read(what: string): Promise<Reply> {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new SmtpError(`timed out waiting for a reply to ${what}`, "transient"));
      }, this.cfg.timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  /**
   * Send a command and read its reply.
   *
   * `verb` is what goes in the trace; `line` is what goes on the wire. They are
   * separate parameters so that AUTH's base64 credential and RCPT TO's address
   * are transmitted without ever being recorded.
   */
  async command(verb: string, line: string): Promise<Reply> {
    if (this.fatal) throw this.fatal;
    this.socket.write(`${line}\r\n`);
    const reply = await this.read(verb);
    this.trace.push(`${verb} -> ${reply.code}`);
    return reply;
  }

  /** Read the server's opening banner, which arrives unprompted. */
  async banner(): Promise<Reply> {
    const reply = await this.read("greeting");
    this.trace.push(`greeting -> ${reply.code}`);
    return reply;
  }

  /** Write raw bytes with no reply expected — the DATA payload. */
  write(payload: string): void {
    if (this.fatal) throw this.fatal;
    this.socket.write(payload);
  }

  /**
   * Replace the plaintext socket with a TLS one wrapped around it.
   *
   * `servername` is set from the configured host so certificate validation is
   * against the name the operator typed, not against whatever the relay claims.
   */
  async upgrade(): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    plain.setEncoding("binary");

    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(
        {
          socket: plain,
          servername: this.cfg.host,
          rejectUnauthorized: !this.cfg.allowSelfSigned,
        },
        () => resolve(s),
      );
      s.once("error", reject);
    });

    this.buffer = "";
    this.lines = [];
    this.socket = secure;
    this.attach(secure);
    this.trace.push("STARTTLS -> established");
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // Nothing useful to do; the message's fate is already decided.
    }
  }
}

/** `250-AUTH PLAIN LOGIN` → the set the relay actually offers. */
function capabilities(ehlo: string): Set<string> {
  return new Set(ehlo.toUpperCase().split(/\s+/).filter(Boolean));
}

/**
 * Strip anything that would end a header line early.
 *
 * CR and LF in a Subject or a display name is header injection: the remainder
 * of the value is parsed as new headers, so a title carrying "\r\nBcc:" turns
 * the notification queue into an open relay. NUL is removed for the same class
 * of reason.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

/** RFC 2047 encoded-word, so an Arabic or accented subject survives the hop. */
function encodeHeaderValue(value: string): string {
  const clean = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/**
 * Base64 the body, wrapped at 76 columns.
 *
 * Not an aesthetic choice. Base64's alphabet contains no `.`, so no line of the
 * payload can begin with one, which removes the dot-stuffing rule of RFC 5321
 * §4.5.2 — a body line of exactly "." otherwise terminates DATA early and
 * truncates the message. It also guarantees the 998-octet line limit and makes
 * UTF-8 transport-safe on a relay that never advertised 8BITMIME.
 */
function base64Body(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * An address as it goes into MAIL FROM / RCPT TO, without a display name.
 *
 * `From: Nexus ERP <no-reply@x.ae>` is a header; the ENVELOPE sender is only
 * the bracketed part. Passing the display name to MAIL FROM is a syntax error
 * on a strict relay and a silent misdelivery on a lenient one.
 */
export function envelopeAddress(value: string): string {
  const bracketed = /<([^>]+)>/.exec(value);
  return headerSafe(bracketed ? bracketed[1]! : value);
}

/**
 * A plausible address, checked before a socket is opened.
 *
 * Deliberately shallow — full RFC 5322 validation is famously unwise and
 * rejecting a legitimate address is worse than one wasted connection. This
 * catches the cases that are certainly wrong (no `@`, whitespace, an injected
 * newline) so an obviously bad recipient fails PERMANENTLY and instantly
 * rather than occupying five retries over an hour.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@<>,;]+@[^\s@<>,;.]+\.[^\s@<>,;]+$/.test(value.trim());
}

export function buildMessage(envelope: SmtpEnvelope, messageId: string): string {
  const headers = [
    `From: ${headerSafe(envelope.from)}`,
    `To: ${headerSafe(envelope.to)}`,
    `Subject: ${encodeHeaderValue(envelope.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    // Transactional mail. Tells a well-behaved mail client not to generate an
    // out-of-office or a read receipt back at an unattended no-reply mailbox.
    "Auto-Submitted: auto-generated",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${base64Body(envelope.text)}\r\n`;
}

async function connect(cfg: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) =>
      reject(new SmtpError(describeSafely(err), "transient"));
    const timer = setTimeout(
      () => reject(new SmtpError("timed out connecting to the relay", "transient")),
      cfg.timeoutMs,
    );
    const done = (s: net.Socket | tls.TLSSocket) => {
      clearTimeout(timer);
      s.off("error", onError);
      resolve(s);
    };
    const socket = cfg.secure
      ? tls.connect(
          {
            host: cfg.host,
            port: cfg.port,
            servername: cfg.host,
            rejectUnauthorized: !cfg.allowSelfSigned,
          },
          () => done(socket),
        )
      : net.connect({ host: cfg.host, port: cfg.port }, () => done(socket));
    socket.once("error", onError);
  });
}

/**
 * Hand one message to one relay.
 *
 * Resolves with the relay's queue identifier — the evidence that makes
 * `delivered` an assertion rather than an assumption. Throws `SmtpError` with
 * a `kind` for everything else; the caller turns that into an outcome.
 */
export async function sendMail(
  cfg: SmtpConfig,
  envelope: SmtpEnvelope,
): Promise<{ queueId: string; trace: string[] }> {
  const from = envelopeAddress(envelope.from);
  const to = envelopeAddress(envelope.to);

  if (!looksLikeEmail(to)) {
    throw new SmtpError("recipient address is not a valid mailbox", "permanent");
  }
  if (!looksLikeEmail(from)) {
    throw new SmtpError("the configured sender address is not a valid mailbox", "configuration");
  }

  const socket = await connect(cfg);
  const session = new SmtpSession(socket, cfg);
  let secure = cfg.secure;

  try {
    const greeting = await session.banner();
    if (greeting.code !== 220) {
      throw replyError(greeting, "the relay refused the connection");
    }

    let ehlo = await session.command("EHLO", `EHLO ${headerSafe(cfg.clientName)}`);
    if (ehlo.code !== 250) throw replyError(ehlo, "EHLO was refused");

    if (!secure && capabilities(ehlo.text).has("STARTTLS")) {
      const start = await session.command("STARTTLS", "STARTTLS");
      if (start.code !== 220) throw replyError(start, "STARTTLS was refused");
      await session.upgrade();
      secure = true;
      // RFC 3207 §4.2: everything learned before the upgrade is discarded,
      // including the AUTH mechanisms. A client that reuses the plaintext EHLO
      // is trusting capabilities announced by an unauthenticated peer.
      ehlo = await session.command("EHLO", `EHLO ${headerSafe(cfg.clientName)}`);
      if (ehlo.code !== 250) throw replyError(ehlo, "EHLO after STARTTLS was refused");
    }

    if (cfg.user && cfg.password) {
      if (!secure && !cfg.allowInsecureAuth) {
        throw new SmtpError(
          "the relay offers no STARTTLS and SMTP credentials are configured — " +
            "refusing to authenticate over an unencrypted connection",
          "configuration",
        );
      }
      const mechanisms = capabilities(ehlo.text);
      const auth = mechanisms.has("PLAIN")
        ? await session.command(
            "AUTH PLAIN",
            `AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.password}`, "utf8").toString("base64")}`,
          )
        : await authLogin(session, cfg);
      if (auth.code !== 235) {
        // 535 and friends will reject every message identically. Reporting this
        // per-message as a delivery failure would drain the retry budget of the
        // entire queue over an afternoon and leave no clue as to why.
        throw replyError(auth, "SMTP authentication was rejected", "configuration");
      }
    }

    const mail = await session.command("MAIL FROM", `MAIL FROM:<${from}>`);
    if (mail.code !== 250) throw replyError(mail, "the sender address was refused");

    const rcpt = await session.command("RCPT TO", `RCPT TO:<${to}>`);
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw replyError(rcpt, "the recipient address was refused");
    }

    const data = await session.command("DATA", "DATA");
    if (data.code !== 354) throw replyError(data, "the relay would not accept the message");

    const messageId = `${randomUUID()}@${headerSafe(cfg.clientName)}`;
    // The ENVELOPE addresses (`from`/`to`, bracket-stripped) went to MAIL FROM
    // and RCPT TO; the HEADERS get the caller's originals, display names and
    // all. Interchanging the two is the classic error: a display name in MAIL
    // FROM is a syntax error on a strict relay, and a bare address in the From
    // header shows the recipient a machine identifier instead of a business.
    session.write(buildMessage(envelope, messageId));
    const accepted = await session.command("<message>", ".");
    if (accepted.code !== 250) throw replyError(accepted, "the message was rejected");

    // Best effort. The message is already accepted; a failure to say goodbye
    // politely must not turn a delivered message into a retry.
    await session.command("QUIT", "QUIT").catch(() => undefined);

    return {
      // The queue id if the relay named one, otherwise our own Message-ID.
      // Either way it is a real identifier the far side has seen, which is the
      // bar `delivered` has to clear.
      queueId: extractQueueId(accepted.text) ?? messageId,
      trace: session.trace,
    };
  } finally {
    session.close();
  }
}

async function authLogin(session: SmtpSession, cfg: SmtpConfig): Promise<Reply> {
  const start = await session.command("AUTH LOGIN", "AUTH LOGIN");
  if (start.code !== 334) return start;
  const user = await session.command(
    "AUTH LOGIN <user>",
    Buffer.from(cfg.user!, "utf8").toString("base64"),
  );
  if (user.code !== 334) return user;
  return session.command(
    "AUTH LOGIN <secret>",
    Buffer.from(cfg.password!, "utf8").toString("base64"),
  );
}

/**
 * `250 2.0.0 Ok: queued as 4Wq1234` → `4Wq1234`.
 *
 * Postfix, Exim and most catchers put an identifier at the end of the accepting
 * reply. Nothing depends on the format; a null here just means the Message-ID
 * is used instead.
 */
function extractQueueId(text: string): string | null {
  const m = /queued as ([A-Za-z0-9._-]+)|\bid=?\s*([A-Za-z0-9._-]{6,})/i.exec(text);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function replyError(
  reply: Reply,
  what: string,
  override?: SmtpFailureKind,
): SmtpError {
  const kind: SmtpFailureKind =
    override ?? (reply.code >= 500 ? "permanent" : "transient");
  // The reply TEXT is scrubbed because a 550 quotes the envelope back at you.
  return new SmtpError(`${what} (${reply.code} ${describeSafely(reply.text)})`, kind, reply.code);
}
