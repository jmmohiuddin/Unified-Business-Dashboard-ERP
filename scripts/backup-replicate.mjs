#!/usr/bin/env node
/**
 * OFFSITE REPLICATION and RETENTION for the encrypted backups written by
 * `scripts/backup.mjs`.
 *
 *   node scripts/backup-replicate.mjs --plan       # what retention would keep/prune
 *   node scripts/backup-replicate.mjs --list       # what is actually offsite
 *   node scripts/backup-replicate.mjs --prune      # apply the retention policy
 *   node scripts/backup-replicate.mjs --replicate <file>   # push one artefact
 *
 * `backup.mjs` imports this module; the CLI above exists so an operator can run
 * a prune or an inventory without taking a fresh dump.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Until now `backup.mjs` wrote an encrypted dump to local disk and stopped. A
 * copy that lives on the machine it protects shares that machine's failure
 * domain: the disk that loses the database loses the backup with it, and a
 * ransomware run encrypts both in the same pass. UAE real-estate records carry
 * a FIFTEEN YEAR retention obligation (see RETENTION_FLOOR_YEARS), which local
 * disk cannot honour across a decade and a half of hardware.
 *
 * ── ENCRYPTION HAPPENS BEFORE UPLOAD. Always. ───────────────────────────────
 *
 * This is the single easiest thing to get subtly wrong, so it is stated here
 * and enforced in code rather than left to the caller's good intentions:
 *
 *   1. `pg_dump` writes a PLAINTEXT `.dump`
 *   2. `encryptFile()` produces `.dump.enc` (AES-256-GCM, per-backup salt)
 *   3. the plaintext `.dump` is `unlink`ed
 *   4. and ONLY THEN does anything here touch the network
 *
 * The storage provider therefore holds ciphertext it cannot read, and
 * `BACKUP_ENCRYPTION_KEY` — which never leaves the machine — is the only thing
 * that turns it back into customer data. If that ordering is ever inverted, a
 * bucket misconfiguration stops being an availability problem and becomes a
 * disclosure of every party, salary and Emirates ID in the business.
 *
 * `assertEncryptedArtefact()` below refuses to upload anything whose first six
 * bytes are not the `NEXBK1`/`NEXBK2` magic. That is a cheap guard against a
 * future refactor that reorders steps 2 and 4 — the kind of change that reviews
 * cleanly and is catastrophic.
 *
 * ── Why raw REST + SigV4 rather than an SDK ─────────────────────────────────
 *
 * `@aws-sdk/client-s3` pulls ~80 transitive packages into a script whose whole
 * job is PUT, HEAD, GET, LIST and DELETE. This file uses five S3 REST calls and
 * ~120 lines of SigV4, has no dependency beyond Node's standard library, and
 * works unchanged against AWS S3, Cloudflare R2, Backblaze B2, MinIO and Wasabi
 * because it speaks the protocol rather than one vendor's client. For a script
 * that handles the most sensitive file the business owns, a small auditable
 * surface is worth more than the convenience — every dependency here is a
 * dependency with read access to the backups.
 *
 * The cost of that choice, stated honestly: no multipart upload. A single PUT
 * caps at 5 GiB, so `replicate()` REFUSES a larger artefact loudly instead of
 * truncating it. See MAX_SINGLE_PUT_BYTES.
 *
 * ── Failing loudly ──────────────────────────────────────────────────────────
 *
 * Every failure path here throws. `backup.mjs` exits non-zero when replication
 * is configured and does not complete. Reporting a green backup whose copy
 * never left the machine is the same defect as the outbox marking undelivered
 * messages `success` — that has happened twice in this codebase and must not
 * happen again in the one place where the consequence is permanent data loss.
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The retention floor, in years.
 *
 * UAE real-estate and tenancy records must be retained for fifteen years. This
 * is a legal obligation, not a tuning knob: the environment can RAISE the floor
 * (`BACKUP_RETENTION_FLOOR_YEARS=20`) but any attempt to lower it is refused in
 * `loadRetentionPolicy()`. A configuration mistake must not be able to delete
 * evidence the business is required to be able to produce.
 *
 * It is a *minimum*, so backups older than the floor become eligible for
 * deletion rather than being kept forever — PDPL data minimisation argues for
 * eventually letting go of personal data the law no longer requires.
 */
