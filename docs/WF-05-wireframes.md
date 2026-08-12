# Nexus — Wireframe Specification

**Document** WF-05 · **Version** 1.0 · **Date** 12 August 2026
**Status** For build
**Implements** PRD-02 v2.0 and PDD-04 v2.0

* * *

## 0. How to read these

Low fidelity, deliberately. The audit's section 30 lists "wireframes, low-fidelity, all states" as step nine of the process that was skipped, with the cost recorded as "loading and error states missing everywhere." These wireframes therefore specify every state, not the happy path, because the happy path is the one thing the product already has.

**Conventions**

```
┌─┐  container          [Button]      primary action
├─┤  section divider    [ Button ]    secondary action
▾    select             ▲ ▼           delta direction
!    exception marker   ●             business-unit colour dot
▒▒▒  skeleton           ┄┄┄           empty state
◇    chart region       →             navigates
ok   passes             no            fails
[x]  checked            [ ]           unchecked
*    the assistant      X             dismiss
find alerts photo mic   affordance labels, not icons
```

Mobile frames are 375 px wide. Desktop frames assume a 1280 px viewport with a 240 px sidebar. Every screen is specified mobile-first; the desktop note states only what differs.

**The five states.** Every screen below carries a state table. A screen ships when all five are built: default, loading, empty, error, and permission-denied. This rule is the whole reason this document exists.

Table of Contents

* * *

## 1. Global shell

### 1.1 Mobile

```
┌──────────────────────────────────┐
│ ≡  Nexus            find  alerts 3     │  56px, sticky
├──────────────────────────────────┤
│                                  │
│           page content           │
│                                  │
│                                  │
├──────────────────────────────────┤
│  ◱      ▣      ◧    ⊕    ⋯      │  64px + safe-area-inset-bottom
│ Today  Money  Biz   +   More     │
└──────────────────────────────────┘
```

The `⊕` is the cash-entry action, not a navigation destination. It opens a sheet. It sits in the centre position because it is the second most important control in the product after the exception list, and because a thumb reaches the centre-bottom most easily.

Bottom navigation is permission-filtered. A barber sees `Today · Schedule · ⊕ · More` where `⊕` opens the tip-entry sheet rather than the full cash sheet.

### 1.2 Desktop

```
┌──────────┬───────────────────────────────────────────────┐
│ Nexus    │  Today                          find  alerts 3      │
│          ├───────────────────────────────────────────────┤
│ ◱ Today  │                                               │
│          │                                               │
│ MONEY    │            page content, max 1120px           │
│  Money in│                                               │
│  Money out                                               │
│  Cheques │                                               │
│  Cash    │                                               │
│  Owner   │                                               │
│          │                                               │
│ BUSINESS │                                               │
│  Compare │                                               │
│  Between │                                               │
│  Rentals │                                               │
│  Services│                                               │
│  Salon   │                                               │
│  Inventory                                               │
│  Customers                                               │
│          │                                               │
│ COMPLIANCE                                               │
│  Watchlist                                               │
│  VAT     │                                               │
│  Corp tax│                                               │
│  Payroll │                                               │
│  E-invoicing                                             │
│  Close   │                                               │
│          │                                               │
│ REPORTS  │                                               │
│  P&L     │                                               │
│  Group   │                                               │
│          │                                               │
│ * Ask    │                                               │
│          │                                               │
├──────────┤                                               │
│ ◍ Sumon  │                                               │
│   Owner ▾│                                               │
└──────────┴───────────────────────────────────────────────┘
```

Groups are labelled. This is the fix for the audit's finding that "grouping is implicit — the nav is flat, the conceptual grouping exists only in this document."

* * *

## 2. Today

The screen that changes what the product is for.

### 2.1 Default, mobile

```
┌──────────────────────────────────┐
│ ≡  Nexus            find  alerts 3     │
├──────────────────────────────────┤
│                                  │
│  NEEDS YOU                    4  │
│                                  │
│  ┌────────────────────────────┐  │
│  │ ! Cheques due tomorrow     │  │
│  │   2 · AED 84,000 · Marina  │  │
│  │                    [View →]│  │
│  ├────────────────────────────┤  │
│  │ ! Trade licence expiring   │  │
│  │   42 days · SEMUL MIAH     │  │
│  │                    [View →]│  │
│  ├────────────────────────────┤  │
│  │ ! AC owes Properties       │  │
│  │   AED 12,400 · 94 days old │  │
│  │                  [Settle →]│  │
│  ├────────────────────────────┤  │
│  │ ! Salon till short         │  │
│  │   AED 45 · 4 of last 6     │  │
│  │                  [Review →]│  │
│  └────────────────────────────┘  │
│                          2 more ▾│
├──────────────────────────────────┤
│  POSITION            This month ▾│
│                                  │
│  ┌──────────────┐┌─────────────┐ │
│  │ Cash         ││ Net profit  │ │
│  │ AED 412,890  ││ AED 84,120  │ │
│  │ ▲ 3.2%       ││ ▼ 8.1%      │ │
│  │ ╱‾╲╱‾‾╲╱     ││ ‾‾╲╱╲___    │ │
│  └──────────────┘└─────────────┘ │
│  ┌──────────────┐┌─────────────┐ │
│  │ Owed to me   ││ VAT due     │ │
│  │ AED 96,340   ││ AED 18,220  │ │
│  │ ▲ 12.0%      ││ in 19 days  │ │
│  └──────────────┘└─────────────┘ │
├──────────────────────────────────┤
│  WHY PROFIT MOVED                │
│                                  │
│  ◇ waterfall                     │
│    91.5k ▬                       │
│          ▬ +0.4 rent             │
│           ▬ -1.1 salon           │
│            ▬▬▬ -12.4 AC          │
│               ▬▬ +1.9 parking    │
│                 ▬▬ +3.8 other    │
│                    ▬ 84.1k       │
│                                  │
│  Profit fell AED 7,400. Rent was │
│  flat; the AC recharge added AED │
│  12,400 of cost the salon        │
│  absorbed.                       │
│                       [Table ⊞]  │
├──────────────────────────────────┤
│  BY BUSINESS                     │
│                                  │
│  ● Properties  ▬▬▬▬▬▬▬  48,200   │
│  ● Field svc   ▬▬▬▬     22,100   │
│  ● Salon       ▬▬▬      14,900   │
│  ● Parking     ▬▬        9,400   │
│  ● Mobile shop ▬         3,600   │
│  ● E-commerce  ◄▬       -14,080  │
│                                  │
│  E-commerce has lost money for   │
│  three months running.           │
│                     [Compare →]  │
├──────────────────────────────────┤
│  CASH THIS MONTH                 │
│  ◇ calendar heatmap              │
│   M T W T F S S                  │
│   ▪ ▪ ▫ ▪ ▪ ▫ ▫                  │
│   ▪ ▓ ▪ ▪ ▓ ▫ ▫                  │
│   ▓ ▪ ▪ ░ ▪ ▫ ▫   ░ out ▓ in     │
│   ▪ ▪ ▪ ▪ ▓ ▫ ▫                  │
│                                  │
│  Cash goes out on the 3rd and    │
│  the 17th, every month.          │
├──────────────────────────────────┤
│  ◱  ▣  ◧  ⊕  ⋯                   │
└──────────────────────────────────┘
```

