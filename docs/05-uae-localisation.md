# 05 — UAE localisation (Dubai mainland)

Localisation here is not currency and a date format. Four UAE rules change the
*data model*, and getting any of them wrong produces numbers that are confidently
incorrect rather than obviously broken.

Configured for: **Dubai · AED · 5% VAT · calendar fiscal year · DED licensing ·
Ejari registration.**

---

## 1. Residential rent is VAT-EXEMPT, and that is not the same as zero-rated

The single most consequential rule for this portfolio.

| Supply | Treatment | Output VAT | Input VAT recoverable? |
|---|---|---|---|
| Salon, retail, e-commerce, field service, contracting | Standard | 5% | Yes |
| Commercial rent, **standalone parking** | Standard | 5% | Yes |
| **Residential rent (the JVC flats)** | **Exempt** | none | **No** |
| Exports, first supply of new residential | Zero-rated | 0% | Yes |

Zero-rated and exempt both charge 0%. They behave oppositely on the input side —
which is why `tax_codes` stores a `treatment` enum and an `inputRecoverable`
flag rather than just a rate. Collapsing both to "0%" would silently overstate
the recoverable position on every return.

**Consequence that costs money:** VAT paid on maintaining the residential flats
cannot be reclaimed. When the group's own technical services company services one
of those flats, Tech Services charges 5% output VAT and Properties **expenses**
it to `5720 Irrecoverable Input VAT`. Booking it as a reclaim is a routine FTA
assessment finding.

**Consequence for overheads:** costs used across both taxable and exempt
businesses must be apportioned. `calculateVatReturn()` applies the FTA standard
method — taxable supplies ÷ total supplies — and reports the recovery ratio and
the irrecoverable amount explicitly on the dashboard.

Verified in `npm run test:e2e`:

```
✓ residential rent carries zero VAT (exempt, not zero-rated)   102 exempt lines, 0.0000 VAT
✓ standalone parking IS standard-rated at 5%                   AED 5,690 output VAT
✓ input VAT on exempt-property maintenance is expensed         AED 900 irrecoverable
```

---

## 2. Post-dated cheques are a first-class entity

A Dubai tenancy is settled with a bundle of cheques handed over at signing — 1,
2, 4, 6 or 12 of them, each dated for a future rental period and physically held
in the landlord's safe. The number of cheques is itself a negotiating lever:
fewer cheques buys a lower annual rent.

No generic ERP models this, and the workarounds are all wrong:

| Wrong approach | What breaks |
|---|---|
| Book the cheques as cash on receipt | Overstates the bank balance by a full year's rent |
| Book them as receivables | The invoice for month 9 does not exist yet |
| Track them in a spreadsheet | No link between a physical instrument and a rental period — fatal in an Ejari or RDC dispute |

The `cheques` table is a state machine — `held → deposited → cleared | bounced →
replaced` — with the covered period, the bank, the custody location, the bounce
reason and a `replacesChequeId` chain. Accrual accounting stays independent: rent
is still invoiced **monthly** so the P&L is right, and a cleared cheque produces
a payment allocated across the invoices for the months it covers.

The seed reflects reality: 78% of residential leases use cheques, 45% of parking
does, and ~4.5% of presented cheques bounce.

```
✓ cheque register has a realistic lifecycle spread   19 held, 84 cleared, 7 bounced
```

The dashboard answers the actual operational question — *what do I bank this
week* — and flags bounces, which are the earliest signal a tenant is in trouble.

---

## 3. End-of-service gratuity is a liability that accrues every day

Federal Decree-Law No. 33 of 2021, Article 51:

- under 1 year of service → no entitlement
- years 1–5 → **21 days' basic wage** per year
- beyond 5 years → **30 days** per year
- capped at two years' total wage
- calculated on **basic salary only**, not total package

That last point is why `employees` splits pay into basic / housing / transport /
other rather than storing one figure. A system with a single "salary" column
physically cannot compute this. UAE employers commonly set basic at 50–60% of
package precisely to contain the liability — a lever the owner can only manage if
the split is visible.

Under the 2021 law the old reductions for resignation were removed: someone who
resigns after a year gets the same accrual as someone terminated.

**Service is counted in calendar anniversaries, not elapsed days ÷ 365.** The
divisor looks equivalent and is not: any period containing a leap day holds more
than 365n days, so it reports an anniversary as passed before it is and starts
paying the 30-day rate early. Five years to the day from 2019-01-01 is AED
34,520.55 on a 10,000 basic; the divisor made it AED 34,547.57. The gap is small
— about AED 135 by year twenty — but it is systematic, it hits every employee
crossing five years, and it is the difference between a register the owner can
check on paper and one they cannot. A part-completed year is pro-rated over its
own length, 365 or 366 days, so the fraction reaches a full year exactly on the
anniversary and never before it. The 365 that remains is the daily-wage divisor
(monthly basic × 12 ÷ 365), which is the MOHRE and court convention and is a
different thing entirely.

**Gross misconduct is an assumption, not a settled position — open question
Q-2b.** `calculateGratuity` forfeits the whole entitlement for a dismissal under
Article 44, and that is what the register shows the owner. Forfeiture was
unambiguously the rule under Articles 120 and 139 of Federal Law 8 of 1980,
which Decree-Law 33/2021 superseded. Article 44 of the new law permits summary
dismissal without notice, but on the reading we have — unconfirmed — it does not
extinguish the Article 51 benefit. It is worth AED 83,835.62 on a ten-year
employee at a 10,000 basic. The code behaviour is unchanged pending advice; what
changed is that the assumption is now marked in the module, on the page, and as
an `it.todo` in `uae.test.ts` instead of a passing test.

