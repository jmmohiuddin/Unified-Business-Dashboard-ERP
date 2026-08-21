import { sql } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import {
  ServiceError,
  nextDocumentNumber,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * INTER-BUSINESS TRANSFERS — the wedge, made operational.
 *
 * This owner runs seven businesses that constantly serve each other: the AC
 * company fixes the flats the property company rents out, the salon's till is
 * topped up from the shop's cash, one licence renewal is paid by whichever
 * entity had money that week. Seven QuickBooks files cannot record that, so
 * today it is not recorded at all — and PRD-02 problem P2 is the consequence:
 * the property business looks more profitable than it is because it never pays
 * for its own maintenance, and the AC business looks less profitable because it
 * absorbs the cost. Both numbers are wrong, in opposite directions, by the same
 * amount, and the owner makes investment decisions on them.
 *
 * Everything below exists to make that one transaction recordable ONCE and
 * correct on BOTH sides.
 *
 * ── The four invariants (TRD-03 ADR-006, PRD-02 FR-M06) ────────────────────
 *
 *  1. BOTH LEGS OR NEITHER. There is no API here that writes one side. Every
 *     posting goes through `postJournal`, which is one journal inside the
 *     caller's single transaction, and the journal carries the lines for both
 *     business units. It is not "create A, then create B and hope" — a partial
 *     inter-company entry is the exact failure the research says leaves
 *     balances stale for years, and the only reliable defence is making the
 *     half-write unrepresentable.
 *
 *  2. `due_from(A→B) === due_to(B→A)`, ALWAYS, TO THE FILS. Guaranteed by
 *     construction — the two amounts are the same `Money` value written twice
 *     in the same journal — and re-checked from the ledger by
 *     `interBusinessReconciliation`, which is what EC-16 asks to be CI-gated.
 *     Construction alone is not enough: a hand-written journal touching 1700 or
 *     2700 could break the pair, so the check reads EVERY journal that touches
 *     those accounts, not only the ones this file wrote.
 *
 *  3. GROUP PROFIT IS UNCHANGED. Stated carefully, because the honest version
 *     is more useful than the slogan — see `interBusinessEliminations`.
 *
 *  4. THE PRICING BASIS IS RECORDED. A single owner whose businesses transact
 *     with each other creates connected-person transactions under UAE corporate
 *     tax, which carry arm's-length documentation obligations. A balanced
 *     journal is not evidence of a price. So every transfer stores its basis,
 *     and an arm's-length claim without a written justification is refused
 *     rather than silently accepted.
 *
 * ── Where the pair identity lives, and why there is no new table ───────────
 *
 * A reciprocal balance needs an ORDERED PAIR (A, B); `journal_lines` carries
 * only one `business_unit_id`. The pair is therefore derived from the journal's
 * own shape: within one journal, the business unit carrying `INTERCO_DUE_FROM`
 * is A and the one carrying `INTERCO_DUE_TO` is B. That is not a convention
 * invented here — it is already true of the 61 inter-company journals in the
 * seed, so the derivation reconciles historic data as well as new postings, and
 * it needs no migration and no per-pair account explosion (ADR-006 anticipated
 * "two more account families per pair", 30 ordered pairs at six businesses;
 * none of that is necessary).
 *
 * The cost of the derivation, stated plainly: a journal that touches DUE_FROM
 * or DUE_TO for more than two business units has no unambiguous pair. Rather
 * than guess one, such a journal is reported as MALFORMED by the reconciliation
 * check and excluded from every balance. Silently attributing it would be the
 * worse failure — a wrong reciprocal balance that reconciles.
 */

const DUE_FROM = "INTERCO_DUE_FROM";
const DUE_TO = "INTERCO_DUE_TO";

/**
 * The two accounts whose balance must always mirror, as a SQL literal list.
 *
 * Kept in one place because three separate queries below have to agree on it
 * exactly: a balance that reads one set of accounts and a reconciliation check
 * that reads another would be a check that cannot fail.
 */
const INTERCO_KEYS = sql`(${DUE_FROM}, ${DUE_TO})`;

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const transferNature = z.enum(["cash_advance", "shared_cost", "service_performed"]);
export type TransferNature = z.infer<typeof transferNature>;

/**
 * How the amount was set — OPEN QUESTION Q-12.
 *
 * `at_cost` is the DEFAULT, deliberately, and the choice is worth stating
 * because it has corporate-tax consequences:
 *
 *   · PRD-02 FR-M06 describes the base journal as a cost reallocation and says
 *     the performing unit "OPTIONALLY recognises revenue at an arm's-length
 *     rate". Cost is the specified default; arm's length is the option.
 *   · An arm's-length price is a NUMBER SOMEBODY HAS TO JUSTIFY. Defaulting to
 *     it would mean this code inventing a transfer price on the owner's behalf
 *     and stamping it as market-benchmarked. That is precisely the guess Q-12
 *     says not to make, and an undocumented arm's-length claim is worse than no
 *     claim: it asserts compliance the file cannot support.
 *   · At cost, neither side is overstated. The recharge covers what the work
 *     actually consumed, which already fixes problem P2.
 *
 * IF Q-12 RESOLVES TO ARM'S LENGTH: nothing in the journal shape changes — only
 * the amount does, plus a non-zero margin on the performing unit. Every
 * transfer records `pricingBasis` and (for `service_performed`) the underlying
 * `costAmount` in the document metadata, so re-pricing history is a bounded
 * pass over `documents` where `metadata->'interBusiness'->>'pricingBasis' =
 * 'at_cost'`, not an archaeological dig. The `arms_length` path is fully built
 * and reachable today by passing the rate and its written basis.
 */
export const pricingBasis = z.enum(["at_cost", "arms_length"]);
export type PricingBasis = z.infer<typeof pricingBasis>;

/**
 * Whether the transfer is a VAT supply.
 *
 * Not a preference — a fact about the two entities. A supply between two
 * separate taxable persons is standard-rated; a movement between two divisions
 * of the SAME taxable person is not a supply at all and is out of scope. That
 * distinction is already modelled: `business_units.is_separate_legal_entity`,
 * whose own schema comment says it "drives inter-company posting".
 *
 * The default is derived from that column (see `defaultVatPosture`) and matches
 * what the seed already posts for TECH→PROP. It is overridable because Q-6
 * (which entities hold which licences) is open and because a VAT group, if the
 * owner forms one, makes intra-group supplies out of scope regardless.
 */
export const vatPosture = z.enum(["out_of_scope", "standard_rated"]);
export type VatPosture = z.infer<typeof vatPosture>;

/**
 * What the RECEIVING business can do with the input VAT.
 *
 * `irrecoverable` is the answer whenever the receiving unit's supplies are
 * exempt — residential rent is exempt in the UAE, so the property company
 * cannot reclaim the VAT the AC company charges it. Booking that as a reclaim
 * is an FTA assessment risk and is exactly the mistake a spreadsheet makes.
 *
 * OPEN QUESTION Q-1 (standalone parking VAT) lands here: the parking business
 * is `kind = 'rental'` like the flats, so the kind-based default below treats
 * its input VAT as irrecoverable. If parking turns out to be a standard-rated
 * supply, transfers INTO parking should pass `inputVat: "recoverable"` and the
 * default needs to stop keying on `kind`. Flagged rather than guessed.
 */
export const inputVatTreatment = z.enum(["recoverable", "irrecoverable"]);
export type InputVatTreatment = z.infer<typeof inputVatTreatment>;

export const interBusinessTransferInput = z.object({
  /** The business that spends the money or performs the work. Holds DUE FROM. */
  payingBusinessUnitId: z.uuid(),
  /** The business that receives the value. Holds DUE TO. */
  benefitingBusinessUnitId: z.uuid(),
  /**
   * NET amount, excluding VAT. VAT is added on top when the transfer is a
   * supply, exactly as it is on a customer invoice — never taken out of the
   * amount the user typed, because "1,200" on the field-app confirmation screen
   * is what the technician was told the job was worth.
   */
  amount: z.number().positive().max(100_000_000),
  nature: transferNature,
  transferDate: z.iso.date(),

  pricingBasis: pricingBasis.default("at_cost"),
  /** WHY this is an arm's-length price. Mandatory when `pricingBasis` says it is. */
  pricingBasisNote: z.string().max(500).optional(),
  /** The underlying cost, when the price is not the cost. Kept for re-pricing
   *  and as the comparable the transfer-pricing file will need. */
  costAmount: z.number().min(0).max(100_000_000).optional(),

  /** What the paying business gave up. `expense` releases a cost it already booked. */
  fundedFrom: z.enum(["cash", "bank", "expense"]).optional(),
  /** The expense account released, when `fundedFrom` is `expense`. */
  costAccountKey: z.string().min(1).max(40).optional(),
  /** Where the benefiting business books the value it received. */
  benefitAccountKey: z.string().min(1).max(40).optional(),

  vat: vatPosture.optional(),
  inputVat: inputVatTreatment.optional(),

  jobId: z.uuid().nullable().optional(),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export type InterBusinessTransferInput = z.infer<typeof interBusinessTransferInput>;

export interface InterBusinessTransferResult {
  documentId: string;
  docNumber: string;
  journalId: string;
  payingBusinessUnitId: string;
  benefitingBusinessUnitId: string;
  /** Strings, not numbers: these are exact and must not become floats in JSON. */
  net: string;
  tax: string;
  gross: string;
  nature: TransferNature;
  pricingBasis: PricingBasis;
  vat: VatPosture;
  inputVat: InputVatTreatment;
}

/** Ledger account behind each funding choice. */
const FUNDING_ACCOUNT: Record<"cash" | "bank", string> = { cash: "CASH", bank: "BANK" };

/**
 * Defaults per nature. Every one of these is overridable on the input; they
 * exist so the common case is a four-field call rather than a chart-of-accounts
 * exam for whoever is standing in a car park with a phone.
 */
const NATURE_DEFAULTS: Record<
  TransferNature,
  { fundedFrom: "cash" | "bank" | "expense"; benefitAccountKey: string; taxable: boolean }
> = {
  // Money lent between businesses. Not a supply, never VAT, no P&L on either
  // side — the group is neither richer nor poorer, it has just moved cash.
  cash_advance: { fundedFrom: "bank", benefitAccountKey: "BANK", taxable: false },
  // A third party's bill paid by the wrong business. The cost belongs to the
  // benefiting unit and is recharged there.
  shared_cost: { fundedFrom: "bank", benefitAccountKey: "REPAIRS", taxable: true },
  // The wedge: one business does the work, the other consumes it.
  service_performed: { fundedFrom: "expense", benefitAccountKey: "REPAIRS", taxable: true },
};

/** Row shape, so `execute<T>` can index it — hence the snake_case keys. */
type BusinessUnitRow = {
  id: string;
  code: string;
  name: string;
  kind: string;
  separate_legal_entity: boolean;
};

async function loadBusinessUnit(ctx: ServiceContext, id: string): Promise<BusinessUnitRow> {
  const rows = await ctx.tx.execute<BusinessUnitRow>(sql`
    SELECT id, code, name, kind::text AS kind,
           is_separate_legal_entity AS separate_legal_entity
      FROM business_units WHERE id = ${id}::uuid
  `);
  const bu = rows[0];
  if (!bu) throw new ServiceError("Business not found.", "not_found");
  return bu;
}

/**
 * Is this transfer a supply between two taxable persons?
 *
 * Both sides separate legal entities → two taxable persons → standard-rated.
 * Otherwise the money never leaves one taxable person and there is no supply.
 *
 * KNOWN IMPRECISION, with a fix already in the tree. This reads
 * `business_units.is_separate_legal_entity`, a boolean that says "this business
 * is its own company" but not WHICH company — so two business units trading
 * under the SAME trade licence both answer true and this function charges VAT
 * on a movement inside one taxable person. In the seeded portfolio no such pair
 * exists, so the defect is latent rather than live.
 *
 * The correct test is `paying.legalEntityId !== benefiting.legalEntityId`, and
 * `legal_entity_id` arrives with migration `0003_legal_entities.sql` (schema
 * note in `packages/db/src/schema/tenancy.ts`, which deprecates this boolean
 * for exactly this reason). Switching to it is a two-line change here and must
 * happen once that migration is applied AND the column is populated — reading a
 * NULL `legal_entity_id` on both sides would make every transfer look
 * intra-entity and silently stop charging VAT, which is the worse failure.
 */
function defaultVatPosture(
  paying: BusinessUnitRow,
  benefiting: BusinessUnitRow,
  nature: TransferNature,
): VatPosture {
  if (!NATURE_DEFAULTS[nature].taxable) return "out_of_scope";
  return paying.separate_legal_entity && benefiting.separate_legal_entity
    ? "standard_rated"
    : "out_of_scope";
}

/** Rental supplies (residential rent) are exempt, so their input VAT sticks. */
function defaultInputVat(benefiting: BusinessUnitRow): InputVatTreatment {
  return benefiting.kind === "rental" ? "irrecoverable" : "recoverable";
}

/** The standard-rated VAT code, read from the tenant's own tax table rather
 *  than hard-coded, so a rate change is a data change. */
async function standardRatedTaxCode(
  ctx: ServiceContext,
): Promise<{ id: string; rate: M.Money }> {
  const rows = await ctx.tx.execute<{ id: string; rate: string }>(sql`
    SELECT id, rate FROM tax_codes WHERE treatment = 'standard' ORDER BY code LIMIT 1
  `);
  const code = rows[0];
  if (!code) {
    throw new ServiceError(
      "No standard-rated tax code is configured, so VAT cannot be charged on this transfer.",
      "invalid",
    );
  }
  return { id: code.id, rate: M.fromDb(code.rate) };
}

/**
 * Record one business paying for, or working for, another.
 *
 * FR-M06. The shape is uniform across all three natures — one journal, a
 * DUE_FROM debit at the paying unit and a DUE_TO credit at the benefiting unit
 * for the same gross amount, with the value legs in between — because a uniform
 * write shape is what makes the reciprocal invariant checkable by a single
 * query instead of three.
 *
 * WHY THE PAYING SIDE ALWAYS RECOGNISES REVENUE ON `service_performed`, EVEN
 * AT COST: the alternative — crediting the performing unit's own cost accounts
 * — produces the same profit on both sides but no revenue line, so the AC
 * company's turnover would not include work it actually did, and
 * `business_performance` (which reads `documents.subtotal`) would keep showing
 * exactly the understatement problem P2 describes. At cost, the revenue equals
 * the cost and the margin is nil, which is the honest picture of unpriced
 * internal work; at arm's length the same journal carries a margin. Only the
 * AMOUNT differs between the two bases, which is what makes Q-12 a re-pricing
 * question rather than a re-modelling one.
 */
export async function interBusinessTransfer(
  ctx: ServiceContext,
  raw: unknown,
): Promise<InterBusinessTransferResult> {
  const input = interBusinessTransferInput.parse(raw);
  // A journal spanning two businesses is a journal. `journal:post` is the
  // honest permission for the manual path — see `chargeInternalJob` for the
  // deliberately narrower capability the field app uses.
  requirePermission(ctx, "journal:post");
  requireBusinessUnit(ctx, input.payingBusinessUnitId);
  requireBusinessUnit(ctx, input.benefitingBusinessUnitId);
  return postTransfer(ctx, input);
}

/**
 * The posting itself, with NO permission check of its own.
 *
 * Private, and it stays private. Two entry points need this journal under two
 * different permissions — `journal:post` for the manual screen and
 * `job:complete` for the field app — and the two ways of expressing that are:
 * pass the permission in (so "which check?" becomes an argument, and one day
 * `undefined`), or check at each entry point and share the body. The second is
 * the one where a new caller cannot forget, because a new caller has to be a
 * new exported function and there is nowhere in this file to add one without
 * writing a `requirePermission` line next to it.
 *
 * Every caller MUST have already called `requirePermission` for its own gate
 * and `requireBusinessUnit` for the PAYING side. The benefiting side is scoped
 * only on the manual path; `chargeInternalJob` deliberately does not, and says
 * why at the omission itself rather than leaving this comment to describe a
 * rule the file does not keep.
 */
async function postTransfer(
  ctx: ServiceContext,
  input: InterBusinessTransferInput,
): Promise<InterBusinessTransferResult> {
  if (input.payingBusinessUnitId === input.benefitingBusinessUnitId) {
    throw new ServiceError(
      "A business cannot transfer to itself. Pick two different businesses.",
      "invalid",
    );
  }

  // Refused, not defaulted. An arm's-length price with no recorded
  // justification is the transfer-pricing equivalent of an unbalanced journal:
  // it looks like documentation and is not. FR-M06 requires the basis on the
  // document, and "arms_length" alone is a label, not a basis.
  if (input.pricingBasis === "arms_length" && !input.pricingBasisNote) {
    throw new ServiceError(
      "An arm's-length price needs its basis recorded — say how the rate was set " +
        "(price list, third-party quote, comparable job).",
      "invalid",
    );
  }

  return withIdempotency(ctx, input.idempotencyKey, "interBusinessTransfer", async () => {
    const paying = await loadBusinessUnit(ctx, input.payingBusinessUnitId);
    const benefiting = await loadBusinessUnit(ctx, input.benefitingBusinessUnitId);

    const defaults = NATURE_DEFAULTS[input.nature];
    const fundedFrom = input.fundedFrom ?? defaults.fundedFrom;
    const benefitAccountKey = input.benefitAccountKey ?? defaults.benefitAccountKey;
    const vat = input.vat ?? defaultVatPosture(paying, benefiting, input.nature);
    const inputVat = input.inputVat ?? defaultInputVat(benefiting);

    if (fundedFrom === "expense" && input.nature !== "service_performed" && !input.costAccountKey) {
      throw new ServiceError(
        "Say which cost account the paying business is releasing.",
        "invalid",
      );
    }

    // ── Price it ────────────────────────────────────────────────────────────
    const net = M.quantize(M.money(input.amount));
    const taxCode =
      vat === "standard_rated" ? await standardRatedTaxCode(ctx) : null;
    const tax = taxCode ? M.quantize(M.mul(net, taxCode.rate)) : M.ZERO;
    const gross = M.add(net, tax);

    // ── Both legs, one journal ──────────────────────────────────────────────
    //
    // Read this as two blocks that mirror each other. The paying block always
    // debits DUE FROM for the gross and gives up `net` of something; the
    // benefiting block always credits DUE TO for the gross and receives `net`
    // of something. Debits and credits therefore each total 2 × gross by
    // construction — `postJournal` re-checks that exactly, and the deferred
    // database trigger checks it again at COMMIT.
    const payingCreditKey =
      input.nature === "service_performed"
        ? "REV_SERVICE"
        : fundedFrom === "expense"
          ? input.costAccountKey!
          : FUNDING_ACCOUNT[fundedFrom];

    const memo = `${paying.name} → ${benefiting.name}`;
    const legs = [
      { accountKey: DUE_FROM, businessUnitId: paying.id, debit: gross, memo },
      { accountKey: payingCreditKey, businessUnitId: paying.id, credit: net, memo },
      ...(M.gt(tax, M.ZERO)
        ? [{ accountKey: "VAT_OUTPUT", businessUnitId: paying.id, credit: tax, memo }]
        : []),

      { accountKey: benefitAccountKey, businessUnitId: benefiting.id, debit: net, memo },
      ...(M.gt(tax, M.ZERO)
        ? [
            {
              accountKey: inputVat === "recoverable" ? "VAT_INPUT" : "VAT_IRRECOVERABLE",
              businessUnitId: benefiting.id,
              debit: tax,
              memo,
            },
          ]
        : []),
      { accountKey: DUE_TO, businessUnitId: benefiting.id, credit: gross, memo },
    ];

    // ── The document: where the pricing basis is recorded ────────────────────
    //
    // One document, on the performing/paying side, carrying
    // `counterparty_business_unit_id`. That is the shape the seed already uses
    // and the columns were modelled for it.
    //
    // It is written as SETTLED (`paid`, nothing due) on purpose. The amount
    // outstanding between two businesses is the DUE FROM / DUE TO ledger
    // balance, not a receivable: leaving `amount_due` on this document would
    // put an inter-business balance into the AR ageing report and into the
    // "money owed" screen, where it would be chased like a customer debt and
    // double-counted against the reciprocal balance shown on /businesses/interco.
    const docType = input.nature === "service_performed" ? "invoice" : "debit_note";
    const docNumber = await nextDocumentNumber(ctx, paying.id, "interco", `IC-${paying.code}`);

    const basis = {
      nature: input.nature,
      pricingBasis: input.pricingBasis,
      pricingBasisNote: input.pricingBasisNote ?? null,
      armsLengthAmount: input.pricingBasis === "arms_length" ? M.toDb(net) : null,
      costAmount: input.costAmount === undefined ? null : M.toDb(M.money(input.costAmount)),
      vat,
      inputVat,
      fundedFrom,
      benefitAccountKey,
      // Both sides separate taxable persons = connected persons under UAE
      // corporate tax. This flag is what a transfer-pricing extract filters on.
      connectedPersons: paying.separate_legal_entity && benefiting.separate_legal_entity,
      jobId: input.jobId ?? null,
      note: input.note ?? null,
    };

    const doc = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO documents
        (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
         party_name_snapshot, counterparty_business_unit_id, issue_date, due_date,
         currency, subtotal, tax_total, total, amount_paid, amount_due, base_total,
         cost_total, notes, metadata, posted_at)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${paying.id}::uuid,
         ${docType}::doc_type, ${docNumber}, 'paid'::doc_status, 'in'::payment_direction,
         ${`${benefiting.name} (inter-business)`}, ${benefiting.id}::uuid,
         ${input.transferDate}::date, ${input.transferDate}::date,
         ${ctx.baseCurrency}, ${M.toDb(net)}, ${M.toDb(tax)}, ${M.toDb(gross)},
         ${M.toDb(gross)}, '0', ${M.toDb(gross)},
         ${M.toDb(input.costAmount === undefined ? M.ZERO : M.money(input.costAmount))},
         ${input.note ?? null},
         ${JSON.stringify({ interBusiness: basis })}::jsonb, now())
      RETURNING id
    `);
    const documentId = doc[0]!.id;

    await ctx.tx.execute(sql`
      INSERT INTO document_lines
        (id, tenant_id, document_id, line_no, description, quantity, unit_price,
         tax_code_id, tax_rate, tax_amount, line_total, unit_cost, job_id)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${documentId}::uuid, 1,
         ${describeTransfer(input.nature, paying.name, benefiting.name)},
         '1', ${M.toDb(net)}, ${taxCode?.id ?? null}::uuid,
         ${taxCode ? M.toDb(taxCode.rate) : "0"}, ${M.toDb(tax)}, ${M.toDb(gross)},
         ${M.toDb(input.costAmount === undefined ? M.ZERO : M.money(input.costAmount))},
         ${input.jobId ?? null}::uuid)
    `);

    const journalId = await postJournal(ctx, {
      postingDate: input.transferDate,
      source: "inter_company",
      sourceTable: "documents",
      sourceId: documentId,
      narration: `${docNumber} · ${paying.name} → ${benefiting.name}`,
      legs,
    });

    await writeAudit(ctx, {
      action: "interco.transfer",
      entityTable: "documents",
      entityId: documentId,
      businessUnitId: paying.id,
      diff: {
        docNumber,
        counterparty: benefiting.code,
        nature: input.nature,
        net: M.toDb(net),
        tax: M.toDb(tax),
        gross: M.toDb(gross),
        pricingBasis: input.pricingBasis,
        vat,
        inputVat,
      },
    });

    return {
      documentId,
      docNumber,
      journalId,
      payingBusinessUnitId: paying.id,
      benefitingBusinessUnitId: benefiting.id,
      net: M.toDb(net),
      tax: M.toDb(tax),
      gross: M.toDb(gross),
      nature: input.nature,
      pricingBasis: input.pricingBasis,
      vat,
      inputVat,
    };
  });
}

function describeTransfer(nature: TransferNature, payingName: string, benefitingName: string) {
  switch (nature) {
    case "cash_advance":
      return `Cash advanced by ${payingName} to ${benefitingName}`;
    case "shared_cost":
      return `Cost paid by ${payingName} on behalf of ${benefitingName}`;
    case "service_performed":
      return `Work done by ${payingName} for ${benefitingName}`;
  }
}

// ── The job-completion hook ─────────────────────────────────────────────────

export const chargeInternalJobInput = z.object({
  jobId: z.uuid(),
  chargedOn: z.iso.date(),
  pricingBasis: pricingBasis.default("at_cost"),
  pricingBasisNote: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface InternalJobCharge extends InterBusinessTransferResult {
  jobId: string;
  jobNumber: string;
  benefitingBusinessName: string;
}

/**
 * Bill a completed job to the business that owns the unit it was done on.
 *
 * WF-05 §16.1 — "this is the wedge, executed automatically, at the moment the
 * work finishes. The transaction the audit says 'nobody invoices anybody' for
 * gets recorded by the person who did the work, without anyone deciding to
 * record it."
 *
 * PERMISSION, DELIBERATELY NARROWER THAN `interBusinessTransfer`.
 *
 * This requires `job:complete`, NOT `journal:post`. That is not an oversight
 * and it is not a hole. The technician role (`maintenance_staff`) holds
 * `job:complete` and nothing accounting-shaped; requiring `journal:post` here
 * would mean the charge never fires for the only person who is ever standing in
 * the flat, and the feature would degrade to "the accountant remembers later",
 * which is the status quo this exists to replace.
 *
 * What the capability actually grants is bounded on every axis that matters:
 * the caller cannot choose the amount (it comes from the job's own recorded
 * labour and material cost), cannot choose the accounts (fixed here), cannot
 * choose the counterparty (it is whichever business owns the unit), and cannot
 * fire it twice (the job's status transition is taken under `FOR UPDATE`, and
 * an existing charge for the job is refused below). A technician can cause a
 * posting they could already cause the business consequences of; they cannot
 * author one.
 *
 * PRICED AT COST by default — see `pricingBasis` above for Q-12. At cost means
 * labour plus materials as recorded on the job, so the AC company recovers what
 * the visit consumed and the flat carries it. `quoted_value` (the customer
 * price) is deliberately NOT used as the default, because using it would be
 * this file choosing an arm's-length rate.
 */
export async function chargeInternalJob(
  ctx: ServiceContext,
  raw: unknown,
): Promise<InternalJobCharge | null> {
  const input = chargeInternalJobInput.parse(raw);
  requirePermission(ctx, "job:complete");

  const rows = await ctx.tx.execute<{
    id: string;
    job_number: string;
    title: string;
    business_unit_id: string;
    unit_business_unit_id: string | null;
    unit_name: string | null;
    labor_cost: string;
    material_cost: string;
    quoted_value: string | null;
    already_charged: string | null;
  }>(sql`
    SELECT j.id, j.job_number, j.title, j.business_unit_id,
           u.business_unit_id AS unit_business_unit_id,
           COALESCE(u.name, u.code) AS unit_name,
           j.labor_cost, j.material_cost, j.quoted_value,
           (SELECT dl.document_id FROM document_lines dl
              JOIN documents d ON d.id = dl.document_id
             WHERE dl.job_id = j.id AND d.counterparty_business_unit_id IS NOT NULL
             LIMIT 1) AS already_charged
      FROM jobs j
      LEFT JOIN units u ON u.id = j.unit_id
     WHERE j.id = ${input.jobId}::uuid
  `);
  const job = rows[0];
  if (!job) throw new ServiceError("Job not found.", "not_found");
  requireBusinessUnit(ctx, job.business_unit_id);

  // Not an internal job at all, or the property team fixing its own flat.
  // `unit_id IS NOT NULL` alone is NOT the test — a job on a unit owned by the
  // same business that did the work has no counterparty and nothing to
  // transfer, and charging it to itself would inflate both sides of that one
  // business's P&L against an account that must always mirror another business.
  if (!job.unit_business_unit_id || job.unit_business_unit_id === job.business_unit_id) {
    return null;
  }

  // Idempotence with teeth: the caller's status guard already prevents a second
  // completion, but this makes "one charge per job" a property of the data
  // rather than of the call order, so a hand-run backfill cannot double-charge.
  if (job.already_charged) {
    throw new ServiceError(
      `${job.job_number} has already been charged to the other business.`,
      "conflict",
    );
  }

  const cost = M.add(M.fromDb(job.labor_cost), M.fromDb(job.material_cost));
  const amount =
    input.pricingBasis === "arms_length" ? M.fromDb(job.quoted_value) : cost;

  // A job with no recorded cost and no quote has nothing to charge. Posting a
  // zero transfer would create a reciprocal pair of nothing and a document the
  // accountant has to explain, so say nothing happened instead.
  if (!M.gt(amount, M.ZERO)) return null;

  const benefiting = await loadBusinessUnit(ctx, job.unit_business_unit_id);

  // NOTE the absence of `requireBusinessUnit(ctx, benefiting.id)`, which the
  // manual path does call. It is omitted on purpose and the reasoning is the
  // whole justification for this hook existing.
  //
  // The business-unit gate answers "may this person post INTO a business they
  // chose?" — it stops a branch manager writing to another branch's books. Here
  // nothing was chosen: the counterparty is whichever business owns the flat the
  // job was raised against, fixed in the data long before the technician arrived.
  // Enforcing scope would mean the charge fires only for principals who can
  // already see both businesses — i.e. the owner and the accountant — which is
  // precisely the "somebody remembers to record it later" path this replaces.
  // The caller's own business unit IS checked, above.
  const transfer = await postTransfer(ctx, {
    payingBusinessUnitId: job.business_unit_id,
    benefitingBusinessUnitId: job.unit_business_unit_id,
    amount: M.toNumber(amount),
    nature: "service_performed",
    transferDate: input.chargedOn,
    pricingBasis: input.pricingBasis,
    pricingBasisNote: input.pricingBasisNote,
    costAmount: M.toNumber(cost),
    jobId: job.id,
    note: `${job.job_number} · ${job.title}${job.unit_name ? ` · ${job.unit_name}` : ""}`,
    idempotencyKey: input.idempotencyKey ? `job:${input.idempotencyKey}` : undefined,
  });

  await ctx.tx.execute(sql`
    UPDATE jobs SET invoiced_value = ${M.toDb(amount)}, updated_at = now()
     WHERE id = ${job.id}::uuid
  `);

  return {
    ...transfer,
    jobId: job.id,
    jobNumber: job.job_number,
    benefitingBusinessName: benefiting.name,
  };
}

// ── Settlement ──────────────────────────────────────────────────────────────

export const settleInterBusinessInput = z.object({
  /** The business that is OWED — the one carrying DUE FROM. */
  creditorBusinessUnitId: z.uuid(),
  /** The business that OWES — the one carrying DUE TO. */
  debtorBusinessUnitId: z.uuid(),
  amount: z.number().positive().max(100_000_000),
  settledOn: z.iso.date(),
  method: z.enum(["cash", "bank"]).default("bank"),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface SettleInterBusinessResult {
  journalId: string;
  settled: string;
  remaining: string;
}

/**
 * Pay down what one business owes another.
 *
 * Symmetric by construction: the same amount leaves DUE TO on the debtor and
 * DUE FROM on the creditor in one journal, so the reciprocal invariant survives
 * a settlement exactly as it survives a charge.
 *
 * OVER-SETTLEMENT IS REFUSED, NOT CLAMPED. Paying more than is owed would drive
 * the pair balance negative — which reads as "the other business now owes US"
 * and is indistinguishable, on the screen, from a real reverse balance. The
 * house rule against `GREATEST(0, …)` applies here for the same reason it
 * applies to payment allocation: absorbing the excess destroys the evidence of
 * the mistake.
 *
 * THE LOCK. The outstanding balance is derived from `journal_lines`, so there is
 * no row to take `FOR UPDATE` and the read-then-check below is otherwise a
 * textbook check-then-act: two concurrent settlements of AED 12,400 against a
 * AED 12,400 balance would both read 12,400, both pass, and both post. A
 * transaction-scoped advisory lock keyed on the ordered pair serialises them, so
 * the second waits and then fails the check honestly. It is released at COMMIT
 * or ROLLBACK by Postgres, never by us.
 */
export async function settleInterBusiness(
  ctx: ServiceContext,
  raw: unknown,
): Promise<SettleInterBusinessResult> {
  const input = settleInterBusinessInput.parse(raw);
  requirePermission(ctx, "journal:post");
  requireBusinessUnit(ctx, input.creditorBusinessUnitId);
  requireBusinessUnit(ctx, input.debtorBusinessUnitId);

  if (input.creditorBusinessUnitId === input.debtorBusinessUnitId) {
    throw new ServiceError("A business cannot settle with itself.", "invalid");
  }

  return withIdempotency(ctx, input.idempotencyKey, "settleInterBusiness", async () => {
    const pairKey = `${ctx.tenantId}:${input.creditorBusinessUnitId}:${input.debtorBusinessUnitId}`;
    await ctx.tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${pairKey}::text, 0::bigint))
    `);

    const creditor = await loadBusinessUnit(ctx, input.creditorBusinessUnitId);
    const debtor = await loadBusinessUnit(ctx, input.debtorBusinessUnitId);

    // Read via the unchecked reader: the permission gate for this operation is
    // `journal:post`, already asserted above. Going through the public
    // `interBusinessBalances` would additionally demand `report:read`, so an
    // operator who may post could be unable to settle — a gate on a read that
    // only exists to make the write safe.
    const balances = await readBalances(ctx);
    const pair = balances.find(
      (b) =>
        b.creditorBusinessUnitId === creditor.id && b.debtorBusinessUnitId === debtor.id,
    );
    const outstanding = pair ? M.fromDb(pair.outstanding) : M.ZERO;
    const amount = M.quantize(M.money(input.amount));

    if (M.gt(amount, outstanding)) {
      throw new ServiceError(
        `${debtor.name} owes ${creditor.name} ${M.toDisplay(outstanding)}. ` +
          `You cannot settle ${M.toDisplay(amount)}.`,
        "invalid",
      );
    }

    const cashKey = FUNDING_ACCOUNT[input.method];
    const memo = `Settlement ${debtor.name} → ${creditor.name}`;
    const journalId = await postJournal(ctx, {
      postingDate: input.settledOn,
      source: "inter_company",
      sourceTable: "business_units",
      sourceId: creditor.id,
      narration: memo,
      legs: [
        // Creditor collects: cash in, the receivable goes away.
        { accountKey: cashKey, businessUnitId: creditor.id, debit: amount, memo },
        { accountKey: DUE_FROM, businessUnitId: creditor.id, credit: amount, memo },
        // Debtor pays: the payable goes away, cash out.
        { accountKey: DUE_TO, businessUnitId: debtor.id, debit: amount, memo },
        { accountKey: cashKey, businessUnitId: debtor.id, credit: amount, memo },
      ],
    });

    await writeAudit(ctx, {
      action: "interco.settle",
      entityTable: "journals",
      entityId: journalId,
      businessUnitId: creditor.id,
      diff: {
        creditor: creditor.code,
        debtor: debtor.code,
        amount: M.toDb(amount),
        method: input.method,
        outstandingBefore: M.toDb(outstanding),
        note: input.note ?? null,
      },
    });

    return {
      journalId,
      settled: M.toDb(amount),
      remaining: M.toDb(M.sub(outstanding, amount)),
    };
  });
}

