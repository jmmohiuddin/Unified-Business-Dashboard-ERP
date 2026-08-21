import { createHash } from "node:crypto";
import * as M from "../../money/index.ts";
import { ServiceError } from "../context.ts";
import type { RowIssue, SourceRow } from "./types.ts";

/**
 * READING WHAT THE ACCOUNTANT ACTUALLY SENDS.
 *
 * Not "a CSV". A file exported from Excel on a Windows machine in Dubai, or
 * pasted out of a Google Sheet, or saved by an accounting package nobody has
 * the manual for. Every assumption this module makes about that file is
 * surfaced on the review screen as a NOTE, because a parser that guesses
 * silently is how an import lands 4,182,440.00 as 4,182.44 and nobody notices
 * until the VAT return is wrong.
 *
 * What it handles rather than rejects:
 *
 *   BOM              Excel writes UTF-8 with a byte-order mark. Left in place,
 *                    the first header becomes an unmatchable string and every
 *                    lookup on the most important column misses — the file
 *                    appears to be missing the column it visibly has.
 *   CRLF and CR      Windows and classic Mac line endings.
 *   Tabs             A spreadsheet paste is tab-separated. Sniffed, not assumed.
 *   Quoted fields    Including embedded delimiters, newlines and doubled quotes.
 *   Blank lines      Skipped, but row numbers keep counting, so an error still
 *                    names the line the spreadsheet shows in its gutter.
 *
 * What it refuses rather than guesses: an ambiguous thousands separator, an
 * unreadable number, an impossible date. Refusing produces a row error the
 * accountant fixes in thirty seconds. Guessing produces a wrong balance sheet
 * that nobody can find the cause of six weeks later.
 */

/** Delimiters sniffed, in preference order when tied. */
const DELIMITERS = [",", "	", ";"] as const;

const BOM = "﻿";

/**
 * Split a delimited file into raw cells.
 *
 * A hand-rolled state machine rather than a dependency: the grammar is small,
 * the core package deliberately carries no runtime dependency beyond decimal.js
 * and drizzle, and a CSV library is supply-chain surface for a parser that fits
 * on one screen.
 */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      // Consume CRLF as one terminator, never as a row plus an empty row.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * Column headers, normalised to a canonical key.
 *
 * "Account Code", "account code", "ACCOUNT_CODE" and "Account  Code " are the
 * same column. Matching the literal string means an import fails on
 * capitalisation, and the user's only clue is "missing column account_code"
 * beside a file that visibly has one.
 */
