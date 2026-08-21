# Nexus — Go-Live Runbook, Deploy Checklist and Manual-Entry SOP

**Document** OPS-07 · **Version** 1.0 · **Date** 12 August 2026
**Status** For operation
**Implements** PRD-02 Phase 0 and Phase 1 · **Constrained by** TRD-03

* * *

## 0. What this covers

Three things that are usually left implicit and then go wrong.

1. **Getting to a state where real money can enter the system.** The Phase 0 exit gate, and the deploy discipline that keeps it true.
2. **The pilot cutover** — moving the property portfolio onto Nexus, with the accountant's sign-off as a hard gate and a rollback that actually works.
3. **How the work is done afterwards.** The current process for capturing cash and closing a month, the redesigned process, and the measured difference.

The audit's risk R1 is stated plainly: *staff keep using paper; data is incomplete. The classic ERP death. Mitigated only by an adoption gate nobody has run.* Sections 4 and 5 are that gate, made concrete.

Table of Contents

* * *

## 1. Phase 0 exit gate

No real money enters the system until every row is true. This is a gate, not a checklist to work through while the migration runs in parallel.

### 1.1 Correctness

- [ ] Zero float arithmetic on money anywhere in `packages/core`, enforced by a lint rule that fails CI
- [ ] `packages/core/src/money` has unit tests, including a property test asserting that an allocated amount sums exactly to the whole
- [ ] Every hand-rolled epsilon comparison deleted, not migrated
- [ ] `uae/` has unit tests with hand-calculated fixtures, reviewed by the accountant before commit
- [ ] Fixtures blocked on an open question are marked pending explicitly, not silently omitted — Q-1 parking and apportionment, Q-2 gratuity on resignation
- [ ] `rbac` has unit tests covering each role's boundary
- [ ] All 227 existing checks green, plus the new unit suite

### 1.2 Reliability

- [ ] Every route has an error boundary with a retry
- [ ] Every route has a loading state using the existing skeleton components
- [ ] A single failing metric degrades one section, verified by deliberately breaking one
- [ ] `/health` returns database reachability, migration version, worker heartbeat and snapshot age
- [ ] A post-deploy smoke test hits `/health` and one authenticated page, and fails the deploy on either
- [ ] Sentry receives errors from web and worker, with the existing redaction applied at the boundary
- [ ] A deliberate production 500 pages a human within five minutes — **tested, not assumed**
- [ ] An uptime monitor watches web and worker independently

### 1.3 Infrastructure

