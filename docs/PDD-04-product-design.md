# Nexus — Product Design Document and Visualisation System

**Document** PDD-04 · **Version** 2.0 · **Date** 12 August 2026
**Status** For ratification
**Implements** PRD-02 v2.0 · **Informed by** RES-01 · **Constrained by** TRD-03
**Companion** WF-05 (Wireframes)

* * *

## 0. Position

Nexus has a real design system. The audit found coherent CSS custom-property tokens, a per-business colour dimension that makes multi-business data readable at a glance, tabular numerals so money columns align, and a deliberate refusal to fake unbuilt screens. Those are good decisions and this document keeps all of them.

It also found that 21 of 21 pages have no loading state and no error boundary, that skeleton components were built and then never used, that two styling systems run side by side, that there is no Button, Input, Table, Modal or Toast component, and that accessibility has never been assessed. Those are not taste problems. They are the design equivalent of the engineering finding: the structure is sound and the envelope around it is missing.

The owner has asked for one substantive change in direction: **more infographics than data, so that people understand visually what is happening.** Section 7 is the answer to that, and it is the longest section in this document because it is the part that does not exist today in any form.

Table of Contents

* * *

## 1. Design critique of the current build

Assessed against the audit's screen inventory and component list, at the stage the product is actually at: a working system about to receive real data.

### 1.1 First impression

The dashboard reads as competent and dense. Numbers are the content, which is correct for this user. What it does not do is tell the owner what to do. It presents a position and leaves the interpretation to him, which is precisely the work he said he does not have time for.

### 1.2 Usability

| Finding | Severity | Recommendation |
| --- | --- | --- |
| The action list is a panel among panels rather than the organising principle. The owner must scan tiles to find the problem | Critical | Exceptions above the fold; metrics below. Section 6 |
| The accountant's three primary screens — VAT201, profit and loss, gratuity — have no navigation entry at all and are reachable only by drill-down | Critical | Restructure navigation. Section 5 |
| No confirmation on financial writes. A credit note posts on one click against real books | Critical | Confirmation on any write that posts a journal above a threshold |
| No pagination anywhere; the receivables page ships 284 KB at seed volume | High | Cursor pagination, virtualised long lists |
| Cheques are filed under rentals. They settle tenancies but are a finance concern, and the accountant cannot find them | High | Move to a finance grouping |
| No global search at 447 parties and 4,151 documents | High | Global search becomes the primary navigation mechanism at real volume |
| No way to record a cash transaction at all | Critical | The manual-entry module. Section 8 |
| No way to report a wrong number from the screen showing it | Medium | A feedback affordance on every metric |

### 1.3 Visual hierarchy

What draws the eye first is the KPI tile row. For a user whose stated job is "catch problems before they cost money," that is the wrong first fixation. The tiles answer *what is the position*; the exception list answers *what needs me*. The second question is the one he opens the app to ask.

The reading flow is otherwise sound: tiles, then comparison, then detail. Whitespace is used adequately. Tabular numerals are correctly applied and this matters more than it sounds — misaligned money columns are read slowly and distrusted.

### 1.4 Consistency

| Element | Issue | Fix |
| --- | --- | --- |
| Styling | Extensive inline `style={{}}` alongside Tailwind utilities. Two systems, so every visual change costs twice and theming is fragile | Consolidate on Tailwind plus tokens |
| Buttons | A `.btn` CSS class, not a component. Usage is inconsistent | Extract a Button component with variants and states |
| Inputs | Inline styles repeated across forms; five `<label>` elements across 21 screens | Extract Field, Input, Select with a label always present |
| Tables | Hand-rolled per page | One Table primitive with sort, empty and loading states |
| Icons | `lucide-react` is installed while the navigation uses Unicode glyphs. Glyphs are unclear at small sizes and carry poor screen-reader semantics | Adopt lucide; remove the glyphs |
| Charts | Sparkline and BarRow hand-rolled as SVG; `recharts` installed and barely used | One chart system. Section 7 |

### 1.5 States — the systemic gap

| State | Coverage |
| --- | --- |
| Empty | Good. Most list pages use `EmptyState` |
| Loading | Zero of 21 pages. `TileSkeleton` and `GridSkeleton` exist and are never rendered |
| Error | Zero boundaries. A thrown error yields a generic framework error page |
| Success | Inline only. No toast for background completion |
| Partial failure | One failed metric fails the whole page |

The skeleton components are the diagnostic. They were built, and then no `loading.tsx` was ever added, so they sit in the codebase unused. That is a design decision made by omission, and it is the single most visible quality gap in the product.

### 1.6 Accessibility

23 aria attributes and 5 labels across 21 screens. No focus-visible treatment in the tokens. Contrast never verified. No screen-reader testing. No automated checking. WCAG 2.2 AA is not met and has never been assessed.

No accessibility mandate binding private-sector business software in the UAE was found in research, so this is not a legal blocker — but it is a real gap for a product whose users include staff with low technical comfort, and it is a hard requirement in the field-app context where daylight legibility is a safety-adjacent concern.

### 1.7 What works well

Worth stating, because a critique that only lists faults is not accurate.