export const RETENTION_FLOOR_YEARS = 15;

/** S3's hard limit for a single PUT. Above this, multipart is mandatory. */
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/** Attempts for network-level and 5xx failures. Uploading an immutable,
 *  content-addressed object is idempotent, so retrying is safe. 4xx is a
 *  configuration or permission error and is never retried — retrying it just
 *  delays the operator learning what is wrong. */
const RETRIES = 3;

/** `scripts/` is outside `check-money.mjs`'s GUARDED roots, so the `Number(`
 *  calls below are not covered by the float-on-money guard. Every one of them
 *  parses a byte count, a day count or a year — no monetary value is read,
 *  computed or written anywhere in this file. */

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Replication is DISABLED unless `BACKUP_S3_BUCKET` is set.
 *
 * That default is deliberate: a developer running `npm run backup` on a laptop
 * must not push a dump of their seed data anywhere, and CI must not need
 * credentials to run the restore drill.
 *
 * But "disabled by default" must not shade into "silently disabled because a
 * variable was misspelled". Once the bucket is set, every other required
 * variable is mandatory and a missing one is a hard error, not a default.
 *
 * ── REGION AND ENDPOINT HAVE NO DEFAULT, AND THAT IS THE POINT ──────────────
 *
 * Open question Q-8 is unresolved: whether hosting outside the UAE satisfies
 * PDPL cross-border transfer rules for records under a fifteen-year in-UAE
 * retention obligation. That question applies to where the BACKUPS live at
 * least as much as to the primary database — a backup is a complete copy of
 * every record, sitting still, for fifteen years.
 *
 * This code cannot answer that question and will not pretend to by shipping a
 * plausible-looking default. `ap-southeast-1` is not a neutral fallback; it is
 * a legal decision about where UAE personal data comes to rest, and it must be
 * made by someone who can be accountable for it. So both variables are
 * required, with no default, and the operator has to type the region out.
 */
export function loadReplicationConfig(env = process.env) {
  const bucket = (env.BACKUP_S3_BUCKET ?? "").trim();
  if (!bucket) return null;

  const missing = [];
  const req = (name) => {
    const value = (env[name] ?? "").trim();
    if (!value) missing.push(name);
    return value;
  };

  const region = req("BACKUP_S3_REGION");
  const endpoint = req("BACKUP_S3_ENDPOINT");
  const accessKeyId = req("BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = req("BACKUP_S3_SECRET_ACCESS_KEY");

  if (missing.length) {
    throw new Error(
      `BACKUP_S3_BUCKET is set, so replication is ON, but ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} missing.\n\n` +
        "  Replication is all-or-nothing on purpose: a half-configured target is\n" +
        "  a backup that reports success and goes nowhere. Set every variable, or\n" +
        "  unset BACKUP_S3_BUCKET to turn replication off deliberately.\n\n" +
        "  BACKUP_S3_REGION and BACKUP_S3_ENDPOINT have no default because\n" +
        "  choosing where UAE personal data rests for fifteen years is a legal\n" +
        "  decision (open question Q-8), not a code default.",
    );
  }

  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error(`BACKUP_S3_ENDPOINT is not a URL: ${endpoint}`);
  }
  if (endpointUrl.protocol !== "https:" && !isLoopback(endpointUrl.hostname)) {
    // Ciphertext over plaintext HTTP still leaks the object names, sizes and
    // cadence of every backup — and the Authorization header. Loopback is
    // exempt so a local MinIO can be used for drills.
    throw new Error(
      `BACKUP_S3_ENDPOINT must be https:// (got ${endpointUrl.protocol}//). ` +
        "Only loopback endpoints may use http, and only for local drills.",
    );
  }

  const verify = (env.BACKUP_S3_VERIFY ?? "download").trim().toLowerCase();
  if (!["download", "head"].includes(verify)) {
    throw new Error(`BACKUP_S3_VERIFY must be "download" or "head" (got ${verify}).`);
  }

  return {
    bucket,
    region,
    endpoint: endpointUrl,
    accessKeyId,
    secretAccessKey,
    sessionToken: (env.BACKUP_S3_SESSION_TOKEN ?? "").trim() || null,
    prefix: normalisePrefix(env.BACKUP_S3_PREFIX ?? ""),
    // Path style (`host/bucket/key`) is what MinIO and most self-hosted
    // gateways speak; virtual-hosted (`bucket.host/key`) is the AWS default.
    // No clever host sniffing — the operator says which.
    pathStyle: truthy(env.BACKUP_S3_FORCE_PATH_STYLE),
    storageClass: (env.BACKUP_S3_STORAGE_CLASS ?? "").trim() || null,
    verify,
    timeoutMs: Number(env.BACKUP_S3_TIMEOUT_MS ?? 120_000),
  };
}