export function normaliseHeader(header: string): string {
  return header
    .split(BOM)
    .join("")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sniffDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = -1;
  for (const d of DELIMITERS) {
    // Counted outside quotes only: a legal name of "Al Futtaim, Trading LLC" in
    // a tab-separated file must not make commas look like the delimiter.
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i]!;
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export interface ParsedSource {
  /** Canonical header keys, in file order. */
  columns: string[];
  rows: SourceRow[];
  /** Line numbers dropped because the line was entirely blank. */
  blankRows: number[];
  notes: string[];
  /** Stable digest of the file's meaningful content. See `fingerprint`. */
  fingerprint: string;
}

/**
 * The idempotency fingerprint.
 *
 * Taken over the NORMALISED content — canonical headers, trimmed cells, blank
 * lines dropped — not over the raw bytes. Re-saving the same spreadsheet
 * changes its line endings and usually its trailing blank line, so a byte
 * digest would call an identical file different and cheerfully import it a
 * second time. That is precisely the failure the fingerprint exists to stop.
 *
 * It is not a security control and does not need to resist an adversary: the
 * person uploading is already authorised to import. SHA-256 because it is free
 * and unambiguous. Fields are length-prefixed so no cell value can forge a
 * boundary and make two different files digest the same.
 */
function fingerprint(columns: string[], cells: string[][]): string {
  const h = createHash("sha256");
  const feed = (values: string[]) => {
    for (const v of values) h.update(`${v.length}:${v}`);
    h.update("|");
  };
  feed(columns);
  for (const row of cells) feed(row);
  return h.digest("hex");
}

/**
 * Rows accepted in one batch.
 *
 * A ceiling, not a performance limit: the batch is the unit of reversal, and a
 * 50,000-row import that turns out to be wrong is not something anyone will
 * choose to reverse in one act. Splitting it is the honest advice.
 */
export const MAX_ROWS = 5000;

export function readSource(text: string): ParsedSource {
  const clean = text.split(BOM).join("");
  if (clean.trim() === "") {
    throw new ServiceError("That file is empty.", "invalid");
  }

  const firstLine = clean.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const delimiter = sniffDelimiter(firstLine);
  const raw = splitRows(clean, delimiter);

  // A trailing newline TERMINATES the last record; it does not begin an empty
  // one. Counting it as a blank row makes the review screen tell an accountant
  // their file has a blank line in it, which sends them looking for something
  // that is not there — every well-formed CSV ends this way.
  const last = raw[raw.length - 1];
  if (raw.length > 1 && last && last.length === 1 && last[0] === "") raw.pop();

  const columns = (raw[0] ?? []).map(normaliseHeader);
  if (columns.filter(Boolean).length === 0) {
    throw new ServiceError("The first line of that file has no column names.", "invalid");
  }

  const duplicate = columns.find((c, i) => c !== "" && columns.indexOf(c) !== i);
  if (duplicate) {
    throw new ServiceError(
      `Two columns are both called "${duplicate}". Rename one and upload again.`,
      "invalid",
    );
  }

  const rows: SourceRow[] = [];
  const cells: string[][] = [];
  const blankRows: number[] = [];

  for (let i = 1; i < raw.length; i++) {
    const values = raw[i]!.map((v) => v.trim());
    // File line number, header included, so it matches the spreadsheet gutter.
    const rowNumber = i + 1;
    if (values.every((v) => v === "")) {
      blankRows.push(rowNumber);
      continue;
    }
    const byColumn = new Map<string, string>();
    columns.forEach((c, idx) => {
      if (c !== "") byColumn.set(c, values[idx] ?? "");
    });
    cells.push(columns.map((c) => byColumn.get(c) ?? ""));
    rows.push({
      rowNumber,
      get: (column: string) => byColumn.get(column) ?? "",
      has: (column: string) => (byColumn.get(column) ?? "") !== "",
    });
  }

  if (rows.length === 0) {
    throw new ServiceError("That file has column names but no rows.", "invalid");
  }
  if (rows.length > MAX_ROWS) {
    throw new ServiceError(
      `That file has ${rows.length} rows. Import at most ${MAX_ROWS} at a time, so a ` +
        `batch that turns out to be wrong is something you would actually reverse.`,
      "invalid",
    );
  }

  const notes: string[] = [];
  if (delimiter === "	") notes.push("Read as tab-separated.");
  if (delimiter === ";") notes.push("Read as semicolon-separated.");
  if (blankRows.length > 0) {
    notes.push(
      `${blankRows.length} blank line(s) skipped. Row numbers below still match your file.`,
    );
  }

  return { columns, rows, blankRows, notes, fingerprint: fingerprint(columns, cells) };
}

/** Every missing column at once, rather than one per upload attempt. */
export function missingColumns(source: ParsedSource, required: string[]): string[] {
  return required.filter((c) => !source.columns.includes(c));
}

// ── Cell readers ────────────────────────────────────────────────────────────
//
// Each returns a value or throws `CellError`, which the importers collect into
// row issues. Throwing rather than returning null is deliberate: a null that
// quietly becomes zero is how an opening balance loses a line and still
// balances.

export class CellError extends Error {
  constructor(
    readonly column: string,
    message: string,
  ) {
    super(message);
    this.name = "CellError";
  }
}

/**
 * Arabic-Indic and Extended Arabic-Indic digits to ASCII.
 *
 * A Dubai file can legitimately contain them. Left alone they are not digits to
 * any parser, and the row is rejected as "not a number" over a number that is
 * plainly there on the accountant's screen.
 */
function asciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.codePointAt(0)!;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String.fromCharCode(48 + (code - base));
  });
}

