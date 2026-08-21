import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as M from "../../money/index.ts";
import {
  ServiceError,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "../context.ts";
import { importerFor } from "./registry.ts";
import { MAX_ROWS, missingColumns, readSource } from "./source.ts";
import type {
  ApplyOutcome,
  BatchRecorder,
  DiffCounts,
  ExpectedLine,
  ImportContext,
  ImportDiff,
  ImportOptions,
  ImportPlan,
  Importer,
} from "./types.ts";

/**
 * THE IMPORT WIZARD'S ENGINE: dry run, commit, reconcile, sign off, reverse.
 *
 * FR-D01 is a P0 blocker for a reason that is easy to state and easy to
 * underestimate: until this exists, no real books can enter the system, so
 * every other capability in the product is a demo. PRD §2.3 puts poor data
 * migration behind 38 percent of ERP implementation failures, and audit risk R2
 * — "migrated opening data is wrong, trust never forms" — is Critical.
 *
 * The five acts, and the guarantee each one carries:
 *
 *  1. DRY RUN, ALWAYS. `previewImport` writes nothing. Not "usually nothing" —
 *     it takes no write path at all, and its result type cannot express a
 *     commit. The review screen's "Nothing has been saved yet" is therefore a
 *     statement about the code, not a promise about it.
 *
 *  2. COMMIT IS A SEPARATE, EXPLICIT ACT — and it re-reads the file and
 *     re-plans from scratch. The approval the user sends back is a FINGERPRINT
 *     and four counts, never the plan itself. If the file changed, or the
 *     database moved underneath it, the counts no longer match and the commit
 *     is refused rather than quietly importing something nobody reviewed.
 *
 *  3. ALL OR NOTHING. One transaction, as everywhere else in this service
 *     layer. The failure mode that matters before go-live is not "the import
 *     crashed" — it is silent partial success, half a set of books that
 *     balances and is wrong. A row that cannot be applied takes the batch with
 *     it.
 *
 *  4. RECONCILED AND SIGNED. Decision D5 makes the accountant's signed
 *     reconciliation the go-live gate, and roadmap criterion 1.1 is "matches
 *     the accountant's figure to the currency unit". `signOffReconciliation`
 *     refuses to record a signature over a difference — the gate is not a
 *     checkbox.
 *
 *  5. REVERSIBLE FOR 72 HOURS. As a batch, by reversing journals and by
 *     deleting the records the batch itself created — after proving that
 *     nothing outside the batch has come to depend on them.
 */

const options = z
  .object({
    asOf: z.iso.date().optional(),
    warehouse: z.string().max(100).optional(),
  })
  .default({});

export const previewImportInput = z.object({
  kind: z.string().min(1).max(30),
  filename: z.string().min(1).max(250),
  /** The file body. Bounded here so an oversized upload fails with a sentence,
   *  not with a database error halfway through. */
  content: z.string().min(1).max(8_000_000),
  businessUnitId: z.uuid().nullable().optional(),
  options,
});

export const commitImportInput = previewImportInput.extend({
  /**
   * What the user approved, copied from the diff they were shown.
   *
   * This is the whole approval contract. It is not the plan — a plan posted
   * back from the browser would make the client authoritative over what lands
   * in the ledger. It is a claim about what the server said last time, checked
   * against what the server says this time.
   */
  approved: z.object({
    fingerprint: z.string().length(64),
    create: z.int().min(0).max(MAX_ROWS),
    update: z.int().min(0).max(MAX_ROWS),
    skip: z.int().min(0).max(MAX_ROWS),
    reject: z.int().min(0).max(MAX_ROWS),
  }),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export const reverseBatchInput = z.object({
  batchId: z.uuid(),
  reason: z.string().min(3).max(500),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export const signOffInput = z.object({
  batchId: z.uuid(),
  /** The accountant's own figure, from their records, typed by hand. */
  accountantTotal: z.string().min(1).max(30),
  note: z.string().max(1000).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/** Reversal window. PRD FR-D01: "reversible as a batch for 72 hours". */
export const REVERSIBLE_HOURS = 72;

function buildContext(
  ctx: ServiceContext,
  businessUnitId: string | null,
  opts: ImportOptions,
): ImportContext {
  return { ...ctx, businessUnitId, options: opts };
}

function countActions(plan: ImportPlan): DiffCounts {
  return {
    create: plan.rows.filter((r) => r.action === "create").length,
    update: plan.rows.filter((r) => r.action === "update").length,
    skip: plan.rows.filter((r) => r.action === "skip").length,
    reject: plan.rejected.length,
  };
}

function toDiff(
  importer: Importer,
  filename: string,
  fingerprint: string,
  rowCount: number,
  plan: ImportPlan,
  extraNotes: string[],
): ImportDiff {
  return {
    dryRun: true,
    kind: importer.kind,
    label: importer.label,
    filename,
    fingerprint,
    rowCount,
    counts: countActions(plan),
    rows: plan.rows.map((r) => ({
      rowNumber: r.rowNumber,
      action: r.action,
      label: r.label,
      detail: r.detail,
      amount: r.amount ? M.toDisplay(r.amount) : undefined,
    })),
    rejected: plan.rejected,
    blockers: plan.blockers,
    totals: plan.totals.map((t) => ({
      label: t.label,
      amount: M.toDisplay(t.amount),
      isProblem: t.isProblem,
    })),
    notes: [...extraNotes, ...plan.notes],
  };
}

/** A diff that reports only why the file cannot be read at all. */
function unreadable(
  importer: Importer,
  filename: string,
  fingerprint: string,
  blockers: string[],
): ImportDiff {
  return {
    dryRun: true,
    kind: importer.kind,
    label: importer.label,
    filename,
    fingerprint,
    rowCount: 0,
    counts: { create: 0, update: 0, skip: 0, reject: 0 },
    rows: [],
    rejected: [],
    blockers,
    totals: [],
    notes: [],
  };
}

async function prepare(
  ctx: ServiceContext,
  input: z.infer<typeof previewImportInput>,
): Promise<{
  importer: Importer;
  importCtx: ImportContext;
  fingerprint: string;
  rowCount: number;
  diff: ImportDiff;
  plan: ImportPlan | null;
}> {
  const importer = importerFor(input.kind);
  requirePermission(ctx, importer.permission);

  const businessUnitId = input.businessUnitId ?? null;
  if (importer.requiresBusinessUnit) {
    if (!businessUnitId) {
      throw new ServiceError(
        `Choose which business these ${importer.label.toLowerCase()} belong to first.`,
        "invalid",
      );
    }
    requireBusinessUnit(ctx, businessUnitId);
  } else if (businessUnitId) {
    requireBusinessUnit(ctx, businessUnitId);
  }

  const source = readSource(input.content);
  const importCtx = buildContext(ctx, businessUnitId, input.options);

  const missing = missingColumns(source, importer.required);
  if (missing.length > 0) {
    // Every missing column at once. Reporting the first one means the
    // accountant fixes it, re-uploads, and is told about the next.
    return {
      importer,
      importCtx,
      fingerprint: source.fingerprint,
      rowCount: source.rows.length,
      plan: null,
      diff: unreadable(importer, input.filename, source.fingerprint, [
        `This file is missing ${missing.length === 1 ? "a column" : "columns"}: ` +
          `${missing.join(", ")}. It has: ${source.columns.filter(Boolean).join(", ")}.`,
      ]),
    };
  }

  const plan = await importer.plan(importCtx, source.rows);

  const priorBatch = await ctx.tx.execute<{ id: string; committed_at: string }>(sql`
    SELECT id, to_char(committed_at, 'DD Mon YYYY HH24:MI') AS committed_at
      FROM import_batches
     WHERE kind = ${importer.kind} AND source_fingerprint = ${source.fingerprint}
       AND reversed_at IS NULL
     LIMIT 1
  `);
  if (priorBatch.length > 0) {
    plan.blockers.unshift(
      `This exact file was already imported on ${priorBatch[0]!.committed_at}. ` +
        `Importing it again would duplicate everything in it. Reverse that batch first if ` +
        `it was wrong.`,
    );
  }

  return {
    importer,
    importCtx,
    fingerprint: source.fingerprint,
    rowCount: source.rows.length,
    plan,
    diff: toDiff(importer, input.filename, source.fingerprint, source.rows.length, plan, source.notes),
  };
}

/**
 * THE DRY RUN.
 *
 * Reads the file, resolves everything it points at, and reports exactly what
 * would happen — created, updated, skipped, rejected, with money totals. It
 * issues SELECTs and nothing else. Its permission check is the same one the
 * commit uses: showing someone a diff of records they may not create is a
 * preview of a button that will refuse, and it leaks the shape of data they are
 * not entitled to.
 */
export async function previewImport(ctx: ServiceContext, raw: unknown): Promise<ImportDiff> {
  const input = previewImportInput.parse(raw);
  const { diff } = await prepare(ctx, input);
  return diff;
}

export interface CommitImportResult {
  batchId: string;
  kind: string;
  counts: DiffCounts;
  journalId: string | null;
  totalDebit: string;
  totalCredit: string;
  reversibleUntil: string;
  /** Set for kinds that reconcile, so the UI can send the accountant onward. */
  needsSignOff: boolean;
}

/**
 * THE COMMIT.
 *
 * Everything here happens in the caller's single transaction, so the batch
 * record, every row it writes, its journal and its audit entry either all land
 * or none do.
 */
export async function commitImport(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CommitImportResult> {
  const input = commitImportInput.parse(raw);

  return withIdempotency(ctx, input.idempotencyKey, "commitImport", async () => {
    const { importer, importCtx, fingerprint, rowCount, plan } = await prepare(ctx, input);

    if (!plan) {
      throw new ServiceError(
        "That file cannot be read. Run the dry run again to see what is missing.",
        "invalid",
      );
    }

    /**
     * The approval contract, checked before anything is written.
     *
     * A mismatch is not a warning. Between the review and the commit the file
     * can be swapped, another user can create the party this file was going to
     * create, or a lease can be signed that makes a unit unavailable — and any
     * of those changes what "Import" means. The user approved a specific set of
     * consequences; if the consequences are no longer that set, the honest
     * answer is to show them the new diff.
     */
    if (input.approved.fingerprint !== fingerprint) {
      throw new ServiceError(
        "That is not the file you reviewed. Upload it again and check the diff before importing.",
        "conflict",
      );
    }
    const counts = countActions(plan);
    if (
      counts.create !== input.approved.create ||
      counts.update !== input.approved.update ||
      counts.skip !== input.approved.skip ||
      counts.reject !== input.approved.reject
    ) {
      throw new ServiceError(
        `This file no longer does what you approved — it would now create ${counts.create}, ` +
          `update ${counts.update}, skip ${counts.skip} and reject ${counts.reject}. ` +
          `Something changed since you reviewed it. Run the dry run again.`,
        "conflict",
      );
    }

    if (plan.blockers.length > 0) {
      // Blockers are not overridable and there is no "import anyway". The first
      // one is the message, because a wall of them is unread.
      throw new ServiceError(plan.blockers[0]!, "invalid");
    }

    if (counts.create === 0 && counts.update === 0) {
      throw new ServiceError(
        "There is nothing in this file to import — every row is already on file.",
        "invalid",
      );
    }

    const batchRows = await ctx.tx.execute<{ id: string; reversible_until: string }>(sql`
      INSERT INTO import_batches
        (id, tenant_id, business_unit_id, kind, source_filename, source_fingerprint,
         row_count, created_count, updated_count, skipped_count, rejected_count,
         total_debit, total_credit, expected_lines, committed_by_user_id,
         committed_at, reversible_until)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${importCtx.businessUnitId}::uuid,
         ${importer.kind}, ${input.filename}, ${fingerprint},
         ${rowCount}, ${counts.create}, ${counts.update}, ${counts.skip}, ${counts.reject},
         ${M.toDb(plan.totalDebit)}, ${M.toDb(plan.totalCredit)},
         ${JSON.stringify(plan.expectedLines)}::jsonb, ${ctx.principal.userId}::uuid,
         now(), now() + interval '${sql.raw(String(REVERSIBLE_HOURS))} hours')
      RETURNING id, reversible_until::text
    `);
    const batchId = batchRows[0]!.id;

    let seq = 0;
    const recorder: BatchRecorder = {
      batchId,
      async record(entry) {
        seq++;
        await ctx.tx.execute(sql`
          INSERT INTO import_batch_rows
            (id, tenant_id, batch_id, seq, row_number, action, entity_table, entity_id, previous)
          VALUES
            (gen_random_uuid(), ${ctx.tenantId}::uuid, ${batchId}::uuid, ${seq},
             ${entry.rowNumber}, ${entry.action}, ${entry.entityTable}, ${entry.entityId}::uuid,
             ${JSON.stringify(entry.previous ?? {})}::jsonb)
        `);
      },
    };

    const outcome: ApplyOutcome = await importer.apply(importCtx, plan, recorder);

    if (outcome.journalId) {
      await ctx.tx.execute(sql`
        UPDATE import_batches SET journal_id = ${outcome.journalId}::uuid, updated_at = now()
         WHERE id = ${batchId}::uuid
      `);
    }

    await writeAudit(ctx, {
      action: "import.commit",
      entityTable: "import_batches",
      entityId: batchId,
      businessUnitId: importCtx.businessUnitId ?? undefined,
      diff: {
        kind: importer.kind,
        filename: input.filename,
        counts,
        rowsWritten: seq,
        journalId: outcome.journalId ?? null,
        // The fingerprint, never the file. An audit record is not a place to
        // park a copy of everybody's Emirates ID.
        fingerprint,
      },
    });

    return {
      batchId,
      kind: importer.kind,
      counts,
      journalId: outcome.journalId ?? null,
      totalDebit: M.toDisplay(plan.totalDebit),
      totalCredit: M.toDisplay(plan.totalCredit),
      reversibleUntil: batchRows[0]!.reversible_until,
      needsSignOff: importer.kind === "opening_balances",
    };
  });
}

// ── Reconciliation and sign-off ─────────────────────────────────────────────

export interface ReconciliationLine {
  accountCode: string;
  accountName: string;
  fileDebit: string;
  fileCredit: string;
  ledgerDebit: string;
  ledgerCredit: string;
  difference: string;
  ties: boolean;
}

export interface ControlCheck {
  label: string;
  accountCode: string;
  subledger: string;
  ledger: string;
  difference: string;
  ties: boolean;
}

export interface ReconciliationReport {
  batchId: string;
  kind: string;
  filename: string;
  committedAt: string;
  reversed: boolean;
  lines: ReconciliationLine[];
  controls: ControlCheck[];
  fileTotalDebit: string;
  fileTotalCredit: string;
  ledgerTotalDebit: string;
  ledgerTotalCredit: string;
  /** Difference between what the file said and what the ledger holds. */
  difference: string;
  ties: boolean;
  signedOff: { at: string; by: string | null; total: string; note: string | null } | null;
}

/**
 * THE SUBLEDGER CONTROL CHECKS.
 *
 * Each one asks the oldest question in bookkeeping: does the list of individual
 * items agree with the control account that summarises them? Aged receivables
 * against AR, the cheque drawer against PDC on hand, the stock count against
 * inventory.
 *
 * BOTH SIDES ARE MEASURED OVER THE SAME SCOPE, and that is the whole point of
 * the shape below. The first version of this compared THIS BATCH's total —
 * scoped to one business unit — against the control account's balance, and the
 * opening journal had posted its legs tenant-wide with no business unit at all,
 * so every check reported "out by the entire balance" on data that was
 * perfectly correct. A control check that can be wrong about scope is worse
 * than no control check, because it trains the accountant to ignore it.
 *
 * So both halves are read fresh, tenant-wide, from the database: the subledger
 * from the table that holds the individual items, the control from the ledger.
 * That also makes the check keep working after go-live, which the batch-total
 * version could not — the batch is a moment, the reconciliation is a standing
 * question.
 */
interface ControlDefinition {
  key: string;
  label: string;
  /** Sums the individual items the control account summarises. */
  subledger: SQL;
}

const CONTROLS: Record<string, ControlDefinition[]> = {
  debts: [
    {
      key: "AR",
      label: "Open invoices against Accounts Receivable",
      subledger: sql`
        SELECT COALESCE(SUM(amount_due), 0)::text AS total FROM documents
         WHERE direction = 'in' AND deleted_at IS NULL
           AND status NOT IN ('cancelled', 'void', 'draft')`,
    },
    {
      key: "AP",
      label: "Open bills against Accounts Payable",
      subledger: sql`
        SELECT COALESCE(SUM(amount_due), 0)::text AS total FROM documents
         WHERE direction = 'out' AND deleted_at IS NULL
           AND status NOT IN ('cancelled', 'void', 'draft')`,
    },
  ],
  cheques: [
    {
      key: "PDC_ON_HAND",
      label: "Cheques still in the safe against Post-Dated Cheques on Hand",
      // `held` only. A deposited cheque belongs to 1150, and a cleared one is
      // already inside the bank balance.
      subledger: sql`
        SELECT COALESCE(SUM(amount), 0)::text AS total FROM cheques
         WHERE direction = 'in' AND status = 'held' AND deleted_at IS NULL`,
    },
  ],
  stock: [
    {
      key: "INVENTORY",
      label: "Stock on hand at cost against Inventory",
      // Multiplied in Postgres, which is `numeric` throughout — exact, and read
      // back through `M.fromDb` as a string.
      subledger: sql`
        SELECT COALESCE(SUM(on_hand * avg_cost), 0)::text AS total FROM stock_levels
         WHERE deleted_at IS NULL`,
    },
  ],
  leases: [
    {
      key: "TENANT_DEPOSIT",
      label: "Deposits held under active leases against Tenant Security Deposits",
      subledger: sql`
        SELECT COALESCE(SUM(deposit_held), 0)::text AS total FROM leases
         WHERE status = 'active' AND deleted_at IS NULL`,
    },
  ],
};

/**
 * THE RECONCILIATION REPORT — the artefact the accountant actually signs.
 *
 * Line by line, to the fils, comparing what the FILE asserted against what the
 * LEDGER now holds. Both halves matter and it is worth being explicit about
 * why: recomputing the "expected" side from the ledger too would compare the
 * ledger with itself and tie every time, which is why `expected_lines` is
 * stored on the batch at commit and never regenerated.
 *
 * For the importers that post nothing, the comparison is a CONTROL CHECK
 * instead: the sub-ledger this batch loaded against the control account the
 * opening balance posted. That is the check that catches the most expensive
 * migration error there is — receivables loaded twice, once as a balance and
 * once as invoices, balancing perfectly and wrong by 100 percent.
 */
export async function buildReconciliation(
  ctx: ServiceContext,
  batchId: string,
): Promise<ReconciliationReport> {
  requirePermission(ctx, "report:read");

  const rows = await ctx.tx.execute<{
    id: string;
    kind: string;
    source_filename: string;
    committed_at: string;
    reversed_at: string | null;
    expected_lines: ExpectedLine[];
    total_debit: string;
    total_credit: string;
    journal_id: string | null;
    business_unit_id: string | null;
    signed_off_at: string | null;
    signed_off_total: string | null;
    sign_off_note: string | null;
    signed_off_by: string | null;
  }>(sql`
    SELECT b.id, b.kind, b.source_filename,
           to_char(b.committed_at, 'DD Mon YYYY HH24:MI') AS committed_at,
           b.reversed_at::text, b.expected_lines, b.total_debit, b.total_credit,
           b.journal_id::text, b.business_unit_id::text,
           to_char(b.signed_off_at, 'DD Mon YYYY HH24:MI') AS signed_off_at,
           b.signed_off_total, b.sign_off_note, u.full_name AS signed_off_by
      FROM import_batches b
      LEFT JOIN users u ON u.id = b.signed_off_by_user_id
     WHERE b.id = ${batchId}::uuid
  `);
  const batch = rows[0];
  if (!batch) throw new ServiceError("That import batch does not exist.", "not_found");

  const lines: ReconciliationLine[] = [];
  let ledgerTotalDebit = M.ZERO;
  let ledgerTotalCredit = M.ZERO;

  if (batch.journal_id) {
    const posted = await ctx.tx.execute<{ code: string; debit: string; credit: string }>(sql`
      SELECT a.code, SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
        FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_id = ${batch.journal_id}::uuid
       GROUP BY a.code
    `);
    const byCode = new Map(posted.map((p) => [p.code, p]));

    for (const expected of batch.expected_lines ?? []) {
      const actual = byCode.get(expected.accountCode);
      const fileDebit = M.fromDb(expected.debit);
      const fileCredit = M.fromDb(expected.credit);
      const ledgerDebit = M.fromDb(actual?.debit ?? "0");
      const ledgerCredit = M.fromDb(actual?.credit ?? "0");
      // Net, so a line posted on the wrong side shows as twice the amount
      // rather than as two separate half-truths.
      const difference = M.quantize(
        M.sub(M.sub(fileDebit, fileCredit), M.sub(ledgerDebit, ledgerCredit)),
      );
      ledgerTotalDebit = M.add(ledgerTotalDebit, ledgerDebit);
      ledgerTotalCredit = M.add(ledgerTotalCredit, ledgerCredit);
      lines.push({
        accountCode: expected.accountCode,
        accountName: expected.accountName,
        fileDebit: M.toDisplay(fileDebit),
        fileCredit: M.toDisplay(fileCredit),
        ledgerDebit: M.toDisplay(ledgerDebit),
        ledgerCredit: M.toDisplay(ledgerCredit),
        difference: M.toDisplay(difference),
        ties: M.isZero(difference),
      });
      byCode.delete(expected.accountCode);
    }

    // Anything the ledger holds for this journal that the file never mentioned.
    // Impossible by construction today, and reported rather than hidden, because
    // "impossible by construction" is what the last six defects also were.
    for (const [code, actual] of byCode) {
      const ledgerDebit = M.fromDb(actual.debit);
      const ledgerCredit = M.fromDb(actual.credit);
      ledgerTotalDebit = M.add(ledgerTotalDebit, ledgerDebit);
      ledgerTotalCredit = M.add(ledgerTotalCredit, ledgerCredit);
      lines.push({
        accountCode: code,
        accountName: "Not in the uploaded file",
        fileDebit: "0.00",
        fileCredit: "0.00",
        ledgerDebit: M.toDisplay(ledgerDebit),
        ledgerCredit: M.toDisplay(ledgerCredit),
        difference: M.toDisplay(M.neg(M.sub(ledgerDebit, ledgerCredit))),
        ties: false,
      });
    }
  }

  const controls: ControlCheck[] = [];
  for (const control of CONTROLS[batch.kind] ?? []) {
    const balance = await ctx.tx.execute<{ debit: string; credit: string }>(sql`
      SELECT COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
        FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
        JOIN journals j ON j.id = jl.journal_id
       WHERE a.system_key = ${control.key} AND j.deleted_at IS NULL AND jl.deleted_at IS NULL
    `);
    // Absolute, because a liability control carries a credit balance and a
    // receivable a debit one, and the accountant is comparing magnitudes.
    const ledger = M.quantize(
      M.abs(M.sub(M.fromDb(balance[0]?.debit ?? "0"), M.fromDb(balance[0]?.credit ?? "0"))),
    );
    const items = await ctx.tx.execute<{ total: string }>(control.subledger);
    const subledger = M.quantize(M.fromDb(items[0]?.total ?? "0"));
    const difference = M.quantize(M.sub(subledger, ledger));
    controls.push({
      label: control.label,
      accountCode: control.key,
      subledger: M.toDisplay(subledger),
      ledger: M.toDisplay(ledger),
      difference: M.toDisplay(difference),
      ties: M.isZero(difference),
    });
  }

  const fileTotalDebit = M.fromDb(batch.total_debit);
  const fileTotalCredit = M.fromDb(batch.total_credit);
  const difference = batch.journal_id
    ? M.quantize(M.sub(fileTotalDebit, M.quantize(ledgerTotalDebit)))
    : M.ZERO;

  const ties =
    lines.every((l) => l.ties) && controls.every((c) => c.ties) && M.isZero(difference);

  return {
    batchId: batch.id,
    kind: batch.kind,
    filename: batch.source_filename,
    committedAt: batch.committed_at,
    reversed: batch.reversed_at !== null,
    lines,
    controls,
    fileTotalDebit: M.toDisplay(fileTotalDebit),
    fileTotalCredit: M.toDisplay(fileTotalCredit),
    ledgerTotalDebit: M.toDisplay(M.quantize(ledgerTotalDebit)),
    ledgerTotalCredit: M.toDisplay(M.quantize(ledgerTotalCredit)),
    difference: M.toDisplay(difference),
    ties,
    signedOff: batch.signed_off_at
      ? {
          at: batch.signed_off_at,
          by: batch.signed_off_by,
          total: M.toDisplay(M.fromDb(batch.signed_off_total ?? "0")),
          note: batch.sign_off_note,
        }
      : null,
  };
}

export interface SignOffResult {
  batchId: string;
  signedTotal: string;
}

/**
 * THE GO-LIVE GATE.
 *
 * Decision D5: the accountant owns the books during migration and their signed
 * reconciliation is what releases go-live. Two refusals make that a control
 * rather than a checkbox:
 *
 *   The reconciliation must TIE. Signing over a difference is signing that the
 *   books are right when the report on the same screen says they are not.
 *
 *   The accountant's own figure must MATCH, to the fils. They type it from
 *   their records, not from this screen — that is the entire point. Roadmap
 *   criterion 1.1 is "matches the accountant's figure to the currency unit",
 *   and a comparison with a tolerance in it would not be that criterion.
 *
 * `journal:post` is the permission because it is held by exactly two roles —
 * the accountant and the owner — and by no read-only auditor. Signing off the
 * opening books is not an act an observer performs.
 */
export async function signOffReconciliation(
  ctx: ServiceContext,
  raw: unknown,
): Promise<SignOffResult> {
  const input = signOffInput.parse(raw);
  requirePermission(ctx, "journal:post");

  return withIdempotency(ctx, input.idempotencyKey, "signOffReconciliation", async () => {
    const report = await buildReconciliation(ctx, input.batchId);

    if (report.reversed) {
      throw new ServiceError("That batch has been reversed. There is nothing to sign.", "invalid");
    }
    if (report.signedOff) {
      throw new ServiceError(
        `This reconciliation was already signed on ${report.signedOff.at}` +
          `${report.signedOff.by ? ` by ${report.signedOff.by}` : ""}.`,
        "duplicate",
      );
    }
    if (report.lines.length === 0 && report.controls.length === 0) {
      /**
       * Nothing to reconcile is not the same as reconciled.
       *
       * A batch that posts nothing and has no control account to tie to would
       * otherwise pass `ties` vacuously — every empty list is all-true — and
       * accept a signature over a comparison that was never made. A signature
       * that means nothing is worse than no signature, because the go-live gate
       * would read it as satisfied.
       */
      throw new ServiceError(
        "This import has nothing to reconcile, so there is nothing to sign. The " +
          "signature that gates go-live is the one on the opening balances.",
        "invalid",
      );
    }
    if (!report.ties) {
      const failing = [
        ...report.lines.filter((l) => !l.ties).map((l) => `${l.accountCode} by ${l.difference}`),
        ...report.controls.filter((c) => !c.ties).map((c) => `${c.accountCode} by ${c.difference}`),
      ];
      throw new ServiceError(
        `This reconciliation does not tie, so it cannot be signed: ` +
          `${failing.slice(0, 3).join("; ")}` +
          `${failing.length > 3 ? ` and ${failing.length - 3} more` : ""}. ` +
          `Reverse the batch, correct the file, and import it again.`,
        "invalid",
      );
    }

    let accountantTotal: M.Money;
    try {
      accountantTotal = M.money(input.accountantTotal.replace(/[\s,]/g, ""));
      if (accountantTotal.isNaN()) throw new Error("not a number");
    } catch {
      throw new ServiceError(
        `"${input.accountantTotal}" is not an amount. Type the total from your own records, ` +
          `for example 4182440.00.`,
        "invalid",
      );
    }

    const posted = M.money(report.ledgerTotalDebit.replace(/,/g, ""));
    if (!M.eq(M.quantize(accountantTotal), M.quantize(posted))) {
      const gap = M.sub(accountantTotal, posted);
      throw new ServiceError(
        `Your figure is AED ${M.toDisplay(accountantTotal)}; the imported trial balance ` +
          `totals AED ${M.toDisplay(posted)} — a difference of AED ` +
          `${M.toDisplay(M.abs(gap))}. Go-live stays blocked until those agree.`,
        "invalid",
      );
    }

    await ctx.tx.execute(sql`
      UPDATE import_batches
         SET signed_off_at = now(), signed_off_by_user_id = ${ctx.principal.userId}::uuid,
             signed_off_total = ${M.toDb(accountantTotal)}, sign_off_note = ${input.note ?? null},
             updated_at = now()
       WHERE id = ${input.batchId}::uuid AND reversed_at IS NULL
    `);

    await writeAudit(ctx, {
      action: "import.signoff",
      entityTable: "import_batches",
      entityId: input.batchId,
      diff: { accountantTotal: M.toDb(accountantTotal), note: input.note ?? null },
    });

    return { batchId: input.batchId, signedTotal: M.toDisplay(accountantTotal) };
  });
}

// ── Reversal ────────────────────────────────────────────────────────────────

export interface ReverseBatchResult {
  batchId: string;
  rowsRemoved: number;
  rowsRestored: number;
  reversalJournalId: string | null;
  signOffCleared: boolean;
}

/**
 * Refuse the reversal if anything outside the batch has come to depend on it.
 *
 * Read out of the foreign-key catalogue rather than from a hand-written list,
 * because a hand-written list is right on the day it is written and wrong from
 * the first migration after that — and the failure is silent: a child table
 * nobody listed gets its parent deleted, the FK cascades or nulls, and real
 * data disappears in the name of undoing an import.
 *
 * Rows the batch created itself are excluded, or a lease created alongside its
 * unit would block its own reversal.
 */
async function assertNothingDependsOnBatch(
  ctx: ServiceContext,
  created: { entityTable: string; entityId: string }[],
): Promise<void> {
  const byTable = new Map<string, string[]>();
  for (const row of created) {
    const list = byTable.get(row.entityTable) ?? [];
    list.push(row.entityId);
    byTable.set(row.entityTable, list);
  }
  const ownIds = new Set(created.map((r) => `${r.entityTable}:${r.entityId}`));

  for (const [table, ids] of byTable) {
    const children = await ctx.tx.execute<{ child_table: string; child_column: string }>(sql`
      SELECT src.relname AS child_table, att.attname AS child_column
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_class tgt ON tgt.oid = c.confrelid
        JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = k.attnum
       WHERE c.contype = 'f' AND tgt.relname = ${table}
         AND array_length(c.conkey, 1) = 1
    `);

    for (const child of children) {
      const excluded = [...ownIds]
        .filter((k) => k.startsWith(`${child.child_table}:`))
        .map((k) => k.split(":")[1]!);

      // Identifiers come from the PostgreSQL catalogue, never from the uploaded
      // file — which is the only reason `sql.raw` is acceptable here.
      const referencing = await ctx.tx.execute<{ n: number; sample: string }>(sql`
        SELECT COUNT(*)::int AS n, MIN(id::text) AS sample
          FROM ${sql.raw(`"${child.child_table}"`)}
         WHERE ${sql.raw(`"${child.child_column}"`)} = ANY(${sql`ARRAY[${sql.join(
           ids.map((i) => sql`${i}::uuid`),
           sql`, `,
         )}]`})
           ${
             excluded.length > 0
               ? sql`AND id <> ALL(ARRAY[${sql.join(
                   excluded.map((i) => sql`${i}::uuid`),
                   sql`, `,
                 )}])`
               : sql``
           }
      `);

      const n = referencing[0]?.n ?? 0;
      if (n > 0) {
        throw new ServiceError(
          `This batch cannot be reversed: ${n} record(s) in ${child.child_table} now point ` +
            `at rows it created. Something has been built on top of this import — undo that ` +
            `first, or correct the data in place instead of reversing.`,
          "conflict",
        );
      }
    }
  }
}

/**
 * REVERSE A BATCH.
 *
 * Two mechanisms, chosen by what the batch did:
 *
 *   A LEDGER POSTING is reversed, never deleted. A second journal with the legs
 *   swapped, in an open period, leaving both entries visible. That is what the
 *   rest of this ledger does and what an auditor expects to find; deleting a
 *   journal would leave a gap in a numbered series and a hole in the audit
 *   trail.
 *
 *   RECORDS THE BATCH CREATED are removed, and records it UPDATED are restored
 *   from the snapshot taken at commit. Removal rather than a soft delete is
 *   deliberate and is the one place this feature departs from "nothing is ever
 *   hard-deleted": a reversed migration batch is a statement that these rows
 *   never should have existed, and a soft-deleted row is still visible to every
 *   query in this codebase that does not filter `deleted_at` — which is nearly
 *   all of them. A tombstone the product ignores is not a reversal, it is a
 *   duplicate. The dependency check above is what makes the deletion safe:
 *   nothing outside the batch may reference these rows, so no cascade fires and
 *   no foreign key is quietly set to NULL.
 */
export async function reverseImportBatch(
  ctx: ServiceContext,
  raw: unknown,
): Promise<ReverseBatchResult> {
  const input = reverseBatchInput.parse(raw);

  return withIdempotency(ctx, input.idempotencyKey, "reverseImportBatch", async () => {
    const rows = await ctx.tx.execute<{
      id: string;
      kind: string;
      journal_id: string | null;
      business_unit_id: string | null;
      source_filename: string;
      reversed_at: string | null;
      signed_off_at: string | null;
      expired: boolean;
      reversible_until: string;
    }>(sql`
      SELECT id, kind, journal_id::text, business_unit_id::text, source_filename,
             reversed_at::text, signed_off_at::text,
             (now() > reversible_until) AS expired,
             to_char(reversible_until, 'DD Mon YYYY HH24:MI') AS reversible_until
        FROM import_batches WHERE id = ${input.batchId}::uuid
    `);
    const batch = rows[0];
    if (!batch) throw new ServiceError("That import batch does not exist.", "not_found");

    const importer = importerFor(batch.kind);
    requirePermission(ctx, importer.permission);
    if (importer.reversePermission) requirePermission(ctx, importer.reversePermission);
    if (batch.business_unit_id) requireBusinessUnit(ctx, batch.business_unit_id);

    if (batch.reversed_at) {
      throw new ServiceError("That batch has already been reversed.", "duplicate");
    }
    if (batch.expired) {
      throw new ServiceError(
        `The ${REVERSIBLE_HOURS}-hour reversal window for this batch closed on ` +
          `${batch.reversible_until}. Correct the records individually, or post an ` +
          `adjusting journal — reversing books that have been trading for days would ` +
          `remove work done since.`,
        "invalid",
      );
    }

    const written = await ctx.tx.execute<{
      seq: number;
      row_number: number;
      action: string;
      entity_table: string;
      entity_id: string;
      previous: Record<string, unknown>;
    }>(sql`
      SELECT seq, row_number, action, entity_table, entity_id::text, previous
        FROM import_batch_rows WHERE batch_id = ${input.batchId}::uuid
       ORDER BY seq DESC
    `);

    await assertNothingDependsOnBatch(
      ctx,
      written.filter((w) => w.action === "create").map((w) => ({
        entityTable: w.entity_table,
        entityId: w.entity_id,
      })),
    );

    let rowsRemoved = 0;
    let rowsRestored = 0;

    // Descending sequence, so anything the batch created on top of its own rows
    // goes first and the foreign keys never have to arbitrate.
    for (const row of written) {
      if (row.action === "create") {
        await ctx.tx.execute(sql`
          DELETE FROM ${sql.raw(`"${row.entity_table}"`)} WHERE id = ${row.entity_id}::uuid
        `);
        rowsRemoved++;
        continue;
      }

      const columns = Object.keys(row.previous ?? {});
      if (columns.length === 0) continue;
      const assignments = columns.map(
        (c) => sql`${sql.raw(`"${c}"`)} = ${(row.previous as Record<string, unknown>)[c] ?? null}`,
      );
      await ctx.tx.execute(sql`
        UPDATE ${sql.raw(`"${row.entity_table}"`)}
           SET ${sql.join(assignments, sql`, `)}, updated_at = now()
         WHERE id = ${row.entity_id}::uuid
      `);
      rowsRestored++;
    }

    let reversalJournalId: string | null = null;
    if (batch.journal_id) {
      const legs = await ctx.tx.execute<{
        system_key: string;
        business_unit_id: string | null;
        debit: string;
        credit: string;
        memo: string | null;
      }>(sql`
        SELECT a.system_key, jl.business_unit_id::text, jl.debit, jl.credit, jl.memo
          FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.journal_id = ${batch.journal_id}::uuid
         ORDER BY jl.line_no
      `);

      reversalJournalId = await postJournal(ctx, {
        postingDate: ctx.today,
        source: "opening",
        sourceTable: "import_batches",
        sourceId: batch.id,
        narration: `Reversal of import ${batch.source_filename}: ${input.reason}`,
        // Sides swapped. The original journal is left exactly as it was.
        legs: legs.map((l) => ({
          accountKey: l.system_key,
          businessUnitId: l.business_unit_id,
          debit: M.fromDb(l.credit),
          credit: M.fromDb(l.debit),
          memo: l.memo ? `Reversal: ${l.memo}` : "Reversal",
        })),
      });
    }

    const signOffCleared = batch.signed_off_at !== null;
    await ctx.tx.execute(sql`
      UPDATE import_batches
         SET reversed_at = now(), reversed_by_user_id = ${ctx.principal.userId}::uuid,
             reversal_reason = ${input.reason},
             reversal_journal_id = ${reversalJournalId}::uuid,
             -- A signature over books that have been taken away is not a
             -- signature over anything. Cleared here, and said out loud in the
             -- confirmation the user reads before pressing the button.
             signed_off_at = NULL, signed_off_by_user_id = NULL,
             signed_off_total = NULL, updated_at = now()
       WHERE id = ${input.batchId}::uuid
    `);

    await writeAudit(ctx, {
      action: "import.reverse",
      entityTable: "import_batches",
      entityId: input.batchId,
      businessUnitId: batch.business_unit_id ?? undefined,
      diff: {
        kind: batch.kind,
        reason: input.reason,
        rowsRemoved,
        rowsRestored,
        reversalJournalId,
        signOffCleared,
      },
    });

    return { batchId: input.batchId, rowsRemoved, rowsRestored, reversalJournalId, signOffCleared };
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface ImportBatchSummary {
  id: string;
  kind: string;
  label: string;
  filename: string;
  committedAt: string;
  committedBy: string | null;
  businessUnit: string | null;
  createdCount: number;
  updatedCount: number;
  totalDebit: string;
  reversed: boolean;
  reversedReason: string | null;
  reversible: boolean;
  reversibleUntil: string;
  signedOffAt: string | null;
  signedOffBy: string | null;
  needsSignOff: boolean;
}

export async function listImportBatches(
  ctx: ServiceContext,
  limit = 50,
): Promise<ImportBatchSummary[]> {
  requirePermission(ctx, "report:read");
  const rows = await ctx.tx.execute<{
    id: string;
    kind: string;
    source_filename: string;
    committed_at: string;
    committed_by: string | null;
    business_unit: string | null;
    created_count: number;
    updated_count: number;
    total_debit: string;
    reversed_at: string | null;
    reversal_reason: string | null;
    reversible: boolean;
    reversible_until: string;
    signed_off_at: string | null;
    signed_off_by: string | null;
  }>(sql`
    SELECT b.id, b.kind, b.source_filename,
           to_char(b.committed_at, 'DD Mon YYYY HH24:MI') AS committed_at,
           u.full_name AS committed_by, bu.name AS business_unit,
           b.created_count, b.updated_count, b.total_debit,
           b.reversed_at::text, b.reversal_reason,
           (b.reversed_at IS NULL AND now() <= b.reversible_until) AS reversible,
           to_char(b.reversible_until, 'DD Mon HH24:MI') AS reversible_until,
           to_char(b.signed_off_at, 'DD Mon YYYY HH24:MI') AS signed_off_at,
           s.full_name AS signed_off_by
      FROM import_batches b
      LEFT JOIN users u ON u.id = b.committed_by_user_id
      LEFT JOIN users s ON s.id = b.signed_off_by_user_id
      LEFT JOIN business_units bu ON bu.id = b.business_unit_id
     ORDER BY b.committed_at DESC
     LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: importerFor(r.kind).label,
    filename: r.source_filename,
    committedAt: r.committed_at,
    committedBy: r.committed_by,
    businessUnit: r.business_unit,
    createdCount: r.created_count,
    updatedCount: r.updated_count,
    totalDebit: M.toDisplay(M.fromDb(r.total_debit)),
    reversed: r.reversed_at !== null,
    reversedReason: r.reversal_reason,
    reversible: r.reversible,
    reversibleUntil: r.reversible_until,
    signedOffAt: r.signed_off_at,
    signedOffBy: r.signed_off_by,
    needsSignOff: r.kind === "opening_balances" && r.reversed_at === null && !r.signed_off_at,
  }));
}

export interface GoLiveStatus {
  ready: boolean;
  /** Opening-balance batches still waiting for the accountant's signature. */
  awaitingSignOff: { batchId: string; filename: string; committedAt: string }[];
  /** True when no opening balances have been imported at all. */
  noOpeningBalances: boolean;
}

/**
 * The go-live gate, as a value other screens can read.
 *
 * Decision D5 says go-live is blocked until the accountant has signed the
 * reconciliation. This is that condition, expressed once, so the pre-close
 * checklist and the compliance watchlist can show it without each inventing
 * their own version of "have we actually migrated yet".
 */
export async function importGoLiveStatus(ctx: ServiceContext): Promise<GoLiveStatus> {
  requirePermission(ctx, "report:read");
  const rows = await ctx.tx.execute<{ id: string; source_filename: string; committed_at: string }>(sql`
    SELECT id, source_filename,
           to_char(committed_at, 'DD Mon YYYY HH24:MI') AS committed_at
      FROM import_batches
     WHERE kind = 'opening_balances' AND reversed_at IS NULL AND signed_off_at IS NULL
     ORDER BY committed_at
  `);
  const anySigned = await ctx.tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM import_batches
     WHERE kind = 'opening_balances' AND reversed_at IS NULL AND signed_off_at IS NOT NULL
  `);
  const signed = anySigned[0]?.n ?? 0;

  return {
    ready: rows.length === 0 && signed > 0,
    awaitingSignOff: rows.map((r) => ({
      batchId: r.id,
      filename: r.source_filename,
      committedAt: r.committed_at,
    })),
    noOpeningBalances: rows.length === 0 && signed === 0,
  };
}