### 2.2 Default, desktop

Same content, three-column grid at 1280 px.

```
┌────────────────────────────────────────────────────────────┐
│  Today                                    This month ▾     │
├────────────────────────────────────────────────────────────┤
│  NEEDS YOU  4                                              │
│  ┌──────────────┬──────────────┬──────────────┬──────────┐ │
│  │ ! Cheques    │ ! Licence    │ ! AC owes    │ ! Till   │ │
│  │   due tmrw   │   42 days    │   Properties │   short  │ │
│  │   84,000     │   SEMUL MIAH │   12,400     │   45     │ │
│  │   [View →]   │   [View →]   │   [Settle →] │ [Review] │ │
│  └──────────────┴──────────────┴──────────────┴──────────┘ │
├────────────────────────────────────────────────────────────┤
│  ┌────────┐┌────────┐┌────────┐┌────────┐                  │
│  │Cash    ││Profit  ││Owed    ││VAT     │                  │
│  │412,890 ││ 84,120 ││ 96,340 ││ 18,220 │                  │
│  │▲3.2%   ││▼8.1%   ││▲12.0%  ││19 days │                  │
│  │╱‾╲╱‾╲  ││‾╲╱╲__  ││╱╱‾‾    ││        │                  │
│  └────────┘└────────┘└────────┘└────────┘                  │
├──────────────────────────────┬─────────────────────────────┤
│  WHY PROFIT MOVED            │  BY BUSINESS                │
│  ◇ waterfall                 │  ● Properties ▬▬▬▬▬ 48,200  │
│                              │  ● Field svc  ▬▬▬▬  22,100  │
│  Profit fell AED 7,400...    │  ● Salon      ▬▬▬   14,900  │
│                              │  ...                        │
├──────────────────────────────┼─────────────────────────────┤
│  CASH THIS MONTH             │  BETWEEN BUSINESSES         │
│  ◇ calendar heatmap          │  ◇ sankey, this month       │
└──────────────────────────────┴─────────────────────────────┘
```

### 2.3 States

| State | Treatment |
| --- | --- |
| **Loading** | Exception region shows three skeleton rows. Each KPI tile shows `TileSkeleton`. Charts show a fixed-height skeleton with the title visible. Sections stream independently — the tiles do not wait for the Sankey |
| **Empty exceptions** | `┄┄┄ Nothing needs you. Last checked 4 minutes ago.` A positive state with a subtle check icon, not a blank region |
| **Empty everything** (fresh tenant, pre-import) | Whole page replaced by an import prompt: "No data yet. Import your books to begin." with a link to the import wizard |
| **Section error** | That section only shows `MetricUnavailable`\: "Couldn't load profit. [Retry]" Every other section renders normally. This is the fix for one failing metric breaking the page |
| **Page error** | Route error boundary with the message, a Retry, and a Report link that pre-fills the feedback flag |
| **Permission-denied** | The section is absent, not greyed. A barber's Today has a schedule region and a tips region and nothing else |
| **Stale data** | If the snapshot backing a tile is older than its freshness threshold, a small `as of 06:00` caption appears. Never a silent stale number |

* * *

## 3. Cash entry

The flow that decides adoption. Target: fifteen seconds, one-handed.

### 3.1 Chooser sheet

Opens from `⊕`. Bottom sheet, dismissable by swipe or Escape.

```
┌──────────────────────────────────┐
│              ▬▬                  │  grab handle
│  What happened?              X   │
│                                  │
│  ┌──────────────┐┌─────────────┐ │
│  │      ↓       ││      ↑      │ │
│  │  Received    ││    Paid     │ │
│  │    cash      ││    cash     │ │
│  └──────────────┘└─────────────┘ │
│  ┌──────────────┐┌─────────────┐ │
│  │      ⊕       ││      ⊖      │ │
│  │  Put my      ││  Took my    │ │
│  │  money in    ││  money out  │ │
│  └──────────────┘└─────────────┘ │
│  ┌────────────────────────────┐  │
│  │      ⇄  One business paid  │  │
│  │         for another        │  │
│  └────────────────────────────┘  │
│                                  │
│  QUICK                           │
│  [Marina rent] [Fuel] [Cleaning] │
│                                  │
│  ─────────────────────────────   │
│  [ photo Photograph a receipt ]     │
│  [ * Just tell me what happened ]│
└──────────────────────────────────┘
```

Tiles are 88 px tall, well above the 44 px minimum, because this is used in a hurry.

The last two rows are the alternative entry paths: receipt capture (FR-M11) and conversational entry through the assistant (FR-M12).

### 3.2 Paid cash

```
┌──────────────────────────────────┐
│  ←  Paid cash                X   │
├──────────────────────────────────┤
│                                  │
│           AED 400                │  48px hero, numeric keypad
│        ────────────              │  open on mount
│                                  │
│  From      ● Properties       ▾  │  last used, pre-selected
│  For       Repairs            ▾  │  6 recents, then search
│  When      Today              ▾  │
│  Cash from Marina float       ▾  │  only if >1 cash point
│  Note      (optional)            │
│                                  │
│  ┌────────────────────────────┐  │
│  │  photo  Add photo             │  │
│  └────────────────────────────┘  │
│                                  │
│  ────────────────────────────    │
│  Marina float   2,340 → 1,940    │
│  VAT on this is not recoverable  │
│  (residential property)          │
│                                  │
│  ┌────────────────────────────┐  │
│  │      Record AED 400        │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

The two lines above the button are the design's whole argument. The first shows the effect on something the user understands — the float in their pocket. The second explains a tax rule in one clause, at the moment it applies, rather than in a settings page nobody reads.

### 3.3 Took my money out

```
┌──────────────────────────────────┐
│  ←  Took my money out        X   │
├──────────────────────────────────┤
│           AED 5,000              │
│        ────────────              │
│                                  │
│  From      ● Properties       ▾  │
│  Out of    Emirates NBD ****4471 ▾│
│  When      Today              ▾  │
│  Note      (optional)            │
│                                  │
│  ────────────────────────────    │
│  This is not an expense. It is   │
│  your own money.                 │
│                                  │
│  You have taken AED 47,000 from  │
│  Properties this year and put in │
│  AED 15,000.                     │
│                                  │
│  ┌────────────────────────────┐  │
│  │     Record AED 5,000       │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

