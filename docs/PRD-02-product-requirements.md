# Nexus — Product Requirements Document

**Document** PRD-02 · **Version** 2.0 · **Date** 12 August 2026
**Supersedes** The reverse-engineered PRD in section 7 of the audit dated 9 August 2026
**Status** For ratification by the owner
**Companions** RES-01 (Research), TRD-03 (Technical), PDD-04 (Design), WF-05 (Wireframes), MCP-06 (MCP Server), OPS-07 (Go-Live and SOP)

* * *

## 0. How to read this document

The audit was a reconstruction: it read the code and inferred what the requirements must have been. This document is the opposite. It states what Nexus is required to do, decides what it will not do, and defines when it is finished. Where it contradicts the code, the code is wrong.

Three conventions carry through:

| Tag | Meaning |
| --- | --- |
| **[BUILT]** | Exists and works today, per the audit's verified inventory |
| **[PARTIAL]** | Exists but does not complete the job a user needs done |
| **[NEW]** | Does not exist. Most of these came out of research, not the code |

Requirement identifiers are stable. `FR-` is functional, `NFR-` non-functional. Where a requirement traces to the audit, the audit's identifier is carried alongside so nothing is lost.

Table of Contents

* * *

## 1. Executive summary

Nexus is a single operating system for a Dubai owner-operator group that runs six unlike businesses: a salon, a mobile-phone shop, an e-commerce channel, residential apartments, parking bays, and a field-services arm covering plumbing, electrical, AC, handyman, cleaning and construction maintenance. Today each of those is a separate spreadsheet, a separate cash box and a separate mental model. Nexus puts them on one ledger, one customer list and one dashboard, with UAE tax and labour law modelled as domain logic rather than a settings page.

The engineering foundation is sound. The audit found a double-entry ledger with a database-enforced balance trigger and zero unbalanced journals across 28,106 lines, row-level security generated from the schema and running under a non-bypassing role, and a semantic metric layer that gives the dashboard, the API and the assistant one definition of every number. Those are the right foundations and this document does not disturb them.

What is missing is the product. Nobody can put real data in, nobody can record cash, nobody can close a month, and nothing tells anyone when something breaks. Research since the audit adds a fourth gap with a statutory clock attached: UAE e-invoicing becomes mandatory for businesses of this size on 1 July 2027, with an accredited service provider appointment due by 31 March 2027, and Nexus has no plan for it.

**This PRD makes one structural change to the project.** It defines an MVP, which the audit identified as the single root cause of everything that went wrong: without "one business, end to end, in production," the natural optimisation was breadth, and breadth is what happened — six businesses at roughly 60 percent, where read paths outnumber write paths two to one.

The MVP is defined in section 3 and everything else in this document is subordinate to it.

* * *

## 2. Problem

### 2.1 Statement

A multi-business owner cannot see his true financial position. Each business keeps its own records in its own format; work one business does for another is never recorded, so the property looks more profitable than it is and the AC business looks less busy; and UAE tax treatment differs by business line, so the consolidated number either does not exist or is wrong. Meanwhile a material share of the money moves as cash, personal funds, and informal settlements that no system captures at all.

### 2.2 Decomposed

| # | Problem | Severity | Status |
| --- | --- | --- | --- |
| P1 | No consolidated view. Six businesses, six record-keeping systems, no group profit and loss | Critical | Solved in the model, unproven with real data |
| P2 | Inter-company work is invisible. Nobody invoices anybody | Critical | Modelled, untested with real work |
| P3 | UAE tax treatment differs per business line. Residential rent is exempt, parking is standard-rated, input VAT must be apportioned | Critical | Implemented; apportionment method and parking treatment both unconfirmed |
| P4 | Cash settles in post-dated cheques, which are neither cash nor receivables | High | Lifecycle built; partial payment and post-clearing return unmodelled |
| P5 | Gratuity is an unfunded, invisible liability accruing daily on basic salary | High | Computed; no payout workflow, no unit tests |
| P6 | Routine watching is manual — overdue debt, expiring leases, bouncing cheques, expiring visas | Medium | Rules built, nothing delivered |
| P7 | Compliance deadlines are remembered, not tracked | High | Watchlist built, no delivery |
| **P8** | **A large share of money never touches an invoice. Cash paid and received, owner funds in and out, one business settling another's bill in cash** | **Critical** | **[NEW] No representation at all** |
| **P9** | **Numbers are shown, not explained. The owner is not an accountant and reads visually** | **High** | **[NEW] Tables and tiles only; no explanatory visualisation** |
| **P10** | **UAE e-invoicing becomes mandatory for this business size on 1 July 2027** | **Critical** | **[NEW] Not in the product, not in the roadmap** |

P8 through P10 did not appear in the audit. P8 came from the owner directly. P9 came from the owner directly. P10 came from regulatory research and is the only requirement here with a legal deadline attached.

### 2.3 Cost of not solving it

- **P8 is the adoption killer.** Research on ERP failure identifies the shadow-system mechanism precisely: a spreadsheet exists because the ERP does not support how people actually work, the two systems drift, and staff come to trust the spreadsheet over the system of record. Every cash transaction that cannot be entered in Nexus is a reason for a spreadsheet to exist. Reported ERP failure rates cluster at 68 to 70 percent, with inadequate change management at 42 percent of failures. A team this small has no change-management function, so the change management has to be in the product.
- **P3 and P10 carry penalties.** Voluntary disclosure of a VAT error above AED 10,000 costs 1 percent per month before an audit and 15 percent plus 1 percent per month after. Failure to appoint an e-invoicing service provider by the deadline is cited at AED 5,000 per month, recurring - though the exact penalty schedule is one of two conflicting framings and is unconfirmed against the Cabinet Decision text (Q-3).
- **P1 and P2 are the reason the product exists.** No competitor at this price point solves them. Zoho Books, the tool this owner would most plausibly buy instead, has no native multi-entity consolidation at all.

* * *

## 3. The MVP definition

The audit's most important finding was the absence of this section. It is stated here as a single sentence, and every priority in this document derives from it.

> **MVP: the property portfolio — apartments and parking — runs entirely on Nexus for one full calendar month. Every money movement that touches it, including cash and owner funds, exists in Nexus and nowhere else. At month end the accountant closes the period inside the system, and the trial balance ties to her own figure to the fils.**

### 3.1 Why the property portfolio

The pilot business has been selected as rentals and parking. This differs from the audit's recommendation of the salon, and the trade-off is worth stating plainly rather than glossing.

**What it gets right.** It is the smallest data migration in the group — 41 leases and 113 cheques against thousands of salon appointments. It exercises the highest-risk compliance path in the entire product: exempt residential rent against standard-rated parking, input VAT apportionment, the annual wash-up, and a fifteen-year record retention obligation. It tests the post-dated cheque lifecycle, which is where UAE money actually settles. And the single highest-return missing feature in the whole backlog, the rent run, lives here.

**What it gets wrong.** Transaction frequency is low. The audit's adoption test — fourteen consecutive days with no parallel paper — produces almost no signal in a business with a handful of monthly events. Fourteen days of rentals might be four transactions.

**The mitigation** is to change the shape of the gate, from duration to completeness. One full calendar month, every money movement, nothing outside the system. That is stated above. The salon then runs as pilot two under the original fourteen-day duration test, where it is meaningful.

### 3.2 What the MVP requires that does not exist

| Requirement | Why the MVP fails without it |
| --- | --- |
| Data import with accountant sign-off | No real books can enter the system |
| Manual cash and owner-fund entry | Rent collected in cash, repairs paid in cash, owner drawings — none can be recorded |
| Lease create, renew, terminate | The pilot business is read-only today |
| Rent run | A month of invoices cannot be raised in any reasonable time |
| Month-end close and period lock | The accountant cannot finish a month; the guard exists but no screen can fire it |
| User deactivation with session revocation | Offboarding requires a database edit and leaves sessions live |
| Error and loading states | One failing metric breaks a whole page, on 21 of 21 pages |
| Observability | A production failure is currently invisible |
| Decimal money arithmetic | The ledger is correct in the database and approximate in the application |
| Unit tests on the tax engines | These numbers go to a regulator |

### 3.3 What the MVP explicitly does not require

The salon. The phone shop. E-commerce. Field services beyond recording an inter-company job against a property. The technician mobile app. Arabic. The e-invoicing transmission path, though its architectural placeholder is required. Accessibility remediation beyond keyboard operability. Any SaaS capability.