- The token system is real, not ad-hoc values. Surface, text, semantic and type-scale groups are properly separated.
- The per-business colour dimension is a genuinely thoughtful touch. Giving each business a stable identity colour is what makes six unrelated businesses readable on one screen, and most products at this stage would not have thought of it.
- Write forms inside collapsible disclosures keep read pages scannable. Good pattern, keep it.
- Query-param filtering means filters are shareable and there is no client state to desynchronise. Simple and right.
- Role-truthful UI — a barber does not see a greyed-out revenue tile, it is not rendered — is a stronger and more honest choice than disabling.
- The placeholder page states what is not built rather than mocking a finished module. Rare, and it should survive.

### 1.8 Priority recommendations

1. **Make exceptions the first thing on the screen.** It changes what the product is for, from a report to a system that tells you what to do.
2. **Ship states everywhere.** Loading, error, partial failure. The components already exist. This is the cheapest large quality gain available.
3. **Build the manual-entry surfaces.** Without them the pilot cannot succeed, and no amount of visual polish compensates.
4. **Build the visualisation system.** The owner asked for it, and the evidence says exactly which forms work.
5. **Extract the missing primitives and delete the inline styles.** Everything after this is cheaper once it is done.

* * *

## 2. Design principles

Seven were reverse-engineered from consistent choices in the code. All seven survive. Three are added.

| # | Principle | What it means in practice |
| --- | --- | --- |
| D1 | **Density over decoration.** Numbers are the content | Compact tiles, tabular figures, minimal chrome. No illustration, no gradient, no ornament |
| D2 | **Every number is drillable.** A figure you cannot verify is a liability | Every KPI links to its rows. Every assistant claim carries an evidence link. A claim without evidence is not rendered |
| D3 | **No fake screens** | State what is not built and which phase delivers it. Never mock a finished module |
| D4 | **Mobile-first for the owner** | Bottom navigation on mobile, sidebar on desktop, safe-area insets respected |
| D5 | **Role-truthful UI. Absent, not empty** | A barber does not see a disabled revenue tile. It is not rendered |
| D6 | **Progressive disclosure of writes** | Write forms live inside collapsible sections so read pages stay scannable |
| D7 | **Tabular numerals everywhere** | Money columns align. Non-negotiable |
| **D8** | **Exceptions before metrics** | The first thing on any screen is what is wrong. The position is second |
| **D9** | **Every chart carries a conclusion** | A chart states what it shows in a sentence. A chart without a conclusion does not ship, and this is enforced at the type level |
| **D10** | **The user describes what happened; the system decides what to debit** | No account picker is ever shown to a non-accountant |

D10 is the principle that makes the manual-entry module possible. Every failed attempt to give cash entry to non-accountants fails on the same rock: it asks the user to be a bookkeeper.

* * *

## 3. Tokens

### 3.1 Colour — structural

The existing groups are correct. Values are restated with the additions this document requires.

| Group | Tokens |
| --- | --- |
| Surface | `--bg` `--surface` `--surface-2` `--surface-3` |
| Text | `--text` `--text-muted` `--text-subtle` `--text-inverse` |
| Semantic | `--accent` (+ soft, hover, border) `--positive` (+ soft) `--negative` (+ soft) `--caution` (+ soft) |
| **Focus** | **`--focus-ring` `--focus-ring-offset`** — new. There is currently no focus treatment in the tokens at all |
| **Border** | **`--border-subtle` `--border-default` `--border-strong`** — new. Currently inline |
| Type scale | `--text-2xs` through `--text-3xl`, eight steps |
| Radius | `--radius-sm` `--radius-md` `--radius-lg` `--radius-xl` |
| Elevation | `--shadow-card` `--shadow-pop` |
| **Motion** | **`--motion-fast` 120ms, `--motion-base` 200ms, `--motion-slow` 320ms, `--ease-out`** — new. No motion tokens exist |
| Fonts | `--font-sans` `--font-mono` |

Two rules on the new tokens:

- **Focus.** A `:focus-visible` ring at 2 px with a 2 px offset, meeting 3:1 non-text contrast against both the element and the surface. Never `outline: none` without a replacement. This is the single largest keyboard-accessibility gap.
- **Motion.** Every transition respects `prefers-reduced-motion: reduce` and collapses to zero duration. No chart animates on load; an animated chart delays the reading of a number, which is the opposite of the product's purpose.

### 3.2 Colour — business units

The per-business colour dimension is the best visual idea in the product. It has never been validated for colour-blind separation or contrast.

**Decision.** Adopt a validated eight-slot categorical order, assigned to business units in fixed order and never cycled.

| Slot | Business unit | Light | Dark |
| --- | --- | --- | --- |
| 1 | Properties (apartments) | `#2a78d6` | `#3987e5` |
| 2 | Field services | `#eb6834` | `#d95926` |
| 3 | Salon | `#1baf7a` | `#199e70` |
| 4 | Parking | `#eda100` | `#c98500` |
| 5 | E-commerce | `#e87ba4` | `#d55181` |
| 6 | Mobile shop | `#008300` | `#008300` |
| 7 | Group / shared | `#4a3aa7` | `#9085e9` |
| 8 | Reserved | `#e34948` | `#e66767` |