"This is not an expense. It is your own money" is the single most important sentence in the manual-entry module. It is the misconception that corrupts small-business books more than any other.

### 3.4 One business paid for another

```
┌──────────────────────────────────┐
│  ←  Between businesses       X   │
├──────────────────────────────────┤
│  Who paid    ● AC Services    ▾  │
│  For whom    ● Properties     ▾  │
│                                  │
│           AED 1,200              │
│        ────────────              │
│                                  │
│  What        Service done     ▾  │
│               (cash advance /    │
│                shared cost /     │
│                service done)     │
│  Job         #4192 AC repair  ▾  │
│  Priced at   Market rate      ▾  │
│  When        Today            ▾  │
│                                  │
│  ┌────────────────────────────┐  │
│  │  ● AC Services             │  │
│  │        ●────────▶          │  │
│  │          1,200             │  │
│  │                 ● Properties│ │
│  │                            │  │
│  │  AC earns 1,200            │  │
│  │  Properties pays 1,200     │  │
│  │  Your group total does not │  │
│  │  change                    │  │
│  └────────────────────────────┘  │
│                                  │
│  ┌────────────────────────────┐  │
│  │       Record               │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

The flow diagram is required, not decorative. It is the only way a non-accountant sees that both sides happened and that group profit did not move.

"Priced at" appears only when the nature is `service done`, and choosing Market rate reveals a rate field. The recorded basis supports the transfer-pricing obligation from connected-person transactions.

### 3.5 Confirmation and undo

```
┌──────────────────────────────────┐
│                                  │
│              ok                   │
│                                  │
│         Recorded                 │
│      AED 400 · Repairs           │
│                                  │
│  Marina float now AED 1,940      │
│                                  │
│  ┌────────────────────────────┐  │
│  │       Record another       │  │
│  └────────────────────────────┘  │
│  [ Undo ]              [ Done ]  │
│                                  │
│  Undo available for 30 seconds   │
└──────────────────────────────────┘
```

Undo creates a reversing entry. It never deletes. Both entries remain visible and linked in the audit trail.

### 3.6 Conversational entry

```
┌──────────────────────────────────┐
│  ←  Tell me what happened    X   │
├──────────────────────────────────┤
│                                  │
│  ┌────────────────────────────┐  │
│  │ paid the plumber 350 cash  │  │
│  │ for the marina flat        │  │
│  └────────────────────────────┘  │
│                          [mic][→] │
├──────────────────────────────────┤
│  I'll record this — check it     │
│  first:                          │
│                                  │
│  ┌────────────────────────────┐  │
│  │ Paid cash                  │  │
│  │ AED 350                    │  │
│  │ ● Properties               │  │
│  │ Plumbing / repairs         │  │
│  │ Today, 12 Aug              │  │
│  │ From Marina float          │  │
│  │                            │  │
│  │ Marina float 1,940 → 1,590 │  │
│  └────────────────────────────┘  │
│                                  │
│  [ Change something ]            │
│  ┌────────────────────────────┐  │
│  │      Yes, record it        │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

Nothing posts on the first turn. Ever. If more than one property matches "marina," the assistant asks which one rather than choosing.

### 3.7 States

| State | Treatment |
| --- | --- |
| Loading | The sheet opens instantly. Business-unit and category lists render from cache; a spinner never blocks the amount field |
| Empty | No cash points configured: "Set up a cash point first" with a link to settings. No business units: cannot occur post-import |
| Error | Inline under the field, never a page. "Marina float would go below zero. [Record anyway with a reason]" |
| Period closed | Blocking, before the form renders: "July is closed. Choose a date in August, or ask Priya to reopen July." |
| Permission-denied | The `⊕` is not rendered for roles without any manual-entry permission |
| Offline | The entry queues locally with a pending badge and posts on reconnect. Web only queues; the field app syncs properly |

* * *

## 4. Cash sessions and day close

### 4.1 Cash register

`/finance/cash`

```
┌──────────────────────────────────┐
│  Cash                        ⊕   │
├──────────────────────────────────┤
│  OPEN NOW                    2   │
│  ┌────────────────────────────┐  │
│  │ ● Salon till               │  │
│  │   Opened 09:00 by Maya     │  │
│  │   Float 500 · 12 entries   │  │
│  │   Expected  ●●●●●          │  │  hidden while open
│  │                    [Close] │  │
│  ├────────────────────────────┤  │
│  │ ● Marina float             │  │
│  │   Opened 08:00 by Sumon    │  │
│  │   Float 2,000 · 4 entries  │  │
│  │                    [Close] │  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  VARIANCE, LAST 30 DAYS          │
│  ◇ dot plot by till              │
│    +20 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄        │
│      0 ─────●──●────●────●──     │
│    -20 ┄┄●┄┄┄┄┄┄●┄┄┄┄┄┄●┄┄      │
│    -60         ●                 │
│        Salon ● Parking ● Marina  │
│                                  │
│  The salon till has been short   │
│  four of the last six closes,    │
│  always on the evening shift.    │
├──────────────────────────────────┤
│  CLOSED SESSIONS                 │
│  11 Aug  Salon    -45  Maya   →  │
│  11 Aug  Parking    0  Rashid →  │
│  10 Aug  Salon    -20  Maya   →  │
│  ...                     [More]  │
└──────────────────────────────────┘
```

The conclusion under the dot plot is the whole reason the chart is a dot plot by till rather than a total. Clustering by person and shift is the signal; a total hides it.

### 4.2 Close — the blind count