// ── Reading the reciprocal position ─────────────────────────────────────────

/**
 * Every journal line that touches either inter-business account, collapsed to
 * one row per (ordered pair, posting date).
 *
 * DELIBERATELY NOT FILTERED ON `source = 'inter_company'`. The invariant is a
 * property of the two ACCOUNTS, not of the code path that wrote them: a manual
 * journal that debits 1700 without a matching 2700 breaks the reciprocal
 * balance just as thoroughly, and a check that only looks at its own postings
 * cannot fail. This is what makes `interBusinessReconciliation` worth gating CI
 * on — it audits the ledger, not this file.
 *
 * `array_agg(DISTINCT …)` rather than `max()` because uuid has no ordering
 * operator; the arrays are also how a malformed multi-business journal is
 * detected rather than silently collapsed to one pair.
 */
const PAIRED_MOVEMENTS = sql`
  WITH leg AS (
    SELECT j.id AS journal_id, j.posting_date, a.system_key,
           jl.business_unit_id, jl.base_debit, jl.base_credit
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE a.system_key IN ${INTERCO_KEYS}
  ),
  paired AS (
    SELECT journal_id, posting_date,
           array_agg(DISTINCT business_unit_id)
             FILTER (WHERE system_key = ${DUE_FROM}) AS creditors,
           array_agg(DISTINCT business_unit_id)
             FILTER (WHERE system_key = ${DUE_TO}) AS debtors,
           COALESCE(SUM(base_debit - base_credit)
             FILTER (WHERE system_key = ${DUE_FROM}), 0) AS due_from,
           COALESCE(SUM(base_credit - base_debit)
             FILTER (WHERE system_key = ${DUE_TO}), 0) AS due_to
      FROM leg
     GROUP BY journal_id, posting_date
  )
`;

