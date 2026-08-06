import { randomBytes } from "node:crypto";

/**
 * UUIDv7 — time-ordered, so primary-key inserts append to the right-hand edge
 * of the B-tree instead of scattering across it.
 *
 * With v4 keys, a table of a few million invoices turns every insert into a
 * random page write and the index no longer fits usefully in cache. v7 keeps
 * insert throughput flat as the table grows, and gives "order by id" a free
 * chronological sort. Postgres 18 has `uuidv7()` natively; generating it here
 * keeps us on 16+ and lets the application know the id before the round trip.
 */
export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const bytes = randomBytes(16);

  // 48-bit big-endian millisecond timestamp
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