This order was checked with the palette validator rather than judged by eye. On the default adjacent pair list — the case that applies to stacked bars, grouped bars and multi-line charts — it passes the lightness band, the chroma floor, colour-vision-deficiency separation at worst ΔE 9.1 against a target of 8, and the normal-vision floor at worst ΔE 19.6 against a floor of 15.

Three constraints follow and they are not optional:

1. **Three slots in light mode sit below 3:1 contrast against the surface** — salon, parking and e-commerce. Wherever those colours carry meaning, a visible direct label or a table view must accompany them. Colour never carries identity alone.
2. **All-pairs chart forms cap at three series.** Scatter, bubble and small multiples put every colour beside every other, and the full eight cannot clear the floors in that arrangement. Past three, fold the tail into "Other" or facet.
3. **Colour follows the entity, never its rank.** Filtering to the top three businesses must not repaint them. Properties is blue whether it is first or fifth.

### 3.3 Status colours — reserved

Never reused as a series colour. Always shipped with an icon and a label, never colour alone.

| Role | Hex | Use |
| --- | --- | --- |
| good | `#0ca30c` | Cleared, on target, reconciled, filed |
| warning | `#fab219` | Due soon, approaching a threshold, stale balance |
| serious | `#ec835a` | Overdue, variance above threshold, unacknowledged |
| critical | `#d03b3b` | Bounced, failed, penalty exposure, unbalanced |

On the light surface, warning and serious fall below 3:1 by design. The icon-plus-label pairing is the mitigation.

### 3.4 Money colour

Positive and negative money is the most common semantic colour use in this product and it is the easiest to get wrong.

- Green for positive, red for negative, using the diverging pair rather than the status palette, so a negative number does not read as a system error.
- **Sign is always carried redundantly.** A minus sign, a parenthesis, or a directional arrow accompanies the colour, every time. Roughly one in twelve men has a red-green deficiency and this is a financial product.
- Neutral grey for zero and for figures where movement is not the point.

* * *

## 4. Component system

### 4.1 Existing

| Component | State coverage | Gap |
| --- | --- | --- |
| Card, CardHeader | — | — |
| KpiTile | value, delta, link | No error state, no loading state |
| Delta | positive, negative, neutral | Needs a redundant symbol, not colour alone |
| Sparkline | — | No empty state |
| BarRow | — | Superseded by the chart system |
| Chip | tone variants | — |
| EmptyState | Good | — |
| TileSkeleton, GridSkeleton | loading | **Never rendered.** No `loading.tsx` exists |
| ActionForm | pending, ok, error | Good pattern |

### 4.2 Required

| Component | Why | States |
| --- | --- | --- |
| Button | Currently a CSS class. Inconsistent usage and no single place for accessibility | default, hover, active, focus-visible, disabled, loading, destructive |
| Field, Input, Select, DatePicker, MoneyInput | Inline styles repeated across every form; almost no labels | default, focus, error with message, disabled, required |
| MoneyInput specifically | Money entry on a phone is the highest-frequency interaction in the new module | Numeric keypad, no spinner, right-aligned, tabular numerals, currency prefix, thousands grouping on blur |
| Table | Hand-rolled per page | header, sortable, empty, loading, paginated, row-selected |
| Pagination | No list is paginated | first, middle, last, single-page, loading |
| Modal / Sheet | None. Confirmations have nowhere to live | open, closing, focus-trapped, Escape-dismissable, mobile bottom sheet |
| ConfirmDialog | A credit note currently posts on one click | Renders the effect in plain language, requires a distinct action |
| Toast | Feedback is inline only; background completions are invisible | info, success, error, with an action |
| Tabs / Filters | Query-param links, not a component | selected, hover, focus, overflow scroll on mobile |
| ErrorBoundary | Zero exist | With a retry affordance and a report link |
| MetricUnavailable | One failed metric currently breaks the page | Section-level degradation with a retry |
| Chart primitives | Section 7 | Each with empty, loading, error, and a required conclusion |
| CashPad | The manual-entry keypad | Section 8 |
| EvidenceLink | D2 made concrete | Attached to every figure and every assistant claim |
| FeedbackFlag | No way to report a wrong number | Captures metric, filters, user, time |

### 4.3 The rule for every new component

Five states or it does not ship: default, loading, empty, error, and disabled or permission-denied. The audit's systemic gap exists because this rule did not.

* * *

## 5. Information architecture

### 5.1 The problem

Navigation is a single flat list of ten entries. The conceptual grouping exists only in documentation. VAT201, profit and loss and gratuity — the accountant's core screens — have no top-level entry. Cheques are filed under rentals. There is no settings home and no global search.

The navigation was designed around the owner. Three of the seven personas cannot find their primary work.

### 5.2 The structure