/**
 * Separate the thousands separator from the decimal separator, or refuse.
 *
 * The three cases, and why the third is a refusal:
 *
 *   BOTH present   The LAST one is the decimal separator and the other is
 *                  grouping. `1,234.50` and `1.234,50` are both unambiguous
 *                  and both mean 1234.5. Nothing is guessed.
 *   ONLY "."       One point is a decimal point. Several are grouping
 *                  (`1.234.567`), because no number has two decimal points.
 *   ONLY ","       `1,234` is a thousands separator in the UAE and a decimal
 *                  comma in Europe, and the file does not say which. Three
 *                  trailing digits is grouping by overwhelming convention;
 *                  one or two trailing digits is REFUSED, because reading
 *                  `1,25` as 125 instead of 1.25 is a hundredfold error in a
 *                  balance sheet and no default is safe.
 */
function toPlainNumber(text: string, column: string, original: string): string {
  const hasDot = text.includes(".");
  const hasComma = text.includes(",");

  if (hasDot && hasComma) {
    const decimal = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    return text.split(grouping).join("").split(decimal).join(".");
  }

  if (hasComma) {
    const parts = text.split(",");
    const tail = parts[parts.length - 1]!;
    if (parts.length === 2 && tail.length !== 3) {
      throw new CellError(
        column,
        `"${original}" is ambiguous — is that comma a decimal point or a thousands ` +
          `separator? Write it as 1234.50.`,
      );
    }
    if (parts.slice(1).some((p) => p.length !== 3)) {
      throw new CellError(column, `"${original}" is not an amount this can read exactly.`);
    }
    return parts.join("");
  }

  if (hasDot) {
    const parts = text.split(".");
    if (parts.length > 2) {
      if (parts.slice(1).some((p) => p.length !== 3)) {
        throw new CellError(column, `"${original}" is not an amount this can read exactly.`);
      }
      return parts.join("");
    }
  }

  return text;
}

/**
 * Read a money cell EXACTLY.
 *
 * The single most dangerous function in the importer: it is where a
 * user-supplied string becomes an amount, and it is precisely where
 * `Number(cell)` would normally appear. It does not. The cleaned string is
 * validated against a strict grammar and handed to Decimal, so a value either
 * parses to the digits the accountant typed or is rejected with its row number.
 *
 * Accepted: a currency word or symbol in the cell, thousands separators, a
 * leading sign, and accounting parentheses — `(1,250.00)` is how every
 * accounting package on earth writes minus 1,250, and reading it as a positive
 * would flip a creditor into a debtor.
 */
export function readMoney(row: SourceRow, column: string, fallback?: M.Money): M.Money {
  const original = row.get(column);
  if (original === "") {
    if (fallback !== undefined) return fallback;
    throw new CellError(column, `"${column}" is empty.`);
  }

  let text = asciiDigits(original).replace(/\s+/g, "");
  let negative = false;

  const bracketed = /^\((.*)\)$/.exec(text);
  if (bracketed) {
    negative = true;
    text = bracketed[1]!;
  }

  // Currency labels people type into the cell rather than into the header.
  text = text.replace(/^(aed|dhs|dh)/i, "").replace(/(aed|dhs|dh)$/i, "");

  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  text = toPlainNumber(text, column, original);

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new CellError(column, `"${original}" is not an amount this can read exactly.`);
  }

  const value = M.money(text);
  return negative ? M.neg(value) : value;
}