/** A journal is well-formed when exactly one business holds each side. */
const WELL_FORMED = sql`
  array_length(creditors, 1) = 1 AND array_length(debtors, 1) = 1
  AND creditors[1] IS NOT NULL AND debtors[1] IS NOT NULL
  AND creditors[1] <> debtors[1]
`;

export interface InterBusinessMovement {
  /** ISO date. */
  on: string;
  /**
   * Signed: positive is a new charge, negative is a settlement. Netted per DAY,
   * which is the granularity FIFO ageing below runs at — a charge and a
   * settlement on the same date cancel before ageing sees either, which is the
   * right answer (nothing was outstanding overnight) and is why the ageing
   * clock is not started by same-day churn.
   */
  dueFromDelta: string;
  dueToDelta: string;
  /** Journals that increased the balance. */
  charges: number;
  /** Journals that reduced it. */
  settlements: number;
}

export interface InterBusinessBalance {
  creditorBusinessUnitId: string;
  creditorCode: string;
  creditorName: string;
  creditorColor: string;
  debtorBusinessUnitId: string;
  debtorCode: string;
  debtorName: string;
  debtorColor: string;
  /** The asset recorded by the creditor. */
  dueFrom: string;
  /** The liability recorded by the debtor. These must be equal. */
  dueTo: string;
  /** `dueFrom - dueTo`. Non-zero means the ledger is broken. */
  difference: string;
  reconciles: boolean;
  /** What is actually owed right now — `dueFrom`, once reconciled. */
  outstanding: string;
  /** Age in days of the OLDEST charge still unsettled, FIFO. Null if settled. */
  ageDays: number | null;
  oldestUnsettledOn: string | null;
  lastMovementOn: string;
  /** Journals that CHARGED this pair. Settlements are counted separately so
   *  "61 transfers" does not silently become 63 after two settlements. */
  transfers: number;
  settlements: number;
  movements: InterBusinessMovement[];
}

