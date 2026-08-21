# Adviser question briefs

Eight open questions in `MASTER_PROJECT_STATE.md` §4 are blocked on someone outside this
project — a tax adviser, an employment lawyer, a data-protection adviser, the group's bank,
the group's WPS agent. They have stayed open across three build waves, and part of the
reason is how they were written. "Standalone parking VAT treatment" is a topic. It is not a
question anyone can bill against.

Each section below is a **brief**: a self-contained page that can be sent to the relevant
professional with no further explanation. It states the question, the group's actual fact
pattern with real figures from the system, the position the software takes today with the
file and line that takes it, what the position is worth arithmetically, and what changes if
the answer comes back differently.

Ninth brief: **Q-2** is included alongside **Q-2b**. It is a separate register question with
the same owner and the same fact pattern, and sending an employment lawyer one without the
other wastes half the engagement.

## How to read these

**Nothing in this document is legal or tax advice, and nothing in it answers any of these
questions.** Where a brief states a concern about the current position, it is attributed —
to the UAE audit, to a code comment, to a specification document — and marked
**UNVERIFIED**. That marking means exactly what it says: nobody on this project has read the
primary source. The point of a brief is to hand the adviser a specific position to confirm
or correct, not to pre-empt them.

Figures marked *(live)* were computed against the seeded development database on
**2026-08-21** by querying it directly, or by executing the engine named in the brief. They
describe a demonstration portfolio, not audited accounts, and they are there to give the
adviser a sense of scale. Figures marked *(illustrative)* come from a worked example in the
code or the audit.

All amounts are AED.

---

## Priority ordering

Two different things are being ranked here, and the owner is deciding where to spend adviser
money, so they are kept apart.

**Class A — blocks work outright.** Nothing proceeds until answered. The cost of not asking
is not a wrong number; it is that a whole activity cannot start.

**Class B — expensive if wrong.** The software runs today. It takes a position, and if the
position is wrong the error accrues quietly until someone assesses it.

| # | Brief | Class | What it unblocks | Effort to obtain |
|---|---|---|---|---|
| 1 | **B-1 · Q-8 — PDPL cross-border** | **A** | Real data entering the system *at all*; therefore the pilot, the salon adoption log, and every downstream gate. Also decides where the backup bucket may live | Paid engagement, weeks of lead time. The single highest-value spend on this list |
| 2 | **B-2 · Q-1b — VAT apportionment basis** | **B** | The residual figure on every VAT return the business will ever file | Same adviser, same meeting as B-3. Marginal cost close to zero if bundled |
| 3 | **B-3 · Q-1 — standalone parking VAT and the floorspace method** | **B** | VAT fixtures; whether to lodge a special-method application | Bundle with B-2 |
| 4 | **B-4 · Q-2b — gross-misconduct gratuity forfeiture** | **B** | Any misconduct termination; the honesty of the gratuity register | One written opinion, or a MOHRE enquiry. Cheap |
| 5 | **B-5 · Q-2 — resignation vs termination gratuity** | **B** | Same engagement as B-4 | Free if bundled with B-4 |
| 6 | **B-6 · Q-7 — the WPS SIF layout** | **A** *(for payroll)* | Filing salaries through the system rather than by spreadsheet | **Cheapest on the list.** A document request to a supplier the group already pays |
| 7 | **B-7 · Q-5 — can a cleared cheque be returned?** | **B** | Closing a deliberate gap in the cheque state machine | An email to the group's relationship manager. Near-free |
| 8 | **B-8 · Q-6 — which entities hold which licences** | **B** | Corporate-tax assessment per taxable person; e-invoicing entity mapping | No external adviser needed at all — the owner and the accountant hold the answer |
| 9 | **B-9 · Q-12 — inter-business services at cost or arm's length** | **B** | The transfer-pricing position, and the P&L shape of every business unit | Same tax adviser. Decide early — see the brief |

**If only two things get commissioned:** B-1, because it is the only Class A item with no
engineering workaround and it gates everything the product is for; and B-6, because it costs
a single email to a supplier and is the difference between the payroll file being generated
and being guessed.

**Cheapest three to obtain, regardless of value:** B-8 (internal), B-7 (one email), B-6 (one
document request). None of the three needs a paid engagement. All three have been open for
three waves.

---

## B-1 · Q-8 — PDPL cross-border transfer for a database outside the UAE

### Question

Does hosting the production database and its backups outside the UAE — currently Neon in
`ap-southeast-1` (Singapore) — satisfy the cross-border transfer requirements of Federal
Decree-Law 45/2021 (PDPL) for personal data attached to UAE real-estate records that carry a
fifteen-year retention obligation; and if it does, under which transfer mechanism and with
what documentation?

Answerable as: *yes, under mechanism X, subject to Y* — or *no, the data must rest in the
UAE*.

### Our fact pattern

A single owner operates seven businesses in Dubai through what are currently four separately
flagged legal entities: residential property rental in Jumeirah Village Circle, standalone
parking in Business Bay, a gents salon in Al Barsha, an AC field-service company in Al Quoz,
a mobile phone shop in Deira, an online store, and a contracting company.

The system holds, or will hold once real data enters it:

- **447 counterparty records** *(live)* — tenants, customers, suppliers — with names,
  contact details, Emirates ID numbers and trade licence numbers.
- **14 active employees** *(live)* with Emirates ID, passport, visa and labour-card details,
  bank IBANs and salary data. This is the WPS population.
- **Residential tenancy records**, which are the fifteen-year-retention category.
  Post-dated-cheque instruments are part of that record: 111 cheques are on file *(live)*, of
  which 81 have cleared, totalling AED 788,635.

Personal data at rest is encrypted at field level (AES-256-GCM with a blind index), and
backups are encrypted before they leave the machine. **Encryption is not the question.** The
question is jurisdiction: where the ciphertext and the operational database are permitted to
come to rest, and for how long.

### The position the software takes today

There is no position. The system is deployed to Vercel with a Neon database in
`ap-southeast-1`, recorded at `docs/MASTER_PROJECT_STATE.md:249` and
`docs/TRD-03-technical-requirements.md:783`, and the specifications state plainly that the
transfer position is undocumented:

- `docs/TRD-03-technical-requirements.md:722` lists, as required before real data: a record
  of processing activities, data processing agreements with each processor, a documented
  72-hour breach response, "and a cross-border transfer position for a database in
  `ap-southeast-1` rather than the UAE".
- `docs/PRD-02-product-requirements.md:959` marks the retention control **"Not met — blocks
  the pilot."**
- `docs/03-roadmap.md:88` gates the salon's fourteen-day adoption run on it: "no real data
  may enter the system yet".