/** Quantities share the grammar; separate so the message says "quantity". */
export function readQuantity(row: SourceRow, column: string, fallback?: M.Money): M.Money {
  try {
    return readMoney(row, column, fallback);
  } catch (err) {
    if (err instanceof CellError) {
      throw new CellError(err.column, err.message.replace("an amount", "a quantity"));
    }
    throw err;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Read a date cell as an ISO date.
 *
 * Slash and dash forms are read DAY FIRST — the UAE and UK convention, and what
 * every tenancy contract and post-dated cheque in this portfolio uses. The
 * assumption is surfaced as a note on the review screen rather than buried
 * here, because 03/04/2026 is a real date under both readings and no parser can
 * distinguish them. Telling the user which reading was applied, before they
 * approve, is the only honest control available.
 */
export function readDate(row: SourceRow, column: string, fallback?: string | null): string {
  const raw = asciiDigits(row.get(column)).trim();
  if (raw === "") {
    if (fallback !== undefined) return fallback as string;
    throw new CellError(column, `"${column}" is empty.`);
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  const named = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{4})$/.exec(raw);

  let y: string;
  let m: string;
  let d: string;
  if (iso) {
    y = iso[1]!;
    m = iso[2]!;
    d = iso[3]!;
  } else if (slash) {
    d = slash[1]!;
    m = slash[2]!;
    y = slash[3]!;
  } else if (named) {
    const index = MONTHS.indexOf(named[2]!.slice(0, 3).toLowerCase());
    if (index < 0) throw new CellError(column, `"${raw}" is not a date this can read.`);
    d = named[1]!;
    m = String(index + 1);
    y = named[3]!;
  } else {
    throw new CellError(column, `"${raw}" is not a date. Use 2026-01-31 or 31/01/2026.`);
  }

  const value = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  // Round-tripped through Date to reject 31/02/2026, which every naive
  // validator accepts and Postgres then rejects at INSERT — halfway through
  // the batch, which is the one outcome this whole feature exists to prevent.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CellError(column, `"${raw}" is not a real date.`);
  }
  return value;
}

export function readText(
  row: SourceRow,
  column: string,
  opts: { max: number; required?: boolean; fallback?: string },
): string {
  const raw = row.get(column).trim();
  if (raw === "") {
    if (opts.required) throw new CellError(column, `"${column}" is required.`);
    return opts.fallback ?? "";
  }
  if (raw.length > opts.max) {
    throw new CellError(column, `"${column}" is longer than ${opts.max} characters.`);
  }
  return raw;
}

export function readEnum<T extends string>(
  row: SourceRow,
  column: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const raw = row.get(column).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (raw === "") {
    if (fallback !== undefined) return fallback;
    throw new CellError(column, `"${column}" is required.`);
  }
  const match = allowed.find((a) => a === raw);
  if (!match) {
    throw new CellError(column, `"${row.get(column)}" is not one of: ${allowed.join(", ")}.`);
  }
  return match;
}

export function readInteger(
  row: SourceRow,
  column: string,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number {
  const raw = asciiDigits(row.get(column)).trim().split(",").join("");
  if (raw === "") {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new CellError(column, `"${column}" is required.`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new CellError(column, `"${row.get(column)}" is not a whole number.`);
  }
  // money-guard-ignore: a count, a day-of-month or a bedroom tally — never an amount. Money is read by readMoney above.
  const value = parseInt(raw, 10);
  if (opts.min !== undefined && value < opts.min) {
    throw new CellError(column, `"${column}" must be at least ${opts.min}.`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new CellError(column, `"${column}" must be at most ${opts.max}.`);
  }
  return value;
}

/** Turn a thrown CellError into the row-level issue the diff renders. */
export function toIssue(rowNumber: number, err: unknown): RowIssue {
  if (err instanceof CellError) return { rowNumber, column: err.column, message: err.message };
  if (err instanceof ServiceError) return { rowNumber, message: err.message };
  if (err instanceof Error) return { rowNumber, message: err.message };
  return { rowNumber, message: "Could not read this row." };
}

/** Rows sort by row number so the error report reads like the file. */
export function byRowNumber(a: RowIssue, b: RowIssue): number {
  return a.rowNumber - b.rowNumber || (a.column ?? "").localeCompare(b.column ?? "");
}