* * *

## 4. Users

Seven personas were inferred in the audit from business types and the permission model. An eighth is added here from research, and three are sharpened.

### P1 · Sumon — the owner (primary)

Owns and directs every business unit. Moves between sites daily and decides from a phone, in transit, between meetings. Checks in bursts, early morning and late evening. Skims, does not study. Trusts a number only if he can see where it came from.

**Needs.** Consolidated cash and profit. A short list of what needs him today. The ability to drill from any headline number to the rows underneath. The ability to record a cash payment from his phone without opening an accounting form. Explanation, not just display — he is not an accountant and reads visually.

**Expectation.** Open the app, understand the position, in well under a minute. The "ten seconds" in the original persona is a useful outer bound rather than a measured rule; no rigorous study establishes a ten-second dashboard threshold, and the closest formal analogue is the standard UX time-scale literature, which treats ten seconds as the limit of task-level attention.

**Design consequence.** The dashboard leads with an exception list, not a wall of tiles. Every figure links to its evidence. Charts carry a written conclusion. Cash entry is two taps from the home screen.

### P2 · Rashid — general manager

Runs day-to-day operations across units. Firefights by phone and has no single queue of what is slipping. Needs a cross-unit operational view, exception lists, and the ability to act without escalating. Sees everything the owner sees except payroll-level compensation detail — 85 of 122 permissions.

### P3 · Priya — accountant

Books, VAT returns, payroll, corporate tax, audit liaison. Chases source documents, reconciles inter-company, apportions input VAT across exempt and standard-rated supplies. High tolerance for accounting complexity, none for ambiguity.

**Three obligations land on her that the audit did not model.** The annual VAT wash-up adjustment reconciling provisional apportionment to actual use. A real corporate tax computation from FY2027, when Small Business Relief expires for periods ending on or after 31 December 2026. And an e-invoicing exception queue from 2027, because a rejected document under the Message Level Status framework is her problem, not the system's.

**Expectation.** Every figure traceable to a journal. Nothing ever hard-deleted. Her screens currently have no top-level navigation entry, which is no longer merely a usability complaint.

### P4 · Maya — receptionist, salon

Books appointments, takes walk-ins, handles payment at the chair. Needs to serve the queue without making the customer wait on software. Fast booking, walk-in without a customer record, point of sale in a few taps. Never sees revenue figures — 17 permissions, location-scoped.

### P5 · External auditor

Read-only, tenant-wide, 19 permissions. Needs evidence, not editing.

### P6 · Kamal — field technician

Executes plumbing, AC and electrical jobs on site. Poor connectivity in basements and new builds. Types on a phone with gloves on.

**Research gives concrete numbers to design against.** Standard gloves reduce effective touch precision to 20 to 25 mm, so tap targets need 48 to 56 px rather than the usual 44. Consumer screens are effectively unreadable in Dubai daylight, so primary status text should target WCAG AAA contrast of 7:1 and a high-contrast mode should be a first-class toggle. Any essential action must be reachable in three taps or the app gets abandoned for a phone call. Critical controls belong in the bottom 40 percent of the screen because the other hand holds a tool.

The technician experience does not exist. The schema supports it fully. This is the largest gap between what the model promises and what a user can do, and it is deliberately deferred to Phase 3.

### P7 · Ali — barber

Self-scoped, 5 permissions. Sees only the salon and is denied revenue figures, both verified by test. Needs his own schedule and his own commission — the latter is computed and has no screen.

### P8 · The cash handler [NEW]

Not a job title. A role that Maya at the salon, the parking attendant, the driver collecting a rent cheque, and the owner himself all occupy at different moments.

**Characteristics.** Handles physical money. Works at a counter or in transit. Has no accounting training and will never construct a journal entry. Is the person whose behaviour determines whether a shadow spreadsheet exists.

**Needs.** A float they open and close. A variance they can explain rather than hide. A receipt they can photograph. A system that asks what happened, not what to debit.

**This persona is the adoption gate.** Every requirement in the manual-entry module exists to serve it.

### 4.1 Jobs to be done

| # | When | I want to | So I can | Served today |
| --- | --- | --- | --- | --- |
| J1 | I wake up | See whether anything went wrong overnight | Act before it compounds | Yes |
| J2 | I consider a new venture | Know which existing business actually makes money | Allocate capital honestly | Partial — no per-unit capital view |
| J3 | A tenant's cheque is due | Know whether it cleared | Chase before it bounces | Yes |
| J4 | VAT filing approaches | Produce a correct return including exempt apportionment | Avoid FTA penalties | Partial — no annual wash-up |
| J5 | An employee resigns | Know the exact gratuity owed | Pay correctly and immediately | Partial — no payout, no tests |
| J6 | A technician finishes a job | Capture it at the site | Invoice same-day rather than next-week | No |
| J7 | I want to know something unusual | Ask in plain language | Avoid waiting for a report | Built and switched off |
| J8 | Stock runs low | Reorder before stockout | Not lose the sale | Yes |
| J9 | Month ends | Close the books | File and move on | No |
| **J10** | **I pay someone in cash** | **Record it in ten seconds from my phone** | **Not lose it, and not keep a notebook** | **No** |
| **J11** | **I put my own money into a business** | **Record it as my capital, not as revenue** | **See what I have actually invested where** | **No** |
| **J12** | **One business pays another's bill** | **Have both sides recorded automatically** | **Know which business subsidises which** | **No manual path** |
| **J13** | **I look at a number I do not like** | **See why it moved** | **Act on the cause rather than the symptom** | **No** |
| **J14** | **A B2B invoice goes out after July 2027** | **Have it transmitted and accepted** | **Not accrue monthly penalties** | **No** |

* * *

## 5. Goals and non-goals

### 5.1 Business goals

| # | Goal | Metric | Target | Horizon |
| --- | --- | --- | --- | --- |
| B1 | The property portfolio runs entirely on Nexus | Money movements outside the system | Zero for one calendar month | Phase 1 |
| B2 | Eliminate the consolidation delay | Time to consolidated position | Under 10 seconds | Met, \~150 ms |
| B3 | Avoid UAE compliance penalties | Late or incorrect filings, and penalty AED | Zero | Ongoing |
| B4 | Recover inter-company margin visibility | Inter-company flows recorded | 100 percent of known flows | Phase 1 |
| B5 | Meet the e-invoicing mandate | ASP appointed and live | Appointed by 31 Mar 2027, live by 1 Jul 2027 | Phase 2 |
| B6 | Replace fragmented record-keeping across the group | Businesses fully operating in Nexus | 6 of 6 | Phase 4 |
| B7 | *Deferred* — become a sellable product | Paying tenants | Not pursued; foundation retained | Gated |

B7 reflects a decision taken: build for this group first, keep the multi-tenant foundation, do not fund commercial work until the internal deployment is proven. The audit's Phase 5 stays gated behind that.

### 5.2 Product goals

| # | Goal | Status |
| --- | --- | --- |
| PG1 | One dashboard covering every business | Built |
| PG2 | One ledger, always balanced | Built, database-enforced |
| PG3 | One customer list across businesses | Built |
| PG4 | UAE rules correct by construction | Isolated correctly; two rules unconfirmed, none unit-tested |
| PG5 | Mobile-first for the owner | Responsive web built; no offline, none needed for him |
| PG6 | Automation that acts, not just records | Engine built, inert — no scheduler, no delivery channel |
| PG7 | AI that cannot lie about numbers | Architecturally solved; being funded |
| **PG8** | **Every money movement is recordable, including the informal ones** | **[NEW] Nothing exists** |
| **PG9** | **The dashboard explains rather than displays** | **[NEW] Nothing exists** |
| **PG10** | **Compliance artefacts are produced, not remembered** | **[NEW] Partially built** |

### 5.3 Non-goals

These did not exist during the build and their absence is a significant part of why scope wandered.