```
Nexus
├─ Today                    /                  Exceptions, then position
│
├─ Money
│   ├─ Money in             /receivables
│   ├─ Money out            /purchases
│   ├─ Cheques              /finance/cheques           moved from /rentals/cheques
│   ├─ Cash                 /finance/cash              NEW — sessions, floats, variance
│   └─ Owner ledger         /finance/owner             NEW — contributions, drawings, ageing
│
├─ Businesses
│   ├─ Compare              /businesses
│   ├─ Between businesses   /businesses/interco        NEW — due-to, due-from, flow
│   ├─ Rentals              /rentals
│   ├─ Service jobs         /services
│   ├─ Salon                /salon
│   ├─ Inventory            /inventory
│   └─ Customers            /crm
│
├─ Compliance               NEW top-level group
│   ├─ Watchlist            /compliance
│   ├─ VAT                  /compliance/vat            was /accounting/vat
│   ├─ Corporate tax        /compliance/corporate-tax  NEW
│   ├─ Gratuity & payroll   /compliance/payroll        was /hr/gratuity
│   ├─ E-invoicing          /compliance/e-invoicing    NEW — transmission and exceptions
│   └─ Period close         /compliance/close          NEW
│
├─ Reports
│   ├─ Profit & loss        /reports/profit-loss
│   └─ Group consolidated   /reports/group             NEW — with eliminations shown
│
├─ Ask                      /assistant                 re-enabled
│
└─ System
    ├─ Inbox                /inbox
    ├─ Settings             /settings                  NEW — a parent now exists
    │   ├─ Users            /settings/users            NEW
    │   ├─ Security         /settings/security
    │   ├─ Businesses       /settings/businesses
    │   ├─ Cash points      /settings/cash-points      NEW
    │   └─ Automations      /settings/automations      NEW
    └─ Search               global, keyboard-invoked
```

### 5.3 Per-role navigation

The flat list is permission-filtered today, which is right. What changes is that each role gets a different **default landing screen and a different top three**.

| Role | Lands on | Primary three |
| --- | --- | --- |
| Owner | Today | Today, Businesses, Money |
| General manager | Today, operations-filtered | Today, Businesses, Service jobs |
| Accountant | Compliance watchlist | Compliance, Money, Reports |
| Property manager | Rentals | Rentals, Cheques, Money in |
| Receptionist | Salon | Salon only |
| Barber | My schedule | Schedule, My commission |
| Warehouse | Inventory | Inventory, Money out |
| Auditor | Reports | Reports, Compliance, Money |

### 5.4 Global search

Invoked with `/` or `Cmd-K`, or a persistent field on mobile. Searches parties, documents, cheques, leases, units, jobs and employees. Results grouped by type, each carrying its business-unit colour. Recent and pinned items when empty. This becomes the primary navigation mechanism at real volume and should be treated as such rather than as a convenience.

* * *

## 6. The exception-first dashboard

### 6.1 The change

Today the dashboard leads with KPI tiles and carries an action-items panel among them. The evidence says invert this. Management by exception is the consistent recommendation across the dashboard literature: the owner's attention is the scarcest resource, and a dashboard that requires scanning twenty tiles to find the one problem has failed.

### 6.2 Structure, mobile

```
┌──────────────────────────────────┐
│ Nexus            [search] [bell] │
├──────────────────────────────────┤
│  NEEDS YOU                    4  │   ← first region, always
│  ┌────────────────────────────┐  │
│  │ ! 2 cheques due tomorrow   │  │
│  │   AED 84,000 · Marina      │  │
│  │   [View]                   │  │
│  ├────────────────────────────┤  │
│  │ ! Trade licence 42 days    │  │
│  │   SEMUL MIAH ELECTRONICS   │  │
│  │   [View]                   │  │
│  ├────────────────────────────┤  │
│  │ ! AC owes Properties       │  │
│  │   AED 12,400 · 94 days     │  │
│  │   [Settle]                 │  │
│  ├────────────────────────────┤  │
│  │ ! Cash short at Salon till │  │
│  │   AED 45 · unexplained     │  │
│  │   [Review]                 │  │
│  └────────────────────────────┘  │
├──────────────────────────────────┤
│  POSITION                        │
│  ┌────────┐┌────────┐            │
│  │ Cash   ││ Profit │            │
│  │ 412,890││  84,120│            │
│  │ ▲ 3.2% ││ ▼ 8.1% │            │
│  │ ╱╲╱‾╲  ││ ‾╲╱╲   │            │
│  └────────┘└────────┘            │
│  ┌────────┐┌────────┐            │
│  │ Owed   ││ VAT    │            │
│  │  96,340││  18,220│            │
│  └────────┘└────────┘            │
├──────────────────────────────────┤
│  WHY PROFIT MOVED                │
│  [waterfall chart]               │
│  "Profit fell AED 7,400 this     │
│   month. Rent was flat; the      │
│   AC recharge added 12,400 of    │
│   cost that the salon absorbed." │
├──────────────────────────────────┤
│  BY BUSINESS                     │
│  [horizontal bars, BU colours]   │
├──────────────────────────────────┤
│ [Today][Money][Biz][+][More]     │   ← the + is cash entry
└──────────────────────────────────┘
```

The `+` in the bottom navigation is the cash-entry action. It is the second most important control in the product after the exception list, because it is the one that determines whether a spreadsheet exists.

### 6.3 Exception rules

- **Ranked**, not chronological. Rank is money at risk multiplied by time pressure.
- Each carries a **reason and one action**, not just a fact. "2 cheques due tomorrow, AED 84,000, Marina" with a View action beats "Cheques due: 2."
- **Dismissable with a reason.** Dismissals are audited and feed a metric — an exception dismissed repeatedly is a badly designed rule, and that should be visible.
- **Empty is a positive state**, not a blank region. "Nothing needs you. Last checked 4 minutes ago."
- **Role-filtered.** A barber sees no financial exceptions. A receptionist sees no compliance exceptions.
- **Capped at seven** on the primary screen, with the remainder behind "N more."