- [ ] Schema deploys as committed migrations. `drizzle-kit push` is removed from every script
- [ ] CI fails on migration drift
- [ ] A staging environment exists and every migration passes through it first. **Done means:** the repository variable `STAGING_ENABLED` is `true`, and a push to `main` produces a green `Staging verdict` check whose summary shows row counts and an unchanged trial balance against a copy of production-shaped data. Design, topology and the setup checklist are [docs/08-staging.md](08-staging.md); the pipeline is `.github/workflows/staging.yml`. **Not done today** — the pipeline is committed and switched off, and says so on every run
- [ ] No deployment can be confused about which database it is on. **Done means:** `NEXUS_ENV` and `NEXUS_PRODUCTION_DB_HOST` are set on every environment, and `scripts/check-env.mjs` runs in the Vercel build command of both projects, so a preview or staging deployment pointed at the production database fails to build. Today every Vercel preview shares the production database ([docs/08-staging.md §1](08-staging.md#1-why-a-preview-deployment-is-not-staging))
- [ ] The RLS generator runs as part of migration, and a table without an enforced policy fails CI
- [ ] The scheduler runs automation, outbox, briefing and KPI snapshots, with a run log visible in the product
- [ ] A job that did not run when expected raises a dashboard exception
- [ ] Backups replicate offsite with a documented retention policy, and a restore has been performed and reconciled — **this blocks the pilot**, because real estate records carry a fifteen-year retention obligation and local-disk-only backup does not meet it

### 1.4 Security

- [ ] A user can be deactivated from inside the product, and every session they hold is invalidated immediately — verified with two browsers
- [ ] `/api/v1/me` is rate-limited to the same policy as `/metrics`
- [ ] The boot assertion queries `pg_roles` and refuses to start if the connected role can bypass row-level security
- [ ] The public demo with published credentials is behind a gate or taken down
- [ ] A record of processing activities exists
- [ ] Data processing agreements are in place with Vercel, Neon, the process host, the delivery provider and Anthropic
- [ ] A cross-border transfer position is documented for a database hosted outside the UAE

### 1.5 Hygiene

- [ ] README table count corrected, with a CI check that counts tables
- [ ] Shadowed placeholder routes deleted
- [ ] Unused dependencies removed

**Sign-off.** Phase 0 exits when the owner and whoever holds engineering both sign against this list. Not when the work "feels done."

* * *

## 2. Deploy checklist

Run this every time. Especially for routine deploys — checklists exist to prevent "I forgot to."

### 2.1 Pre-deploy

- [ ] CI green, including unit, integration, metric snapshot, end-to-end and the 68 security checks
- [ ] Migration generated, committed and reviewed as SQL, not as a schema diff
- [ ] Migration applied to staging and the staging smoke test passed. **Done means:** the `Staging verdict` check is green for this commit — `.github/workflows/staging.yml` migrated the staging branch, deployed the application to the staging project and ran `scripts/smoke.mjs` against the URL it had just deployed. Do not tick this from a green CI run: CI applies migrations to an empty throwaway Postgres, which proves the SQL parses and says nothing about what it does to eleven thousand existing journals
- [ ] No known critical bug in the release
- [ ] Rollback plan written **before** deploying, including whether the migration is reversible
- [ ] If the migration is not reversible, that is stated explicitly and the deploy is scheduled outside business hours
- [ ] Feature flags set for anything not yet meant to be visible
- [ ] Anyone who will be using the system in the next hour is told

### 2.2 Deploy

- [ ] Apply the migration as an explicit gated step, never as a side effect of the application deploy
- [ ] Deploy `apps/web`
- [ ] Deploy `apps/worker` and confirm the heartbeat within two minutes
- [ ] Deploy `apps/mcp` if changed
- [ ] Post-deploy smoke test passes
- [ ] Watch error rate and p95 latency for fifteen minutes
- [ ] Verify by hand: sign in, load Today, record a one-dirham cash entry, reverse it

That last step is deliberate. An automated smoke test proves the page renders. Recording and reversing a real entry proves the write path, the journal, the audit log and the reversal all still work — which is the only thing that actually matters.

### 2.3 Post-deploy

- [ ] Error rate back to baseline
- [ ] Scheduled jobs ran on their next tick
- [ ] Snapshot job produced a snapshot
- [ ] Release note written, even for a small change
- [ ] Related tickets closed

### 2.4 Rollback triggers

Decide these before deploying, not during.

| Trigger | Threshold | Action |
| --- | --- | --- |
| Error rate | Above 1 percent of requests, sustained 5 minutes | Roll back the application immediately |
| Dashboard p95 | Above 2 seconds, sustained 10 minutes | Roll back |
| Any unbalanced journal | One | **Stop everything.** Roll back, do not accept new writes, investigate before resuming |
| Write failures | Above 2 percent of write attempts | Roll back |
| Worker heartbeat | Missing for 5 minutes | Roll back the worker; the web app can run without it briefly |
| Cross-tenant assertion failure in monitoring | One | Roll back and treat as a security incident |
| Any figure the accountant reports as wrong | One, during the pilot | Freeze writes, investigate before resuming |

The last row is not a system metric and that is the point. During the pilot the accountant is the monitor, and her report outranks a green dashboard.

### 2.5 Migration-specific

The first two rows are measured automatically by the `migrate` job in
`.github/workflows/staging.yml` and printed to the run summary. They are exact
counts, not `n_live_tup` estimates, for every table in the schema rather than
only the ones the migration was expected to touch — the interesting case is the
table it touched by accident.

- [ ] Row counts before and after, for every table the migration touches. **Evidence:** the "Row count changes" diff in the staging run summary
- [ ] Trial balance before and after — must be identical unless the migration is deliberately financial. **Evidence:** the staging run is green. The job fails on any movement; a deliberately financial migration must be re-run from the Actions tab with the `financial_migration` input ticked, which records the intent against that run
- [ ] For a data-shape migration, a reversal script exists and has been run on staging. **Still manual** — nothing generates or runs a down script. Write it, run it against the staging branch by hand, and confirm the trial balance and row counts return to the baseline the same run printed
- [ ] For a destructive migration, a fresh verified backup exists, taken within the hour

* * *

## 3. The pilot cutover

Moving the property portfolio — apartments and parking — onto Nexus. This is the highest-risk operation in the project, because the audit's risk R2, *migrated opening balances are wrong*, is rated critical and nobody has done it yet.

### 3.1 Timeline

| Week | Work | Gate |
| --- | --- | --- |
| −4 | Phase 0 exit gate signed. Extract source data from spreadsheets and the accountant's files | Phase 0 signed |
| −3 | Build importers. Dry-run every dataset. Iterate on rejections | Zero unexplained rejections |
| −2 | Full dry-run against a staging copy. Accountant reconciles the resulting trial balance line by line | Reconciliation complete |
| −1 | Fix whatever the reconciliation found. Second dry-run. **Accountant signs** | Signed reconciliation |
| 0 | Commit the import on the first of the month. Freeze the spreadsheets read-only | Trial balance ties to the fils |
| 1–4 | Live operation. Weekly reconciliation against the frozen spreadsheets | Weekly checks pass |
| 5 | Close the month inside Nexus. File from it | Month closed and filed |

Cutover happens on the first of a month. Mid-month cutover means apportioning a partial period in the middle of an already risky operation, for no benefit.

**Weeks −2 and −1 have a hard prerequisite.** "A staging copy" means the staging
branch described in [docs/08-staging.md](08-staging.md), refreshed from
production and put through the anonymisation pass in its §4 before anyone
connects to it. Both gates are the primary mitigation for the audit's critical
risk **R2** — *migrated opening balances are wrong* — and neither can be run
against a Vercel preview, because previews share the production database.

Two things must therefore be true before week −2 begins, and both are still open:

- the staging environment is stood up — [docs/08-staging.md §6](08-staging.md#6-owner-checklist), checklist items 1–10;
- the anonymisation pass exists — checklist item 7. Until it does, **no
  production data may be copied to staging**, and a synthetically seeded staging
  branch is enough to prove a migration but is not enough for a reconciliation,
  which by definition needs the real figures.

**Done, for both weeks:** the dry-run ran against the staging branch, and §3.3's
table is completed and signed against the trial balance that branch produced.
"Dry-run against production" is not a substitute and must not be recorded as
one — a dry-run that can only be performed on the live ledger is the risk R2
exists to name.

### 3.2 What gets migrated, in order

Order matters. Each step depends on the one above it.

1. **Legal entities and business units** — trade licences, TRNs, fiscal year ends. Required before anything else because e-invoicing and corporate tax are per entity.
2. **Chart of accounts**, including the new accounts: cash-in-hand per cash point, owner capital contributed, owner drawings, cash over and short per cash point, due-from and due-to per business-unit pair.
3. **Parties** — tenants, suppliers, employees. Deduplicated before import, not after.
4. **Units** — apartments and parking bays, each carrying its VAT treatment. **This is where an error is most expensive**, because it propagates into every invoice the rent run generates.
5. **Leases** with their instalment schedules.
6. **Opening balances** — the trial balance as at the cutover date.
7. **Outstanding receivables and payables**, invoice by invoice, not as a lump.
8. **Post-dated cheques** in hand, with their current state.
9. **Employees**, contracts and pay components, with gratuity service dates.
10. **Cash point floats** as at cutover.

### 3.3 The reconciliation

The gate. Nothing goes live without it.

The accountant is given two documents: the trial balance Nexus produces after the dry-run import, and her own trial balance as at the same date. She reconciles them line by line and signs.

| Line | Nexus | Accountant | Difference | Explained |
| --- | --- | --- | --- | --- |
| Bank |  |  |  |  |
| Cash in hand |  |  |  |  |
| Accounts receivable |  |  |  |  |
| Post-dated cheques held |  |  |  |  |
| Accounts payable |  |  |  |  |
| VAT payable |  |  |  |  |
| Gratuity provision |  |  |  |  |
| Owner's capital |  |  |  |  |
| Retained earnings |  |  |  |  |
| **Total** |  |  |  | **Must be nil** |

**A difference of one fils is a difference.** The audit's own success criterion is "matches the accountant's figure to the fils," and rounding it away is exactly how a migration error becomes permanent.

### 3.4 Rollback

Available for the first 72 hours. After that, correcting entries rather than reversal.

1. Reverse the import batch. Every imported record carries the batch identifier.
2. Unfreeze the spreadsheets.
3. Re-key anything recorded in Nexus during the live window into the spreadsheets — there will be few, and they are in the audit log.
4. Post-mortem before any second attempt.

The spreadsheets stay read-only rather than deleted for the whole of the first month. They are the rollback path, and deleting a rollback path to force adoption is how a bad migration becomes an unrecoverable one.

### 3.5 Go-live day

- [ ] Fresh verified backup taken
- [ ] Import committed
- [ ] Trial balance matches the signed reconciliation
- [ ] Rent run previewed for the month and the VAT split checked against expectation
- [ ] Cash points created with their opening floats
- [ ] Every user can sign in, with MFA enrolled
- [ ] Owner records one real cash entry, end to end, and reverses it
- [ ] Accountant confirms the audit log shows both
- [ ] Spreadsheets frozen read-only
- [ ] Everyone told what changed and who to ask

* * *

## 4. Process optimisation — cash capture

The process this product exists to fix.

### 4.1 Current state

```
Money changes hands
        │
        ▼
Someone remembers          ← failure point 1: memory
        │
        ▼
Written on a slip,
in a notebook, or
in WhatsApp                ← failure point 2: three formats, no format
        │
        ▼
Slip survives the day      ← failure point 3: slips are lost
        │
        ▼
Handed over weekly
or monthly                 ← failure point 4: 1–30 days of latency
        │
        ▼
Accountant asks
"what was this for?"       ← failure point 5: rework, and the answer is a guess
        │
        ▼
Keyed into a spreadsheet   ← failure point 6: transcription error
        │
        ▼
Spreadsheet reconciled
against the bank
at month end               ← failure point 7: variance discovered 30 days late
```

**Measured waste**

| Waste | Where | Cost |
| --- | --- | --- |
| Waiting | 1 to 30 days between the transaction and the record | The consolidated figure is always stale by up to a month |
| Rework | "What was this for?" | A guess recorded as a fact |
| Handoffs | Cash handler, then owner, then accountant | Three chances to lose it |
| Over-processing | The same figure keyed into a slip, a spreadsheet, and the accounts | Three times the work |
| Manual work | Every step | All of it |
| Defects | Lost slips, transcription errors | Unknowable, which is the worst property a financial control can have |

### 4.2 Future state

```
Money changes hands
        │
        ▼
Two taps, on the phone,
at the moment              ← 15 seconds. One handoff. Zero latency.
        │
        ▼
Journal posted, audited,
reversible                 ← no transcription, no interpretation
        │
        ▼
Visible to the owner and
the accountant instantly
        │
        ▼
Day close, blind count,
variance explained         ← variance found today, not in 30 days
```

### 4.3 The difference

| Measure | Now | After | Change |
| --- | --- | --- | --- |
| Steps | 7 | 2 | −71 percent |
| Handoffs | 3 | 0 | eliminated |
| Latency, transaction to ledger | 1 to 30 days | Under a minute | eliminated |
| Formats | 3 informal | 1 typed | standardised |
| Transcription points | 2 | 0 | eliminated |
| Variance detection | Month end | Day close | 30 days earlier |
| Audit trail | None | Complete | new capability |

The three-handoff elimination is the one that matters. Every handoff is a chance for the record to not exist, and a record that does not exist is indistinguishable from money that was never received.

### 4.4 What makes it stick

The redesign fails if any of these is missing.

1. **Two taps, fifteen seconds.** Beyond that, people revert to the notebook. This is a hard design constraint, not a target.
2. **No accounting vocabulary.** "Paid cash," not "Credit cash-in-hand."
3. **The effect is shown before submitting.** "Marina float 2,340 → 1,940" is what replaces understanding double entry.
4. **The photo is optional.** Making it mandatory guarantees the entry is skipped in exactly the case cash covers.
5. **Undo exists for thirty seconds.** People enter faster when a mistake is cheap.
6. **The owner does it too.** If the owner keeps a private notebook, the staff will keep theirs. This is the single strongest adoption lever available and it costs nothing.

* * *

## 5. Process optimisation — month-end close

### 5.1 Current state

There is no close. The accountant assembles figures from spreadsheets and bank statements, and there is no point at which a period becomes final. `assertPeriodOpen` exists in the service layer and no screen can ever fire it, so the guard is unreachable code.

The consequence, in the audit's words: *an accountant cannot complete their core monthly job in this system.*

### 5.2 Future state

```
Day 1–3    Reconcile
             cash sessions all closed
             bank reconciled
             cheques in flight identified
Day 3–5    Review
             pre-close checklist clear
             inter-business balances net
             unallocated payments resolved
Day 5–7    Adjust
             accruals, corrections, the annual VAT wash-up if due
Day 7      Lock
             period closed; posting into it refused with a named reason
Day 7–10   File
             VAT return produced and transcribed to EmaraTax
             WPS by the 1st of the following month — no grace period since June 2026
Day 10     Report
             group consolidated P&L with eliminations shown
```

### 5.3 The pre-close checklist

Surfaced in the product, not kept in someone's head. The close button stays disabled while any item is open.

| Check | Blocking |
| --- | --- |
| All cash sessions closed | Yes |
| All journals balance | Yes — should be structurally impossible to fail |
| Bank reconciled to the period end | Yes |
| Unallocated payments resolved | Yes |
| Inter-business balances reciprocate exactly | Yes |
| Cheques in flight identified and aged | No, informational |
| VAT computed and reviewed | Yes |
| Owner ledger movements categorised | Yes |
| Cash variances above threshold acknowledged | Yes |
| Scheduled jobs all ran during the period | No, informational |

### 5.4 The difference

| Measure | Now | After |
| --- | --- | --- |
| A period can be finalised | No | Yes |
| Posting into a filed period | Possible and undetected | Refused |
| Time to a filable VAT position | Days of assembly | Produced continuously |
| Confidence the figure is final | None | The lock is the guarantee |

* * *

## 6. Operating rhythm

| Cadence | Who | What |
| --- | --- | --- |
| Continuous | Anyone handling money | Record it at the moment |
| Daily, close of business | Each cash handler | Close the till with a blind count. Explain any variance above threshold |
| Daily, morning | Owner | Open Today. Clear the exception list or dismiss with a reason |
| Weekly | General manager | Inter-business balances, jobs breaching SLA, stock below reorder |
| Weekly, during the pilot only | Accountant | Reconcile Nexus against the frozen spreadsheets. Report any difference immediately |
| Monthly | Accountant | The close sequence in section 5.2 |
| Monthly | Owner | Group consolidated P&L with eliminations. The inter-business Sankey. The owner ledger ageing |
| Quarterly | Accountant | VAT return |
| Annually | Accountant | VAT wash-up adjustment, corporate tax computation, gratuity review |
| Annually | Owner | Trade licence renewals, and from 2027 the e-invoicing service provider relationship |

* * *

## 7. Incident response

Minimal, because the team is small and an unread runbook is worse than a short one.

### 7.1 Severity

| Level | Definition | Response |
| --- | --- | --- |
| **1** | Financial data is wrong or at risk. An unbalanced journal, a cross-tenant leak, a corrupted balance | Stop writes. Notify the owner and the accountant. Restore from a verified backup if needed. Post-mortem is mandatory |
| **2** | The system is down or a core flow is broken | Roll back. Notify users. Fix forward only after the rollback is confirmed stable |
| **3** | A feature is degraded but money still moves correctly | Fix in the next deploy |
| **4** | Cosmetic | Backlog |

### 7.2 The first five minutes of a severity 1

1. Stop the bleeding. Disable writes before diagnosing.
2. Capture state. Snapshot the database before touching anything.
3. Notify the owner and the accountant. They may need to stop external actions — a payment, a filing.
4. Only then diagnose.

Step two is the one people skip under pressure, and it is the one that determines whether a post-mortem is possible.

### 7.3 The specific ones worth pre-writing

| Incident | First action |
| --- | --- |
| Unbalanced journal detected | Stop writes. This should be structurally impossible; treat it as data corruption until proven otherwise |
| A tax figure was wrong on a filed return | Quantify. Above AED 10,000 in tax difference, voluntary disclosure is mandatory within 20 business days of discovery |
| Automation sent something it should not have | Kill switch. The caps, dedupe and approval gates are already built; find out which one did not fire |
| A user left and still has access | Deactivate, which invalidates sessions. Then audit everything they did since leaving |
| The worker has not run for a day | Check the run log. Automation, outbox, briefing and snapshots have all silently not happened; the snapshot gap needs backfilling |

* * *

## 8. Measuring adoption

Feature delivery is not progress. Daily use is.

### 8.1 The gate

**One full calendar month in which every money movement touching the property portfolio exists in Nexus and nowhere else, and the accountant's trial balance ties to the fils.**

This replaces the audit's fourteen-day duration test for this pilot, because a fourteen-day window in a business with a handful of monthly events produces almost no signal. The salon runs as pilot two under the original duration test, where it is meaningful.

### 8.2 Weekly, during the pilot

| Check | Method | Pass |
| --- | --- | --- |
| Money movements outside Nexus | The accountant reconciles by hand against the frozen spreadsheets | Zero |
| Cash entries recorded same-day | Compare `occurredOn` to `createdAt` | Above 90 percent |
| Cash sessions closed with a blind count | Sessions closed over sessions opened | 100 percent |
| Exceptions actioned rather than dismissed | Event counts | Trending up |
| Owner opened the app | Session events | Most days |

### 8.3 The leading indicator of failure

**A spreadsheet reappearing.** Not "someone complained." Not "adoption feels slow." A spreadsheet.

If one appears, the correct response is to find out what it does that Nexus cannot, and build that — not to ask people to stop using it. The shadow-system research is unambiguous that the root cause is product fit rather than resistance: the tool does not support how the work is actually done, so a workaround appears, and then the two records drift until people trust the spreadsheet more than the system.

The audit's own contingency for R1 says the same thing in fewer words: *pause feature work; fix the workflow that drove them back to paper.*

* * *

## 9. Open dependencies

Operational items that need an answer from outside the team.

| # | Question | Owner | Blocks |
| --- | --- | --- | --- |
| Q-1 | Standalone parking VAT treatment; whether to apply for the floorspace apportionment method | Tax adviser | Pilot go-live |
| Q-2 | Current resignation versus termination gratuity position | MOHRE or employment lawyer | Gratuity test fixtures |
| Q-5 | Whether a cleared UAE cheque can be returned | The group's bank | Cheque state machine |
| Q-6 | Which entities hold which licences, and their revenue against thresholds | Owner and accountant | E-invoicing timing |
| Q-7 | Exact WPS SIF layout | The group's WPS agent | Payroll run |
| Q-8 | Whether the current hosting satisfies PDPL cross-border transfer | Data protection adviser | Real data entering the system — **and the staging branch**, which is a second copy of the same records in the same region and inherits the question rather than answering it ([docs/08-staging.md §3](08-staging.md#3-topology)) |
| Q-10 | Owner ledger staleness and materiality thresholds | Owner and accountant | Cash and owner-ledger defaults |
| Q-11 | Cash variance threshold requiring manager acknowledgement | Owner | Day-close default |
| Q-12 | Whether inter-business services bill at cost or at market | Owner and tax adviser | Inter-business transfer defaults |

Q-1 and Q-8 both block go-live. They should be commissioned this week, because both have lead times measured in weeks and neither is expensive.

* * *

## 10. The two hours that would teach the most

Stated separately because it is cheap, it is not scheduled, and it would resolve more open questions than any further analysis.

**One hour with the accountant**, reconstructing last quarter's VAT201 by hand. Watch which figures she cannot get, which she has to guess, and which she checks twice.

**One hour with whoever handles rent cheques**, watching them do it. Where the cheque physically lives, what gets written down, what gets remembered, and when it gets told to someone.

The audit named the absence of user research as one of the three things that mattered most, and it is still true. Two hours would fix a meaningful share of it.