| # | Non-goal | Rationale |
| --- | --- | --- |
| NG1 | Not a general-purpose accounting package | It serves this portfolio's shape. It will lose a breadth comparison against Zoho and should not try to win one |
| NG2 | Not a replacement for the accountant | It produces defensible numbers; a human still files |
| NG3 | Not a customer-facing storefront | E-commerce means channel order sync, not a shopfront |
| NG4 | No payroll disbursement | WPS SIF export only; the bank moves the money |
| NG5 | No direct FTA e-filing for VAT or corporate tax | Produce the return; a human submits. E-invoicing is separate and is in scope, because it is not filing |
| NG6 | Not multi-jurisdiction | UAE only. A second country is a sibling directory, not a configuration flag |
| NG7 | No LLM-generated SQL, ever | Architectural commitment. Accuracy and tenant isolation both depend on it |
| NG8 | No offline web | Offline is a native mobile concern, for technicians only |
| NG9 | No native app for the owner | Responsive web is sufficient for reading. Duplicating 21 screens natively buys almost nothing |
| NG10 | No expansion of the role model | 122 permissions for 9 users is already ahead of need |
| NG11 | No construction or projects module | Tables exist with no story behind them. Delete or defer; do not build on speculation |
| NG12 | **No feature parity with Odoo** | The wedge is portfolio consolidation plus UAE specificity. Breadth is how this loses |
| NG13 | **No bank feed integration in v1** | Removes the single most common cause of double counting until manual entry is proven |
| NG14 | **No automated posting from AI or MCP without confirmation** | Every write proposed by a model requires an explicit human confirmation step |

* * *

## 6. User stories

Priorities: P0 blocks the MVP. P1 is required for the product to be genuinely usable. P2 is quality and reach.

### Epic A — Consolidated visibility (owner)

| ID | Story | Priority | Status |
| --- | --- | --- | --- |
| A1 | As an owner, I want one dashboard across all businesses so that I stop asking people for numbers | P0 | Built |
| A2 | As an owner, I want to drill from any headline number to its rows so that I can trust it | P0 | Built |
| A3 | As an owner, I want a per-business profit comparison so that I know which subsidises which | P0 | Built |
| A4 | As an owner, I want the first thing I see to be what needs me today, not a wall of metrics | P0 | Partial — panel exists, not the organising principle |
| A5 | As an owner, I want a daily briefing pushed to me so that I do not have to open the app | P1 | Composed, no delivery channel |
| A6 | As an owner, I want to ask questions in plain language so that I get answers nobody built a report for | P1 | Built, switched off, being funded |
| A7 | As an owner, I want to see trends over time so that I know if things are improving | P1 | No historical snapshots |
| **A8** | **As an owner, I want a chart that tells me why a number moved, not just what it is** | **P1** | **[NEW]** |
| **A9** | **As an owner, I want to see how money moves between my businesses in one picture** | **P2** | **[NEW]** |

### Epic B — Money in

| ID | Story | Priority | Status |
| --- | --- | --- | --- |
| B1 | As an accountant, I want to raise an invoice with correct VAT treatment per business line | P0 | Built |
| B2 | As an accountant, I want to record a payment and allocate it across invoices | P0 | Built |
| B3 | As an accountant, I want over-allocation refused | P0 | Built |
| B4 | As an accountant, I want a credit note that reverses revenue, VAT and cost of goods and restocks | P0 | Built |
| B5 | As a property manager, I want to generate every monthly rent invoice in one action | P0 | Missing — highest return per unit of work |
| B6 | As an accountant, I want to track post-dated cheques through their lifecycle | P0 | Built |
| B7 | As an accountant, I want to record a cheque returned unpaid after it cleared | P1 | State unreachable |
| **B8** | **As an accountant, I want to record a cheque that was partially paid by the bank** | **P1** | **[NEW] Now a normal UAE outcome** |

### Epic C — Money out

| ID | Story | Priority | Status |
| --- | --- | --- | --- |
| C1 | As an accountant, I want to record a supplier bill that receives stock and posts input VAT | P0 | Built |
| C2 | As an accountant, I want irrecoverable VAT expensed for exempt-supply businesses | P0 | Built |
| C3 | As an accountant, I want to pay a bill without over-paying it | P0 | Built |
| C4 | As a warehouse manager, I want to raise a purchase order and have it approved | P1 | Create only |
| C5 | As a warehouse manager, I want to count stock and post the variance | P1 | Built |
| C6 | As a warehouse manager, I want to transfer stock between warehouses | P2 | Missing |

### Epic M — Manual and cash entry [NEW]

This epic did not exist. It is the adoption gate.

| ID | Story | Priority |
| --- | --- | --- |
| M1 | As a cash handler, I want to record cash received in under fifteen seconds, on a phone, without choosing an account | P0 |
| M2 | As a cash handler, I want to record cash paid out the same way, and attach a photo of the receipt | P0 |
| M3 | As an owner, I want to record money I put into a business as my capital, not as revenue | P0 |
| M4 | As an owner, I want to record money I take out as a drawing, and see what I have taken across all businesses | P0 |
| M5 | As an owner, I want to record one business paying another's cost, and have both sides created automatically | P0 |
| M6 | As a cash handler, I want to open a float at the start of a shift and close it with a counted amount at the end | P1 |
| M7 | As a cash handler, I want a variance between counted and expected cash to be recorded and explained, not hidden | P1 |
| M8 | As an accountant, I want every manual entry to be reviewable, reversible and attributable, and never hard-deleted | P0 |
| M9 | As an accountant, I want to see the owner ledger per business with an ageing flag on stale balances | P1 |
| M10 | As an owner, I want to save a repeating cash entry as a template and fire it with one tap | P2 |
| M11 | As an owner, I want to photograph a bill and have the fields filled in for me to check | P2 |
| M12 | As an owner, I want to record a cash payment by telling the assistant what happened, and confirm before it posts | P1 |

### Epic D — Operations

| ID | Story | Priority | Status |
| --- | --- | --- | --- |
| D1 | As a receptionist, I want to book a chair in a few taps, including walk-ins with no customer record | P1 | Built |
| D2 | As a barber, I want to see my own schedule and my own commission | P1 | Schedule only |
| D3 | As a general manager, I want to raise and complete a service job | P1 | Built |
| D4 | As a technician, I want to complete a job offline on site and have it sync | P2 (P0 for Kamal) | No mobile app |
| D5 | As a property manager, I want a unit board showing vacancy | P0 | Read-only |
| D6 | As a property manager, I want to create, renew and terminate a lease | P0 | No write path |
| **D7** | **As a property manager, I want a service job on a property to bill the property automatically at cost or at market** | **P0** | **[NEW] The wedge, made operational** |

### Epic E — Compliance

| ID | Story | Priority | Status |
| --- | --- | --- | --- |
| E1 | As an accountant, I want a VAT201 with input apportionment across exempt and standard-rated supplies | P0 | Built, untested in isolation |
| E2 | As an accountant, I want the gratuity liability on basic salary only | P0 | Built, untested |
| E3 | As an accountant, I want a WPS SIF file for the bank | P0 | Export only |
| E4 | As an accountant, I want a corporate-tax estimate | P1 | Built, untested, assumes relief that expires |
| E5 | As an owner, I want warning before a trade licence, Ejari or visa expires | P0 | Metric only, no delivery |
| E6 | As an accountant, I want to close a period so nobody can post into it | P0 | Guard exists, no screen |
| E7 | As an auditor, I want read-only access to everything with an immutable trail | P1 | Built |
| **E8** | **As an accountant, I want the annual input-VAT wash-up adjustment computed and posted** | **P0** | **[NEW]** |
| **E9** | **As an accountant, I want reverse charge applied to imported services** | **P1** | **[NEW]** |
| **E10** | **As an accountant, I want B2B invoices transmitted as PINT AE e-invoices and their acceptance tracked** | **P1** | **[NEW] Statutory from 1 Jul 2027** |
| **E11** | **As an accountant, I want a corporate tax computation that does not assume Small Business Relief** | **P1** | **[NEW] Relief expires for periods ending on or after 31 Dec 2026** |

### Epic F — Platform and trust

| ID | Story | Priority | Status |
| --- | --- | --- | --- |
| F1 | As any user, I want my session protected by multi-factor authentication | P0 | Built |
| F2 | As an owner, I want to sign out everywhere if I suspect compromise | P1 | Built |
| F3 | As an owner, I want to import my existing books | P0 | Missing — blocks everything |
| F4 | As an owner, I want the system to alert me automatically | P1 | Rules run, no channel |
| F5 | As a developer, I want an API so a mobile app can be built | P2 | Read-only |
| **F6** | **As an owner, I want to invite, re-role and deactivate staff from inside the product, and deactivation must kill their sessions** | **P0** | **[NEW severity] Currently a database edit** |
| **F7** | **As an owner, I want to query and record through Claude on my phone, with confirmation before anything posts** | **P1** | **[NEW]** |
| **F8** | **As any user, I want a way to say "this number is wrong" from the screen showing it** | **P2** | **[NEW] The highest-signal bug class in an ERP** |