### 6.4 Exception sources

Overdue receivables · cheques due or bounced · leases expiring · trade licence, Ejari and visa expiry · VAT and corporate tax filing deadlines · WPS deadline · low stock below reorder point · jobs breaching SLA · cash variance above threshold · stale inter-business balances · owner ledger balances past the ageing threshold · unreconciled cash sessions · scheduled jobs that did not run · e-invoice rejections · failed writes.

The last three are new and they matter: a system that does not tell you it is broken is worse than one that is visibly broken.

* * *

## 7. The visualisation system

This is the section that answers the owner's request. The rule that governs all of it: **a chart's job is to carry a conclusion, not to display data.** Where a chart cannot carry a conclusion, use a number.

### 7.1 Procedure

Every chart in Nexus is specified in this order, and colour comes last because most bad charts pick colour first.

1. **Is it even a chart?** A single current value with a trend is a stat tile, not a one-bar bar chart. A handful of headline numbers is a KPI row. More than about seven classes that all carry meaning is a table.
2. **Pick the form from the job** the reader must do — compare magnitude, tell series apart, show polarity against a baseline, show change over time, show part-to-whole.
3. **Assign colour by its job** — categorical for identity, sequential for magnitude, diverging for polarity, status for state.
4. **Validate the palette with the script**, not by eye.
5. **Apply mark specs** — thin marks, rounded data-ends anchored to the baseline, 2 px lines, a 2 px surface gap between adjacent fills, selective direct labels rather than a number on every point.
6. **Add hover.** Crosshair and tooltip on line and area, per-mark tooltip on bar, dot and cell. The only form that skips it is a bare stat tile.
7. **Accessibility pass.** Legend present for two or more series; four or fewer are also direct-labelled; a table view exists; dark mode is separately selected, not an automatic flip; texture is available for the colour-blind, print and forced-colours cases.
8. **Render it and look at it.** The validator checks colour, not layout.

### 7.2 The chart for every metric

| What the owner needs to know | Form | Colour job | Never |
| --- | --- | --- | --- |
| Cash right now | Stat tile with sparkline | one hue | A gauge |
| Cash over time | Line, with a minimum-safe-balance reference line and a shaded danger band | one hue | Bars per day |
| Cash in versus out per period | Grouped bars, or two lines with the gap shaded | 2 categorical | Dual axis |
| Why profit moved | **Waterfall**, opening to closing with named drivers | diverging plus neutral totals | Stacked bar pretending to be a bridge |
| Profit by business | Horizontal bars, sorted, business-unit colours | categorical | Pie — profit can be negative and a pie cannot show that |
| Revenue mix, one period | Stacked bar | categorical | Pie |
| Revenue mix over time | 100 percent stacked bar | categorical | Multiple pies |
| Six businesses compared over time | **Small multiples**, shared scale, one panel each | one hue per panel | Six lines on one chart |
| Occupancy against target | **Bullet graph** | one hue plus a target marker | Gauge, donut ring |
| Utilisation of technicians | Bullet graph | one hue | Speedometer |
| Receivables ageing | Stacked horizontal bars by bucket, one bar per customer, sorted by exposure | sequential across buckets | Pie of buckets |
| Cheque pipeline | Funnel by state, counts and value | ordinal ramp | Pie |
| Daily cash movement | **Calendar heatmap**, diverging around zero | diverging | A 365-point line |
| Booking or job density | Calendar heatmap, sequential | sequential | A bar per day |
| Money between businesses | **Sankey**, monthly, curated nodes | categorical by source business | A daily Sankey; a matrix table for a non-accountant |
| VAT position | Stat tile plus a two-bar comparison of output against recoverable input | 2 categorical | A single number with no context |
| Gratuity liability | Stat tile with a trend line, and a bar per employee band | one hue | A pie by employee |
| Variance to budget | Bars with a target marker and a signed delta | diverging | Dual-axis combo |
| Before and after per unit | Dumbbell | one hue, two shades | Two grouped bars |
| Cash variance by till | Dot plot by cash point over time, zero reference line | diverging | A total |

Three forms in that table do not exist in the product today and carry most of the explanatory weight: the waterfall, the bullet graph and the calendar heatmap.

### 7.3 The waterfall — the most important chart in the product

The owner's question is almost never "what is my profit." It is "why is it different from last month." That is a bridge, and the bridge is the chart that answers it.

**Construction**

- Opening total anchored to zero, in a neutral total colour.
- Interior bars float between the previous cumulative total and the new one.
- Closing total anchored to zero, in a distinct strong colour, direct-labelled with both the value and the comparison.
- **Exactly two semantic colours** for increases and decreases, plus a third neutral for totals and subtotals. Not a per-category rainbow — that defeats the narrative.
- Thin grey connector lines so the eye follows the cascade.
- Every bar signed and labelled.
- **Five to eight steps maximum.** Minor items roll into a single "other" bar. Beyond eight it stops being readable, and showing every general-ledger line defeats the purpose.