```
   step 1                        step 2
┌──────────────────────┐   ┌──────────────────────┐
│  Close Salon till    │   │  Counted   AED 1,835 │
│                      │   │  Expected  AED 1,840 │
│  Opened 09:00        │   │  ──────────────────  │
│  Float      AED 500  │   │  Short     AED 5     │
│  12 entries today    │   │                      │
│                      │   │  Below the AED 20    │
│  Count the cash and  │   │  limit. Recorded as  │
│  enter the total.    │   │  cash short.         │
│                      │   │                      │
│  ┌────────────────┐  │   │  ┌────────────────┐  │
│  │  AED           │  │   │  │  Close till    │  │
│  └────────────────┘  │   │  └────────────────┘  │
│                      │   │                      │
│  [ Submit count ]    │   │                      │
└──────────────────────┘   └──────────────────────┘
```

**Implementation note that is not negotiable.** The expected figure must not be present in any payload sent to the client while the session is open. It is not hidden with CSS. It is not in the DOM. Otherwise the control is theatre.

### 4.3 Variance above threshold

```
┌──────────────────────────────────┐
│  Counted   AED 1,720             │
│  Expected  AED 1,840             │
│  ──────────────────────          │
│  Short     AED 120               │
│                                  │
│  ! Above the AED 20 limit.       │
│    A reason is required.         │
│                                  │
│  What happened?                  │
│  ┌────────────────────────────┐  │
│  │                            │  │
│  └────────────────────────────┘  │
│  [Recount] [Paid out, no receipt]│
│  [Wrong change] [Don't know]     │
│                                  │
│  Rashid will be asked to         │
│  acknowledge this.               │
│                                  │
│  ┌────────────────────────────┐  │
│  │  Close with variance       │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

"Don't know" is a deliberate option. Forcing a false reason produces worse data than an honest blank, and the point of the account is to make the pattern visible, not to extract a confession.

* * *

## 5. Owner ledger

`/finance/owner`

```
┌──────────────────────────────────┐
│  Owner ledger        This year ▾ │
├──────────────────────────────────┤
│  NET POSITION                    │
│  ┌────────────────────────────┐  │
│  │  You have taken out        │  │
│  │       AED 132,000          │  │
│  │  more than you put in      │  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  BY BUSINESS                     │
│  ◇ diverging bars, zero centred  │
│                                  │
│  ● Properties   ◄▬▬▬▬  -47,000 ! │
│  ● Salon        ◄▬▬    -28,000   │
│  ● Mobile shop  ◄▬     -12,000   │
│  ● Parking       ▬     +8,000    │
│  ● E-commerce    ▬▬▬  +34,000    │
│  ● Field svc    ◄▬▬▬  -31,000    │
│                                  │
│  You fund e-commerce from        │
│  property income.                │
├──────────────────────────────────┤
│  ! NEEDS ATTENTION               │
│  ┌────────────────────────────┐  │
│  │ Properties drawings         │  │
│  │ unchanged for 94 days       │  │
│  │ AED 47,000                  │  │
│  │              [Settle] [Note]│  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  MOVEMENTS                       │
│  12 Aug  Out  5,000  Properties → │
│  02 Aug  In  15,000  E-commerce → │
│  28 Jul  Out 12,000  Salon      → │
│                          [More]  │
└──────────────────────────────────┘
```

The conclusion line — "You fund e-commerce from property income" — is the kind of thing a portfolio owner does not know until a chart tells him, and it is exactly the audit's job-to-be-done J2, "know which existing business actually makes money," which the audit marked as only partially served.

* * *

## 6. Between businesses

`/businesses/interco`

```
┌──────────────────────────────────┐
│  Between businesses  This month ▾│
├──────────────────────────────────┤
│  ◇ sankey                        │
│                                  │
│  ● Field svc ▬▬▬▬▬▬▬▬▬╮          │
│                        ├▶ ● Props│
│  ● Salon     ▬▬▬╮      │   18,600│
│                  ╰─────┤          │
│  ● Parking   ▬▬─────────╯         │
│                                  │
│  ● Props     ▬▬▬▬──────▶ ● Salon │
│                            4,200 │
│                                  │
│  Field services did AED 12,400   │
│  of work for Properties this     │
│  month and has not been settled. │
├──────────────────────────────────┤
│  BALANCES                        │
│  ┌────────────────────────────┐  │
│  │ Field svc → Properties      │  │
│  │ AED 12,400 · 94 days     !  │  │
│  │                   [Settle] │  │
│  ├────────────────────────────┤  │
│  │ Salon → Properties          │  │
│  │ AED 6,200 · 12 days         │  │
│  │                   [Settle] │  │
│  ├────────────────────────────┤  │
│  │ Properties → Salon          │  │
│  │ AED 4,200 · 3 days          │  │
│  │                   [Settle] │  │
│  └────────────────────────────┘  │
│                                  │
│  ok All balances reconcile        │
├──────────────────────────────────┤
│  EFFECT ON GROUP PROFIT          │
│  Sum of businesses    AED 91,520 │
│  Less eliminations       -7,400  │
│  ──────────────────────────────  │
│  Group profit         AED 84,120 │
│                                  │
│  These transfers move money      │
│  between your businesses. They   │
│  do not make or lose you money.  │
└──────────────────────────────────┘
```

The elimination is shown, not just its effect. The owner needs to see that the group figure is smaller than the sum of the parts and why, or he will not trust it.

`ok All balances reconcile` turns into a critical exception if any reciprocal pair fails to match. That check is CI-gated per TRD-03 ADR-006 and surfaced here.

* * *

## 7. Money in

`/receivables` — largely built. Changes shown.

```
┌──────────────────────────────────┐
│  Money in                    ⊕   │
│  [All][Overdue 8][Due 7d][Paid]  │
├──────────────────────────────────┤
│  ◇ ageing, stacked horizontal    │
│  Al Fahim  ▓▓▓▓▓▒▒░░  34,000  !  │
│  Khan      ▓▓▓▒▒      27,000  !  │
│  Sharma    ▓▓         11,200     │
│  others    ▓▓▓▓       24,140     │
│            0-30 31-60 61-90 90+  │
│                                  │
│  AED 61,000 of the AED 96,340    │
│  owed is from two tenants, both  │
│  past 90 days.                   │
├──────────────────────────────────┤
│  ▸ Record a payment              │  disclosure, unchanged
├──────────────────────────────────┤
│  INV-1042  Al Fahim              │
│  ● Properties   Due 4 Aug        │
│  AED 12,000            8 days ! →│
│  ────────────────────────────────│
│  INV-1043  Khan Trading          │
│  ● Mobile shop  Due 12 Aug       │
│  AED 4,200             today   → │
│  ...                             │
│  ◄ 1 2 3 ... 12 ►    50 per page │  NEW — pagination
└──────────────────────────────────┘
```

Changes from the current build: the ageing chart replaces a bare list header; pagination exists; the conclusion line names the concentration; every row carries the business-unit colour dot.

* * *

## 8. Cheques

`/finance/cheques` — moved out of rentals.

```
┌──────────────────────────────────┐
│  Cheques                         │
│  [Held 61][Deposited 9][Due 7d 4]│
│  [Bounced 2][Returned 0]         │
├──────────────────────────────────┤
│  ◇ funnel by state               │
│  Held       ▬▬▬▬▬▬▬  61 · 812k   │
│  Deposited  ▬▬▬       9 · 104k   │
│  Cleared    ▬▬▬▬▬    38 · 447k   │
│  Bounced    ▬          2 ·  24k  │
│                                  │
│  AED 84,000 clears tomorrow.     │
├──────────────────────────────────┤
│  CHQ 447811   Emirates NBD       │
│  Al Fahim · Marina 1204          │
│  AED 42,000   Due tomorrow       │
│  ┌──────────┐┌──────────┐        │
│  │ Deposit  ││ Bounced  │        │
│  └──────────┘└──────────┘        │
│  ────────────────────────────────│
│  CHQ 447812   ADCB               │
│  Khan · Marina 0902              │
│  AED 42,000   Due tomorrow       │
│  ...                             │
└──────────────────────────────────┘
```

### 8.1 New transitions

Two states the current machine cannot represent.

```
Partial payment                Post-clearing return
┌────────────────────────┐   ┌────────────────────────┐
│  CHQ 447811            │   │  CHQ 447790            │
│  AED 42,000            │   │  Cleared 4 Aug         │
│                        │   │  AED 18,000            │
│  The bank paid part of │   │                        │
│  this cheque.          │   │  ! The bank returned   │
│                        │   │    this after it       │
│  Paid  AED [ 12,000 ]  │   │    cleared.            │
│  Left  AED   30,000    │   │                        │
│                        │   │  This reverses the     │
│  The AED 30,000 stays  │   │  receipt and puts AED  │
│  owed.                 │   │  18,000 back as owed.  │
│                        │   │                        │
│  [ Record ]            │   │  Reason [           ]  │
└────────────────────────┘   │  [ Record return ]     │
                             └────────────────────────┘