* * *

## 7. Functional requirements

Each requirement carries acceptance criteria. Traceability to the audit's identifiers is preserved in the right-hand column.

### 7.1 Manual and cash entry [NEW module]

The design principle for this entire module: **the user describes what happened; the system decides what to debit.** No screen in this module shows an account picker to a non-accountant. Every object maps to a fixed journal shape.

* * *

**FR-M01 · Cash receipt** · P0 · Story M1

Record money physically received that is not settling an existing invoice, or is settling one in cash.

*Inputs:* business unit, amount, date defaulting to today, cash point, optional counterparty, optional invoice allocation, optional note, optional photo.

*Journal:* debit cash-in-hand for the cash point, credit either accounts receivable when allocated to an invoice, or a revenue account with VAT split when not.

*Acceptance criteria*

- Recording a cash receipt of AED 500 against an open invoice reduces that invoice's amount due by 500 and posts a balanced journal.
- Recording a cash receipt with no allocation posts to revenue with the VAT treatment of the selected business unit, and residential-rent business units post as exempt.
- The entry is completable in four fields or fewer on a phone, with amount focused on open.
- An audit entry records actor, timestamp and before-and-after state.
- Replaying the same idempotency key does not double-post.

* * *

**FR-M02 · Cash payment** · P0 · Story M2

*Inputs:* business unit, amount, date, cash point, expense category or supplier, optional bill allocation, optional note, optional photo.

*Journal:* debit expense or accounts payable, debit input VAT where recoverable, credit cash-in-hand. Where the business unit makes exempt supplies, input VAT is expensed rather than posted to the recoverable account — the same rule the bill path already implements.

*Acceptance criteria*

- Paying AED 400 cash for a repair on a residential property expenses the VAT rather than recovering it, and the VAT201 excludes it from recoverable input tax.
- A photo attaches to the entry and is retrievable from the audit trail.
- Cash-in-hand cannot go negative for a cash point without an explicit override carrying a reason, which is recorded.

* * *

**FR-M03 · Owner contribution** · P0 · Story M3

*Inputs:* business unit, amount, date, destination — bank or a cash point, optional note.

*Journal:* debit bank or cash-in-hand, credit owner's capital contributed for that business unit.

*Acceptance criteria*

- The entry never appears in revenue on any profit-and-loss view.
- The owner ledger for the business unit increases by the amount.
- A group-level owner ledger shows contributions across all business units.

* * *

**FR-M04 · Owner drawing** · P0 · Story M4

*Journal:* debit owner's drawings, credit bank or cash-in-hand.

*Acceptance criteria*

- The entry never appears as an expense on any profit-and-loss view.
- The owner ledger decreases by the amount.
- A net owner position per business unit is available, and at group level.

* * *

**FR-M05 · Owner ledger with ageing** · P1 · Story M9

A per-business-unit and group view of contributions, drawings and net position over time, with two flags: a balance unchanged for longer than a configurable staleness period, and a net drawn balance above a configurable materiality threshold.

*Rationale:* the director's loan account pattern from the research. A running total alone is not enough — in practice these balances sit unexamined for years, and the failure is invisible without an ageing clock.

*Acceptance criteria*

- Both thresholds are configurable per tenant with sensible defaults.
- A flagged balance appears in the compliance watchlist and in the dashboard exception list.

* * *

**FR-M06 · Inter-business transfer** · P0 · Story M5, D7

The wedge, made operational. One business paying another's cost, or doing work for another, recorded once and reflected on both sides.

*Inputs:* paying business unit, benefiting business unit, amount, date, nature — cash advance, shared cost, or service performed, optional job reference, optional note.

*Journal, created at the point of the transaction, not reconciled afterwards:*

- Paying unit: debit due-from-{benefiting unit}, credit cash, bank or expense as appropriate.
- Benefiting unit: debit expense or asset, credit due-to-{paying unit}.
- Where the nature is a service performed, the performing unit optionally recognises revenue at an arm's-length rate and the receiving unit recognises the cost, which nets to zero at group level.

*Acceptance criteria*

- Both legs are created in one transaction. It is not possible to create one without the other.
- Due-from on unit A always equals due-to on unit B for the same counterparty pair. A reconciliation check asserts this and fails CI if violated.
- Group-level consolidated profit and loss eliminates both sides, and the consolidated total is unchanged by the transfer.
- Where an arm's-length rate is applied, the basis is recorded on the document. This supports the transfer-pricing documentation obligation that arises for connected persons under UAE corporate tax.
- A settlement action reverses both sides symmetrically.

* * *

**FR-M07 · Cash point float and day close** · P1 · Stories M6, M7

*Cash point:* a named physical location holding cash, belonging to a business unit — the salon till, the shop till, the parking kiosk, the owner's pocket float. Operates on the imprest system: a fixed float, replenished to level rather than allowed to drift.

*Open:* records the opening float and the person responsible.
*Close:* records a counted amount entered **before** the expected amount is shown. This is a blind count, and it is the standard control against a counter adjusting the figure to match a known target.

*Variance:* the difference posts to a **cash over and short** account belonging to that cash point, in other income and expense below operating profit. Never to miscellaneous expense, and never to a generic suspense bucket.

*Acceptance criteria*

- The expected amount is not rendered on the client before the counted amount is submitted.
- A variance above a configurable threshold requires a reason and a manager acknowledgement before the session closes.
- Variance is queryable by cash point, by person and by period, and appears as a chart in the dashboard. The purpose is to distinguish a training problem from a theft problem, which requires clustering, not totals.
- Replenishment restores the float to its configured level and posts the expenses.

* * *

**FR-M08 · Manual journal, for the accountant only** · P1 · Story M8

An unrestricted debit-and-credit entry form, gated on a permission only the accountant and owner roles hold.

*Acceptance criteria*

- Requires the entry to balance before submission, in addition to the database trigger.
- Requires a narrative. Blank narratives are rejected.
- Refused when the period is closed, with the message naming the period and who closed it.
- Reversible by a reversing entry. Never editable, never deletable.

* * *

**FR-M09 · Correction and reversal** · P0 · Story M8

No manual entry is ever edited or hard-deleted. Correction creates a reversing entry linked to the original, following the same reversal-not-deletion principle the credit-note path already uses.

*Acceptance criteria*

- The original and the reversal are both visible, linked, in the audit trail.
- Reversal into a closed period is refused.
- A reversed entry is visually marked wherever it appears.

* * *

**FR-M10 · Entry templates** · P2 · Story M10

Save any manual entry as a named template. Fire from a home-screen shortcut with amount and date pre-filled to last used and today.

* * *

**FR-M11 · Receipt capture with confidence-gated review** · P2 · Story M11

Photograph or forward a receipt or bill. Extraction fills supplier, date, total, tax and where possible line items. Fields carry confidence scores.

*Acceptance criteria*

- Fields above the confidence threshold are pre-filled and visually calm; fields below it are flagged and focused for correction.
- Nothing posts without an explicit confirmation.
- The source image is retained and linked to the posted entry for the full retention period.
- Extraction failure degrades to a blank manual form with the image attached, never to an error page.

*Note:* line items are the hardest field for every extraction tool measured — 65 to 97 percent accuracy against 99 percent for totals. Design the review UI assuming line items will need correction.

* * *

**FR-M12 · Conversational entry via the assistant** · P1 · Story M12

Record a manual entry by describing it in natural language to the assistant, through the app or through the MCP server.

*Acceptance criteria*

- The assistant proposes a structured entry and renders it for confirmation. It never posts directly.
- The proposal shows the business unit, amount, category and the resulting effect in plain language: "this will reduce Marina Properties cash by AED 400 and record a repair expense."
- Ambiguity produces a question, not a guess. "Which property?" rather than picking one.
- The confirmation step is a distinct user action, not a default-yes.
- Every proposal and every confirmation is logged with the originating conversation identifier.

* * *

### 7.2 Data migration

**FR-D01 · Import with dry-run diff and sign-off** · P0 · Story F3 · Audit BL-003, PD-02