**The conclusion line is mandatory and is the point.** Not "Profit bridge, July to August" but "Profit fell AED 7,400. Rent was flat; the AC recharge added AED 12,400 of cost the salon absorbed."

### 7.4 Small multiples for six unlike businesses

Six overlapping lines on one chart is unreadable, and it also breaks the palette rule — all-pairs forms cap at three series. Six panels, identical axes, shared scale, one line each, business-unit colour per panel. This is the correct answer to "how are my businesses doing" and it is what a single combined chart cannot do.

### 7.5 The Sankey — use with discipline

Inter-business money flow is the product's differentiator and a Sankey is the only form that shows it intuitively to a non-accountant. It is also the easiest chart here to misuse.

**Rules**

- Monthly, never daily. Comparing two periods in one Sankey is effectively impossible.
- Curated node set: six businesses, a consolidated position, and four to six destination categories. Everything else folds into "other." Every general-ledger account produces spaghetti.
- Flow width proportional to AED value, with values labelled at each node.
- It supplements the bar and line views; it never replaces them. It is poor for reading precise values or spotting a trend change, which is exactly what makes it good as a monthly big-picture view and bad as a daily widget.

### 7.6 Marks and chrome

- Thin marks. Rounded 4 px data-ends anchored to the baseline. 2 px line strokes. Markers no smaller than 8 px.
- A 2 px surface-coloured gap between stacked segments and between adjacent bars; a 2 px surface ring on overlapping marks.
- Recessive grid and axes. The grid is context, not content.
- **Selective direct labels.** Label the last point, the maximum, the minimum, and anything the conclusion refers to. Never a number on every point.
- **Text wears text tokens, never the series colour.** A coloured mark beside a label carries identity; the label itself stays in ink.

### 7.7 The conclusion line

Every chart component takes a required `conclusion` prop. A chart without one does not compile — this is stated in TRD-03 as a type-level constraint, and it is the mechanism by which "explain, do not display" becomes structural rather than aspirational.

**What a conclusion is:** a single sentence stating what the chart shows and, where possible, why. Generated from the data, not from a template.

| Bad | Good |
| --- | --- |
| Profit by month | Profit fell AED 7,400 in August, mainly from the AC recharge |
| Occupancy rate | 34 of 41 units let. Three leases end within 60 days |
| Cash variance | The salon till has been short four of the last six closes, always on the evening shift |
| Receivables ageing | AED 61,000 of the AED 96,000 owed is from two tenants, both past 90 days |

The fourth example is the shape to aim for: it names the number, the concentration and the implied action, in one sentence.

### 7.8 Interaction

- Line and area: crosshair with a tooltip showing every series at that point.
- Bar, dot, cell: per-mark tooltip on hover and on tap.
- Hit targets larger than the mark itself.
- Filters in one row above the chart group, never inside a chart.
- Every chart has a **table view toggle**. This is the accessibility relief mechanism and it is also how the accountant checks a number.
- Clicking any mark drills to the rows behind it. This is D2 applied to charts.

### 7.9 Mobile constraints

- Tap-to-reveal tooltips; hover does not exist. Prefer direct labelling so the key value is visible without any interaction.
- Direct labels at the end of each line or bar rather than an off-chart legend that forces eye travel.
- Legend chips, when needed, are tappable at 44 px minimum — not colour dots.
- Wide-short or square aspect ratios that fit portrait without horizontal scrolling.
- Long series truncate to a rolling window — last 30 or 90 days — rather than compressing twelve months illegibly.
- Six-panel small multiples become a swipeable two-by-three grid, not six stacked full-width charts.

### 7.10 Dark mode

Dark mode is **selected**, not flipped. Each colour has its own dark step, validated against the dark surface, because saturated red and green at full intensity vibrate against near-black and lose contrast. The business-unit table in section 3.2 gives both columns. Contrast is checked in both modes in CI.

### 7.11 Anti-patterns — none of these ship

| Never | Why |
| --- | --- |
| Gauges and speedometers | Space-inefficient, trend-blind, non-linear scales mislead. The bullet graph exists to replace them |
| Donut rings as KPI progress | Angle and area are judged poorly. A bar with a target marker says the same thing in less space and compares across cards |
| Pie charts | Cannot show negative values, and angle judgement is worse than length judgement. Profit by business can be negative |
| Dual axes | Implies a correlation between two independently scaled series that is not there. The single most common chart mistake |
| Three-dimensional anything | Distorts area and volume perception |
| A ninth generated hue | The eighth slot is the ceiling. A ninth series folds into "other," facets, or uses shape as well as hue |
| Colour cycling by rank | Filtering must not repaint the survivors. Properties is blue always |
| A rainbow sequential scale | Sequential is one hue, light to dark. Diverging is two hues with a neutral grey midpoint |
| A number on every data point | Selective labels only |
| Animated chart entry | Delays the reading of a number |
| Status colours as series colours | A status colour must never impersonate a business unit |

* * *

## 8. Manual entry — the design that decides adoption

### 8.1 The principle

D10: the user describes what happened; the system decides what to debit. No account picker. No debit and credit columns. No accounting vocabulary anywhere except in the accountant's own manual-journal screen.

The target is fifteen seconds from unlocking the phone to a posted cash entry, done one-handed, possibly outdoors.

