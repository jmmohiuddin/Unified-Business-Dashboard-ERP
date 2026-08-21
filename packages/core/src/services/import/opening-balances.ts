import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { postJournal } from "../context.ts";
import { CellError, byRowNumber, readMoney, readText, toIssue } from "./source.ts";
import type {
  ApplyOutcome,
  BatchRecorder,
  ExpectedLine,
  ImportContext,
  ImportPlan,
  Importer,
  PlannedRow,
  RowIssue,
  SourceRow,
} from "./types.ts";

/**
 * OPENING BALANCES — the import everything else is measured against.
 *
 * This is the one the gate metric names: "migrated trial balance versus the
 * accountant's figure — ties to the fils". Every other importer loads records;
 * this one loads the books, and if it is wrong the product is wrong from its
 * first day in a way no later correctness recovers from. PRD §2.3 attributes
 * 38 percent of ERP implementation failures to migration, and audit risk R2
 * ("migrated opening data is wrong, trust never forms") is rated Critical.
 *
 * THE FAILURE THIS FILE IS BUILT AROUND. A trial balance that does not balance
 * is the single most likely input error, because it is what the accountant's
 * own export produces when a line is filtered out, a subtotal row is included,
 * or a rounding difference has been living in a spreadsheet for a year. The
 * ledger's deferred constraint trigger would reject the posting at COMMIT with
 * a message about a constraint — true, useless, and arriving after the user has
 * pressed Import. So the imbalance is detected HERE, in the dry run, stated as
 * an amount and a direction ("debits exceed credits by AED 250.00"), and made a
 * blocker that no approval can override. There is no "import anyway".
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It posts one journal, and it does not touch
 * the sub-ledgers. The open invoices behind the receivables control account are
 * the `debts` importer's job, and the reconciliation checks that the two agree.
 * Loading both and posting both would double the receivable — the most common
 * way an opening balance import goes wrong in a way that still balances.
 */

/** How the file may name the account. All three are unambiguous within a chart. */
interface ChartAccount {
  id: string;
  code: string;
  name: string;
  systemKey: string | null;
  isPostable: boolean;
}

export interface OpeningBalanceRow {
  accountId: string;
  accountKey: string;
  accountCode: string;
  accountName: string;
  businessUnitId: string | null;
  debit: M.Money;
  credit: M.Money;
  memo: string;
}

export interface OpeningBalanceOptions {
  /** The date the balances are as at. Posted as the journal's posting date. */
  asOf: string;
}

const COLUMNS = [
  "account_code",
  "account_name",
  "debit",
  "credit",
  "business_unit",
  "memo",
] as const;

async function loadChart(ctx: ImportContext): Promise<ChartAccount[]> {
  const rows = await ctx.tx.execute<{
    id: string;
    code: string;
    name: string;
    system_key: string | null;
    is_postable: boolean;
  }>(sql`
    SELECT id, code, name, system_key, is_postable
      FROM accounts
     WHERE deleted_at IS NULL AND is_active = true
  `);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    systemKey: r.system_key,
    isPostable: r.is_postable,
  }));
}

async function loadBusinessUnits(ctx: ImportContext): Promise<Map<string, string>> {
  const rows = await ctx.tx.execute<{ id: string; code: string }>(sql`
    SELECT id, code FROM business_units WHERE deleted_at IS NULL
  `);
  const byCode = new Map<string, string>();
  for (const r of rows) byCode.set(r.code.trim().toLowerCase(), r.id);
  return byCode;
}

/**
 * Resolve however the file names an account.
 *
 * Code first, then the system key, then the exact name. Accountants export
 * whichever their previous package used, and a lookup that only accepts one of
 * them rejects a file that is entirely correct. All three are unique within a
 * chart, so nothing here is a guess — a name that matches two accounts is not
 * resolved at all rather than resolved arbitrarily.
 */
function resolveAccount(chart: ChartAccount[], token: string): ChartAccount | "ambiguous" | null {
  const needle = token.trim().toLowerCase();
  if (needle === "") return null;
  const byCode = chart.filter((a) => a.code.toLowerCase() === needle);
  if (byCode.length === 1) return byCode[0]!;
  const byKey = chart.filter((a) => (a.systemKey ?? "").toLowerCase() === needle);
  if (byKey.length === 1) return byKey[0]!;
  const byName = chart.filter((a) => a.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1 || byCode.length > 1) return "ambiguous";
  return null;
}