Importers for opening balances, customers and suppliers, leases and units, outstanding debts, post-dated cheques, stock, and employees with contracts and pay components.

*Acceptance criteria*

- Every import runs in dry-run first and produces a diff: rows to create, rows to update, rows rejected with reasons.
- Nothing commits until an explicit approval action.
- After commit, a reconciliation report compares the imported trial balance to a figure the accountant supplies, line by line.
- The accountant records a sign-off against the reconciliation. Go-live is blocked until it exists.
- An import is reversible as a batch for 72 hours after commit.

*Rationale:* poor data migration is 38 percent of ERP implementation failures and is the audit's risk R2 at critical severity. The dry-run diff and the sign-off are the mitigation.

* * *

### 7.3 Period close and compliance

**FR-C01 · Month-end close and period lock** · P0 · Story E6 · Audit BL-004, PD-03, RQ-30

*Flow:* reconcile, review, adjust, lock, file, report.

*Acceptance criteria*

- An accountant with the close permission can close a period.
- Any posting into a closed period is refused by the service with a message naming the period and the closer. The `assertPeriodOpen` guard already exists and becomes reachable.
- Reopening requires the owner's permission and is audited.
- A pre-close checklist shows unreconciled cash sessions, unallocated payments, cheques in flight, and inter-business balances that do not net.

* * *

**FR-C02 · VAT201 with apportionment and annual wash-up** · P0 · Story E1, E8 · Audit RQ-25

Extends the existing return with the annual actual-use adjustment.

*Acceptance criteria*

- The quarterly return apportions input VAT between exempt and taxable supplies using the configured method.
- The apportionment method is a tenant setting with two options: the standard output-based method, and a floorspace method for property. The selected method and, where relevant, the FTA approval reference are recorded on the return.
- At tax year end the system computes the actual-use adjustment reconciling provisional apportionment to actual, and produces a posting for it.
- Every box on the return links to the journals underneath it.
- Unit tests cover fully taxable, fully exempt, mixed apportionment, zero-rated export, and the annual wash-up, each against hand-calculated fixtures.

**Open dependency Q-1.** Standalone parking VAT treatment and whether to apply for the floorspace method both require a tax adviser's written opinion before the pilot goes live.

* * *

**FR-C03 · Reverse charge on imported services** · P1 · Story E9

*Acceptance criteria*

- A bill from a non-resident supplier for services with a UAE place of supply self-accounts output VAT and, where recoverable, input VAT.
- Both appear in the correct VAT201 boxes.
- Recovery is denied where the supply supports exempt supplies.

* * *

**FR-C04 · Corporate tax computation** · P1 · Story E11 · Audit RQ-28

*Acceptance criteria*

- Small Business Relief eligibility is evaluated per entity against revenue in the current and all prior periods, and against the relief's expiry for periods ending on or after 31 December 2026.
- Where relief is unavailable, a full computation runs against the nil band to AED 375,000 and 9 percent above.
- The nine-month filing deadline per entity appears in the compliance watchlist.
- Related-party transactions, which the inter-business transfer path generates by construction, are listed separately for transfer-pricing documentation.
- Unit tests cover below threshold, relief applied, relief expired, and above the nil band, against hand-calculated fixtures.

* * *

**FR-C05 · Gratuity with payout** · P0 · Story E2, E5 · Audit RQ-26

*Acceptance criteria*

- Liability accrues daily on basic salary only.
- A payout workflow settles the accrued liability on termination and posts the journal.
- Rehire after a gratuity payout restarts the service clock and does not double-count. This is edge case EC-05, currently unhandled.
- The alternative savings scheme is supported as a switchable per-employee calculation basis, contributing a percentage of monthly basic salary instead of accruing a lump sum.
- Unit tests cover under one year, one to five years, over five years, the two-year cap, and rehire, against hand-calculated fixtures.

**Open dependency Q-2.** Whether resignation still reduces entitlement under the 2022 labour law must be confirmed before fixtures are written. Writing a test against a stale rule enshrines the error permanently, which is precisely the failure mode the audit warns about.

* * *

**FR-C06 · Payroll run and WPS** · P1 · Story E3 · Audit BL-018

Promoted from the audit's P1 backlog because the rules changed. Since 1 June 2026 the fifteen-day grace period is gone, wages are due on the first day of the following month with no weekend allowance, and the on-time compliance threshold rose to 85 percent.

*Acceptance criteria*

- A payroll run computes gross, deductions and net per employee and posts the journal.
- SIF generation follows the format required by the group's own WPS agent.
- The deadline appears in the compliance watchlist with escalating urgency, and fires an alert before the first of the month.

* * *

**FR-C07 · E-invoicing, PINT AE** · P1 · Story E10 · Statutory

*Architectural placeholder required in Phase 1. Full implementation in Phase 2.*

*Acceptance criteria for the placeholder*

- Each legal entity carries a Tax Identification Number field and an entity-to-business-unit mapping.
- Documents pass through a serialiser boundary rather than rendering directly.
- An `EInvoiceProvider` interface exists with a no-op default, mirroring the existing `DeliveryProvider` pattern.

*Acceptance criteria for the full implementation*

- Standard tax invoices and credit notes serialise to PINT AE XML with correct entity TIN, line-level VAT treatment, and required fields.
- Transmission goes through an accredited service provider adapter. Nexus does not connect to the Peppol network directly.
- Message Level Status responses are recorded per document, and rejected documents appear in an exception queue with the rejection reason.
- Business-to-consumer documents continue to produce a compliant local tax invoice and are not transmitted.
- Retry is bounded, logged and idempotent.

**Open dependencies Q-3, Q-4, Q-6.** Penalty schedule, final field list, and which entities hold which licences.

* * *

### 7.4 Rentals — the pilot business

**FR-R01 · Lease lifecycle** · P0 · Story D6 · Audit BL-012

Create, renew, terminate, with a schedule of instalments and the cheques that settle them.

*Acceptance criteria*

- Creating a lease generates the instalment schedule and, where provided, links the post-dated cheques.
- Renewal preserves history and does not orphan the previous term.
- A renewal mid-VAT-period apportions correctly. This is edge case EC-04, currently unmodelled.
- Termination handles the deposit, the final settlement and any refund.
- Residential and parking leases share the model but carry distinct VAT treatment, enforced by a regression test.

* * *

**FR-R02 · Rent run** · P0 · Story B5 · Audit BL-011, RQ-11

Generate a month of rent invoices in one action.

*Acceptance criteria*

- Preview lists every invoice to be created with the lease it derives from and the VAT treatment applied.
- Nothing posts until the preview is approved.
- Re-running the same month is idempotent and creates nothing.
- The generated total reconciles to the lease schedule.
- A lease starting or ending mid-month is apportioned.

* * *

**FR-R03 · Cheque lifecycle, extended** · P0 · Stories B6, B7, B8

*Acceptance criteria*

- Existing transitions are preserved: cleared only from held or deposited, bounced only from held or deposited, replaced only from bounced. The guard is correct and prevents the double-count.
- **New:** partial payment is representable, because UAE banks are now required to pay partially where partial funds exist. It posts the received portion and leaves the balance outstanding.
- **New:** a post-clearing return is representable, posting a reversing journal and moving the cheque to a returned state, subject to Q-5.
- Bouncing posts the bank charge.

* * *

**FR-R04 · Unit and occupancy board** · P0 · Story D5

Read exists. Add: vacancy forecast from lease end dates, and occupancy trend over time once snapshots exist.

* * *

### 7.5 Dashboard and explanation

**FR-V01 · Exception-first dashboard** · P0 · Story A4

The organising principle changes. Exceptions above the fold; metrics below.

*Acceptance criteria*

- The first screen region is a ranked list of things off-target or off-trend, with the reason and a direct action link on each.
- An empty exception list renders as a positive state, not a blank region.
- Each exception is dismissable with a reason, and dismissals are audited.
- The list is role-filtered. A barber sees no financial exceptions.

*Rationale:* management by exception is the consistent recommendation across the dashboard literature. A dashboard requiring a scan of twenty tiles to find the one problem has already failed the glanceability test.

* * *

**FR-V02 · Explanatory visualisation system** · P1 · Stories A8, A9 · New

Every headline number that can move gets a form that explains the movement. Full specification in PDD-04; the requirement here is the contract.