Open questions on this module, both for the same adviser:

| Q | Question | Owner | Blocks |
|---|---|---|---|
| **Q-2** | Resignation versus termination gratuity under the 2022 law | MOHRE / employment lawyer | Gratuity fixtures |
| **Q-2b** | Whether an Article 44 gross-misconduct dismissal still forfeits gratuity | MOHRE / employment lawyer | Gratuity fixtures; any misconduct settlement |

For this group the accrued liability is **AED 160,353** across 14 staff — money
already owed, on a balance sheet that would otherwise show none of it. It is
accrued monthly as a *delta*, so re-running the job is idempotent. (Recomputed
on the current seed, the anniversary arithmetic puts the group AED 120 lower
than the old divisor did — every employee's figure moves down or stays put,
never up. The exact total moves with the date the demo is seeded.)

```
✓ gratuity provision ties to per-employee accruals   employees AED 160,353 vs ledger AED 160,353
```

---

## 4. Compliance dates are operational, not administrative

In the UAE these are not paperwork:

| Item | What happens when it lapses |
|---|---|
| Trade licence | Company bank account freezes; no visa can be issued or renewed; daily fines |
| Establishment card | Blocks all MOHRE transactions |
| Employee visa / labour card | Working illegally; employer fined per person |
| Ejari registration | Tenancy unenforceable at the Rental Dispute Centre; tenant cannot activate DEWA |
| WPS filing | Establishment blocked from new work permits |

All are tracked as columns with expiry dates and surfaced on the dashboard
watchlist at 90 days, with the automation rules seeded to alert at 60 (licences)
and 45 (visas). The demo deliberately has two licences and a visa inside the
window, plus a handful of unregistered leases, so the widget has something real
to say.

---

## 5. Corporate tax (Federal Decree-Law 47 of 2022)

- 0% on taxable income up to **AED 375,000**; **9%** above
- **Small Business Relief**: revenue ≤ **AED 3,000,000** may elect to be treated
  as having no taxable income — available for tax periods ending on or before
  **31 December 2026**, so it is live right now and worth knowing about
- Brought-forward losses may offset at most 75% of taxable income

`calculateCorporateTax()` returns the computation with its reasoning, and the
dashboard labels it an **estimate for planning**. It deliberately does not post a
tax journal: the year-end charge is the accountant's entry, and an ERP that
quietly books its own tax provision is doing something it should not.

Note for this group: SBR is assessed **per taxable person**, and `PROP`, `BUILD`,
`TECH` and `MOBILE` are flagged as separate legal entities. Each is tested on its
own revenue, so some may qualify while the group as a whole does not.

---

## 6. WPS — Wage Protection System

Salaries must be paid through a MOHRE-approved agent and reported in a Salary
Information File. The format is unforgiving: EDR records per employee, exactly
one SCR control record last, fixed column order, CRLF line endings, filename
`<EmployerID><YYMMDDHHMM>.SIF`.

`generateSif()` produces it, and `validateWps()` runs first — checking the
13-digit employer ID, 14-digit Person IDs, 23-character UAE IBANs and routing
codes. Catching a malformed IBAN when the file is generated is materially better
than discovering it when the bank rejects the batch two days before payday.

---

## 7. Everything else that changed

| | Bangladesh assumption | UAE reality |
|---|---|---|
| Currency | BDT ৳, lakh/crore scale | AED, thousands/millions — `formatMoneyCompact` keys the scale off the currency, so "AED 12 L" can never render |
| VAT | 15% | 5%, with exempt and zero-rated distinguished |
| Fiscal year | July start | Calendar year |
| Payment methods | bKash / Nagad mobile wallets | Card-dominant, plus digital wallets, cheques and Tabby/Tamara BNPL |
| COD share | ~65% of online orders | ~28% |
| Weekly rhythm | Friday closed | Trades 7 days; Thu–Sat peak; Friday dips for Jumu'ah, not closed |
| Seasonality | — | AC work roughly doubles May–September |
| Identity | National ID | Emirates ID `784-YYYY-NNNNNNN-C`, TRN 15 digits |
| Deposits | 1–2 months' rent | 5% of annual rent (10% furnished) |
| Rent escalation | 5% annual | 0% — the RERA index caps most Dubai renewals |
| Customer mix | Bangladeshi names | Weighted to Dubai's actual population: ~55% South Asian, ~20% Arab, ~10% Filipino, ~8% Western |

---

## Where the code lives

```
packages/core/src/uae/
  gratuity.ts   End-of-service calculation (Decree-Law 33/2021)
  wps.ts        SIF generation + pre-flight validation
  tax.ts        Corporate tax, VAT return with input apportionment
  index.ts      Emirates, cheque conventions, Emirates ID / IBAN / TRN validators

packages/core/src/metrics/uae-metrics.ts
  vat_return_position · corporate_tax_estimate · gratuity_liability
  cheque_pipeline · compliance_watchlist
```

Nothing outside `uae/` hard-codes a VAT rate, a gratuity formula or a filing
format. A second country — Saudi ZATCA e-invoicing is the obvious next one — is
a sibling directory, not a rewrite.

---

## Not built

Named so the gaps are not mistaken for oversights:

- **FTA VAT201 submission** — the position is computed; filing is manual (Phase 3)
- **e-invoicing** — the UAE mandate phases in from 2026; not implemented
- **Ejari API** — registration is a tracked field, not an integration
- **DEWA integration** — premise numbers stored, no meter feed
- **Free-zone / designated-zone VAT** — flags exist on `business_units`, the
  special place-of-supply rules are not implemented (all seven entities are
  mainland)
- **Corporate tax filing** — estimate only, no return generation