```

The second is gated on open question Q-5, which asks the group's bank whether a cleared UAE cheque can in fact be returned. If the answer is no, this screen is not built. If yes, this is the shape.

* * *

## 9. Rentals

### 9.1 Unit board

```
┌──────────────────────────────────┐
│  Rentals                     ⊕   │
│  [All 41][Let 34][Vacant 7]      │
├──────────────────────────────────┤
│  Occupancy                       │
│  ◇ bullet graph                  │
│  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬│▬▬  83%         │
│                target 90%        │
│                                  │
│  34 of 41 let. Three leases end  │
│  within 60 days.                 │
├──────────────────────────────────┤
│  ENDING SOON                  3  │
│  Marina 1204 · 22 days   [Renew] │
│  Marina 0902 · 41 days   [Renew] │
│  Bay P-14   · 58 days    [Renew] │
├──────────────────────────────────┤
│  ┌──────────────────────────────┐│
│  │ ▸ Rent run — August          ││
│  └──────────────────────────────┘│
├──────────────────────────────────┤
│  APARTMENTS                      │
│  1204  Al Fahim   12,000/mo   →  │
│  1205  vacant     ┄┄┄      [Let] │
│  ...                             │
│  PARKING                         │
│  P-14  Khan        1,200/mo   →  │
│  ...                             │
└──────────────────────────────────┘
```

### 9.2 Rent run

The highest-return missing feature in the backlog. Two steps: preview, then commit. Nothing posts from step one.

```
   step 1 — preview             step 2 — done
