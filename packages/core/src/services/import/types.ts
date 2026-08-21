import type * as M from "../../money/index.ts";
import type { ServiceContext } from "../context.ts";

/**
 * THE SHAPES THE IMPORT WIZARD SPEAKS IN.
 *
 * Two vocabularies live here and the distinction is the whole design:
 *
 *   PLAN   — what the server computed. Money is `Money`, ids are real, and it
 *            is only ever held inside one transaction.
 *   DIFF   — what the user is shown and asked to approve. Money is a STRING at
 *            display precision, there are no database ids, and it crosses the
 *            server-action boundary.
 *
 * The diff is deliberately not the plan. A plan serialised to the browser and
 * posted back would make the client's copy authoritative — the classic
 * migration bug where the file is swapped between "review" and "import" and the
 * numbers the accountant signed off are not the numbers that landed. The commit
 * path re-reads the file and re-plans from scratch; the diff comes back only as
 * an APPROVAL — a fingerprint plus four counts that must still match.
 */

export const IMPORT_KINDS = [
  "opening_balances",
  "parties",
  "units",
  "leases",
  "debts",
  "cheques",
  "stock",
  "employees",
] as const;

export type ImportKind = (typeof IMPORT_KINDS)[number];

/**
 * One thing wrong with one row.
 *
 * `rowNumber` is the line number IN THE FILE, header included, so it is the
 * number the accountant's spreadsheet shows them in the row gutter. Reporting
 * an index into the parsed array instead — off by one, and off by more once
 * blank lines are skipped — sends them to the wrong row, which is worse than
 * saying nothing.
 */
export interface RowIssue {
  rowNumber: number;
  column?: string;
  message: string;
}

export type RowAction = "create" | "update" | "skip";

/** One row of the reviewed diff, as the review screen renders it. */
export interface DiffRow {
  rowNumber: number;
  action: RowAction;
  /** Human identity of the record: "Flat 402 · Marina Tower". */
  label: string;
  /** What would change, or why it is being skipped. */
  detail?: string;
  /** Display precision. Absent where the row carries no money. */
  amount?: string;
}

export interface DiffTotal {
  label: string;
  amount: string;
  /** Rendered as a problem rather than a fact — an out-of-balance total. */
  isProblem?: boolean;
}

export interface DiffCounts {
  create: number;
  update: number;
  skip: number;
  reject: number;
}

/**
 * The dry run's answer.
 *
 * `dryRun` is a literal `true`, not a boolean, because the review screen states
 * "Nothing has been saved yet" and that sentence must be impossible to render
 * over a result that did save something. A type that cannot be false is a
 * cheaper guarantee than a comment asking people to remember.
 */
export interface ImportDiff {
  dryRun: true;
  kind: ImportKind;
  label: string;
  filename: string;
  fingerprint: string;
  rowCount: number;
  counts: DiffCounts;
  rows: DiffRow[];
  rejected: RowIssue[];
  /**
   * Reasons the whole batch cannot commit, as opposed to rows that would be
   * skipped. A trial balance that does not balance is a blocker; a lease whose
   * unit is missing is a rejected row.
   */
  blockers: string[];
  totals: DiffTotal[];
  /** Assumptions the parser made, stated where the user will read them. */
  notes: string[];
}

/** A per-account figure the uploaded trial balance asserted. */
export interface ExpectedLine {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}

export interface PlannedRow<P = unknown> {
  rowNumber: number;
  action: RowAction;
  label: string;
  detail?: string;
  amount?: M.Money;
  payload: P;
}

export interface ImportPlan {
  rows: PlannedRow[];
  rejected: RowIssue[];
  blockers: string[];
  totals: { label: string; amount: M.Money; isProblem?: boolean }[];
  notes: string[];
  /** Only the opening-balance importer fills these; everything else ties to a
   *  control total rather than to a chart of accounts. */
  expectedLines: ExpectedLine[];
  totalDebit: M.Money;
  totalCredit: M.Money;
}

/**
 * The handful of settings the wizard collects on the chooser step, before a
 * file is even read.
 *
 * They live here rather than as magic columns in the file because they describe
 * the BATCH, not a row: an as-at date repeated on 68 trial-balance lines is 68
 * chances for one of them to disagree with the rest, and the importer would
 * then have to decide which one the accountant meant.
 */
export interface ImportOptions {
  /** Opening balances: the date the balances are as at. */
  asOf?: string;
  /** Stock: which warehouse the count belongs to, by code. */
  warehouse?: string;
}

/** Context an importer runs in: a service context plus the target business. */
export interface ImportContext extends ServiceContext {
  /** Null for kinds that are tenant-wide (opening balances across the group). */
  businessUnitId: string | null;
  options: ImportOptions;
}

/**
 * Where the reversal records what it undid.
 *
 * Handed to `apply` so an importer records every row it writes at the moment it
 * writes it. Collecting them afterwards by re-querying would match rows the
 * import did not create — the owner adding a customer by hand between the
 * import and the reversal is enough to lose their record.
 */
export interface BatchRecorder {
  batchId: string;
  record(entry: {
    rowNumber: number;
    action: "create" | "update";
    entityTable: string;
    entityId: string;
    previous?: Record<string, unknown>;
  }): Promise<void>;
}

export interface ApplyOutcome {
  /** Set by importers that post to the ledger. */
  journalId?: string;
}

export interface SourceRow {
  /** 1-based line in the file, header included. */
  rowNumber: number;
  get(column: string): string;
  has(column: string): boolean;
}

export interface Importer {
  kind: ImportKind;
  label: string;
  /** One-line statement of what this file is, shown on the chooser step. */
  description: string;
  /** Column headers the template offers. Order is the template's order. */
  template: string[];
  /** Columns without which the file cannot be read at all. */
  required: string[];
  /** Permission to preview or commit. */
  permission: string;
  /** Additional permission to reverse. Ledger-backed kinds need it. */
  reversePermission?: string;
  /** Whether the batch must name a business unit. */
  requiresBusinessUnit: boolean;
  plan(ctx: ImportContext, rows: SourceRow[]): Promise<ImportPlan>;
  apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome>;
}