export function planOpeningBalances(
  rows: SourceRow[],
  chart: ChartAccount[],
  businessUnits: Map<string, string>,
  defaultBusinessUnitId: string | null,
): ImportPlan {
  const planned: PlannedRow<OpeningBalanceRow>[] = [];
  const rejected: RowIssue[] = [];
  const expectedLines: ExpectedLine[] = [];
  const notes: string[] = [];
  const seenAccounts = new Map<string, number>();

  let totalDebit = M.ZERO;
  let totalCredit = M.ZERO;

  for (const row of rows) {
    try {
      const token = readText(row, "account_code", { max: 60, required: true });
      const account = resolveAccount(chart, token);

      if (account === null) {
        throw new CellError(
          "account_code",
          `No account matches "${token}". Use the code, the system key, or the exact ` +
            `account name from your chart of accounts.`,
        );
      }
      if (account === "ambiguous") {
        throw new CellError(
          "account_code",
          `"${token}" matches more than one account. Use the account code instead.`,
        );
      }
      if (!account.isPostable) {
        throw new CellError(
          "account_code",
          `"${account.code} ${account.name}" is a heading, not a postable account. ` +
            `Post the balance to the account underneath it.`,
        );
      }
      if (!account.systemKey) {
        // The ledger's posting path resolves legs by system key. An account
        // without one cannot be posted to at all, and saying "not configured"
        // three layers down at COMMIT would be unreadable.
        throw new CellError(
          "account_code",
          `"${account.code} ${account.name}" has no system key and cannot be posted to. ` +
            `Ask for it to be configured before importing.`,
        );
      }

      const previous = seenAccounts.get(account.code);
      if (previous !== undefined) {
        throw new CellError(
          "account_code",
          `Account ${account.code} is already on row ${previous}. Combine the two lines ` +
            `into one — a trial balance has one line per account.`,
        );
      }

      /**
       * Both conventions, without guessing between them.
       *
       * Two-column files put the amount in `debit` or `credit`. Single-column
       * files put a signed amount in one of them. Netting the two handles both:
       * a negative debit IS a credit, which is what the sign means, and the
       * balance check downstream still has to pass either way. What is refused
       * is a row carrying a positive figure in BOTH columns — that is not a
       * convention, it is a mistake, and netting it would silently discard the
       * smaller of two numbers the accountant meant to be separate lines.
       */
      const debitCell = readMoney(row, "debit", M.ZERO);
      const creditCell = readMoney(row, "credit", M.ZERO);
      if (M.gt(debitCell, M.ZERO) && M.gt(creditCell, M.ZERO)) {
        throw new CellError(
          "debit",
          `This row has both a debit (${M.toDisplay(debitCell)}) and a credit ` +
            `(${M.toDisplay(creditCell)}). A trial balance line is one or the other.`,
        );
      }

      const net = M.quantize(M.sub(debitCell, creditCell));
      if (M.isZero(net)) {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: `${account.code} ${account.name}`,
          detail: "Zero balance — nothing to post.",
          payload: {
            accountId: account.id,
            accountKey: account.systemKey,
            accountCode: account.code,
            accountName: account.name,
            businessUnitId: defaultBusinessUnitId,
            debit: M.ZERO,
            credit: M.ZERO,
            memo: "",
          },
        });
        seenAccounts.set(account.code, row.rowNumber);
        continue;
      }

      const debit = M.gt(net, M.ZERO) ? net : M.ZERO;
      const credit = M.gt(net, M.ZERO) ? M.ZERO : M.neg(net);

      let businessUnitId = defaultBusinessUnitId;
      const buToken = readText(row, "business_unit", { max: 40 });
      if (buToken !== "") {
        const resolved = businessUnits.get(buToken.toLowerCase());
        if (!resolved) {
          throw new CellError("business_unit", `No business matches "${buToken}".`);
        }
        businessUnitId = resolved;
      }

      seenAccounts.set(account.code, row.rowNumber);
      totalDebit = M.add(totalDebit, debit);
      totalCredit = M.add(totalCredit, credit);

      expectedLines.push({
        accountCode: account.code,
        accountName: account.name,
        debit: M.toDb(debit),
        credit: M.toDb(credit),
      });

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: `${account.code} ${account.name}`,
        detail: M.gt(debit, M.ZERO)
          ? `Debit ${M.toDisplay(debit)}`
          : `Credit ${M.toDisplay(credit)}`,
        amount: M.gt(debit, M.ZERO) ? debit : credit,
        payload: {
          accountId: account.id,
          accountKey: account.systemKey,
          accountCode: account.code,
          accountName: account.name,
          businessUnitId,
          debit,
          credit,
          memo: readText(row, "memo", { max: 200 }),
        },
      });
    } catch (err) {
      rejected.push(toIssue(row.rowNumber, err));
    }
  }

  totalDebit = M.quantize(totalDebit);
  totalCredit = M.quantize(totalCredit);

  const blockers: string[] = [];

  /**
   * THE BALANCE GATE, stated in the accountant's own terms.
   *
   * Exact — `M.eq` on quantized totals, never a tolerance. The half-fils
   * tolerance that used to guard the ledger is the defect the money module
   * exists to close, and reintroducing one here would let an unbalanced opening
   * balance through the one door built to stop it.
   *
   * The message carries the DIFFERENCE and its direction, because "does not
   * balance" tells an accountant nothing they did not already fear, whereas
   * "debits exceed credits by AED 250.00" is a number they can search their
   * spreadsheet for.
   */
  if (!M.eq(totalDebit, totalCredit)) {
    const difference = M.sub(totalDebit, totalCredit);
    const direction = M.isNegative(difference) ? "Credits exceed debits" : "Debits exceed credits";
    blockers.push(
      `This trial balance does not balance. ${direction} by ` +
        `AED ${M.toDisplay(M.abs(difference))} — debits AED ${M.toDisplay(totalDebit)}, ` +
        `credits AED ${M.toDisplay(totalCredit)}. Nothing can be posted until they agree.`,
    );
  }

  if (rejected.length > 0) {
    /**
     * A rejected line in a trial balance is a blocker, not a skip.
     *
     * Everywhere else in this feature a bad row is dropped and the rest
     * imported — the wireframe's "41 leases to create, 3 rejected". A trial
     * balance is different in kind: dropping a line changes the totals, so the
     * remaining lines would balance only by coincidence, and importing "most of
     * the books" produces a general ledger that is wrong by exactly the amount
     * nobody is looking at. Refuse the batch.
     */
    blockers.push(
      `${rejected.length} line(s) could not be read. A trial balance imports whole or ` +
        `not at all — fix the lines listed below and upload again.`,
    );
  }

  const totals = [
    { label: "Total debits", amount: totalDebit },
    { label: "Total credits", amount: totalCredit },
    {
      label: "Difference",
      amount: M.sub(totalDebit, totalCredit),
      isProblem: !M.eq(totalDebit, totalCredit),
    },
  ];

  notes.push("Balances post as one journal, dated as at the date you chose.");
  if (planned.some((p) => p.action === "skip")) {
    notes.push("Accounts with a zero balance are listed but post nothing.");
  }

  return {
    rows: planned,
    rejected: rejected.sort(byRowNumber),
    blockers,
    totals,
    notes,
    expectedLines,
    totalDebit,
    totalCredit,
  };
}