/**
 * Reciprocal balances, per ordered pair, straight from the ledger.
 *
 * No stored balance and no cache. A reciprocal balance that is materialised is a
 * reciprocal balance that can drift from the journals it summarises, and the
 * research's documented failure mode for inter-company accounting is exactly
 * that: balances nobody re-derives, going stale for years.
 */
export async function interBusinessBalances(
  ctx: ServiceContext,
): Promise<InterBusinessBalance[]> {
  requirePermission(ctx, "report:read");
  return readBalances(ctx);
}

/** The balance derivation, without the read permission — see `settleInterBusiness`. */
async function readBalances(ctx: ServiceContext): Promise<InterBusinessBalance[]> {
  const rows = await ctx.tx.execute<{
    creditor_id: string;
    creditor_code: string;
    creditor_name: string;
    creditor_color: string;
    debtor_id: string;
    debtor_code: string;
    debtor_name: string;
    debtor_color: string;
    posting_date: string;
    due_from: string;
    due_to: string;
    charges: number;
    settlements: number;
  }>(sql`
    ${PAIRED_MOVEMENTS}
    SELECT cb.id AS creditor_id, cb.code AS creditor_code, cb.name AS creditor_name,
           cb.color_token AS creditor_color,
           db.id AS debtor_id, db.code AS debtor_code, db.name AS debtor_name,
           db.color_token AS debtor_color,
           p.posting_date::text AS posting_date,
           SUM(p.due_from)::text AS due_from,
           SUM(p.due_to)::text AS due_to,
           COUNT(*) FILTER (WHERE p.due_from > 0)::int AS charges,
           COUNT(*) FILTER (WHERE p.due_from < 0)::int AS settlements
      FROM paired p
      JOIN business_units cb ON cb.id = p.creditors[1]
      JOIN business_units db ON db.id = p.debtors[1]
     WHERE ${WELL_FORMED}
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
     ORDER BY 9
  `);

  const byPair = new Map<string, InterBusinessBalance>();
  for (const r of rows) {
    const key = `${r.creditor_id}:${r.debtor_id}`;
    let pair = byPair.get(key);
    if (!pair) {
      pair = {
        creditorBusinessUnitId: r.creditor_id,
        creditorCode: r.creditor_code,
        creditorName: r.creditor_name,
        creditorColor: r.creditor_color,
        debtorBusinessUnitId: r.debtor_id,
        debtorCode: r.debtor_code,
        debtorName: r.debtor_name,
        debtorColor: r.debtor_color,
        dueFrom: "0.0000",
        dueTo: "0.0000",
        difference: "0.0000",
        reconciles: true,
        outstanding: "0.0000",
        ageDays: null,
        oldestUnsettledOn: null,
        lastMovementOn: r.posting_date,
        transfers: 0,
        settlements: 0,
        movements: [],
      };
      byPair.set(key, pair);
    }
    pair.movements.push({
      on: r.posting_date,
      dueFromDelta: M.toDb(M.fromDb(r.due_from)),
      dueToDelta: M.toDb(M.fromDb(r.due_to)),
      charges: r.charges,
      settlements: r.settlements,
    });
  }

  const out: InterBusinessBalance[] = [];
  for (const pair of byPair.values()) {
    const dueFrom = M.sum(pair.movements.map((m) => M.fromDb(m.dueFromDelta)));
    const dueTo = M.sum(pair.movements.map((m) => M.fromDb(m.dueToDelta)));
    const difference = M.sub(dueFrom, dueTo);
    const aged = ageOldestUnsettled(pair.movements, ctx.today);

    out.push({
      ...pair,
      dueFrom: M.toDb(dueFrom),
      dueTo: M.toDb(dueTo),
      difference: M.toDb(difference),
      // Exact. A reciprocal pair that is "close enough" is the tolerance this
      // codebase deleted twelve of; a one-fils gap here means a real posting bug.
      reconciles: M.eq(dueFrom, dueTo),
      outstanding: M.toDb(dueFrom),
      ageDays: aged.ageDays,
      oldestUnsettledOn: aged.on,
      lastMovementOn: pair.movements[pair.movements.length - 1]!.on,
      transfers: pair.movements.reduce((t, m) => t + m.charges, 0),
      settlements: pair.movements.reduce((t, m) => t + m.settlements, 0),
    });
  }

  // Biggest exposure first: the balance most worth settling is the one with the
  // most money sitting in it, and after that the one that has sat longest.
  return out.sort(
    (a, b) =>
      M.cmp(M.fromDb(b.outstanding), M.fromDb(a.outstanding)) ||
      (b.ageDays ?? 0) - (a.ageDays ?? 0),
  );
}