*Acceptance criteria*

- Profit change between two periods renders as a waterfall from opening to closing with named drivers.
- Target attainment renders as a bullet graph. No gauges, no donut rings, no speedometers anywhere in the product.
- Part-to-whole across business units renders as a bar or stacked bar. No pie charts.
- Comparison across the six business units uses small multiples with a shared scale, not six overlapping series.
- Daily cash movement and booking density render as calendar heatmaps.
- Inter-business money flow renders as a Sankey, monthly, capped at a curated node set.
- Every chart carries a plain-language conclusion line, generated from the data, not a title. "Salon profit is up 8 percent this month, mainly from repeat bookings" rather than "Profit by month."
- No chart conveys meaning through colour alone. Sign is always carried redundantly by a symbol or a label.
- Chart elements meet WCAG 2.2 non-text contrast of 3:1, and chart text meets 4.5:1, in both light and dark themes.

* * *

**FR-V03 · Historical snapshots and trend** · P1 · Story A7 · Audit BL-014, TD-20, DB-3

The `kpi_snapshots` table is written by the seed and read by nothing. Populate it nightly for all metrics and read dashboards from it with a live fallback.

*Acceptance criteria*

- A scheduled job writes a snapshot per metric per business unit per day.
- Every KPI tile shows a trend against the equivalent prior period.
- Backfill from journal history is possible for the migrated period.

* * *

### 7.6 Platform

**FR-P01 · User management** · P0 · Story F6 · Audit BL-041, PD-17, S-9

Invite, assign role and scope, change role, deactivate.

*Acceptance criteria*

- Deactivating a user invalidates every session they hold, immediately.
- Deactivation is reversible; the user record and their audit history are never deleted.
- Role changes take effect on the next request, not the next login.
- Every action is audited with actor and reason.

* * *

**FR-P02 · Scheduler** · P0 · Audit BL-010, TD-15

Automation runner, notification outbox, daily briefing, and KPI snapshots run on a schedule with a visible run log. Three built subsystems currently do nothing in production because no scheduler exists.

* * *

**FR-P03 · One delivery channel** · P1 · Story F4, A5, E5 · Audit BL-015

WhatsApp Business or a UAE SMS provider. The existing `DeliveryProvider` interface gets one real implementation.

*Acceptance criteria*

- Existing caps, dedupe keys, approval gates and dry-run default are honoured. A runaway automation messaging customers is risk R9 and the controls are already built.
- A kill switch stops all outbound delivery immediately.
- Delivery failures are visible, not silent.

* * *

**FR-P04 · Error and loading states** · P0 · Audit BL-007, TD-03

*Acceptance criteria*

- Every route has an error boundary with a retry affordance.
- Every route has a loading state using the skeleton components that already exist and are currently unused.
- A single failing metric degrades one section to an unavailable state; it does not break the page.

* * *

**FR-P05 · Observability** · P0 · Audit BL-008, TD-07, TD-19

*Acceptance criteria*

- A production 500 alerts a human within five minutes.
- A `/health` endpoint exists and a smoke test runs after every deploy.
- The security event stream, which currently emits to stdout with no collector, reaches a sink.
- Web vitals and page timings are collected.

* * *

**FR-P06 · AI assistant** · P1 · Story A6 · Funded

The assistant does three things and no more.

1. Answer questions by calling the existing typed metrics, with an evidence link on every figure.
2. Propose a manual entry from a natural-language description, for human confirmation. Per FR-M12.
3. Explain a chart or a movement in plain language.

*Acceptance criteria*

- No SQL generation, ever. NG7.
- Permissions are enforced inside the metric layer, so the assistant cannot surface payroll to a receptionist. This already holds.
- Every numeric claim carries a link to its rows. A claim without evidence is not rendered.
- No write posts without explicit confirmation. NG14.
- When the assistant cannot answer from the metric layer, it says so rather than approximating.
- Conversations are retained and auditable.

* * *

**FR-P07 · MCP server** · P1 · Story F7

Full specification in MCP-06. The requirement here: the same three capabilities as FR-P06, exposed to Claude on the owner's phone and desktop, under the same permission model and the same confirmation rule.

* * *

**FR-P08 · Feedback affordance** · P2 · Story F8 · Audit PD-14

A way to flag a wrong number from the screen showing it, capturing the metric, the filters, the user and the time. The highest-signal bug class in an ERP currently has no reporting path.

* * *

**FR-P09 · Pagination** · P1 · Audit BL-013, TD-05

Cursor pagination on every list. The receivables page currently ships 284 KB of HTML at seed volume.

* * *

**FR-P10 · Global search** · P1 · Audit BL-020, PD-11

Across parties and documents. At 447 parties and 4,151 documents navigation is already strained.

* * *

**FR-P11 · Navigation restructure** · P0 · Audit BL-021, PD-12

Compliance screens — VAT201, profit and loss, gratuity — get top-level entries. Cheques move from under rentals to a finance grouping. A settings home exists. The accountant's primary screens are currently the hardest to reach in a product that requires her to file returns.

* * *

**FR-P12 · Confirmation on financial writes** · P1 · Audit BL-033, PD-13

A credit note currently posts on a single click against real books.

* * *

## 8. Prioritisation

### Must have — the MVP fails without these

| Requirement | Status |
| --- | --- |
| Consolidated dashboard, ledger, tenant isolation, invoicing, bills, payments, audit trail, authentication and RBAC | Built |
| FR-D01 data import with sign-off | Missing |
| FR-M01 to FR-M06, FR-M08, FR-M09 manual and cash entry | Missing |
| FR-C01 month-end close and period lock | Missing |
| FR-C02 VAT201 with wash-up | Partial |
| FR-C05 gratuity with payout and tests | Partial |
| FR-R01, FR-R02 lease lifecycle and rent run | Missing |
| FR-P01 user management with session revocation | Missing |
| FR-P02 scheduler | Missing |
| FR-P04 error and loading states | Missing |
| FR-P05 observability | Missing |
| FR-P11 navigation restructure | Missing |
| FR-V01 exception-first dashboard | Partial |
| Decimal money arithmetic, versioned migrations, unit tests on tax engines | Missing — see TRD-03 |

### Should have

FR-M07 cash float and day close · FR-R03 extended cheque lifecycle · FR-V02 visualisation system · FR-V03 snapshots and trend · FR-P03 delivery channel · FR-P06 AI assistant · FR-P07 MCP server · FR-P09 pagination · FR-P10 global search · FR-P12 confirmations · FR-C03 reverse charge · FR-C04 corporate tax · FR-C06 payroll run · FR-C07 e-invoicing placeholder

### Could have

FR-M10 templates · FR-M11 receipt capture · FR-M12 conversational entry · FR-P08 feedback · FR-C07 full e-invoicing · commission statements · dispatch board · automation management UI · stock transfer · purchase order approval

### Will not have in this cycle

Technician mobile app (Phase 3) · Arabic and RTL (Phase 4) · accessibility remediation beyond keyboard operability (Phase 4) · e-commerce channel sync · construction module · SSO · white-label · advanced business intelligence · FTA e-filing for VAT and corporate tax

* * *

## 9. Acceptance criteria — representative end-to-end

**AC-1 · Record a customer payment**
Given an invoice with AED 5,000 outstanding, and I hold `payment:create`, when I record AED 3,000 allocated to it, then a balanced journal posts debiting cash and crediting receivables, the invoice shows AED 2,000 due with status partial, an audit entry records actor and before-and-after, and replaying the idempotency key does not double-post.

**AC-2 · Over-allocation refused**
Given an invoice with AED 1,000 outstanding, when I allocate AED 1,500, then the write is rejected with a clear message, no journal posts, and the transaction rolls back in full.

**AC-3 · Exempt-supply input VAT not recovered**
Given the properties business makes exempt residential-rent supplies, when it receives a bill carrying 5 percent input VAT, then that VAT is expensed rather than posted to recoverable input VAT, and the VAT201 excludes it from recoverable input tax.

**AC-4 · Cross-tenant access impossible**
Given I am authenticated in tenant A, when a query or write targets tenant B, then the read returns zero rows and the write is rejected by the database, not by application code.

**AC-5 · Scoped user sees only their scope**
Given I am a barber scoped to the salon, when I open the dashboard, then I see only salon data and revenue metrics are absent, not empty.