┌──────────────────────────┐  ┌──────────────────────┐
│  Rent run — August 2026  │  │           ok          │
│                          │  │                      │
│  34 invoices             │  │   34 invoices        │
│  AED 412,000             │  │   AED 412,000        │
│                          │  │                      │
│  Apartments  29  386,000 │  │  Reconciles to the   │
│    exempt, no VAT        │  │  lease schedule.     │
│  Parking      5   26,000 │  │                      │
│    standard-rated, +1,238│  │  [View invoices →]   │
│                          │  │  [Send to tenants]   │
│  ! 2 leases end mid-     │  └──────────────────────┘
│    month and are         │
│    apportioned:          │
│    Marina 0902  8,120    │
│    Bay P-03       640    │
│                          │
│  ! 1 lease has no cheque │
│    on file: Marina 1108  │
│                          │
│  ok Already run for       │
│    August? No.           │
│                          │
│  [Cancel] [Create 34]    │
└──────────────────────────┘
```

The preview shows the VAT treatment split explicitly, because that split is the highest-risk calculation in the pilot business. An accountant reads that line and catches a misconfigured lease before 34 wrong invoices exist.

### 9.3 Lease editor

```
┌──────────────────────────────────┐
│  ←  New lease                    │
├──────────────────────────────────┤
│  Unit       Marina 1205       ▾  │
│  Type       Residential          │  derived from unit
│             VAT exempt           │
│  Tenant     [search or add]   ▾  │
│  From       01 Sep 2026       ▾  │
│  To         31 Aug 2027       ▾  │
│  Rent       AED [ 12,000 ] /mo   │
│  Instalments 4 cheques        ▾  │
│  Deposit    AED [ 12,000 ]       │
│  Ejari      [ ref ]  expires ▾   │
├──────────────────────────────────┤
│  SCHEDULE                        │
│  01 Sep  36,000  chq [        ]  │
│  01 Dec  36,000  chq [        ]  │
│  01 Mar  36,000  chq [        ]  │
│  01 Jun  36,000  chq [        ]  │
├──────────────────────────────────┤
│  Residential rent is VAT exempt. │
│  VAT you pay on costs for this   │
│  unit cannot be reclaimed.       │
│                                  │
│  [ Create lease ]                │
└──────────────────────────────────┘
```

The explanation at the bottom appears at the moment the treatment is set, not in documentation. It is the same pattern as the cash-payment screen.

* * *

## 10. Compliance

### 10.1 Watchlist — the accountant's landing screen

```
┌──────────────────────────────────┐
│  Compliance                      │
├──────────────────────────────────┤
│  ◇ timeline, next 90 days        │
│  ├──●───────●────●──────●────┤   │
│   VAT     WPS  Licence  CT       │
│   19d      1d    42d   184d      │
├──────────────────────────────────┤
│  THIS WEEK                    2  │
│  ┌────────────────────────────┐  │
│  │ ! WPS salaries due 1 Sep   │  │
│  │   No grace period since    │  │
│  │   June 2026                │  │
│  │              [Run payroll] │  │
│  ├────────────────────────────┤  │
│  │ ! Ejari renewal · Marina   │  │
│  │   1204 · 6 days            │  │
│  │                    [View]  │  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  UPCOMING                        │
│  VAT Q3 return       19 days  →  │
│  Trade licence       42 days  →  │
│    SEMUL MIAH ELECTRONICS        │
│  Visa · 2 staff      67 days  →  │
│  Corporate tax FY25 184 days  →  │
│  E-invoicing ASP    231 days  !  │
│    Deadline 31 Mar 2027          │
├──────────────────────────────────┤
│  DOCUMENTS ON FILE               │
│  Trade licences  3 of 3      ok   │
│  Ejari           38 of 41    !   │
│  Visas           9 of 9      ok   │
│  TRN certs       3 of 3      ok   │
└──────────────────────────────────┘
```

The e-invoicing row is included from day one with a countdown, so the deadline is visible for the 231 days before it becomes urgent rather than the week after.

### 10.2 VAT

```
┌──────────────────────────────────┐
│  VAT               Q3 2026    ▾  │
│  1 Jul – 30 Sep · due 28 Oct     │
├──────────────────────────────────┤
│  ┌────────────────────────────┐  │
│  │   Payable   AED 18,220     │  │
│  └────────────────────────────┘  │
│                                  │
│  ◇ two bars                      │
│  Output VAT  ▬▬▬▬▬▬▬▬  31,440    │
│  Recoverable ▬▬▬▬      13,220    │
│                                  │
│  You cannot reclaim AED 4,180    │
│  because residential rent is     │
│  exempt.                         │
├──────────────────────────────────┤
│  APPORTIONMENT                   │
│  Method   Output-based (standard)│
│  Taxable supplies      AED 421k  │
│  Exempt supplies       AED 386k  │
│  Recoverable share        52.2%  │
│                                  │
│  note A floorspace method may suit  │
│    a property portfolio better.  │
│    It needs FTA approval.        │
│                     [Learn more] │
├──────────────────────────────────┤
│  RETURN                          │
│  Box 1  Standard-rated  ...   →  │
│  Box 3  Reverse charge  ...   →  │
│  Box 5  Exempt supplies ...   →  │
│  Box 9  Standard purch. ...   →  │
│  ...                             │
│  Every box links to its journals │
├──────────────────────────────────┤
│  ANNUAL WASH-UP                  │
│  ┌────────────────────────────┐  │
│  │ Due after 31 Dec 2026      │  │
│  │ Reconciles provisional     │  │
│  │ apportionment to actual    │  │
│  │ use.                       │  │
│  │              [Not yet due] │  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  [ Export for EmaraTax ]         │
└──────────────────────────────────┘
```

### 10.3 E-invoicing

```
┌──────────────────────────────────┐
│  E-invoicing                     │
├──────────────────────────────────┤
│  ┌────────────────────────────┐  │
│  │  Not yet required          │  │
│  │  You must appoint an       │  │
│  │  accredited provider by    │  │
│  │  31 March 2027 and be live │  │
│  │  by 1 July 2027.           │  │
│  │                            │  │
│  │  231 days to appoint       │  │
│  │  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░         │  │
│  │              [Set up ASP]  │  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  READINESS                       │
│  Legal entities         3 of 3 ok │
│  TINs recorded          2 of 3 ! │
│  Provider appointed         no    │
│  B2B documents identified   ok    │
│    142 of 411 this quarter       │
├──────────────────────────────────┤
│  Once live, this screen shows    │
│  transmission status and any     │
│  rejected documents.             │
└──────────────────────────────────┘
```

Post go-live the same route shows a transmission log and an exception queue of rejected documents with their Message Level Status reason.

### 10.4 Period close

```
┌──────────────────────────────────┐
│  Close period      August 2026 ▾ │
├──────────────────────────────────┤
│  BEFORE YOU CLOSE                │
│  ok All cash sessions closed      │
│  ok All journals balance          │
│  ! 2 payments unallocated        │
│      AED 3,400          [Fix →]  │
│  ! 1 inter-business balance      │
│      does not net       [Fix →]  │
│  ok 4 cheques in flight — fine    │
│  ok Bank reconciled to 31 Aug     │
│  ok VAT computed                  │
├──────────────────────────────────┤
│  TRIAL BALANCE                   │
│  Debits      AED 4,182,440       │
│  Credits     AED 4,182,440       │
│  ok Balanced                      │
│                     [View full →]│
├──────────────────────────────────┤
│  ┌────────────────────────────┐  │
│  │  Close August              │  │
│  └────────────────────────────┘  │
│  Nobody will be able to post     │
│  into August after this. Only    │
│  you and Sumon can reopen it.    │
└──────────────────────────────────┘
```

The Close button stays disabled while any caution item is open. This is the screen that turns `assertPeriodOpen` from unreachable code into a working control.

* * *

## 11. Group consolidated profit and loss

`/reports/group`

```
┌──────────────────────────────────┐
│  Group P&L        This month  ▾  │
│  [Consolidated] [By business]    │
├──────────────────────────────────┤
│  ◇ waterfall, revenue to profit  │
│  Revenue     ▬▬▬▬▬▬▬▬  612,400   │
│  Direct cost ◄▬▬▬▬    -318,200   │
│  Staff       ◄▬▬       -94,600   │
│  Rent & util ◄▬        -61,300   │
│  Other       ◄▬        -46,780   │
│  Eliminations ▬          -7,400  │
│  Profit      ▬▬▬▬      84,120    │
│                                  │
│  Staff cost is 15% of revenue,   │
│  up from 12% in June.            │
├──────────────────────────────────┤
│  ELIMINATIONS                    │
│  Field svc → Properties  12,400  │
│  Salon → Properties       6,200  │
│  Properties → Salon      -4,200  │
│  Parking → Properties    -7,000  │
│  ─────────────────────────────   │
│  Net effect              -7,400  │
│                                  │
│  Without removing these, your    │
│  businesses would appear to earn │
│  AED 7,400 more than the group   │
│  actually made.                  │
├──────────────────────────────────┤
│  BY BUSINESS                     │
│  ◇ small multiples, 6 panels     │
│  ┌────┐┌────┐┌────┐              │
│  │Prop││Salon││Park│              │
│  │╱‾╲ ││ ‾╲ ││╱‾  │              │
│  └────┘└────┘└────┘              │
│  ┌────┐┌────┐┌────┐              │
│  │Field││Shop││Ecom│              │
│  │╱╲╱ ││ ── ││╲__ │              │
│  └────┘└────┘└────┘              │
│  Same scale on every panel.      │
│                                  │
│  E-commerce is the only business │
│  trending down.                  │
├──────────────────────────────────┤
│  [ Export ]  [ Table ⊞ ]         │
└──────────────────────────────────┘
```

Small multiples with a shared scale rather than six lines on one chart. This is the correct form for six unlike businesses and it is what a single combined chart cannot do.

* * *

## 12. Assistant

`/assistant` — re-enabled.

```
┌──────────────────────────────────┐
│  * Ask                       X   │
├──────────────────────────────────┤
│                                  │
│  Which business is losing money? │
│                          — you   │
│                                  │
│  E-commerce. It lost AED 14,080  │
│  this month and has lost money   │
│  for three months running.       │
│                                  │
│  ┌────────────────────────────┐  │
│  │ ● E-commerce               │  │
│  │ Jun  -8,200                │  │
│  │ Jul -11,400                │  │
│  │ Aug -14,080                │  │
│  │              [See rows →]  │  │
│  └────────────────────────────┘  │
│                                  │
│  ◇ line, three months            │
│                                  │
│  Mostly advertising spend, which │
│  rose 62% while revenue was      │
│  flat.                           │
│           [Ad spend rows →]      │
│                                  │
├──────────────────────────────────┤
│  Try: how much cash do I have ·  │
│  what is due this week · why did │
│  profit fall                     │
├──────────────────────────────────┤
│  [                        ][mic][→]│
└──────────────────────────────────┘
```

Every number carries an evidence link. A claim without one is not rendered — that is design principle D2 applied to generated text, and it is the difference between an assistant and a liability.

### 12.1 When it cannot answer

```
│  I can't answer that from the    │
│  numbers I have. There's no      │
│  metric for advertising return   │
│  by channel.                     │
│                                  │
│  I can show you total ad spend   │
│  and e-commerce revenue side by  │
│  side.               [Show me]   │
```

Saying so is required behaviour, not a failure state. The alternative is a plausible number, which in an ERP is worse than no number.

* * *

## 13. Import wizard

Four steps. Nothing commits before step three.

```
 1 Choose        2 Map           3 Review        4 Done
┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐
│ What are    ││ Match your  ││ 41 leases   ││ Imported    │
│ you         ││ columns     ││ to create   ││             │
│ importing?  ││             ││ 3 rejected  ││ Trial       │
│             ││ Your file → ││   no unit   ││ balance     │
│ [x] Opening   ││ Nexus       ││   match     ││ AED         │
│   balances  ││             ││             ││ 4,182,440   │
│ [x] Customers ││ Unit    ▾   ││ 0 updates   ││             │
│ [x] Leases    ││ Tenant  ▾   ││             ││ ! Priya     │
│ [x] Cheques   ││ Start   ▾   ││ ┌─────────┐ ││ must sign   │
│ [ ] Stock     ││ Rent    ▾   ││ │ Nothing │ ││ the         │
│ [ ] Employees ││             ││ │ has been│ ││ reconcilia- │
│             ││ ok 41 rows   ││ │ saved   │ ││ tion before │
│ [Upload]    ││   readable  ││ │ yet.    │ ││ go-live.    │
│             ││             ││ └─────────┘ ││             │
│             ││             ││             ││ [Send for   │
│ [Next]      ││ [Back][Next]││[Back][Import]││  sign-off]  │
└─────────────┘└─────────────┘└─────────────┘└─────────────┘
```

"Nothing has been saved yet" is stated explicitly on the review step because dry-run imports that silently commit are the classic way migration goes wrong, and poor data migration is 38 percent of ERP implementation failures.

A batch remains reversible for 72 hours after commit.

* * *

## 14. Settings — users

```
┌──────────────────────────────────┐
│  Users                  [Invite] │
├──────────────────────────────────┤
│  ◍ Sumon Miah                    │
│    Owner · all businesses        │
│    Active · MFA on            →  │
│  ────────────────────────────────│
│  ◍ Priya S.                      │
│    Accountant · all businesses   │
│    Active · MFA on            →  │
│  ────────────────────────────────│
│  ◍ Maya R.                       │
│    Receptionist · Salon Marina   │
│    Active · MFA off           !  │
│  ────────────────────────────────│
│  ◍ Ahmed K.                      │
│    Barber · Salon Marina         │
│    Deactivated 4 Aug          →  │
└──────────────────────────────────┘
```

### 14.1 Deactivate

```
┌──────────────────────────────────┐
│  Deactivate Ahmed K.?            │
│                                  │
│  He will be signed out of every  │
│  device immediately.             │
│                                  │
│  His record and everything he    │
│  did stay in the system. You can │
│  reactivate him later.           │
│                                  │
│  Reason  [                    ]  │
│                                  │
│  [ Cancel ]  [ Deactivate ]      │
└──────────────────────────────────┘
```

"Signed out of every device immediately" is the whole point of the screen. Today this requires a database edit and the sessions survive it.

* * *

## 15. Search

```
┌──────────────────────────────────┐
│  find [ marina                   ] │
├──────────────────────────────────┤
│  UNITS                        3  │
│  ● Marina 1204 · let          →  │
│  ● Marina 1205 · vacant       →  │
│  ● Marina 0902 · let          →  │
│                                  │
│  PARTIES                      2  │
│  ● Marina Facilities LLC      →  │
│  ● Al Fahim · Marina 1204     →  │
│                                  │
│  DOCUMENTS                   14  │
│  INV-1042 · 12,000 · Aug      →  │
│  INV-1039 · 12,000 · Jul      →  │
│                       [All 14 →] │
│                                  │
│  CHEQUES                      6  │
│  CHQ 447811 · 42,000 · due    →  │
│                                  │
│  ASK                             │
│  * "how is marina doing"      →  │
└──────────────────────────────────┘
```

The last row routes an unmatched query to the assistant, which is the right fallback for a search that finds nothing.

* * *

## 16. Field application — Phase 3

Designed to the ruggedised constraints: 48 to 56 px targets, 7:1 contrast, three-tap ceiling, controls in the bottom 40 percent.

```
  Job list                    Job detail