The offsite backup replication that landed in this wave makes the dependency concrete rather
than theoretical. `scripts/backup-replicate.mjs` requires `BACKUP_S3_REGION` and
`BACKUP_S3_ENDPOINT` and **deliberately gives them no default** — the script refuses to run
and prints, at `scripts/backup-replicate.mjs:155-157`:

> `BACKUP_S3_REGION` and `BACKUP_S3_ENDPOINT` have no default because choosing where UAE
> personal data rests for fifteen years is a legal decision (open question Q-8), not a code
> default.

The retention floor is compiled in at `scripts/backup-replicate.mjs:87`
(`RETENTION_FLOOR_YEARS = 15`) and any attempt to configure a shorter one is refused.

### What it is worth

This one does not resolve to an amount. It resolves to a gate.

- **Today:** the pilot cannot start. No real tenancy, payroll or customer record may be
  entered. Three build waves have produced a system that is, by its own go-live runbook,
  forbidden to hold the data it was built for.
- **Cost if the answer is "no", asked now:** re-provision the database in a UAE region and
  re-point the backup bucket. The schema is 103 tables under versioned migrations; there is
  no production data to move. Effectively the cost of a re-deploy.
- **Cost if the answer is "no", asked after the pilot:** the same migration, plus moving
  live personal data that has already been transferred to a jurisdiction it should not have
  reached — which is a notification question, not just an engineering one.

The asymmetry is the entire argument for asking first. The engineering cost of the bad
answer roughly doubles every time real data lands before it is known.

### What changes if the answer differs

| Answer | Consequence |
|---|---|
| Yes, permitted under an adequacy or contractual mechanism | Configuration and paperwork: set `BACKUP_S3_REGION`/`BACKUP_S3_ENDPOINT`, execute the DPAs, write the record of processing activities. No code change |
| Yes, but only with the data resting in the UAE | Infrastructure migration: UAE-region Postgres, UAE-region object storage. A cost and vendor decision, not a rewrite — no schema or application change |
| Yes for operational data, no for the fifteen-year archive | A split: operational database stays, archive replicates to a UAE bucket. `backup-replicate.mjs` already parameterises region and endpoint, so this is configuration plus a second target |
| No | Full migration before any real data is entered, which is the cheap version of this outcome and the reason to ask now |

### Who owns it

A **UAE data-protection adviser**. Register owner per `MASTER_PROJECT_STATE.md:206`.

### What a complete answer looks like

A written position that states:

1. Whether the transfer to Singapore is permitted, and under which article and mechanism.
2. Whether the fifteen-year real-estate retention obligation carries an in-UAE residency
   requirement distinct from the transfer question, and if so which records it attaches to
   (tenancy contracts only, or the cheque instruments and party records with them).
3. Whether backups and the operational database are treated identically, or whether the
   archive is subject to a stricter rule.
4. What documentation must exist before real data is entered — record of processing
   activities, DPAs with Vercel, Neon, the storage provider, the delivery provider and
   Anthropic, and a breach-response procedure.
5. A named region, or a named criterion by which a region may be chosen. The backup script
   needs one string; the reason it refuses to guess is that guessing is the failure mode.

---

## B-2 · Q-1b — the basis the VAT apportionment ratio is computed from

### Question

Under Article 55 of the Executive Regulation (Cabinet Decision 52/2017), is the FTA's
standard input-tax apportionment method computed from **supplies value** (taxable supplies ÷
total supplies) or from **input-tax amounts** (input tax attributable to taxable supplies ÷
that plus input tax attributable to exempt supplies)?

Answerable as: *supplies value* or *input-tax amounts*.

### Our fact pattern

The portfolio makes both taxable and exempt supplies, so residual input VAT on shared
overheads must be apportioned. Over the trailing twelve months *(live)*:

| Supply | Account | Amount | Treatment |
|---|---|---|---|
| Contract revenue | 4400 | 2,192,760.00 | Standard |
| Product sales | 4200 | 682,330.48 | Standard |
| Service revenue | 4100 | 312,398.12 | Standard |
| Parking income | 4310 | 108,806.00 | Standard *(subject to B-3)* |
| **Taxable supplies** | | **3,296,294.60** | |
| Residential rental income | 4300 | 636,494.00 | **Exempt** |
| **Total supplies** | | **3,932,788.60** | |

On the supplies basis the recovery ratio is **3,296,294.60 ÷ 3,932,788.60 = 83.82%**
*(live)*.

Residual input VAT is close to nil in the seeded data because few supplier bills have been
posted through the purchasing path — so the live exposure is small **today** and grows
directly with the residual as real overhead bills start flowing. The number that matters is
the one below.

### The position the software currently takes

**Supplies value.** `packages/core/src/uae/tax.ts:547`:

```ts
const suppliesRatio = M.gt(totalSup, M.ZERO) ? M.div(taxable, totalSup) : M.money(1);
```

and the basis is named as a constant at `packages/core/src/uae/tax.ts:265`:

```ts
export const APPORTIONMENT_BASIS_IN_USE = "supplies_value" as const;
```

**The concern, attributed and UNVERIFIED.** The UAE audit (`audit-uae.md`, CALC-3) records:
that turnover-based apportionment is the **UK** partial-exemption standard method, which is
the likely origin of this formula; that the UAE standard method under Cabinet Decision
52/2017 Art. 55 may instead work from input-tax amounts; and that the auditor was
"moderately but not fully confident of this and [had] not verified it against the regulation
text". The docblock at `tax.ts:234-264` repeats the warning in the code and states plainly
that **nobody on this project has read the regulation text.**