/**
 * Retention policy.
 *
 * Grandfather-father-son, with the fifteen-year obligation as the floor rather
 * than as one more configurable number:
 *
 *   · every backup for the last `dailyDays` days           (fast recovery)
 *   · one per ISO week for the last `weeklyWeeks` weeks     (recent history)
 *   · one per calendar month for the last `monthlyMonths`   (audit questions)
 *   · one per calendar YEAR for `floorYears` years          (the obligation)
 *   · older than `floorYears` — eligible for deletion
 *
 * The daily/weekly/monthly numbers are operational and may be tuned. The floor
 * is legal and may only be raised.
 */
export function loadRetentionPolicy(env = process.env) {
  const floorYears = intVar(env, "BACKUP_RETENTION_FLOOR_YEARS", RETENTION_FLOOR_YEARS);
  if (floorYears < RETENTION_FLOOR_YEARS) {
    throw new Error(
      `BACKUP_RETENTION_FLOOR_YEARS=${floorYears} is below the ${RETENTION_FLOOR_YEARS}-year ` +
        "UAE real-estate retention obligation.\n\n" +
        "  This value may be raised, never lowered. If the obligation genuinely\n" +
        "  changed, change RETENTION_FLOOR_YEARS in scripts/backup-replicate.mjs\n" +
        "  in a reviewed commit with the citation — not in an environment\n" +
        "  variable on one host.",
    );
  }

  const mode = (env.BACKUP_PRUNE ?? "off").trim().toLowerCase();
  if (!["off", "local", "remote", "both"].includes(mode)) {
    throw new Error(`BACKUP_PRUNE must be off, local, remote or both (got ${mode}).`);
  }

  return {
    floorYears,
    dailyDays: intVar(env, "BACKUP_RETENTION_DAILY_DAYS", 30),
    weeklyWeeks: intVar(env, "BACKUP_RETENTION_WEEKLY_WEEKS", 26),
    monthlyMonths: intVar(env, "BACKUP_RETENTION_MONTHLY_MONTHS", 24),
    mode,
    dryRun: truthy(env.BACKUP_PRUNE_DRY_RUN),
  };
}

function intVar(env, name, fallback) {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got ${raw}).`);
  return n;
}

const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
const normalisePrefix = (p) => p.replace(/^\/+/, "").replace(/\/*$/, p.trim() === "" ? "" : "/");

// ── SigV4 ───────────────────────────────────────────────────────────────────

/** RFC 3986. `encodeURIComponent` leaves `!'()*` alone; S3's canonicalisation
 *  does not, and a single unencoded character produces a signature mismatch
 *  whose error message tells you nothing useful. */
const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();