/**
 * FIFO ageing.
 *
 * A running total tells the owner how much is owed; it cannot tell him that AED
 * 12,400 of it has been sitting there since May, which is the number that makes
 * him act. Settlements consume the oldest charges first — the same convention
 * as customer payment allocation, and for the same reason: allocating to the
 * newest charge would leave a permanently ancient balance that is in fact being
 * paid.
 */
function ageOldestUnsettled(
  movements: InterBusinessMovement[],
  today: string,
): { on: string | null; ageDays: number | null } {
  const open: { on: string; amount: M.Money }[] = [];
  for (const m of movements) {
    const delta = M.fromDb(m.dueFromDelta);
    if (M.gt(delta, M.ZERO)) {
      open.push({ on: m.on, amount: delta });
      continue;
    }
    let credit = M.neg(delta);
    while (M.gt(credit, M.ZERO) && open.length > 0) {
      const head = open[0]!;
      const take = M.min(credit, head.amount);
      head.amount = M.sub(head.amount, take);
      credit = M.sub(credit, take);
      if (M.isZero(head.amount)) open.shift();
    }
  }

  const oldest = open.find((o) => M.gt(o.amount, M.ZERO));
  if (!oldest) return { on: null, ageDays: null };
  const MS_PER_DAY = 86_400_000;
  const ageDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest.on}T00:00:00Z`)) / MS_PER_DAY,
  );
  return { on: oldest.on, ageDays };
}

export interface InterBusinessReconciliation {
  ok: boolean;
  pairsChecked: number;
  /** Pairs where the two sides disagree. Empty is the only acceptable state. */
  breaks: {
    creditorCode: string;
    debtorCode: string;
    dueFrom: string;
    dueTo: string;
    difference: string;
  }[];
  /** Journals touching 1700/2700 with no unambiguous counterparty pair. */
  malformed: { journalId: string; journalNumber: string; postingDate: string; detail: string }[];
  /** Total absolute discrepancy across the ledger. Must be exactly zero. */
  totalDifference: string;
}

/**
 * EC-16 — "inter-business balances do not net".
 *
 * The assertion the audit asks to be CI-gated and surfaced in the pre-close
 * checklist. It re-derives both sides of every pair from `journal_lines` and
 * reports any pair that disagrees, plus any journal that touches an
 * inter-business account without a resolvable counterparty.
 *
 * It reads the whole ledger deliberately: the value of this check is that it
 * would catch a break introduced by a manual journal, a bad migration or a
 * future service, none of which go through the code above.
 */
export async function interBusinessReconciliation(
  ctx: ServiceContext,
): Promise<InterBusinessReconciliation> {
  requirePermission(ctx, "report:read");

  const balances = await interBusinessBalances(ctx);
  const breaks = balances
    .filter((b) => !b.reconciles)
    .map((b) => ({
      creditorCode: b.creditorCode,
      debtorCode: b.debtorCode,
      dueFrom: b.dueFrom,
      dueTo: b.dueTo,
      difference: b.difference,
    }));

  const malformedRows = await ctx.tx.execute<{
    journal_id: string;
    journal_number: string;
    posting_date: string;
    creditors: number;
    debtors: number;
  }>(sql`
    ${PAIRED_MOVEMENTS}
    SELECT p.journal_id, j.journal_number, p.posting_date::text AS posting_date,
           COALESCE(array_length(p.creditors, 1), 0)::int AS creditors,
           COALESCE(array_length(p.debtors, 1), 0)::int AS debtors
      FROM paired p
      JOIN journals j ON j.id = p.journal_id
     WHERE NOT (${WELL_FORMED})
     ORDER BY p.posting_date DESC
  `);

  const malformed = malformedRows.map((r) => ({
    journalId: r.journal_id,
    journalNumber: r.journal_number,
    postingDate: r.posting_date,
    detail:
      r.creditors === 0
        ? "credits Due to Group Companies with no matching Due from"
        : r.debtors === 0
          ? "debits Due from Group Companies with no matching Due to"
          : `spans ${r.creditors} paying and ${r.debtors} benefiting businesses — no single pair`,
  }));

  const totalDifference = M.sum(balances.map((b) => M.abs(M.fromDb(b.difference))));

  return {
    ok: breaks.length === 0 && malformed.length === 0,
    pairsChecked: balances.length,
    breaks,
    malformed,
    totalDifference: M.toDb(totalDifference),
  };
}

// ── Consolidation ───────────────────────────────────────────────────────────

export interface EliminationRow {
  creditorBusinessUnitId: string;
  creditorCode: string;
  creditorName: string;
  debtorBusinessUnitId: string;
  debtorCode: string;
  debtorName: string;
  /** Income recognised inside the group by the performing business. */
  internalRevenue: string;
  /** Cost recognised inside the group by the benefiting business. */
  internalCost: string;
  /** `internalRevenue - internalCost`. Zero when the transfer was at cost. */
  internalMargin: string;
  /** Input VAT the benefiting business cannot reclaim. NOT eliminated. */
  irrecoverableVat: string;
  transfers: number;
}

export interface InterBusinessEliminations {
  from: string;
  to: string;
  rows: EliminationRow[];
  /** Remove from a revenue figure built by summing the businesses. */
  revenueElimination: string;
  /** Remove from a cost figure built by summing the businesses. */
  costElimination: string;
  /**
   * How much a DOCUMENT-DERIVED sum of business profits overstates the group.
   * Zero when everything was transferred at cost. See the docblock.
   */
  profitElimination: string;
  /** A real group cost of transacting internally. Never eliminated. */
  irrecoverableVat: string;
  /** Ledger-derived, over the same window: Σ income − Σ expense, per business. */
  sumOfBusinessProfit: string;
  /**
   * Income and expense posted with NO business unit on the line. Included in
   * `groupProfit` and excluded from `byBusiness`, so the parts and the whole
   * reconcile: `sumOfBusinessProfit = Σ byBusiness.profit + unattributedProfit`.
   * A non-zero value here is a posting bug worth chasing, not a rounding.
   */
  unattributedProfit: string;
  /** The consolidated figure. */
  groupProfit: string;
  /** Per-business ledger profit, so the P&L can show the parts and the whole. */
  byBusiness: {
    businessUnitId: string;
    code: string;
    name: string;
    color: string;
    profit: string;
  }[];
}

/**
 * The elimination data behind the group profit-and-loss (WF-05 §11 and §6).
 *
 * WF-05 §11 is explicit about why this exists: "the elimination is shown, not
 * just its effect. The owner needs to see that the group figure is smaller than
 * the sum of the parts and why, or he will not trust it."
 *
 * WHAT IS ACTUALLY TRUE, WHICH IS NOT QUITE THE SLOGAN.
 *
 * "Group profit is unchanged by an inter-business transfer" is correct, and
 * from a double-entry ledger it is correct AUTOMATICALLY: the performing
 * business's income and the benefiting business's cost are both already in the
 * journals, so summing (income − expense) across all business units nets them
 * to zero without anyone eliminating anything. `sumOfBusinessProfit` and
 * `groupProfit` below are therefore EQUAL, and that equality is the invariant —
 * not a subtraction that has to be performed.
 *
 * So what is there to eliminate? Two real things, and one apparent one:
 *
 *  1. REVENUE AND COST ARE BOTH GROSSED UP. The group did not sell AED 21,260
 *     of AC work to the world; it sold it to itself. `revenueElimination` and
 *     `costElimination` are what a consolidated turnover figure must remove.
 *     They are equal at cost, so profit does not move.
 *
 *  2. IRRECOVERABLE VAT IS A GENUINE GROUP COST AND IS NOT ELIMINATED. When the
 *     AC company (a taxable person) invoices the property company (whose
 *     residential rent is exempt), 5% leaves the group permanently and goes to
 *     the FTA. That is real money and it belongs in group profit. Netting it out
 *     would flatter the accounts and hide the strongest argument the owner has
 *     for VAT-grouping the entities.
 *
 *  3. THE APPARENT ONE: `profitElimination` is non-zero only when transfers
 *     carried a MARGIN — i.e. arm's-length pricing. It is what a sum of
 *     DOCUMENT-derived business results (`business_performance`, which reads
 *     `documents.subtotal − documents.cost_total` and therefore sees the
 *     performing side's invoice but never the benefiting side's cost)
 *     overstates the group by. A P&L screen built by summing that metric MUST
 *     subtract it; a P&L built from the ledger must not.
 *
 * The window is inclusive on both ends and is applied to `posting_date`.
 */
export async function interBusinessEliminations(
  ctx: ServiceContext,
  params: { from: string; to: string },
): Promise<InterBusinessEliminations> {
  requirePermission(ctx, "report:read");

  const rows = await ctx.tx.execute<{
    creditor_id: string;
    creditor_code: string;
    creditor_name: string;
    debtor_id: string;
    debtor_code: string;
    debtor_name: string;
    internal_revenue: string;
    internal_cost: string;
    irrecoverable_vat: string;
    transfers: number;
  }>(sql`
    ${PAIRED_MOVEMENTS},
    scoped AS (
      SELECT journal_id, creditors[1] AS creditor_id, debtors[1] AS debtor_id
        FROM paired
       WHERE ${WELL_FORMED}
         AND posting_date BETWEEN ${params.from}::date AND ${params.to}::date
    ),
    effect AS (
      SELECT s.creditor_id, s.debtor_id, s.journal_id,
             COALESCE(SUM(jl.base_credit - jl.base_debit)
               FILTER (WHERE a.type = 'income'), 0) AS revenue,
             COALESCE(SUM(jl.base_debit - jl.base_credit)
               FILTER (WHERE a.type = 'expense'
                         AND a.system_key IS DISTINCT FROM 'VAT_IRRECOVERABLE'), 0) AS cost,
             COALESCE(SUM(jl.base_debit - jl.base_credit)
               FILTER (WHERE a.system_key = 'VAT_IRRECOVERABLE'), 0) AS vat
        FROM scoped s
        JOIN journal_lines jl ON jl.journal_id = s.journal_id
        JOIN accounts a ON a.id = jl.account_id
       GROUP BY 1, 2, 3
    )
    SELECT cb.id AS creditor_id, cb.code AS creditor_code, cb.name AS creditor_name,
           db.id AS debtor_id, db.code AS debtor_code, db.name AS debtor_name,
           SUM(e.revenue)::text AS internal_revenue,
           SUM(e.cost)::text AS internal_cost,
           SUM(e.vat)::text AS irrecoverable_vat,
           -- Settlements travel through the same accounts but move no revenue
           -- and no cost, so counting them as transfers would inflate the
           -- figure the owner reads as "how much work did we do for ourselves".
           COUNT(*) FILTER (WHERE e.revenue <> 0 OR e.cost <> 0)::int AS transfers
      FROM effect e
      JOIN business_units cb ON cb.id = e.creditor_id
      JOIN business_units db ON db.id = e.debtor_id
     GROUP BY 1, 2, 3, 4, 5, 6
     ORDER BY 7 DESC
  `);

  const profitRows = await ctx.tx.execute<{
    id: string;
    code: string;
    name: string;
    color_token: string;
    profit: string;
  }>(sql`
    WITH pl AS (
      SELECT jl.business_unit_id,
             -- Profit contribution is (credit - debit) for BOTH sides: income is
             -- credit-natured, and an expense reduces profit by its debit. One
             -- expression rather than two signed cases, so there is no sign to
             -- get backwards.
             SUM(jl.base_credit - jl.base_debit) AS profit
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.type IN ('income', 'expense')
         AND j.posting_date BETWEEN ${params.from}::date AND ${params.to}::date
       GROUP BY jl.business_unit_id
    )
    SELECT b.id, b.code, b.name, b.color_token,
           COALESCE(pl.profit, 0)::text AS profit
      FROM business_units b
      LEFT JOIN pl ON pl.business_unit_id = b.id
     WHERE b.is_active = true
     ORDER BY b.sort_order
  `);

  const unattributedRows = await ctx.tx.execute<{ profit: string }>(sql`
    SELECT COALESCE(SUM(jl.base_credit - jl.base_debit), 0)::text AS profit
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE a.type IN ('income', 'expense')
       AND jl.business_unit_id IS NULL
       AND j.posting_date BETWEEN ${params.from}::date AND ${params.to}::date
  `);
  const unattributedProfit = M.fromDb(unattributedRows[0]?.profit);

  const eliminationRows: EliminationRow[] = rows.map((r) => {
    const revenue = M.fromDb(r.internal_revenue);
    const cost = M.fromDb(r.internal_cost);
    return {
      creditorBusinessUnitId: r.creditor_id,
      creditorCode: r.creditor_code,
      creditorName: r.creditor_name,
      debtorBusinessUnitId: r.debtor_id,
      debtorCode: r.debtor_code,
      debtorName: r.debtor_name,
      internalRevenue: M.toDb(revenue),
      internalCost: M.toDb(cost),
      internalMargin: M.toDb(M.sub(revenue, cost)),
      irrecoverableVat: M.toDb(M.fromDb(r.irrecoverable_vat)),
      transfers: r.transfers,
    };
  });

  const revenueElimination = M.sum(eliminationRows.map((r) => M.fromDb(r.internalRevenue)));
  const costElimination = M.sum(eliminationRows.map((r) => M.fromDb(r.internalCost)));
  const irrecoverableVat = M.sum(eliminationRows.map((r) => M.fromDb(r.irrecoverableVat)));
  const sumOfBusinessProfit = M.add(
    M.sum(profitRows.map((p) => M.fromDb(p.profit))),
    unattributedProfit,
  );

  return {
    from: params.from,
    to: params.to,
    rows: eliminationRows,
    revenueElimination: M.toDb(revenueElimination),
    costElimination: M.toDb(costElimination),
    profitElimination: M.toDb(M.sub(revenueElimination, costElimination)),
    irrecoverableVat: M.toDb(irrecoverableVat),
    sumOfBusinessProfit: M.toDb(sumOfBusinessProfit),
    unattributedProfit: M.toDb(unattributedProfit),
    // The ledger has already netted the internal legs against each other. The
    // consolidated figure IS the sum of the parts; proving that is the point.
    groupProfit: M.toDb(sumOfBusinessProfit),
    byBusiness: profitRows.map((p) => ({
      businessUnitId: p.id,
      code: p.code,
      name: p.name,
      color: p.color_token,
      profit: M.toDb(M.fromDb(p.profit)),
    })),
  };
}

// ── The transfer register ───────────────────────────────────────────────────

export interface InterBusinessTransferRow {
  documentId: string;
  docNumber: string;
  issueDate: string;
  payingCode: string;
  payingName: string;
  benefitingCode: string;
  benefitingName: string;
  description: string;
  net: string;
  tax: string;
  gross: string;
  nature: TransferNature | null;
  pricingBasis: PricingBasis | null;
  pricingBasisNote: string | null;
  connectedPersons: boolean;
  jobId: string | null;
}

/**
 * Recent transfers, newest first.
 *
 * Reads the DOCUMENT rather than the journal because the pricing basis lives
 * there, and the pricing basis is the column an FTA transfer-pricing enquiry
 * actually asks for. Historic seed transfers carry no basis metadata, so those
 * fields come back null rather than being invented — an unknown basis must look
 * unknown.
 */
export async function interBusinessTransfers(
  ctx: ServiceContext,
  params: { limit?: number } = {},
): Promise<InterBusinessTransferRow[]> {
  requirePermission(ctx, "report:read");

  const rows = await ctx.tx.execute<{
    id: string;
    doc_number: string;
    issue_date: string;
    paying_code: string;
    paying_name: string;
    benefiting_code: string;
    benefiting_name: string;
    description: string | null;
    subtotal: string;
    tax_total: string;
    total: string;
    nature: string | null;
    pricing_basis: string | null;
    pricing_basis_note: string | null;
    connected_persons: boolean | null;
    job_id: string | null;
  }>(sql`
    SELECT d.id, d.doc_number, d.issue_date::text AS issue_date,
           pb.code AS paying_code, pb.name AS paying_name,
           bb.code AS benefiting_code, bb.name AS benefiting_name,
           (SELECT dl.description FROM document_lines dl
             WHERE dl.document_id = d.id ORDER BY dl.line_no LIMIT 1) AS description,
           d.subtotal, d.tax_total, d.total,
           d.metadata -> 'interBusiness' ->> 'nature' AS nature,
           d.metadata -> 'interBusiness' ->> 'pricingBasis' AS pricing_basis,
           d.metadata -> 'interBusiness' ->> 'pricingBasisNote' AS pricing_basis_note,
           (d.metadata -> 'interBusiness' ->> 'connectedPersons')::boolean AS connected_persons,
           (SELECT dl.job_id FROM document_lines dl
             WHERE dl.document_id = d.id AND dl.job_id IS NOT NULL LIMIT 1)::text AS job_id
      FROM documents d
      JOIN business_units pb ON pb.id = d.business_unit_id
      JOIN business_units bb ON bb.id = d.counterparty_business_unit_id
     WHERE d.counterparty_business_unit_id IS NOT NULL
       AND d.status NOT IN ('cancelled', 'void', 'draft')
     ORDER BY d.issue_date DESC, d.doc_number DESC
     LIMIT ${params.limit ?? 25}
  `);

  return rows.map((r) => ({
    documentId: r.id,
    docNumber: r.doc_number,
    issueDate: r.issue_date,
    payingCode: r.paying_code,
    payingName: r.paying_name,
    benefitingCode: r.benefiting_code,
    benefitingName: r.benefiting_name,
    description: r.description ?? `${r.paying_name} → ${r.benefiting_name}`,
    net: M.toDb(M.fromDb(r.subtotal)),
    tax: M.toDb(M.fromDb(r.tax_total)),
    gross: M.toDb(M.fromDb(r.total)),
    nature: (r.nature as TransferNature | null) ?? null,
    pricingBasis: (r.pricing_basis as PricingBasis | null) ?? null,
    pricingBasisNote: r.pricing_basis_note,
    connectedPersons: r.connected_persons ?? false,
    jobId: r.job_id,
  }));
}