The code and the VAT screen previously both described the supplies formula as "the FTA's
standard input-tax apportionment method" without evidence. That claim is now marked as
unconfirmed in the engine, in the persisted return and on screen
(`apps/web/src/app/(app)/accounting/vat/page.tsx:412`, which renders the row *"Apportionment
basis confirmed with tax adviser — NO, open question"*). One place still asserts it as fact:
`docs/05-uae-localisation.md:35-37`.

The alternative is deliberately not implemented and not switchable. It is parked as an
`it.todo` at `packages/core/src/uae/vat.test.ts:449`.

### What it is worth

Worked example from the code's own docblock *(illustrative)* — the same numbers appear in
`tax.ts:248-254` and in the parked test:

Input tax directly attributable to taxable supplies 50,000; directly attributable to exempt
supplies 10,000; residual 20,000; supplies split 1,000,000 taxable / 1,000,000 exempt.

| Basis | Ratio | Residual recovered |
|---|---|---|
| Supplies value *(in use)* | 1,000,000 ÷ 2,000,000 = **50.00%** | 20,000 × 0.50 = **10,000.00** |
| Input-tax amounts | 50,000 ÷ 60,000 = **83.33%** | 20,000 × 50,000 ÷ 60,000 = **16,666.67** |
| **Difference, one quarter** | | **6,666.67** |

The code docblock and the register round this to AED 6,667; the exact figure is 6,666.67.

Two quarters on the same facts is **13,333.34**, past the **AED 10,000** voluntary-disclosure
threshold recorded at `docs/PRD-02-product-requirements.md:68` and carried in the code as
`VOLUNTARY_DISCLOSURE_THRESHOLD` (`tax.ts:232`). Above that threshold, an error on a filed
return must be disclosed and carries a monthly penalty.

The direction matters: on this shape of facts the supplies basis recovers **less**, so being
wrong this way is over-payment rather than under-declaration. That is not a reason to relax.
It reverses whenever the exempt business carries a disproportionate share of directly
attributable input tax, and either direction is a misstated return.

### What changes if the answer differs

**Configuration-shaped, but not a runtime switch.** Both inputs the alternative needs —
`directlyAttributableInput` and `exemptAttributableInput` — are already fields on
`VatReturnInput` (`tax.ts`), so computing the input-tax ratio needs no new data and no schema
change. `ApportionmentBasis` already enumerates `"input_tax_value"` (`tax.ts:267`).

`APPORTIONMENT_BASIS_IN_USE` is deliberately a constant rather than a setting. The reasoning
is recorded in its docblock: a switch would invite someone to flip it without the adviser's
answer.

**On restatement:** every VAT return persisted from this wave onward records the basis and
ratio that produced it — `vat_returns.apportionment_basis` and
`vat_returns.fta_approval_reference`
(`packages/db/src/schema/accounting.ts:269-273`). A change of basis is therefore a bounded
query over filed returns, not an archaeological exercise. Returns filed **before** the
persistence layer existed carry no such record.

### Who owns it

The **tax adviser**. Register owner per `MASTER_PROJECT_STATE.md:208`. Same owner and same
engagement as B-3 — send them together.

### What a complete answer looks like

1. Which basis Art. 55 prescribes for the standard method, with the citation.
2. Whether zero-rated supplies count as taxable in the numerator (the code assumes yes —
   `tax.ts:544`, with a comment saying so).
3. If input-tax amounts: whether the ratio is struck per return period or annually with a
   period-end wash-up.
4. Whether returns already filed on the supplies basis require correction, and whether the
   AED 10,000 threshold is tested per return or cumulatively.

---

## B-3 · Q-1 — standalone parking VAT, and whether to apply for floorspace apportionment

### Question

Two parts, both answerable as a position:

**(a)** Is input VAT on costs serving the group's standalone parking operation recoverable
in full, on the basis that standalone parking is a standard-rated supply, notwithstanding
that the parking business sits alongside exempt residential letting under the same owner?

**(b)** Should the group apply to the FTA for a special apportionment method based on
floorspace rather than using the standard method — and if so, what ratio should the
application seek?

### Our fact pattern

Bay Square Parking is a standalone parking operation in Business Bay: paid parking bays let
to drivers, not parking sold as ancillary to a residential lease. It is modelled as a
`rental`-kind business unit alongside Sumon Properties, which lets residential flats in
Jumeirah Village Circle and makes **exempt** supplies.

Trailing twelve months *(live)*:

| | Parking (PARK) | Residential (PROP) |
|---|---|---|
| Revenue | 108,806.00 | 636,494.00 |
| Expenses | 30,020.00 | 115,301.00 |
| Treatment on the output side | Standard-rated, 5% | Exempt |

`docs/05-uae-localisation.md:19` states standalone parking is standard-rated at 5%, and the
end-to-end test asserts it on the output side. The output side is not in question.

The property portfolio is the reason (b) exists at all: shared overheads run across exempt
flats and taxable operations, and the standard method apportions them on turnover
(**83.82%** recoverable on the current split — see B-2).

### The position the software currently takes

**(a) Recovery is allowed, and it is driven by the tax code on the purchase line, not by the
business unit.** This changed in this wave. Previously recoverability was decided by the
business unit's `kind`, so every bill posted to the parking company had its input VAT
expensed as irrecoverable purely because the unit was labelled `rental` — the position
contradicted the group's own output-side treatment.

Now a dedicated tax code exists, `packages/db/src/seed/reference.ts:193-205`:

```ts
code: "PARKING",
name: "VAT 5% — standalone parking (standard rated)",
rate: "0.050000",
treatment: "standard",
inputRecoverable: true,
```

and `packages/core/src/services/purchasing.ts:288-299` resolves each purchase line's
`servesTaxCode` against `tax_codes.input_recoverable`, classifying the input VAT into one of
three buckets — recoverable, irrecoverable, or **residual** where a cost serves both
(`purchasing.ts:269-273`). The residual bucket is what feeds the apportionment engine.

**(b) The floorspace method is built but not selected.** `ApportionmentMethod` is a
discriminated union (`packages/core/src/uae/tax.ts:283-293`) in which the `floorspace`
variant **requires** an FTA approval reference:

```ts
| { kind: "floorspace"; recoveryRatio: number; ftaApprovalReference: string }
```

`resolveApportionmentMethod` (`tax.ts:441-489`) reads tenant settings and falls back to the
standard method — with a visible note — if a floorspace configuration cannot produce both a
ratio and an approval reference. The docblock states the intent: "a `floorspace` setting that
cannot produce an approval reference is not a configuration, it is a claim nobody has
authorised." The tenant setting is unset, so the standard method is in force
(`packages/core/src/metrics/uae-metrics.ts:93`).

Both halves are parked as `it.todo` in `packages/core/src/uae/vat.test.ts:462-472`.

### What it is worth

**(a) The parking input-VAT position**, at current spend *(live)*: parking expenses of
AED 30,020.00 over twelve months. If all of it were standard-rated supply to the parking
operation, the input VAT at stake is

> 30,020.00 × 5% = **AED 1,501.00 per year**

That is the recurring amount that turns on whether the answer is "recoverable" or
"irrecoverable". It is modest at current volume and scales linearly with the parking
operation. Note that no misclassification is currently sitting in the ledger: the whole of
account 5720 *Irrecoverable Input VAT* — **AED 1,063.00** all-time *(live)* — belongs to the
residential property unit, which is where it should be.

**Why the cost of being wrong is now low.** Before this wave, the answer would have required
rewriting the classification logic. It no longer does. Recoverability follows the line's tax
code, so reversing the position is a data change: stop using the `PARKING` code, or change
its `inputRecoverable` flag. **This is a configuration change, not a rewrite** — which is
worth telling the adviser, because it means a cautious answer costs the business very little
to implement.

**(b) The floorspace question** cannot be priced from the current data, and this brief will
not invent a number. What can be stated is the mechanism: the special method replaces the
turnover ratio (**83.82%** today) with an agreed one, applied to residual input VAT. Every
percentage point of difference is worth 1% of the residual pool. The residual pool is
near-nil in the current data and will grow with real overhead billing, so the value of the
application is a forward judgement about the property portfolio's cost base — exactly the
judgement the adviser is being engaged for.

### What changes if the answer differs

| Answer | Consequence |
|---|---|
| (a) Parking input VAT is recoverable — current position confirmed | Nothing. The `PARKING` code stays as seeded |
| (a) Not recoverable, or recoverable only in part | Data change: flip `inputRecoverable` on the `PARKING` tax code, or route parking costs to the residual bucket. No code change, no migration |
| (b) Do not apply for floorspace | Nothing. Standard method already in force |
| (b) Apply, and it is granted | Configuration: write the agreed ratio and the FTA approval reference into tenant settings. The engine already validates and applies both, and stamps them onto every persisted return |
| (b) Apply, granted with a different ratio later | Same configuration path. Returns carry the basis and reference that produced them (`vat_returns`), so a change is traceable |

### Who owns it

The **tax adviser**. Register owner per `MASTER_PROJECT_STATE.md:207`. Send with B-2.

### What a complete answer looks like

1. A written position on standalone parking input VAT, distinguishing it from parking
   supplied as ancillary to an exempt residential lease.
2. Whether the fact that parking and residential letting share an owner (and possibly a
   trade licence — see B-8) affects that position.
3. A recommendation on whether to lodge a special-method application for floorspace, and if
   so the ratio to seek and the evidence needed to support it.
4. If the application is recommended: the expected timeline, and which method applies in the
   interim.

---

## B-4 · Q-2b — does an Article 44 gross-misconduct dismissal still forfeit gratuity?

### Question

Under Federal Decree-Law 33/2021, does a summary dismissal under Article 44 extinguish the
employee's Article 51 end-of-service benefit, or does the benefit remain payable
notwithstanding the dismissal?

Answerable as: *forfeited* or *payable*.

### Our fact pattern

Fourteen active employees across the salon, the mobile shop, the field-service company and
the contracting company *(live)*, on a combined monthly package of **AED 79,200.00**.
Total accrued end-of-service benefit across the fourteen, valued today by the system's own
engine, is **AED 161,761.20** *(live)*. The longest-serving employee has 8.14 years of
service and an accrued benefit of **AED 16,496.09** *(live)*.

The group has not yet dismissed anyone for misconduct. The question is live because the
system computes and displays a number that would be paid — or withheld — the day it does.

### The position the software currently takes

**Forfeiture in full.** `packages/core/src/uae/gratuity.ts:213`:

```ts
if (reason === "gross_misconduct") {
  return {
    entitled: false, ... amount: 0,
    explanation:
      "Forfeited: dismissal under Article 44 (gross misconduct). " +
      "Assumed, not confirmed — see Q-2b.",
```

**The concern, attributed and UNVERIFIED.** The assumption docblock immediately above that
branch (`gratuity.ts:186-212`) records it:

> That was unambiguously the rule under Articles 120 and 139 of the superseded Federal Law 8
> of 1980. Whether it survived is not clear: Article 44 of Federal Decree-Law 33/2021 permits
> summary dismissal without notice, but on the reading we have — which no adviser has
> confirmed — it does not extinguish the Article 51 end-of-service benefit.

The UAE audit reached the same conclusion independently (`audit-uae.md`, CALC-12) and
declined to assert an answer.

The behaviour is left as it stands **deliberately**, and the reasoning is worth relaying to
the adviser: flipping it would be guessing in the other direction, and paying a gratuity the
law does not require is as hard to unwind as withholding one it does. What changed in this
wave is that the guess is now marked everywhere it is visible rather than asserted as fact:

- `packages/core/src/uae/uae.test.ts:236` — what was a **passing assertion** that misconduct
  yields AED 0 is now an `it.todo` naming the question.
- `apps/web/src/app/(app)/hr/gratuity/page.tsx:407,480,664` — the register shows the
  forfeited row with a Q-2b marker and explains to the user that this is an assumption, and
  the settlement path requires an explicit acknowledgement before paying nothing on it.
- `docs/05-uae-localisation.md:114-118` — states it as an open question rather than as law.

### What it is worth

Per employee, at the register's canonical illustration *(illustrative)* — ten years of
service on an AED 10,000 monthly basic, executed against the engine:

| | Days | Rate | Amount |
|---|---|---|---|
| Years 1–5 at 21 days/year | 105 | 328.767123 | 34,520.55 |
| Years 6–10 at 30 days/year | 150 | 328.767123 | 49,315.07 |
| **Ordinary termination** | **255** | | **83,835.62** |
| **Article 44 dismissal, as coded** | 0 | | **0.00** |

Daily basic wage = 10,000 × 12 ÷ 365 = 328.767123. Verified by executing
`calculateGratuity` directly.

On the group's **actual** payroll the largest single exposure is **AED 16,496.09** *(live)*
and the whole accrued book is **AED 161,761.20** *(live)*.

The exposure is per event, not per year: it crystallises the first time someone is dismissed
for misconduct, and the decision to dismiss is often taken by people who will not consult a
lawyer first.

### What changes if the answer differs

| Answer | Consequence |
|---|---|
| Forfeited — current position confirmed | Delete the assumption docblock, replace it with the citation, and restore `uae.test.ts:236` to a passing assertion. No behavioural change |
| Payable | Delete the branch at `gratuity.ts:213`. `reason` then has no effect on the amount at all and becomes a record-keeping field. A handful of lines, plus the register copy and `docs/05-uae-localisation.md` |
| Payable in part, or payable subject to conditions | The only answer that needs design work: `reason` would become a real input to the calculation rather than a switch |

No migration, and no restatement — nothing has been paid or withheld on this basis, because
no misconduct termination has occurred.

### Who owns it

**MOHRE or a UAE employment lawyer.** Register owner per `MASTER_PROJECT_STATE.md:210`.
Send with B-5, which the same person answers in the same sitting.

### What a complete answer looks like

1. Whether Article 44 dismissal forfeits the Article 51 benefit under the 2021 law, with the
   citation — including, if the position rests on the absence of a provision rather than on
   one, a statement to that effect.
2. If forfeited: whether forfeiture is automatic, or contingent on process (investigation,
   written notice, MOHRE notification).
3. If payable: whether any part may be withheld or set off, and against what.
4. Whether an unlawful or contested Article 44 dismissal changes the answer retrospectively.

---

## B-5 · Q-2 — resignation versus termination under the 2021 law

### Question

Under Federal Decree-Law 33/2021, does an employee who resigns accrue end-of-service benefit
on the same basis as one whose contract is terminated by the employer — or does resignation
reduce or scale the entitlement by length of service, as it did under the superseded law?

Answerable as: *identical* or *reduced, on this scale*.

### Our fact pattern

As B-4: fourteen active employees, AED 161,761.20 of accrued benefit *(live)*, longest
service 8.14 years. Resignations are the ordinary case — the group has had staff turnover
across the salon and the field-service vans. Every one of them was valued by the system on
the assumption below.

### The position the software currently takes

**Resignation accrues identically to termination.** `calculateGratuity` accepts a `reason`
of `"resignation"` and — apart from the `gross_misconduct` branch covered by B-4 — ignores
it entirely (`packages/core/src/uae/gratuity.ts:75` declares the field;
`gratuity.ts:213` is the only place it is read).

The assumption is recorded in the file header and parked as an `it.todo` in
`packages/core/src/uae/uae.test.ts`, explicitly stating that no fixture was written in
either direction because the question is open. The UAE audit called this "the model for how
the others should be handled" (`audit-uae.md`).

**The concern, attributed and UNVERIFIED.** The superseded Federal Law 8/1980 scaled the
resigning employee's entitlement by length of service — a fraction for shorter service,
rising to the full amount. The project's reading is that Decree-Law 33/2021 removed that
distinction. Nobody here has verified it.

### What it is worth

If resignation were scaled rather than equal, the overstatement is a fraction of each
resigning employee's accrued balance. Against the current book of **AED 161,761.20**
*(live)*, a scale that paid, for example, two-thirds at mid-service would overstate the
accrued liability on the affected employees by roughly a third of their balances — the exact
figure depends entirely on the scale, which is the thing being asked.

What can be stated without guessing the scale: the number is **not** per-event like B-4. It
is a standing misstatement of the accrued liability on the balance sheet for every employee
who will eventually resign, which in a salon and a field-service business is most of them.

### What changes if the answer differs

| Answer | Consequence |
|---|---|
| Identical — current position confirmed | Convert the `it.todo` to a passing fixture. No behavioural change |
| Scaled by service | `reason` becomes a real input: a scale applied to the computed entitlement. Small, self-contained change to one function, plus fixtures. No migration. The accrued balances already posted would need re-valuing |

### Who owns it

**MOHRE or a UAE employment lawyer** — the same engagement as B-4. Register owner per
`MASTER_PROJECT_STATE.md:209`.

### What a complete answer looks like

1. Whether resignation and employer termination produce the same Article 51 entitlement
   under the 2021 law, with the citation.
2. If they differ, the exact scale and the service bands it applies to.
3. Whether resignation during a limited-term contract differs from an unlimited one.
4. Whether notice served or not served affects the entitlement, as distinct from affecting
   pay in lieu.

---

## B-6 · Q-7 — the exact WPS SIF layout required by the group's agent

### Question

Please provide your written specification for the Salary Information File: the exact field
order, count, format and permitted values for the EDR and SCR records, the file naming
convention, the line ending, and the date formats — as your systems will accept it.

This is a document request, not a question of judgement.

### Our fact pattern

Fourteen active employees on a combined monthly package of **AED 79,200.00** *(live)*, paid
through a MOHRE-approved agent each month. The system generates the SIF from payroll data
rather than asking the owner to fill a spreadsheet, on the reasoning that a misplaced column
rejects the whole batch and a rejected batch two days before payday is a real operational
failure — and a missed WPS filing blocks the establishment from issuing or renewing work
permits, which for a business running on sponsored staff is existential rather than a fine.

### The position the software currently takes

It emits a file. **The layout is a reconstruction, not a transcription of any specification,
and the code now says so.** `packages/core/src/uae/wps.ts` carries the layout as a single
exported structure, `SIF_LAYOUT`, whose first field is a provenance string:

```ts
source: "UNVERIFIED reconstruction — open question Q-7 (PRD-02:1069)",
```

with the docblock immediately above it stating that it was reconstructed from
`docs/05-uae-localisation.md` §6, "which cites no source", and "do not treat this as a
transcription of a spec". The line ending is annotated the same way: *"MOHRE expects CRLF.
Also unverified."*

**This is exactly the specimen we currently produce.** Generated by executing `generateSif`,
with synthetic identifiers substituted for real employee data:

```
EDR,78419990001234,0000000,402010101,AE070331234567890123456,20260701,20260731,31,7500.00,0.00,0
EDR,78419990005678,0000000,402010101,AE070331234567890123457,20260701,20260731,12,4000.01,250.00,0
SCR,1234567890123,0000000,402010101,260802,0905,202607,11750.01,2,AED
```

Filename: `12345678901232608020905.SIF` — employer ID followed by `YYMMDDHHMM`. Line ending
CRLF, including a trailing one after the SCR.

Field-by-field, as we currently understand it:

| EDR | Field | Specimen |
|---|---|---|
| 1 | Record type | `EDR` |
| 2 | MOHRE Person ID (14 digits) | `78419990001234` |
| 3 | Employee agent ID | `0000000` |
| 4 | Employee bank routing code | `402010101` |
| 5 | Employee IBAN (23 chars, `AE` + 21 digits) | `AE07033…` |
| 6 | Pay period start, `YYYYMMDD` | `20260701` |
| 7 | Pay period end, `YYYYMMDD` | `20260731` |
| 8 | Days in period | `31` |
| 9 | Fixed income, 2 dp, no separators | `7500.00` |
| 10 | Variable income | `0.00` |
| 11 | Days on leave | `0` |

| SCR | Field | Specimen |
|---|---|---|
| 1 | Record type | `SCR` |
| 2 | Employer ID (13 digits) | `1234567890123` |
| 3 | Employer agent ID | `0000000` |
| 4 | Employer routing code | `402010101` |
| 5 | Creation date, `YYMMDD` | `260802` |
| 6 | Creation time, `HHMM` | `0905` |
| 7 | Salary year+month, `YYYYMM` | `202607` |
| 8 | Total salaries | `11750.01` |
| 9 | Employee count | `2` |
| 10 | Currency | `AED` |

**Four specific respects in which the UAE audit believes this may diverge from the commonly
documented MOHRE layout — all UNVERIFIED** (`audit-uae.md`, CALC-17):

1. **The EDR may carry one field too many.** The documented EDR is reported to carry a single
   *employee agent ID* which **is** the bank routing code, where we emit fields 3 and 4
   separately. Field 3 is hard-coded to `"0000000"` for every employee in the API route
   (the `agentId` literal in `apps/web/src/app/api/wps/[month]/route.ts`), which reads like a
   field with no real source.
2. **SCR salary month and year may be separate fields** (`MM` and `YYYY`) where we emit them
   concatenated as `YYYYMM` in field 7.
3. **SCR field order** may be `… employeeCount, totalSalaries, currency` where we emit
   `totalSalaries, employeeCount, currency`.
4. **Date formats.** The documented creation date and time may be `YYYY-MM-DD` and `HH:mm`
   where we emit `YYMMDD` and `HHMM`. The file also mixes widths internally: 8-character
   pay-period dates on the EDR against 6-character creation dates on the SCR.

One thing that is *not* in doubt: amounts are rendered to exactly two decimals with no
thousands separator, and the SCR control total is accumulated in exact decimal from the same
values as the EDR lines, so the control record cannot drift from the sum of the details.

**One point on the pay period, which is not a layout question.** The second specimen row is a
part-month payee: 12 days paid, but the period still reads 1–31 July. A payroll run supplies
the true start and end (`edrPeriod` in `packages/core/src/uae/wps.ts`), and where the day
count disagrees with the span the file generator raises a warning naming the mismatch — the
specimen above produced exactly one: *"the pay period 2026-07-01 to 2026-07-31 is 31 days,
but the record claims 12."* What the agent's answer needs to settle is **which convention
they expect for a joiner or a leaver**: the employment span, the payment span, or the whole
salary month with the day count carrying the pro-ration.

### What it is worth

**The monthly payroll batch: AED 79,200.00 across 14 employees** *(live)*, every month.

The failure mode is not a wrong number, it is a rejected file. A rejected batch means the
WPS filing is late; a late or missed filing blocks work-permit issuance and renewal for the
whole establishment. Fourteen sponsored staff across four businesses depend on it.

The cost of obtaining the answer is one email to a supplier the group already pays. This is
the cheapest item on the whole list and it has been open for three waves.

### What changes if the answer differs

Entirely contained. The layout is now a single exported structure, `SIF_LAYOUT` in
`packages/core/src/uae/wps.ts`, with `edr()`, `scr()`, `fileName()`, `lineEnding` and
`currency` as its members. Correcting the layout means editing that structure and replacing
its `source` string with a citation of the agent's document. No schema change, no migration,
no restatement — a SIF is generated on demand and is not persisted as a record.

Two things the answer should also settle, which are hard-coded today and need a home in
tenant settings: the employer ID, employer agent ID and employer routing code (the `EMPLOYER`
constant in `apps/web/src/app/api/wps/[month]/route.ts`), and whether the per-employee agent
ID is a real per-bank value or the routing code under another name.

### Who owns it

**The group's WPS agent** — the bank or exchange house through which salaries are paid.
Register owner per `MASTER_PROJECT_STATE.md:215`.

### What a complete answer looks like

Their specification document, or a filled-in template file. Specifically:

1. Field order, count and permitted values for EDR and SCR.
2. Whether the employee agent ID and the bank routing code are one field or two.
3. Date and time formats for pay period and file creation, and whether they are consistent
   across record types.
4. Amount format: decimals, separators, and whether a negative or zero amount is permitted.
5. Filename convention and line ending.
6. The group's own employer ID, employer agent ID and employer routing code.
7. Ideally, a sample file that their system has accepted.

---

## B-7 · Q-5 — can a cleared UAE cheque be returned by the bank?

### Question

After a cheque has cleared and funds have been credited to our account, can the bank
subsequently return it unpaid and reverse the credit — and if so, within what window and for
what reasons?

Answerable as: *no, clearing is final* — or *yes, within N days, for these reasons*.

### Our fact pattern

Dubai tenancies are settled with a bundle of post-dated cheques handed over at signing — 1,
2, 4, 6 or 12 of them, each dated for a future rental period and held in the landlord's safe.
The system treats each cheque as a first-class instrument rather than as cash or as a
receivable, because the landlord must be able to prove which physical instrument covered
which rental period.

Current cheque book *(live)*:

| Status | Count | Value |
|---|---|---|
| Cleared | 81 | 788,635.00 |
| Held (in the safe, not yet due) | 23 | 213,441.00 |
| Deposited (presented, awaiting clearance) | 4 | 28,340.00 |
| Bounced | 3 | 52,836.00 |

Largest single cleared cheque: **AED 60,000.00** *(live)*.

### The position the software currently takes

**A cleared cheque is terminal — and the omission is deliberate and marked as parked, not
settled.** `packages/core/src/services/payments.ts:338-347`:

```ts
const allowed: Record<string, string[]> = {
  deposit: ["held"],
  clear:   ["held", "deposited"],
  bounce:  ["deposited", "held"],
  ...
  replace: ["bounced", "held"],
};
```

`cleared` appears in no source list, so no transition leads out of it. The comment
immediately above (`payments.ts:327-337`) ties the gap explicitly to this question and warns
against closing it as a tidy-up:

> whether a cleared UAE cheque can later be returned by the bank is open question Q-5 …
> Do not add `cleared` to `bounce` (or to any list) to "tidy up" the gap — reversing a
> cleared cheque has to unwind the payment, its allocations and the ledger.

The database enum (`packages/db/src/schema/_enums.ts:173-181`) carries seven states,
including `returned` — "handed back to the drawer (early settlement, lease ended)" — which no
transition currently produces. The specification records the corresponding edge case as
"state unreachable".

### What it is worth

The exposure is **per cheque**, and it is the amount of the cheque plus whatever the clearing
credit has already been allocated against.

- Largest single cleared cheque in the book: **AED 60,000.00** *(live)*.
- Total already cleared: **AED 788,635.00** across 81 instruments *(live)*.

If clearing is not final and a cheque is returned after credit, the system today has **no way
to record it**. The consequences are concrete: the tenant's rent for that period shows as
paid when it is not; the bank balance is overstated by the cheque amount; and the arrears
report will not show the tenant. Every one of those is a number the owner acts on.

The reason this is Class B rather than Class A is that the gap is *closed* rather than
*wrong* — the software refuses the transition instead of mishandling it. The cost is that the
event cannot be recorded at all, not that it is recorded incorrectly.

### What changes if the answer differs

| Answer | Consequence |
|---|---|
| Clearing is final | Add a comment citing the bank's confirmation and close the question. No code change. The `returned` enum state is then dealt with separately, as an early-settlement hand-back rather than a bank return |
| A cleared cheque can be returned | A real piece of work, not a one-line guard change: a `cleared → bounced` transition that unwinds the payment, its allocations across the covered rental periods, and the ledger entries — plus the bank charge. The comment at `payments.ts:327-337` says as much. Estimated small-to-medium, and it needs the window and the reasons to model it correctly |

### Who owns it

**The group's bank** — the relationship manager who handles the landlord's cheque deposits.
Register owner per `MASTER_PROJECT_STATE.md:213`. One email.

### What a complete answer looks like

1. Whether a cheque credited to the account can subsequently be returned unpaid.
2. If so: the window, measured from what event; and the permitted reasons (technical return,
   stop payment, forgery, account closure).
3. Whether the customer is notified before or after the debit is reversed.
4. Whether the same answer applies to cheques deposited through different channels.
5. Separately, and useful while they are answering: what the bank charges on a bounced cheque
   and how it appears on the statement.

---

## B-8 · Q-6 — which entities hold which licences, and their revenue against the thresholds

### Question

For each of the seven businesses, which registered legal entity — with which trade licence
and which tax registration number — does it trade under; and what is each entity's revenue
measured against the AED 3,000,000 Small Business Relief cap and the AED 50,000,000
threshold?

Answerable as a table: business → entity → licence number → TRN → revenue.

### Our fact pattern

Seven businesses *(live)*, with a boolean on each saying whether it is its own legal entity —
but nothing saying **which** entity, and no entity records at all:

| Business | Kind | Flagged separate entity | Revenue YTD |
|---|---|---|---|
| BUILD — Sumon Contracting LLC | Construction | **Yes** | 2,192,760.00 |
| PROP — Sumon Properties | Residential rental | **Yes** | 636,494.00 |
| ONLINE — Nexus Online Store | E-commerce | No | 367,617.14 |
| MOBILE — Sumon Telecom LLC | Retail | **Yes** | 314,713.33 |
| SALON — Royal Cuts Gents Salon | Salon | No | 201,528.59 |
| TECH — Sumon Technical Services LLC | Field service | **Yes** | 110,869.52 |
| PARK — Bay Square Parking | Parking | No | 108,806.00 |
| **Group total** | | | **3,932,788.60** |

The three businesses flagged "no" trade under *someone's* licence. Nobody has recorded whose.

### The position the software takes today

**It assesses corporate tax group-wide, and it says so.** The `legal_entities` table exists
(`packages/db/src/schema/tenancy.ts:81-158`) with columns for legal name, tax identification
number, trade licence number and expiry, licensing authority, establishment card, free-zone
and designated-zone flags, and a per-entity fiscal year end. It is **empty**: zero rows, and
zero of the seven business units carry a `legal_entity_id` *(live)*.

So the corporate-tax metric sums income and expense across all seven with no entity grouping
(`packages/core/src/metrics/uae-metrics.ts:281-294`). The code documents this as a known gap
rather than claiming otherwise (`uae-metrics.ts:299-304`):

> `priorPeriodRevenues` is deliberately not passed, and that is a known gap rather than a
> claim … Supplying it needs the same rework as assessing relief per taxable person instead
> of group-wide, which this single ungrouped query does not do either.

`docs/05-uae-localisation.md:178-180` states the correct rule and names the four entities:
"SBR is assessed **per taxable person** … Each is tested on its own revenue, so some may
qualify while the group as a whole does not."

The same gap affects inter-business VAT. `packages/core/src/services/interco.ts:255-273`
decides whether a transfer between two businesses is a taxable supply by reading the
`is_separate_legal_entity` boolean on each side — which says a business is *its own company*
but not *which* company, so two businesses trading under the same licence would both answer
true and be charged VAT on a movement inside one taxable person. The code flags this as a
latent defect and names the fix as switching to `legal_entity_id` once it is populated.

### What it is worth

**The eligibility conclusion flips entirely.** Group revenue *(live)* is
**AED 3,932,788.60**, above the AED 3,000,000 Small Business Relief cap. No individual
entity is: the largest is BUILD at **AED 2,192,760.00**.

Executed against `calculateCorporateTax` with the live figures:

| | Revenue tested | SBR | Tax due |
|---|---|---|---|
| Group-wide *(as the metric computes it today)* | 3,932,788.60 | **Denied** | **AED 1,345.83** |
| BUILD assessed alone | 2,192,760.00 | **Applied** | **AED 0.00** |

Group profit year-to-date is AED 389,953.68, of which the first AED 375,000 falls in the nil
band — so the taxable slice is AED 14,953.68 and 9% of it is AED 1,345.83. The absolute
number is small **today** only because profit is barely above the nil band.

The sensitivity is what matters: **every additional AED 100,000 of group profit above the
nil band costs AED 9,000 under the group-wide test and AED 0 per entity, for as long as each
entity stays under the AED 3,000,000 cap.** The error direction is the unpleasant one — it
makes the owner budget for tax that may not be owed.

This is a management planning estimate and is labelled as such in the product; it is not a
filed figure. But it is the number the owner sees.

### What changes if the answer differs

This one is **not** a configuration change. It is a data-entry exercise followed by a code
change that is already scoped:

1. **Data:** create one `legal_entities` row per registered company, and set
   `business_units.legal_entity_id` on all seven. The table and the column already exist —
   this is seeding, not migration.
2. **Code:** group the corporate-tax metric by entity, run the engine per entity, and sum.
   Switch `interco.ts` from the `is_separate_legal_entity` boolean to `legal_entity_id`. The
   code comment warns that this switch **must** happen only after the column is populated —
   reading NULL on both sides would make every transfer look intra-entity and silently stop
   charging VAT, which is the worse failure.
3. **Downstream:** the same rows carry the tax identification number that PINT AE e-invoicing
   requires as the supplier identifier, so this answer is a prerequisite for the e-invoicing
   mandate as well (accredited service provider by 31 March 2027, live 1 July 2027).

### Who owns it

**The owner and the accountant** — not an external adviser. Register owner per
`MASTER_PROJECT_STATE.md:214`. This is the cheapest item on the list to obtain and it needs
nobody's fee.

### What a complete answer looks like

A table with one row per business:

| Business | Legal entity name as registered | Trade licence no. | Licensing authority | Licence expiry | VAT TRN | Corporate tax registration no. | Free zone? | Fiscal year end |
|---|---|---|---|---|---|---|---|---|

Plus, per entity:

1. Revenue for the current tax period **and all prior periods**, since Small Business Relief
   is tested against both.
2. Whether any entity is above AED 50,000,000, which is the threshold the specification cites
   for e-invoicing phasing and connected-person documentation.
3. Which entity holds the establishment card and labour card for each employee population.

---

## B-9 · Q-12 — inter-business services at cost or at an arm's-length rate

### Question

When one of the group's businesses performs services for another — the technical services
company servicing the landlord's flats, one business paying another's supplier bill — should
the recharge be at cost, or at an arm's-length market rate; and what transfer-pricing
documentation does the answer require under UAE corporate tax?

Answerable as: *at cost* or *at arm's length, supported by [documentation]*.

### Our fact pattern

The businesses trade with each other constantly, and this is the group's actual operating
model rather than an edge case. The technical services company services the landlord's
residential flats. The contracting company works on group property. One business's cash pays
another's supplier when the timing suits.

Already on the books *(live)*: **61 journal lines** across accounts 1700 *Due from Group
Companies* and 2700 *Due to Group Companies*, totalling **AED 22,323.00**, recorded as
technical-services invoices with `source = 'inter_company'`.

**None of the 61 carries a recorded pricing basis** *(live)*. They predate the transfer
service and their document metadata is empty. So the historical position is not "at cost" or
"at arm's length" — it is *unstated*.

At least three of the counterparties are separately registered companies (see B-8), so at
least some of these movements are between distinct taxable persons.

### The position the software currently takes

**At cost, by default, with the basis recorded explicitly on every transfer — and an
arm's-length claim without a written justification is refused.**
`packages/core/src/services/interco.ts:120`:

```ts
export const pricingBasis = z.enum(["at_cost", "arms_length"]);
```

defaulted to `at_cost` at `interco.ts:172`, with the reasoning stated in the docblock above
it (`interco.ts:96-119`):

> An arm's-length price is a NUMBER SOMEBODY HAS TO JUSTIFY. Defaulting to it would mean this
> code inventing a transfer price on the owner's behalf and stamping it as market-benchmarked.
> That is precisely the guess Q-12 says not to make, and an undocumented arm's-length claim is
> worse than no claim.

The refusal is enforced, not documented: `interco.ts:376` rejects a transfer marked
`arms_length` that carries no `pricingBasisNote`. Each transfer persists its
`pricingBasis`, its written justification, the arm's-length amount and the underlying cost
(`interco.ts:462-465`), which is what makes re-pricing a bounded query rather than an
archaeological dig. The `arms_length` path is fully built and reachable today by supplying
the rate and its basis.

The specification (`docs/PRD-02-product-requirements.md:426-446`, FR-M06) describes the base
journal as a cost reallocation and says the performing unit "**optionally** recognises
revenue at an arm's-length rate", and requires that "where an arm's-length rate is applied,
the basis is recorded on the document. This supports the transfer-pricing documentation
obligation that arises for connected persons under UAE corporate tax." Cost is the specified
default; arm's length is the option.

The specification also flags this as the one to decide early
(`docs/PRD-02-product-requirements.md:1076`): *"It determines whether the inter-company flow
is a cost allocation or a revenue transaction, which changes the profit-and-loss shape of
every business unit and creates a transfer-pricing position."*

### What it is worth

Three separable amounts.

**1. The 61 existing movements — AED 22,323.00 with no recorded basis** *(live)*. Small in
absolute terms, but this is the population that would have to be characterised
retrospectively if a basis were ever asserted for a prior period.

**2. The P&L shape of each business, going forward.** At cost, the performing business
recognises no margin and the receiving business bears the true cost — neither side is
overstated, and consolidated profit is unchanged. At arm's length, the performing business
recognises revenue and margin it does not recognise today, and the receiving business bears
a higher cost. Consolidated profit still nets to zero, but **the per-business numbers the
owner manages by move in opposite directions.** With TECH currently showing a YTD loss of
AED 69,153.48 and PROP a profit of AED 521,193.00 *(live)*, and TECH's principal internal
customer being PROP, the choice materially changes which business looks like it is working.

**3. The corporate-tax interaction.** Per B-8, each entity is tested separately against the
AED 3,000,000 Small Business Relief cap and the AED 375,000 nil band. Moving margin between
entities by choosing a transfer price moves taxable income between taxable persons — which
is precisely why the arm's-length rule exists, and precisely why an undocumented position is
the expensive one.

### What changes if the answer differs

| Answer | Consequence |
|---|---|
| At cost — current default confirmed | Nothing. Record the confirmation in the docblock and stop treating it as an assumption |
| Arm's length | **No journal shape changes.** Callers pass `pricingBasis: "arms_length"` with the rate and its written basis; the path is already built, validated and persisted. What has to be produced is the *justification* — the benchmarking that supports each rate. That is adviser work, not engineering work |
| Arm's length, applied retrospectively | The expensive answer. 61 movements totalling AED 22,323.00 *(live)* carry no basis and would need characterising one by one, with journals restated where the price changes |

The third row is the reason the specification says decide early. Every month this stays open
adds transfers to the population that would need retrospective treatment.

### Who owns it

**The owner and the tax adviser.** Register owner per `MASTER_PROJECT_STATE.md:219`. Bundle
with B-2 and B-3 — same adviser, and B-8's entity table is an input to this answer.

### What a complete answer looks like

1. Whether recharges between these entities must be at arm's length, or whether cost is
   acceptable, and on what basis the distinction is drawn.
2. If arm's length: an acceptable method for setting the rate (cost-plus at what margin,
   comparable uncontrolled price, or other), and what evidence must be retained per transfer.