export const openingBalancesImporter: Importer = {
  kind: "opening_balances",
  label: "Opening balances",
  description:
    "Your trial balance as at the day before you go live. One line per account, " +
    "debits and credits, and they must agree.",
  template: [...COLUMNS],
  required: ["account_code"],
  // The ledger's own permission. `journal:post` is held by the accountant and
  // the owner and by nobody else — which is exactly who may set the books.
  permission: "journal:post",
  reversePermission: "journal:reverse",
  requiresBusinessUnit: false,

  async plan(ctx, rows) {
    const [chart, businessUnits] = await Promise.all([loadChart(ctx), loadBusinessUnits(ctx)]);
    return planOpeningBalances(rows, chart, businessUnits, ctx.businessUnitId);
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    const legs = plan.rows
      .filter((r) => r.action === "create")
      .map((r) => {
        const payload = r.payload as OpeningBalanceRow;
        return {
          accountKey: payload.accountKey,
          businessUnitId: payload.businessUnitId,
          debit: payload.debit,
          credit: payload.credit,
          memo: payload.memo || `Opening balance ${payload.accountCode}`,
        };
      });

    if (legs.length === 0) {
      return {};
    }

    const asOf = ctx.options.asOf ?? ctx.today;

    /**
     * One journal for the whole batch, not one per line.
     *
     * A per-line journal would balance only against a suspense account, would
     * produce sixty journal numbers for one act, and would make the reversal
     * sixty postings instead of one. The batch is the unit of meaning here, and
     * `postJournal` re-checks the balance exactly before it writes anything —
     * so the gate above is the readable error and this is the backstop.
     */
    const journalId = await postJournal(ctx, {
      postingDate: asOf,
      source: "opening",
      sourceTable: "import_batches",
      sourceId: into.batchId,
      narration: `Opening balances imported as at ${asOf}`,
      legs,
    });

    return { journalId };
  },
};