**AC-6 · Cash payment on an exempt property** [NEW]
Given I am at a property and pay AED 400 cash for a repair, when I record a cash payment against the properties business unit, then a balanced journal posts debiting repairs expense AED 400 and crediting cash-in-hand AED 400, the input VAT is expensed not recovered, the cash point balance reduces by 400, and the whole entry took four fields.

**AC-7 · Inter-business transfer nets to zero at group level** [NEW]
Given the AC business services a flat owned by the properties business, when I record an inter-business transfer of AED 1,200 for the job, then the AC business shows AED 1,200 revenue and a due-from balance, the properties business shows AED 1,200 maintenance cost and a due-to balance, the two balances are equal and opposite, and group consolidated profit is unchanged.

**AC-8 · Day close with variance** [NEW]
Given a cash point opened with a float of AED 500 and AED 1,340 of cash receipts recorded, when the counter submits a blind count of AED 1,835, then the expected figure of AED 1,840 is revealed after submission, a variance of AED 5 short posts to cash over and short for that cash point, and because AED 5 is below the threshold no manager acknowledgement is required.

**AC-9 · Posting into a closed period is refused** [NEW]
Given the accountant closed July, when any user attempts to post a document, payment or manual entry dated in July, then the write is refused with a message naming the period and the closer, and no journal posts.

**AC-10 · Assistant proposes but does not post** [NEW]
Given I tell the assistant "paid the plumber 350 cash for the Marina flat," when it produces a proposal, then it renders the business unit, amount, category and plain-language effect, it asks which property if more than one matches, nothing posts until I confirm explicitly, and the proposal and confirmation are both logged.

* * *

## 10. Edge cases

The audit identified twelve. Their status and the new ones:

| # | Edge case | Requirement |
| --- | --- | --- |
| EC-01 | Two users edit the same invoice | Optimistic locking. TRD-03 |
| EC-02 | Payment in a non-base currency | Deferred. `fx_rate` exists, no feed, no UI |
| EC-03 | Cheque returned after clearing | FR-R03, gated on Q-5 |
| EC-04 | Lease renewal mid-VAT-period | FR-R01 |
| EC-05 | Employee rehired after gratuity paid | FR-C05 |
| EC-06 | Stock count for a null variant | Handled; the null-unique-index trap remains elsewhere |
| EC-07 | Credit note exceeding the invoice | Handled |
| EC-08 | Partial refund to a different method | Deferred |
| EC-09 | Timezone boundary at 00:30 Gulf time | Test required. TRD-03 |
| EC-10 | Removing a user's access | FR-P01 |
| EC-11 | Posting into a closed period | FR-C01 |
| EC-12 | Very large lists | FR-P09 |
| **EC-13** | **Cash point goes negative** | **FR-M02. Blocked without an explicit reasoned override** |
| **EC-14** | **Cheque partially paid by the bank** | **FR-R03** |
| **EC-15** | **Owner drawing exceeds available cash** | **Permitted, flagged in the owner ledger. It is a real event** |
| **EC-16** | **Inter-business balances do not net** | **FR-M06 reconciliation check, CI-gated, surfaced in the pre-close checklist** |
| **EC-17** | **Import re-run after partial commit** | **FR-D01 batch reversibility** |
| **EC-18** | **E-invoice rejected by the ASP** | **FR-C07 exception queue** |
| **EC-19** | **Manual entry proposed by the assistant against a closed period** | **Refused at the service layer before the proposal renders** |

* * *

## 11. Non-functional requirements

| Category | Requirement | Current | Verdict |
| --- | --- | --- | --- |
| Performance | Dashboard under 500 ms | \~150 ms metric sweep | Met |
| Performance | List pages bounded | No pagination; 284 KB receivables | Not met — FR-P09 |
| Reliability | No lost writes | One transaction per action, database-enforced invariants | Strong |
| Reliability | A failing metric degrades one section | Breaks the page | Not met — FR-P04 |
| Correctness | Money arithmetic exact end to end | Correct in the database, IEEE-754 doubles in the application | **Not met — critical** |
| Correctness | Legally consequential functions unit-tested against hand-calculated fixtures | No unit-test framework exists | **Not met — critical** |
| Availability | 99.5 percent | No SLO, no monitoring | Unmeasured — FR-P05 |
| Security | See audit section 18 | argon2id, MFA, RLS, PII encryption, 68 checks | Strong |
| Security | Offboarding revokes access immediately | Database edit; sessions survive | Not met — FR-P01 |
| Privacy | PDPL-shaped erasure | Pseudonymisation retaining tax invoices | Met technically; procedural gaps |
| Retention | **Real estate records retained 15 years, in the UAE unless permitted otherwise** | **Encrypted backup, local disk only, no offsite** | **Not met — blocks the pilot** |
| Accessibility | WCAG 2.2 AA | 23 aria attributes, 5 labels, never audited | Not met — Phase 4 |
| Maintainability | Domain core imports no React or Next | Genuinely clean | Strong. Do not disturb |
| Observability | Errors and traces | None | Not met — FR-P05 |
| Localisation | Arabic and RTL | English hardcoded | Not met — Phase 4 |
| Scalability | Understood behaviour to 10× current volume | Never load-tested; every page force-dynamic | Unknown — Phase 4 |

The retention row is new and it blocks the pilot. Fifteen-year retention for real estate records, held in the UAE unless the FTA permits otherwise, is incompatible with encrypted backups on a local disk. This is a Phase 0 addition.

* * *

## 12. Success metrics

The product is almost entirely uninstrumented. `kpi_snapshots` is populated once by the seed and read by no code path, so there is no live time series and no way to answer whether anything is improving.

### 12.1 The gate metrics

Three numbers decide whether the MVP succeeded. Nothing else substitutes.

| Metric | Target | How measured |
| --- | --- | --- |
| Money movements touching the property portfolio that exist outside Nexus | Zero for one calendar month | Weekly reconciliation against the owner's own record, by hand, during the pilot |
| Migrated trial balance versus the accountant's figure | Ties to the fils | Signed reconciliation, FR-D01 |
| Period closed inside the system and filed from it | One month | Binary |

### 12.2 Leading indicators

| Metric | Instrumented |
| --- | --- |
| Manual entries per week, by type and by user | No — required |
| Median seconds from opening the app to a posted cash entry | No — required |
| Cash sessions closed with a blind count, as a share of sessions opened | No — required |
| Dashboard opens per day, and drill-down rate | No — required |
| Exceptions actioned versus dismissed | No — required |
| Assistant queries answered without a human | No — required |
| Write failures by action and error code | No — required |
| Permission denials by permission and route | No — required |

### 12.3 Lagging indicators

| Metric | Target |
| --- | --- |
| Days with no parallel paper record | Rising, then stable |
| Unbalanced journals | Zero, permanently. Already asserted by tests |
| Inter-business balances that do not net at close | Zero |
| Cash variance as a share of cash handled, by cash point | Trending toward zero; clustering investigated |
| Compliance deadlines met on time | 100 percent |
| Production 5xx per 1,000 requests | Below 1 |
| p95 dashboard load | Under 800 ms |

### 12.4 The events to instrument

Every event carries user, tenant, role, business unit and timestamp.

`session_started` · `dashboard_viewed` with load milliseconds and metric count · `exception_shown`, `exception_actioned`, `exception_dismissed` with reason · `metric_drilled` · `manual_entry_recorded` with type, amount band and seconds to complete · `cash_session_opened`, `cash_session_closed` with variance band · `owner_ledger_flagged` · `interbusiness_transfer_recorded` · `payment_recorded` · `bill_received` · `invoice_created` · `rent_run_executed` with invoice count · `cheque_transitioned` with from and to states · `period_closed` · `import_dry_run`, `import_committed` · `assistant_query`, `assistant_proposal`, `assistant_confirmed`, `assistant_rejected` · `notification_read` with time to read · `write_failed` · `permission_denied` · `feedback_submitted`

* * *

## 13. Release plan

Phase 0 is unchanged from the audit and is correct. Phases 1 onward are reordered around the MVP, the manual-entry gate, and the e-invoicing deadline.

### Phase 0 — Stabilisation · 3 to 4 weeks · no new features

Make the system safe to put real money into.