3. Whether the group's size triggers master-file or local-file documentation obligations, and
   at which revenue threshold.
4. Whether the 61 movements already booked need to be characterised retrospectively, or
   whether the position can be applied prospectively from a stated date.
5. Whether transfers between two businesses under the **same** licence (see B-8) are outside
   the rule entirely, which is the distinction the software cannot currently draw.

---

## Appendix — where these questions live in the code

Each is marked at the point where the assumption is made, so a future contributor reading the
code finds the question rather than an ordinary-looking guard. This list exists so an adviser's
answer can be applied without a search.

| Brief | Marked at |
|---|---|
| B-1 · Q-8 | `scripts/backup-replicate.mjs:118-131` (region has no default), `docs/TRD-03-technical-requirements.md:722` |
| B-2 · Q-1b | `packages/core/src/uae/tax.ts:234-265`, parked test `packages/core/src/uae/vat.test.ts:449` |
| B-3 · Q-1 | `packages/core/src/uae/tax.ts:269-293`, `packages/db/src/seed/reference.ts:193-205`, parked tests `packages/core/src/uae/vat.test.ts:462-472` |
| B-4 · Q-2b | `packages/core/src/uae/gratuity.ts:186-212`, parked test `packages/core/src/uae/uae.test.ts:236` |
| B-5 · Q-2 | `packages/core/src/uae/gratuity.ts` header, parked test in `packages/core/src/uae/uae.test.ts` |
| B-6 · Q-7 | `SIF_LAYOUT` in `packages/core/src/uae/wps.ts` — the `source` field is the marker |
| B-7 · Q-5 | `packages/core/src/services/payments.ts:327-337` |
| B-8 · Q-6 | `packages/core/src/metrics/uae-metrics.ts:299-304`, `packages/core/src/services/interco.ts:255-273` |
| B-9 · Q-12 | `packages/core/src/services/interco.ts:96-119` |

The register of record is `docs/MASTER_PROJECT_STATE.md` §4. This document expands it; it
does not replace it.