function signRequest({ config, method, canonicalUri, query, headers, payloadSha256, now }) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const signedHeaders = { ...headers, "x-amz-content-sha256": payloadSha256, "x-amz-date": amzDate };
  if (config.sessionToken) signedHeaders["x-amz-security-token"] = config.sessionToken;

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const names = Object.keys(signedHeaders)
    .map((n) => n.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(Object.entries(signedHeaders).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const canonicalHeaders = names.map((n) => `${n}:${lowered[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaderList = names.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadSha256,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...signedHeaders,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  };
}

// ── S3 transport ────────────────────────────────────────────────────────────

function addressing(config, key) {
  const host = config.endpoint.host; // includes :port
  if (config.pathStyle) {
    const path = `/${config.bucket}${key ? `/${key}` : ""}`;
    return { host, canonicalUri: `/${uriEncode(config.bucket)}${key ? `/${key.split("/").map(uriEncode).join("/")}` : ""}`, path };
  }
  return {
    host: `${config.bucket}.${host}`,
    canonicalUri: key ? `/${key.split("/").map(uriEncode).join("/")}` : "/",
    path: `/${key ?? ""}`,
  };
}

/**
 * One signed S3 request.
 *
 * `body` may be a Buffer or a file path (streamed). Streaming matters: a dump
 * is read twice — once to hash it, once to send it — and neither pass may load
 * a multi-gigabyte artefact into memory.
 *
 * `onBody` receives the response stream when the caller wants to consume it
 * without buffering (the download verification hashes it as it arrives).
 */
function s3Request(config, { method, key = "", query = {}, headers = {}, body = null, bodySha256, bodyLength, onBody }) {
  const { host, canonicalUri, path } = addressing(config, key);
  const payloadSha256 = bodySha256 ?? (body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256);

  const base = { ...headers, host };
  if (body !== null) base["content-length"] = String(bodyLength ?? body.length);

  const signed = signRequest({
    config,
    method,
    canonicalUri,
    query,
    headers: base,
    payloadSha256,
    now: new Date(),
  });

  const search = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const transport = config.endpoint.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolvePromise, rejectPromise) => {
    const req = transport(
      {
        protocol: config.endpoint.protocol,
        hostname: config.endpoint.hostname,
        port: config.endpoint.port || (config.endpoint.protocol === "https:" ? 443 : 80),
        method,
        path: `${config.endpoint.pathname.replace(/\/$/, "")}${path}${search ? `?${search}` : ""}`,
        headers: { ...base, ...signed },
        timeout: config.timeoutMs,
      },
      async (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          const chunks = [];
          for await (const c of res) chunks.push(c);
          rejectPromise(
            httpError(status, method, key, redact(config, Buffer.concat(chunks).toString("utf8").slice(0, 800))),
          );
          return;
        }
        if (onBody) {
          try {
            resolvePromise({ status, headers: res.headers, value: await onBody(res) });
          } catch (e) {
            rejectPromise(e);
          }
          return;
        }
        const chunks = [];
        for await (const c of res) chunks.push(c);
        resolvePromise({ status, headers: res.headers, body: Buffer.concat(chunks) });
      },
    );

    req.on("timeout", () => req.destroy(new Error(`S3 ${method} ${key || "/"} timed out after ${config.timeoutMs}ms`)));
    req.on("error", rejectPromise);

    if (body === null) {
      req.end();
    } else if (typeof body === "string") {
      createReadStream(body).on("error", rejectPromise).pipe(req);
    } else {
      req.end(body);
    }
  });
}

function httpError(status, method, key, detail) {
  const err = new Error(`S3 ${method} ${key || "/"} failed: HTTP ${status}${detail ? `\n${detail}` : ""}`);
  err.status = status;
  return err;
}

/** Nothing printed by this script may contain the secret. S3 error documents
 *  echo request details back, and a mistake there would put the credential in
 *  a CI log that outlives the incident. */
function redact(config, text) {
  let out = text;
  for (const secret of [config.secretAccessKey, config.sessionToken].filter(Boolean)) {
    out = out.split(secret).join("«redacted»");
  }
  return out;
}

async function withRetry(label, fn) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      // A 4xx is the operator's problem: wrong key, wrong bucket, no
      // permission. Retrying hides it behind a delay.
      if (typeof err.status === "number" && err.status < 500) throw err;
      if (attempt === RETRIES) break;
      const wait = 500 * 2 ** (attempt - 1);
      console.log(`  … ${label} attempt ${attempt} failed (${err.message.split("\n")[0]}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

// ── S3 operations ───────────────────────────────────────────────────────────

async function putObject(config, key, filePath, sha256, size) {
  const headers = { "content-type": "application/octet-stream" };
  if (config.storageClass) headers["x-amz-storage-class"] = config.storageClass;
  return withRetry(`PUT ${key}`, () =>
    s3Request(config, { method: "PUT", key, headers, body: filePath, bodySha256: sha256, bodyLength: size }),
  );
}

async function headObject(config, key) {
  return withRetry(`HEAD ${key}`, () => s3Request(config, { method: "HEAD", key }));
}

async function deleteObject(config, key) {
  return withRetry(`DELETE ${key}`, () => s3Request(config, { method: "DELETE", key }));
}

/** Streams the object through a SHA-256 without ever holding it in memory. */
async function hashObject(config, key) {
  const res = await withRetry(`GET ${key}`, () =>
    s3Request(config, {
      method: "GET",
      key,
      onBody: async (stream) => {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += chunk.length;
          hash.update(chunk);
        }
        return { sha256: hash.digest("hex"), bytes };
      },
    }),
  );
  return res.value;
}

/** ListObjectsV2, following continuation tokens.
 *
 *  The response is parsed with a regex rather than an XML library. That is a
 *  deliberate limit, not an oversight: the only keys this ever lists are ones
 *  this script wrote, whose names are `[a-z0-9._-]` by construction. Anything
 *  that does not parse into a backup name is reported and never deleted. */
export async function listRemote(config) {
  const objects = [];
  let token = null;
  do {
    const query = { "list-type": "2", "max-keys": "1000" };
    if (config.prefix) query.prefix = config.prefix;
    if (token) query["continuation-token"] = token;
    const res = await withRetry("LIST", () => s3Request(config, { method: "GET", query }));
    const xml = res.body.toString("utf8");
    for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = decodeEntities(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "");
      const size = Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? "0");
      if (key) objects.push({ key, size, name: basename(key) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? decodeEntities(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "")
      : null;
  } while (token);
  return objects;
}

const decodeEntities = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// ── Replication ─────────────────────────────────────────────────────────────

/**
 * Refuse to upload anything that is not one of our encrypted artefacts.
 *
 * The magic bytes are written by `encryptFile()` in backup.mjs. If a future
 * change ever reorders "encrypt" and "replicate", or points this at the raw
 * `pg_dump` output, this throws instead of publishing every Emirates ID in the
 * business to an object store. A cheap assertion against an expensive mistake.
 */
export function assertEncryptedArtefact(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const head = Buffer.alloc(6);
    readSync(fd, head, 0, 6, 0);
    const magic = head.toString("latin1");
    if (magic !== "NEXBK2" && magic !== "NEXBK1") {
      throw new Error(
        `Refusing to replicate ${basename(filePath)}: it does not start with the Nexus\n` +
          "  encrypted-backup magic, so it is not ciphertext. Backups are encrypted\n" +
          "  BEFORE they leave the machine, without exception.",
      );
    }
  } finally {
    closeSync(fd);
  }
}

function hashFile(filePath) {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("error", rej)
      .on("data", (c) => hash.update(c))
      .on("end", () => res(hash.digest("hex")));
  });
}

/**
 * Upload one encrypted artefact and PROVE it arrived.
 *
 * Verification is not optional and not inferred from the 200. An HTTP 200 says
 * the request was accepted; it does not say the bytes on the far side are the
 * bytes we sent, and a silently truncated fifteen-year archive is discovered at
 * exactly the wrong moment.
 *
 * Two levels, `BACKUP_S3_VERIFY`:
 *   · `download` (default) — read the object back and compare SHA-256 end to
 *     end. Costs one egress of the artefact per backup and is the only check
 *     that actually proves restorability of the remote copy.
 *   · `head` — compare Content-Length, and compare the ETag against the local
 *     MD5 when the provider returns a plain (non-multipart, non-SSE-KMS) ETag.
 *     Cheaper, weaker: it proves an object of the right size exists.
 *
 * The upload itself is integrity-checked independently: `x-amz-content-sha256`
 * carries the real payload hash, which S3 verifies against the received body
 * and rejects on mismatch.
 */
export async function replicate(config, filePath, { log = console.log } = {}) {
  if (!existsSync(filePath)) throw new Error(`Nothing to replicate: ${filePath} does not exist.`);
  assertEncryptedArtefact(filePath);

  const size = statSync(filePath).size;
  if (size > MAX_SINGLE_PUT_BYTES) {
    throw new Error(
      `${basename(filePath)} is ${(size / 1024 ** 3).toFixed(1)} GiB, over the 5 GiB single-PUT limit.\n\n` +
        "  This script deliberately implements no multipart upload (see the file\n" +
        "  header). It refuses rather than uploading a truncated backup. Either\n" +
        "  split the dump per schema, or accept an SDK dependency and implement\n" +
        "  multipart — but do not let this pass silently.",
    );
  }

  const key = `${config.prefix}${basename(filePath)}`;
  const sha256 = await hashFile(filePath);

  log(`· Replicating → ${describeTarget(config)}/${key}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  await putObject(config, key, filePath, sha256, size);

  const head = await headObject(config, key);
  const remoteSize = Number(head.headers["content-length"] ?? -1);
  if (remoteSize !== size) {
    throw new Error(`Replica size mismatch for ${key}: sent ${size} bytes, remote reports ${remoteSize}.`);
  }

  if (config.verify === "download") {
    const back = await hashObject(config, key);
    if (back.sha256 !== sha256) {
      throw new Error(
        `Replica DIGEST MISMATCH for ${key}.\n` +
          `  local  sha256 ${sha256}\n` +
          `  remote sha256 ${back.sha256}\n` +
          "  The remote copy is not the backup. Do not treat it as one.",
      );
    }
    log(`✓ Replica verified by full read-back: ${size} bytes, sha256 ${sha256.slice(0, 16)}…`);
  } else {
    const etag = String(head.headers.etag ?? "").replace(/"/g, "");
    if (/^[0-9a-f]{32}$/.test(etag)) {
      const md5 = createHash("md5").update(await readWhole(filePath)).digest("hex");
      if (md5 !== etag) throw new Error(`Replica ETag mismatch for ${key}: local ${md5}, remote ${etag}.`);
      log(`✓ Replica verified by size + ETag: ${size} bytes (no read-back; BACKUP_S3_VERIFY=head)`);
    } else {
      // Say what was NOT proven. A verification that quietly degraded is worse
      // than no verification, because it is reported as a tick.
      log(`✓ Replica exists at the right size (${size} bytes). ETag "${etag}" is not a plain MD5,`);
      log("  so content was NOT compared. Set BACKUP_S3_VERIFY=download to prove the bytes.");
    }
  }

  return { key, size, sha256 };
}

async function readWhole(filePath) {
  const chunks = [];
  for await (const c of createReadStream(filePath)) chunks.push(c);
  return Buffer.concat(chunks);
}

export const describeTarget = (config) =>
  `${config.endpoint.protocol}//${config.pathStyle ? `${config.endpoint.host}/${config.bucket}` : `${config.bucket}.${config.endpoint.host}`} [${config.region}]`;

// ── Retention ───────────────────────────────────────────────────────────────

/** `nexus-2026-08-21T04-35-17.dump.enc` → the Date it was taken.
 *  The stamp is produced from `toISOString()` in backup.mjs, so it is UTC. */
export function parseBackupStamp(name) {
  const m = /^(.+)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.dump\.enc$/.exec(name);
  if (!m) return null;
  const [, db, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : { db, date };
}

const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const DAY_MS = 86_400_000;

/** ISO-8601 week key, e.g. `2026-W34`. Weeks, not "seven day windows", so the
 *  weekly tier lands on a stable calendar boundary an operator can reason
 *  about when asked "what do you have from March". */
function isoWeekKey(d) {
  const t = new Date(utcDay(d));
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dow + 3); // nearest Thursday
  const year = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((t.getTime() - utcDay(firstThursday)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const yearKey = (d) => String(d.getUTCFullYear());

/**
 * Decide what survives.
 *
 * Pure and time-injectable so the policy can be exercised against a synthetic
 * fifteen-year history without waiting fifteen years. Returns every entry
 * annotated with a reason, because "why did you delete that" is a question this
 * will be asked during an audit, and "the script decided" is not an answer.
 *
 * ── The floor guard ─────────────────────────────────────────────────────────
 *
 * Tiering alone already keeps a yearly backup inside the floor. The guard after
 * it is independent and deliberately redundant: no entry inside the floor
 * window may be pruned if it is the ONLY surviving backup for its calendar
 * year. If a tuning mistake, a clock skew or a future edit to the tiers ever
 * produced a plan that emptied a year, the guard promotes those entries back to
 * `keep` rather than letting the plan proceed. Retention bugs are discovered
 * years later, when the deleted thing is the thing being asked for.
 */
export function planRetention(entries, policy, now = new Date()) {
  const decided = [];

  const parsed = [];
  for (const entry of entries) {
    const stamp = parseBackupStamp(entry.name);
    if (!stamp) {
      // Never delete a file this script does not recognise as its own output.
      decided.push({ ...entry, date: null, keep: true, reason: "unrecognised name — not ours to delete" });
      continue;
    }
    parsed.push({ ...entry, date: stamp.date });
  }

  parsed.sort((a, b) => b.date - a.date); // newest first

  const ageDays = (d) => (utcDay(now) - utcDay(d)) / DAY_MS;
  const floorCutoff = new Date(now.getTime());
  floorCutoff.setUTCFullYear(floorCutoff.getUTCFullYear() - policy.floorYears);

  const seen = { week: new Set(), month: new Set(), year: new Set() };

  parsed.forEach((entry, index) => {
    const age = ageDays(entry.date);

    // The newest backup is never a prune candidate under any policy. If the
    // policy can delete the only current backup, the policy is a delete script.
    if (index === 0) {
      decided.push({ ...entry, keep: true, reason: "most recent backup" });
      return;
    }

    if (entry.date < floorCutoff) {
      decided.push({
        ...entry,
        keep: false,
        reason: `older than the ${policy.floorYears}-year retention floor`,
      });
      return;
    }

    if (age <= policy.dailyDays) {
      decided.push({ ...entry, keep: true, reason: `within the ${policy.dailyDays}-day daily window` });
      return;
    }

    if (age <= policy.weeklyWeeks * 7) {
      const k = isoWeekKey(entry.date);
      if (!seen.week.has(k)) {
        seen.week.add(k);
        decided.push({ ...entry, keep: true, reason: `weekly retain (${k})` });
      } else {
        decided.push({ ...entry, keep: false, reason: `superseded within week ${k}` });
      }
      return;
    }

    if (age <= policy.monthlyMonths * 31) {
      const k = monthKey(entry.date);
      if (!seen.month.has(k)) {
        seen.month.add(k);
        decided.push({ ...entry, keep: true, reason: `monthly retain (${k})` });
      } else {
        decided.push({ ...entry, keep: false, reason: `superseded within month ${k}` });
      }
      return;
    }

    const k = yearKey(entry.date);
    if (!seen.year.has(k)) {
      seen.year.add(k);
      decided.push({ ...entry, keep: true, reason: `yearly retain (${k}), inside the ${policy.floorYears}-year floor` });
    } else {
      decided.push({ ...entry, keep: false, reason: `superseded within year ${k}` });
    }
  });

  // ── Floor guard ──────────────────────────────────────────────────────────
  const keptYears = new Set(decided.filter((d) => d.keep && d.date).map((d) => yearKey(d.date)));
  for (const d of decided) {
    if (d.keep || !d.date || d.date < floorCutoff) continue;
    const y = yearKey(d.date);
    if (!keptYears.has(y)) {
      d.keep = true;
      d.reason = `FLOOR GUARD: only surviving backup for ${y}, inside the ${policy.floorYears}-year obligation`;
      keptYears.add(y);
    }
  }

  decided.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  return {
    keep: decided.filter((d) => d.keep),
    prune: decided.filter((d) => !d.keep),
    all: decided,
  };
}

export function listLocal(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".dump.enc"))
    .map((n) => ({ name: n, path: resolve(dir, n), size: statSync(resolve(dir, n)).size }));
}

/**
 * Apply the plan.
 *
 * Local pruning is intentionally the more conservative of the two. Local disk
 * is where the restore drill runs and where an operator reaches first during an
 * incident, so `BACKUP_PRUNE` must name `local` explicitly — the default `off`
 * deletes nothing anywhere.
 */
export async function prune({ localDir, config, policy, log = console.log, now = new Date() }) {
  const results = { local: null, remote: null };

  if (policy.mode === "local" || policy.mode === "both") {
    const plan = planRetention(listLocal(localDir), policy, now);
    log(`\n· Retention — local (${localDir})`);
    reportPlan(plan, log);
    if (!policy.dryRun) {
      for (const entry of plan.prune) unlinkSync(entry.path);
    }
    results.local = plan;
  }

  if ((policy.mode === "remote" || policy.mode === "both") && config) {
    const objects = await listRemote(config);
    const plan = planRetention(objects, policy, now);
    log(`\n· Retention — offsite (${describeTarget(config)}/${config.prefix})`);
    reportPlan(plan, log);
    if (!policy.dryRun) {
      for (const entry of plan.prune) await deleteObject(config, entry.key);
    }
    results.remote = plan;
  }

  return results;
}

export function reportPlan(plan, log = console.log) {
  const guarded = plan.keep.filter((k) => k.reason.startsWith("FLOOR GUARD"));
  log(`  ${plan.keep.length} kept · ${plan.prune.length} pruned`);
  for (const g of guarded) log(`  ⚠ ${g.name} — ${g.reason}`);
  for (const p of plan.prune) log(`  − ${p.name}  (${p.reason})`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function cli() {
  const { config: dotenv } = await import("dotenv");
  dotenv({ path: ".env", quiet: true });

  const args = process.argv.slice(2);
  const config = loadReplicationConfig();
  const policy = loadRetentionPolicy();
  const localDir = resolve(process.env.BACKUP_DIR ?? "./backups");

  if (args.includes("--list")) {
    if (!config) throw new Error("Replication is not configured (BACKUP_S3_BUCKET is unset).");
    const objects = await listRemote(config);
    console.log(`\n${objects.length} object(s) at ${describeTarget(config)}/${config.prefix}`);
    for (const o of objects) console.log(`  ${o.name}  ${(o.size / 1024 / 1024).toFixed(1)} MB`);
    console.log("");
    return;
  }

  const replicateAt = args.indexOf("--replicate");
  if (replicateAt !== -1) {
    if (!config) throw new Error("Replication is not configured (BACKUP_S3_BUCKET is unset).");
    const file = args[replicateAt + 1];
    if (!file) throw new Error("--replicate needs a path to an encrypted artefact.");
    await replicate(config, resolve(file));
    return;
  }

  if (args.includes("--plan") || args.includes("--prune")) {
    const dryRun = args.includes("--plan") || policy.dryRun;
    // `--plan` never deletes, whatever BACKUP_PRUNE says. `--prune` on the CLI
    // means "run the configured mode now"; it does not turn pruning on for a
    // deployment that chose `off`.
    const mode = args.includes("--plan") && policy.mode === "off" ? (config ? "both" : "local") : policy.mode;
    if (mode === "off") {
      console.log("\nBACKUP_PRUNE=off — retention is not applied. Nothing was deleted.\n");
      return;
    }
    await prune({ localDir, config, policy: { ...policy, mode, dryRun }, now: new Date() });
    console.log(dryRun ? "\n(dry run — nothing was deleted)\n" : "\n✓ Retention applied.\n");
    return;
  }

  console.log(
    "\nUsage: node scripts/backup-replicate.mjs [--plan | --prune | --list | --replicate <file>]\n",
  );
}

/** `pathToFileURL`, not a template literal — `import.meta.url` percent-encodes
 *  the space in "…/sumon vai/ERP Software/…", so a hand-built `file://${path}`
 *  never matches and the CLI silently does nothing and exits 0. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((e) => {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(1);
  });
}