Decimal money arithmetic. Unit tests on the tax and gratuity engines. Error and loading states on every route. Observability with a five-minute alert path. Versioned migrations replacing schema push. Scheduler for automation, outbox, briefing and snapshots. User deactivation with session revocation. Rate limit on the unprotected `/me` endpoint. **Added:** offsite encrypted backup replication, to meet the fifteen-year property retention obligation.

**Done when** there is zero float arithmetic on money and a lint rule enforces it; the tax engines have unit tests with hand-calculated fixtures; every route has an error boundary and a loading state; a production 500 alerts a human within five minutes; every schema change is a reviewable committed migration; scheduled jobs run with a visible log; and all 227-plus checks are green.

### Phase 1 — The MVP · 6 to 8 weeks

The property portfolio runs on Nexus, including cash.

Data import with dry-run diff and accountant sign-off. The manual-entry module, FR-M01 to FR-M06 plus FR-M08 and FR-M09. Lease lifecycle and rent run. Month-end close and period lock. Exception-first dashboard. Navigation restructure. Pagination. One delivery channel. E-invoicing architectural placeholder.

**Done when** the migrated trial balance ties to the fils against the accountant's figure; the property portfolio completes one calendar month with every money movement inside the system and nothing outside it; the accountant closes that month inside the system and files from it; and the rent run generates a full month reconciling to the lease schedule.

### Phase 2 — Compliance envelope and the second business · 6 to 8 weeks

VAT annual wash-up. Reverse charge. Corporate tax computation without relief. Payroll run and WPS under the new deadline. E-invoicing full implementation with an appointed ASP. The salon as pilot two under the fourteen-day duration test, with cash float and day close. Cash over and short reporting. The AI assistant and the MCP server. The visualisation system. Historical snapshots and trend.

**Done when** an e-invoice transmits and is accepted end to end; a corporate tax computation runs for each entity without relying on Small Business Relief; the salon runs fourteen consecutive days with no parallel paper; and the owner can answer "why did profit move" from a chart without asking anyone.

### Phase 3 — Field and mobile · 6 weeks

Public write endpoints. Technician app with offline job completion, photo capture, lock-on-claim. Owner briefing and approvals on mobile.

**Done when** a full day of jobs completes offline and syncs without duplication; cold start to job list is under 3 seconds on a mid-range Android; and a job completed on a property automatically raises the inter-business transfer.

### Phase 4 — Scale and reach · 8 weeks

Snapshot-backed dashboards and caching. Load test and partitioning plan. Arabic and right-to-left. WCAG 2.2 AA remediation with automated checks in CI. Browser end-to-end tests. Penetration test. Security log collector. Remaining businesses.

### Phase 5 — Commercial · gated

Not started. The decision is to build internally first and retain the multi-tenant foundation. The foundation is already paid for; that does not make the commercial work free.

* * *

## 14. Open questions

| # | Question | Owner | Blocks |
| --- | --- | --- | --- |
| Q-1 | Standalone parking VAT treatment; whether to apply for the floorspace apportionment method | Tax adviser | Pilot go-live, FR-C02 |
| Q-2 | Current resignation versus termination gratuity position | MOHRE or employment lawyer | FR-C05 fixtures |
| Q-3 | Exact e-invoicing penalty schedule | Primary source | FR-C07 scoping |
| Q-4 | Final PINT AE mandatory field list | MOF data dictionary | FR-C07 serialiser |
| Q-5 | Whether a cleared UAE cheque can be returned | The group's bank | FR-R03 |
| Q-6 | Which entities hold which licences, and their revenue against the AED 50m and AED 3m thresholds | Owner and accountant | FR-C07, FR-C04 |
| Q-7 | Exact WPS SIF layout for the group's agent | WPS agent | FR-C06 |
| Q-8 | Whether the current hosting position satisfies PDPL cross-border transfer | Data protection adviser | Real data entering the system |
| Q-9 | Willingness to pay, if Nexus is ever offered beyond this group | Owner, deferred | Phase 5 only. Answered for now by decision D1 |
| Q-10 | Materiality and staleness thresholds for the owner ledger | Owner and accountant | FR-M05 defaults |
| Q-11 | Cash variance threshold requiring manager acknowledgement | Owner | FR-M07 default |
| Q-12 | Whether inter-business services bill at cost or at an arm's-length market rate | Owner and tax adviser | FR-M06, transfer pricing |

Q-12 is the one worth deciding early. It determines whether the inter-company flow is a cost allocation or a revenue transaction, which changes the profit-and-loss shape of every business unit and creates a transfer-pricing position.

* * *

## 15. Traceability

| PRD requirement | Audit identifier | Research finding |
| --- | --- | --- |
| FR-M01 to FR-M12 | None — new module | F-03, F-04, F-07 |
| FR-D01 | BL-003, PD-02, RQ-34 | F-07 |
| FR-C01 | BL-004, PD-03, RQ-30 | — |
| FR-C02 | RQ-25, TDD-4 | F-08 |
| FR-C03 | F-03 gap in the audit | F-08 |
| FR-C04 | RQ-28 | F-09 |
| FR-C05 | RQ-26, EC-05 | F-10 |
| FR-C06 | BL-018, RQ-27 | F-10 |
| FR-C07 | None — new | F-01 |
| FR-R01 | BL-012, RQ-24, EC-04 | — |
| FR-R02 | BL-011, RQ-11 | — |
| FR-R03 | RQ-12, RQ-13, EC-03 | F-13 |
| FR-V01 | Partial in A4 | F-06 |
| FR-V02 | None — new | F-06 |
| FR-V03 | BL-014, TD-20, DB-3, PD-07 | F-06 |
| FR-P01 | BL-041, PD-17, S-9, R7 | F-07 |
| FR-P02 | BL-010, TD-15 | — |
| FR-P03 | BL-015, PD-06 | — |
| FR-P04 | BL-007, TD-03 | — |
| FR-P05 | BL-008, TD-07, TD-19, R8 | — |
| FR-P06 | BL-023, PD-08, RQ-06 | F-14 |
| FR-P07 | None — new | F-04, F-14 |
| FR-P08 | PD-14 | F-07 |
| FR-P09 | BL-013, TD-05 | — |
| FR-P10 | BL-020, PD-11 | — |
| FR-P11 | BL-021, PD-12 | F-06 |
| FR-P12 | BL-033, PD-13, S-12 | — |

**Audit items now closed as decisions rather than open questions**

- D1, internal tool or product to sell: internal first, SaaS-ready foundation retained. Phase 5 gated.
- D2, AI assistant fund or delete: funded, scoped to three capabilities.
- D3, which business pilots first: the property portfolio, with a completeness gate rather than a duration gate.
- D4, is Arabic required: deferred to Phase 4, treated as market credibility rather than confirmed statute.
- D5, who owns the books during migration: the accountant, whose signed reconciliation is a go-live gate.
- D6, keep construction and e-commerce tables: construction dropped, NG11. E-commerce retained as schema, no surface until Phase 4.

* * *

## 16. What changed from the audit, and why

| Change | Reason |
| --- | --- |
| An MVP exists | The audit's own root-cause finding. Without one sentence defining done, breadth wins |
| Manual and cash entry is a P0 module, not a gap | The owner raised it; ERP adoption research says it is the mechanism by which the whole project fails |
| Pilot changed from salon to property, with a different gate shape | Owner decision. The gate changed because a fourteen-day duration test produces no signal in a low-frequency business |
| E-invoicing added with a statutory deadline | Regulatory research. Absent from the audit entirely |
| VAT scope widened to the annual wash-up and reverse charge | Regulatory research. The engine is incomplete for a mixed-supply business |
| Corporate tax reframed around relief expiry | Small Business Relief ends for periods ending on or after 31 December 2026 |
| Payroll run promoted from P1 to a Phase 2 must | WPS grace period removed on 1 June 2026 |
| Dashboard reorganised around exceptions | Converged recommendation across the dashboard literature |
| Visualisation system added as a requirement | The owner asked for explanation over display; the evidence says which forms work |
| AI assistant funded and scoped to three capabilities | Owner decision, plus a framing that makes it defensible |
| MCP server added | Owner decision. Marginal cost is low because the semantic layer already exists |
| Fifteen-year retention added as a blocking NFR | Property record retention obligation, incompatible with local-disk-only backup |
| Persona P8, the cash handler, added | Research. It is the persona that determines adoption |
| Non-goals expanded from 8 to 14 | The absence of non-goals is why scope wandered |