### 8.2 Entry flow

```
[+] from bottom nav
        │
        ▼
┌────────────────────────────┐
│  What happened?            │
│                            │
│  ┌──────────┐┌──────────┐  │
│  │ Received ││   Paid   │  │
│  │  cash    ││   cash   │  │
│  └──────────┘└──────────┘  │
│  ┌──────────┐┌──────────┐  │
│  │ Put my   ││ Took my  │  │
│  │ money in ││ money out│  │
│  └──────────┘└──────────┘  │
│  ┌──────────────────────┐  │
│  │ One business paid    │  │
│  │ for another          │  │
│  └──────────────────────┘  │
│                            │
│  Recent templates          │
│  · Marina rent · Fuel      │
└────────────────────────────┘
        │  "Paid cash"
        ▼
┌────────────────────────────┐
│  ← Paid cash               │
│                            │
│         AED 400            │  ← hero, keypad open on entry
│      ─────────────         │
│                            │
│  From   [Properties     ▾] │  ← defaults to last used
│  For    [Repairs        ▾] │  ← 6 recent categories, then search
│  When   [Today          ▾] │
│  Note   [                ] │  ← optional
│                            │
│  [ photo Add photo ]          │
│                            │
│  ┌──────────────────────┐  │
│  │  Record AED 400      │  │
│  └──────────────────────┘  │
│                            │
│  Marina Cash: 2,340 → 1,940│  ← effect, before submitting
└────────────────────────────┘
        │
        ▼
    Toast: Recorded. [Undo]
```

**Design decisions and their reasons**

- **Amount first, keypad open.** It is the only field the user always knows. Everything else defaults.
- **Plain-language verbs, not object names.** "Took my money out" rather than "Owner drawing." The accounting term appears only in the accountant's ledger view.
- **The effect is shown before submission.** "Marina Cash: 2,340 → 1,940." This is what replaces understanding double entry.
- **Undo in the toast for 30 seconds**, which creates a reversing entry rather than deleting. Nothing is ever hard-deleted.
- **Photo optional and late.** Making it mandatory guarantees the entry is skipped when there is no receipt, which is exactly the case cash covers.
- **Five options, not a list of twenty.** Every additional choice on this screen costs adoption.

### 8.3 Day close and the blind count

```
┌────────────────────────────┐
│  Close Salon till          │
│                            │
│  Opened 09:00 · float 500  │
│  12 cash entries today     │
│                            │
│  Count the cash and enter  │
│  the total.                │
│                            │
│         AED [        ]     │  ← expected is NOT shown
│                            │
│  [ Submit count ]          │
└────────────────────────────┘
        │
        ▼
┌────────────────────────────┐
│  Counted    AED 1,835      │
│  Expected   AED 1,840      │
│  ─────────────────────     │
│  Short      AED 5          │
│                            │
│  Below the AED 20 limit.   │
│  Recorded as cash short.   │
│                            │
│  [ Close till ]            │
└────────────────────────────┘
```

The expected figure is not rendered before the count is submitted, and it is not present in any client payload while the session is open. This is a blind count and it is the standard control against a counter adjusting the figure to match a known target. Above the threshold, a reason is required and a manager acknowledgement is requested.

The design intent, from the research: **most variance is a training signal, not theft — but only if it is tracked with enough granularity to see clustering by person, shift and till.** So the variance screen shows a dot plot over time by till and by person, not a total.

### 8.4 Inter-business transfer

The one entry that needs a picture, because the concept is genuinely two-sided.

```
┌────────────────────────────┐
│  One business paid for     │
│  another                   │
│                            │
│  Who paid   [AC Services ▾]│
│  For whom   [Properties  ▾]│
│  Amount     AED 1,200      │
│  What       [Service done▾]│
│  Job        [#4192       ▾]│
│                            │
│  ┌──────────────────────┐  │
│  │  AC Services         │  │
│  │      ●───────▶       │  │
│  │        1,200         │  │
│  │              ● Props │  │
│  │                      │  │
│  │  AC earns 1,200      │  │
│  │  Properties pays it  │  │
│  │  Group total: no     │  │
│  │  change              │  │
│  └──────────────────────┘  │
│                            │
│  [ Record ]                │
└────────────────────────────┘
```

The small flow diagram is not decoration. It is the only way a non-accountant sees that both sides happened and that group profit did not move.

### 8.5 Receipt capture and confidence-gated review

Extracted fields above the confidence threshold render calm and pre-filled. Fields below it render with a caution border and the first one takes focus. Nothing posts without an explicit confirmation. Extraction failure degrades to a blank form with the image attached — never to an error page.

Line items are the hardest field for every extraction tool measured, at 65 to 97 percent accuracy against 99 percent for totals. Design the review screen assuming line items will need correction, and put the total where it can be checked at a glance.

* * *

## 9. Accessibility

### 9.1 Target

WCAG 2.2 AA for the web product. AAA contrast, at 7:1, for primary status text in the field application, because consumer screens at 400 to 600 nits are effectively unreadable at Dubai daylight levels of around 80,000 lux.

No accessibility mandate binding private-sector business software in the UAE was confirmed in research. This target is chosen because the users include staff with low technical comfort, not because a regulator requires it.

### 9.2 The gaps and their fixes