┌──────────────────────┐   ┌──────────────────────┐
│  Today          ◉ 4  │   │  ←  #4192            │
│  ! Offline · 4 queued│   │                      │
├──────────────────────┤   │  AC not cooling      │
│                      │   │  Marina Tower 1204   │
│  ┌────────────────┐  │   │  Al Fahim            │
│  │ 09:00          │  │   │  0501234567          │
│  │ AC not cooling │  │   │                      │
│  │ Marina 1204    │  │   │  ┌────────────────┐  │
│  │ ● Properties   │  │   │  │ Parts used     │  │
│  └────────────────┘  │   │  │ + Add          │  │
│  ┌────────────────┐  │   │  └────────────────┘  │
│  │ 11:30          │  │   │  ┌────────────────┐  │
│  │ Leak, kitchen  │  │   │  │ photo Photos   2  │  │
│  │ Bay Square 802 │  │   │  └────────────────┘  │
│  └────────────────┘  │   │                      │
│                      │   │  ← bottom 40% —      │
│  ← bottom 40% —      │   │                      │
│  ┌────────────────┐  │   │  ┌────────────────┐  │
│  │  START NEXT    │  │   │  │   COMPLETE     │  │
│  └────────────────┘  │   │  └────────────────┘  │
└──────────────────────┘   └──────────────────────┘
```

### 16.1 Complete, and the inter-business trigger

```
┌──────────────────────┐
│  Job done            │
│                      │
│  Time    2h 15m      │
│  Parts   1 capacitor │
│  Photos  2           │
│                      │
│  ┌────────────────┐  │
│  │ This flat      │  │
│  │ belongs to     │  │
│  │ Properties.    │  │
│  │                │  │
│  │ AED 1,200 will │  │
│  │ be charged to  │  │
│  │ Properties.    │  │
│  └────────────────┘  │
│                      │
│  ┌────────────────┐  │
│  │    CONFIRM     │  │
│  └────────────────┘  │
└──────────────────────┘
```

This is the wedge, executed automatically, at the moment the work finishes. The transaction the audit says "nobody invoices anybody" for gets recorded by the person who did the work, without anyone deciding to record it.

### 16.2 Offline behaviour

- 14 days of assigned jobs cached.
- Unlimited photo capture, queued, uploaded on reconnect.
- **Lock on claim.** Checking in locks the job for edits by anyone else until check-out or timeout. This eliminates the conflict class rather than building a merge interface.
- The offline banner states the queue depth, never a spinner. A technician needs to know how much is waiting, not that something is happening.

* * *

## 17. State matrix

Every screen, every state. A screen ships when its row is complete.

| Screen | Default | Loading | Empty | Error | Denied |
| --- | --- | --- | --- | --- | --- |
| Today | §2.1 | Skeleton per section, streamed | Positive empty exceptions; import prompt if no data | Per-section `MetricUnavailable`; route boundary | Sections absent, not greyed |
| Cash entry | §3.2 | Sheet opens instantly, lists cached | No cash point → setup link | Inline under field | `⊕` not rendered |
| Day close | §4.2 | Count field enabled first | n/a | Inline | Close absent |
| Cash register | §4.1 | Skeleton rows | "No cash points yet" + setup | Per-section | Route hidden |
| Owner ledger | §5 | Skeleton | "No owner movements yet" | Per-section | Route hidden |
| Between businesses | §6 | Sankey skeleton | "No transfers yet" + explainer | Per-section | Route hidden |
| Money in | §7 | Table skeleton | Existing `EmptyState` | Per-section | Route hidden |
| Money out | — | Table skeleton | Existing | Per-section | Route hidden |
| Cheques | §8 | Skeleton | "No cheques on file" | Per-section | Route hidden |
| Rentals | §9.1 | Skeleton | "No units yet" + import link | Per-section | Route hidden |
| Rent run | §9.2 | Preview spinner with count | "No active leases" | Preview error, nothing posted | Action absent |
| Lease editor | §9.3 | Form ready, lists cached | n/a | Inline per field | Route hidden |
| Compliance | §10.1 | Skeleton | "Nothing due in 90 days" | Per-section | Route hidden |
| VAT | §10.2 | Skeleton | "No transactions this period" | Per-box error | Route hidden |
| E-invoicing | §10.3 | Skeleton | Readiness state is the empty state | Per-section | Route hidden |
| Period close | §10.4 | Checklist skeleton | n/a | Blocking, close disabled | Route hidden |
| Group P&L | §11 | Chart skeletons | "No data this period" | Per-section | Route hidden |
| Assistant | §12 | Streaming response | Suggested prompts | "Couldn't reach the assistant. [Retry]" | Route hidden |
| Import | §13 | Per-step | n/a | Per-row rejection with reasons | Owner and accountant only |
| Users | §14 | Skeleton | n/a | Inline | Owner only |
| Search | §15 | Debounced spinner in results | "Nothing found" + ask fallback | Inline | Results permission-filtered |
| Field job list | §16 | Cached first, then refresh | "No jobs today" | Offline banner with queue depth | Self-scoped |

* * *

## 18. Responsive rules

| Breakpoint | Navigation | Grid | Notes |
| --- | --- | --- | --- |
| Under 768 px | Bottom bar with `⊕`, top bar with search and bell | 1 column | `env(safe-area-inset-bottom)` respected. Charts wide-short. Small multiples become a swipeable 2×3 grid |
| 768 to 1024 px | Bottom bar | 2 columns | Exception cards go two-up |
| Over 1024 px | Left sidebar with group labels, user footer | 3 to 4 columns | Reading-heavy pages cap at 900 px; dashboards at 1120 px |

Charts are container-query aware, not viewport-aware. A chart in a sidebar behaves like a mobile chart regardless of screen width.

* * *

## 19. What these wireframes deliberately do not show

- Visual styling. Colour, type and spacing live in PDD-04. These frames are structure and state only.
- Screens that exist and are working and are not changing — the salon booking flow, inventory counts, the security settings screen.
- Phase 4 screens: Arabic layouts, e-commerce channel sync, the automation management interface.
- The construction and projects module, which is dropped per non-goal NG11.