| Gap | Fix |
| --- | --- |
| No focus-visible treatment in tokens | `--focus-ring` at 2 px with 2 px offset, 3:1 against both element and surface |
| Five labels across 21 screens | Every input has a visible label. Placeholder is never the label |
| Contrast never verified | Automated check across both themes in CI, covering text at 4.5:1 and chart elements at 3:1 |
| No keyboard testing | Every flow completable by keyboard, verified in the browser test suite |
| No screen-reader testing | One pass per release on the primary flows |
| Charts inaccessible | Table view toggle on every chart; legend for two or more series; texture available |
| Colour alone carries sign | Redundant symbol on every signed figure |
| Tap targets | 44 px minimum in the web product; 48 to 56 px in the field application |

### 9.3 Chart accessibility specifically

Three light-mode business-unit colours fall below 3:1 against the surface. Wherever those colours carry meaning, a visible direct label or the table view must be present. This is not a recommendation; it is the condition under which that palette passes.

* * *

## 10. Arabic and right-to-left

Deferred to Phase 4. Designed for now, so the retrofit is not expensive.

Research did not confirm a single crisp statutory citation requiring Arabic in business software. What it did establish is strong legal and market practice: Arabic is the language of UAE courts, MOHRE-registered employment contracts are typically Arabic or bilingual, and commercial documents generally need Arabic to be enforceable. Treat bilingual invoice and contract output as a credibility requirement rather than a confirmed statute.

**Design decisions to take now, cost nothing, and save weeks later**

- Use logical CSS properties throughout: `margin-inline-start`, not `margin-left`; `padding-inline`, not `padding-left` and `padding-right`. This is the single highest-leverage decision and it is free.
- No hard-coded left and right in layout. Flex and grid direction follow `dir`.
- Icons that imply direction — back, forward, trend arrows — flip; icons that do not — clock, camera, currency — never flip.
- **Numbers and money never mirror.** AED 12,400 reads left to right in an Arabic paragraph. Tabular numerals still align.
- Charts mirror their axis order; the value axis stays conventional. A time axis runs right to left in Arabic.
- Error codes rather than English strings in the domain layer, per TRD-03 ADR-013. This is the expensive part if left undone.
- Documents — invoices, contracts, statements — are bilingual before the interface is.

* * *

## 11. Field application design constraints

Phase 3, specified here so the constraints are not rediscovered.

| Constraint | Value | Reason |
| --- | --- | --- |
| Tap target | 48 to 56 px | Standard gloves reduce effective touch precision to 20 to 25 mm; capacitive gloves to 12 to 15 mm |
| Contrast, primary status text | 7:1, AAA | Consumer screens are unreadable at \~80,000 lux |
| High-contrast mode | First-class user toggle, not an accessibility setting | Field conditions change hour to hour |
| Taps to any essential action | Three maximum from the home state | Beyond that the technician calls the office instead, and the data is lost |
| Control placement | Bottom 40 percent of the screen | The other hand holds a tool or a ladder |
| Text | Minimal; icons carry primary meaning | Multilingual crews, variable literacy |
| Offline | Assumed default, not an edge case | Basements and new builds have no signal |
| Conflict | Lock on claim | Eliminates the conflict class rather than building a merge interface |

* * *

## 12. Motion

Minimal, and always interruptible.

| Use | Duration | Notes |
| --- | --- | --- |
| Hover and focus | 120 ms |  |
| Disclosure open and close | 200 ms | Height and opacity |
| Sheet and modal | 200 ms | Translate and fade |
| Toast | 200 ms in, 320 ms out |  |
| Skeleton shimmer | 1200 ms loop | Subtle |
| Chart entry | **None** | An animated chart delays reading a number |
| Number change | **None** | Counting-up animations make a figure unreadable for the duration |

Everything respects `prefers-reduced-motion: reduce` and collapses to zero.

* * *

## 13. Handoff

### 13.1 Build order

1. Tokens: focus, border and motion groups; the validated business-unit palette in both modes.
2. Primitives: Button, Field, Input, MoneyInput, Select, Table, Pagination, Modal, ConfirmDialog, Toast.
3. States: `loading.tsx` and `error.tsx` per route group; `MetricUnavailable` for section-level degradation. The skeletons already exist.
4. Navigation restructure, per section 5.
5. Exception-first dashboard, per section 6.
6. Chart primitives, per section 7, starting with stat tile, bar, line, waterfall, bullet.
7. Manual entry surfaces, per section 8.
8. Remaining chart forms: calendar heatmap, small multiples, funnel, dumbbell, Sankey.
9. Inline-style removal, one route at a time, gated on no visual diff.

### 13.2 Definition of design done

A screen ships when it has: all five states; a visible label on every input; a focus-visible treatment on every interactive element; keyboard completability; every chart carrying a conclusion and a table view; contrast verified in both themes; tap targets at 44 px minimum; and no colour carrying meaning alone.

### 13.3 What is explicitly not being changed

Density over decoration. The disclosure pattern for write forms. Query-param filters. Role-truthful rendering. The honest placeholder page. Tabular numerals. Server-rendered pages with no client-state library.

These were right. The audit found a product whose visual problems were all omissions rather than mistakes, which is a much better position to be in than the reverse.
