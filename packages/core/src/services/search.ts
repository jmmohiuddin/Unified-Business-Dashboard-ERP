import { sql, type SQL } from "drizzle-orm";
import * as M from "../money/index.ts";
import { can } from "../rbac.ts";
import { blindIndex } from "../security/pii.ts";
import { ServiceError, type ServiceContext } from "./context.ts";

/**
 * GLOBAL SEARCH — FR-P10.
 *
 * At 447 parties, 4,151 documents, 41 leases, 824 jobs and 111 cheques, the
 * only way to reach a specific record was to guess which list screen it lived
 * on and page through it. This is the one query in the product whose job is to
 * cross every module at once, which makes it the one query where a scoping
 * mistake is worth the most to an attacker and costs the most to the owner.
 *
 * Four rules govern everything below.
 *
 *  1. PERMISSION DECIDES WHICH ARMS ARE COMPILED, NOT WHICH ROWS ARE HIDDEN.
 *     A group the principal cannot read never becomes SQL. There is no
 *     post-filter over a wider result set, because a post-filter is one early
 *     `return` away from being skipped, and because the count shown next to a
 *     group heading is derived from the same query — a filtered-after-the-fact
 *     search leaks "there are 14 matches you may not see", which is itself the
 *     disclosure.
 *
 *  2. BUSINESS-UNIT SCOPE IS IN THE WHERE CLAUSE. RLS scopes by tenant and
 *     nothing else; a branch manager scoped to the salon is inside the same
 *     tenant as the parking invoices. Search is the classic place that scope
 *     is discovered to be missing, because every other screen is reached
 *     through a nav entry that was already permission-filtered and search is
 *     reached by typing. Every arm carries `businessUnitScope`, and the parties
 *     arm — the one table in the set with no `business_unit_id` — carries the
 *     `party_business_units` EXISTS that stands in for it.
 *
 *  3. ENCRYPTED IDENTIFIERS ARE MATCHED, NEVER READ. Emirates ID, passport and
 *     IBAN are ciphertext (security/pii.ts). Decrypting 447 rows to grep them
 *     would defeat the entire control, so an identity-shaped query is hashed
 *     once through the blind index and compared as an equality against the
 *     `_bidx` columns. Nothing decrypts, and no result row carries a document
 *     number, a hint or a masked tail — a hit says only that this record's
 *     registered ID matched what you typed.
 *
 *  4. ONE ROUND TRIP. The arms are UNION ALL'd into a single statement rather
 *     than issued as seven awaits inside one transaction. On a local socket
 *     the difference is noise; against Neon from a Vercel function seven
 *     sequential round trips is 30-40 ms of latency spent on nothing, and a
 *     search box that costs 800 ms is a form submission with extra steps.
 *
 * ── HOW IT IS INDEXED ───────────────────────────────────────────────────────
 *
 * `parties_search_trgm` already exists (packages/db/src/sql/rls.ts): a GIN
 * trigram index over `(display_name || ' ' || COALESCE(primary_phone,''))`.
 * The parties arm therefore matches that EXACT expression, character for
 * character, because a trigram index on an expression only serves a predicate
 * written over the same expression. Adding `OR email ILIKE …` to that arm would
 * read well and silently drop it back to a sequential scan, so email is
 * deliberately not searched here — see the note on `PARTY_SEARCHABLE`.
 *
 * The other five tables have no text index and are matched with a sequential
 * scan, which is the right answer at their present size (4,151 documents is a
 * ~2 ms scan) and the wrong answer at 100k. The report accompanying this file
 * states the measurement rather than asserting the performance.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Shape
// ════════════════════════════════════════════════════════════════════════════

export const SEARCH_GROUPS = [
  "parties",
  "documents",
  "units",
  "leases",
  "jobs",
  "cheques",
  "employees",
] as const;

export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/**
 * Why a row came back.
 *
 * Carried through to the UI because "why is this here?" is the first question
 * a search result has to answer, and because `identity` is the one value that
 * must never be accompanied by the value that matched.
 */
export type SearchMatch = "name" | "number" | "phone" | "text" | "identity";

export interface SearchHit {
  group: SearchGroup;
  id: string;
  /** The line a human scans: a document number, a unit code, a person's name. */
  title: string;
  /** The line that disambiguates two rows with the same title. */
  subtitle: string | null;
  /** Third-level context — the party on a document, the site on a unit. */
  context: string | null;
  status: string | null;
  amount: M.Money | null;
  currency: string | null;
  /** ISO date the row is "about": issue date, cheque date, lease start. */
  occurredOn: string | null;
  businessUnit: { id: string; name: string; colorToken: string } | null;
  /** Where clicking goes. Never null — every group has a reachable screen. */
  href: string;
  matchedOn: SearchMatch;
}

export interface SearchGroupResult {
  group: SearchGroup;
  label: string;
  /** Matches found, capped at `COUNT_CAP`. `capped` says which it is. */
  total: number;
  capped: boolean;
  hits: SearchHit[];
  /** The list screen that shows the rest, when one exists. */
  moreHref: string | null;
}

/**
 * What happened to the identity-document arm.
 *
 * Reported rather than hidden. `unavailable` means the PII keyring would not
 * load, which makes exact ID lookup impossible — and a search box that quietly
 * stops finding people by their Emirates ID, returning a confident "nothing
 * found", is the same failure mode as the rotation bug the keyring module's
 * header describes. The screen says so out loud instead.
 */
export type IdentityLookup = "not_attempted" | "matched" | "no_match" | "unavailable";

export interface SearchResult {
  query: string;
  groups: SearchGroupResult[];
  /** Total across every group, capped per group. */
  matched: number;
  /** Groups excluded because the principal lacks the permission. */
  denied: SearchGroup[];
  identity: IdentityLookup;
  /** Server-side query time in milliseconds. Rendered on the screen. */
  tookMs: number;
}

export interface SearchOptions {
  /** Hits returned per group. The rest are behind `moreHref`. Default 5. */
  perGroup?: number;
  /** Restrict to these groups. Anything the principal cannot read still 403s. */
  groups?: readonly SearchGroup[];
}

// ════════════════════════════════════════════════════════════════════════════
//  Policy
// ════════════════════════════════════════════════════════════════════════════

/**
 * The permission each group is gated on.
 *
 * Deliberately the permission that gates the DESTINATION SCREEN in
 * `apps/web/src/app/(app)/layout.tsx`, not the one that is merely semantically
 * closest. Search must not become a side door into a module: if a role cannot
 * see the cheque register in its navigation, typing a cheque number must not
 * hand it the register's contents one row at a time. That is why `cheques`
 * gates on `lease:read` — matching the `/rentals/cheques` nav entry — rather
 * than on `payment:read`, which several counter-staff roles hold.
 *
 * No new permission key is introduced. A `search:read` would have to be added
 * to the catalogue and granted to sixteen roles before anybody could use the
 * feature at all, which is the "control that can never fire" shape wave 2 shipped.
 */
const GROUP_PERMISSION: Record<SearchGroup, string> = {
  parties: "party:read",
  documents: "document:read",
  units: "unit:read",
  leases: "lease:read",
  jobs: "job:read",
  cheques: "lease:read",
  employees: "employee:read",
};

const GROUP_LABEL: Record<SearchGroup, string> = {
  parties: "People and companies",
  documents: "Invoices and bills",
  units: "Units",
  leases: "Leases",
  jobs: "Service jobs",
  cheques: "Cheques",
  employees: "Employees",
};

/**
 * Where "see all N" goes.
 *
 * `/crm` is the only list screen in the product that reads a free-text `q`
 * parameter, so it is the only one that can honestly carry the query through.
 * The others get their plain list route, and the caller appends nothing — a
 * link that drops a `?q=` on a screen that ignores it looks like a filter and
 * behaves like a reset.
 */
const GROUP_MORE_HREF: Record<SearchGroup, ((q: string) => string) | null> = {
  parties: (q) => `/crm?q=${encodeURIComponent(q)}`,
  documents: () => "/receivables",
  units: () => "/rentals",
  leases: () => "/rentals",
  jobs: () => "/services",
  cheques: () => "/rentals/cheques",
  employees: null,
};

/**
 * Shortest query that runs.
 *
 * Two characters, not one. A single character matches a third of the database,
 * returns the cap, and tells the user nothing — and with pg_trgm a pattern
 * shorter than three characters cannot use the trigram index at all, so it is
 * also the most expensive possible query. Two is the floor because unit codes
 * are two characters ("8B") and refusing those would break the wireframe's own
 * example.
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * How far each arm counts before giving up on an exact total.
 *
 * The count beside a group heading comes from `count(*) OVER ()`, which is
 * computed over every matching row before the LIMIT — so an uncapped arm would
 * make a one-letter query scan and materialise the whole table just to render
 * the number 4,151. Capping the inner scan bounds that work; `capped` on the
 * result says "500+" rather than pretending 500 is the answer.
 */
const COUNT_CAP = 500;

const DEFAULT_PER_GROUP = 5;
const MAX_PER_GROUP = 25;

// ════════════════════════════════════════════════════════════════════════════
//  Predicates
// ════════════════════════════════════════════════════════════════════════════

/**
 * Business-unit scope as a SQL predicate, mirroring `canAccessBusinessUnit`.
 *
 * Three cases and all three matter:
 *   scope "tenant"      — every business, no predicate.
 *   businessUnitIds []  — FALSE. A scoped membership with no businesses granted
 *                         sees nothing, which is correct and is NOT the same as
 *                         "no filter". An empty array also interpolates to `()`,
 *                         a syntax error, so it has to be handled before the
 *                         ANY() is built rather than inside it.
 *   otherwise           — ANY(ARRAY[…]).
 *
 * The same helper exists privately in `rentals.ts`; it is duplicated rather
 * than shared because promoting it means editing `context.ts`, which several
 * agents hold open this wave. Flagged in the report for consolidation.
 */
function businessUnitScope(ctx: ServiceContext, column: SQL): SQL {
  if (ctx.principal.scope === "tenant") return sql`TRUE`;
  const allowed = ctx.principal.businessUnitIds;
  if (allowed === null) return sql`TRUE`;
  if (allowed.length === 0) return sql`FALSE`;
  return sql`${column} = ANY(ARRAY[${sql.join(
    allowed.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}])`;
}

/**
 * Parties have no `business_unit_id`, by design.
 *
 * One human is routinely a salon customer, the tenant in flat 4B and a
 * subcontractor, so the party row is tenant-level and `party_business_units`
 * carries the relationships. Scope therefore has to be an EXISTS over that
 * table, and the consequence is worth stating plainly: a party with no
 * `party_business_units` row at all is invisible to every scoped user and
 * visible only tenant-wide. That is the safe direction — a lead nobody has
 * linked to a business is not a salon record — but it does mean the scoped
 * count is lower than "all parties who ever transacted with my branch" if the
 * link table is ever left unpopulated.
 */
function partyScope(ctx: ServiceContext): SQL {
  if (ctx.principal.scope === "tenant") return sql`TRUE`;
  const allowed = ctx.principal.businessUnitIds;
  if (allowed === null) return sql`TRUE`;
  if (allowed.length === 0) return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1 FROM party_business_units pbu
     WHERE pbu.party_id = p.id
       AND ${businessUnitScope(ctx, sql`pbu.business_unit_id`)}
  )`;
}

/**
 * The expression `parties_search_trgm` is built over.
 *
 * Kept as one constant so the index and the predicate cannot drift apart in a
 * later edit — the failure mode is silent, since a mismatched expression still
 * returns the right rows, just via a sequential scan that nobody notices until
 * the table is large.
 */
const PARTY_SEARCHABLE = sql`(p.display_name || ' ' || COALESCE(p.primary_phone, ''))`;

/** LIKE metacharacters are escaped so a typed `%` searches for a percent sign. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Could this be an identity document rather than a name?
 *
 * Deliberately loose. A false positive costs one equality against an indexed
 * `_bidx` column and returns nothing; a false negative means the owner types a
 * tenant's Emirates ID and is told the person does not exist. The Emirates ID
 * format (784-YYYY-NNNNNNN-N) survives `normalise` in pii.ts as fifteen
 * digits, and passports are six to twelve alphanumerics.
 */
function looksLikeIdentity(term: string): boolean {
  const bare = term.replace(/[\s\-/._]/g, "");
  if (bare.length < 6 || bare.length > 20) return false;
  return /^[0-9]{6,20}$/.test(bare) || /^[A-Za-z]{1,2}[0-9]{5,12}$/.test(bare);
}

// ════════════════════════════════════════════════════════════════════════════
//  Row shape
// ════════════════════════════════════════════════════════════════════════════

// A `type` rather than an `interface` on purpose: `tx.execute<T>` constrains T
// to `Record<string, unknown>`, and only a type alias gets the implicit index
// signature that satisfies it. Every other row shape in `services/` is written
// the same way for the same reason.
type RawHit = {
  grp: string;
  id: string;
  title: string;
  subtitle: string | null;
  context: string | null;
  status: string | null;
  amount: string | null;
  currency: string | null;
  occurred_on: string | null;
  bu_id: string | null;
  bu_name: string | null;
  bu_color: string | null;
  href: string;
  matched_on: string;
  grp_total: string;
};

/**
 * Wrap one arm's matcher in the ranking, counting and limiting layers.
 *
 * The window functions sit BETWEEN the capped scan and the per-group limit on
 * purpose: `count(*) OVER ()` has to see every matched row to produce the
 * group total, and `row_number()` has to order them before the outer LIMIT
 * throws the tail away. Doing either in the wrong layer gives a count of 5.
 */
function arm(inner: SQL, perGroup: number): SQL {
  return sql`
    SELECT grp, id, title, subtitle, context, status, amount, currency,
           occurred_on, bu_id, bu_name, bu_color, href, matched_on, grp_total
      FROM (
        SELECT m.*,
               count(*) OVER () AS grp_total,
               row_number() OVER (
                 ORDER BY m.rank, m.sort_key DESC NULLS LAST, m.title
               ) AS rn
          FROM (${inner} LIMIT ${COUNT_CAP}) m
      ) z
     WHERE rn <= ${perGroup}
  `;
}

// ════════════════════════════════════════════════════════════════════════════
//  The arms
// ════════════════════════════════════════════════════════════════════════════

interface Patterns {
  /** `%term%`, LIKE-escaped. */
  contains: string;
  /** `term%`, LIKE-escaped. */
  prefix: string;
  /** The raw trimmed term, lower-cased, for equality. */
  exact: string;
  /** Blind index of the term, or null when it is not identity-shaped. */
  bidx: string | null;
}

function partiesArm(ctx: ServiceContext, p: Patterns): SQL {
  // The identity predicate is a separate OR arm rather than being folded into
  // the trigram expression: it is an equality on `parties_national_id_bidx`,
  // and the planner picks it up as a second bitmap branch.
  const identity = p.bidx ? sql`OR p.national_id_bidx = ${p.bidx}` : sql``;
  return sql`
    SELECT 'parties'::text                                   AS grp,
           p.id::text                                        AS id,
           p.display_name::text                              AS title,
           NULLIF(concat_ws(' · ',
             CASE WHEN p.is_tenant_renter THEN 'Tenant' END,
             CASE WHEN p.is_customer THEN 'Customer' END,
             CASE WHEN p.is_supplier THEN 'Supplier' END,
             CASE WHEN p.is_employee_party THEN 'Staff' END), '')::text AS subtitle,
           -- The phone is operational contact data and is already searchable;
           -- no encrypted identifier appears here, and none may be added.
           p.primary_phone::text                             AS context,
           NULL::text                                        AS status,
           NULLIF(p.open_balance, 0)::text                   AS amount,
           COALESCE(p.currency, ${ctx.baseCurrency})::text    AS currency,
           NULL::text                                        AS occurred_on,
           NULL::text                                        AS bu_id,
           NULL::text                                        AS bu_name,
           NULL::text                                        AS bu_color,
           '/crm'::text                                      AS href,
           CASE
             WHEN ${p.bidx ? sql`p.national_id_bidx = ${p.bidx}` : sql`FALSE`} THEN 'identity'
             WHEN p.primary_phone ILIKE ${p.contains} THEN 'phone'
             ELSE 'name'
           END::text                                         AS matched_on,
           CASE
             WHEN ${p.bidx ? sql`p.national_id_bidx = ${p.bidx}` : sql`FALSE`} THEN 0
             WHEN lower(p.display_name) = ${p.exact} THEN 1
             WHEN p.display_name ILIKE ${p.prefix} THEN 2
             WHEN p.display_name ILIKE ${p.contains} THEN 3
             ELSE 4
           END                                               AS rank,
           to_char(p.last_transaction_at, 'YYYY-MM-DD')::text AS sort_key
      FROM parties p
     WHERE p.deleted_at IS NULL
       AND ${partyScope(ctx)}
       AND (${PARTY_SEARCHABLE} ILIKE ${p.contains} ${identity})
  `;
}

function documentsArm(ctx: ServiceContext, p: Patterns): SQL {
  return sql`
    SELECT 'documents'::text                                 AS grp,
           d.id::text                                        AS id,
           d.doc_number::text                                AS title,
           (CASE d.doc_type::text
              WHEN 'invoice' THEN 'Invoice'
              WHEN 'bill' THEN 'Bill'
              WHEN 'credit_note' THEN 'Credit note'
              ELSE d.doc_type::text
            END || ' · ' || to_char(d.issue_date, 'DD Mon YYYY'))::text AS subtitle,
           COALESCE(d.party_name_snapshot, pa.display_name)::text AS context,
           d.status::text                                    AS status,
           d.total::text                                     AS amount,
           d.currency::text                                  AS currency,
           d.issue_date::text                                AS occurred_on,
           b.id::text                                        AS bu_id,
           b.name::text                                      AS bu_name,
           b.color_token::text                               AS bu_color,
           (CASE WHEN d.direction = 'in' THEN '/receivables' ELSE '/purchases' END)::text AS href,
           CASE WHEN d.doc_number ILIKE ${p.contains} THEN 'number' ELSE 'name' END::text AS matched_on,
           CASE
             WHEN lower(d.doc_number) = ${p.exact} THEN 0
             WHEN d.doc_number ILIKE ${p.prefix} THEN 1
             WHEN d.doc_number ILIKE ${p.contains} THEN 2
             ELSE 3
           END                                               AS rank,
           d.issue_date::text                                AS sort_key
      FROM documents d
      JOIN business_units b ON b.id = d.business_unit_id
      LEFT JOIN parties pa ON pa.id = d.party_id
     WHERE d.deleted_at IS NULL
       AND d.doc_type IN ('invoice', 'bill', 'credit_note')
       AND ${businessUnitScope(ctx, sql`d.business_unit_id`)}
       AND (d.doc_number ILIKE ${p.contains}
            OR d.party_name_snapshot ILIKE ${p.contains})
  `;
}

function unitsArm(ctx: ServiceContext, p: Patterns): SQL {
  // "marina 1204" in the wireframe is a site name and a unit code typed as one
  // string, so the match runs over the concatenation rather than either column.
  const searchable = sql`(s.name || ' ' || u.code || ' ' || COALESCE(u.name, '') || ' ' || COALESCE(s.area, ''))`;
  return sql`
    SELECT 'units'::text                                     AS grp,
           u.id::text                                        AS id,
           (s.name || ' · ' || u.code)::text                 AS title,
           (COALESCE(u.name, replace(u.kind::text, '_', ' ')))::text AS subtitle,
           COALESCE(s.area, s.city)::text                    AS context,
           u.status::text                                    AS status,
           NULLIF(u.list_rent, 0)::text                      AS amount,
           ${ctx.baseCurrency}::text                          AS currency,
           NULL::text                                        AS occurred_on,
           b.id::text                                        AS bu_id,
           b.name::text                                      AS bu_name,
           b.color_token::text                               AS bu_color,
           '/rentals'::text                                  AS href,
           CASE WHEN u.code ILIKE ${p.contains} THEN 'number' ELSE 'name' END::text AS matched_on,
           CASE
             WHEN lower(u.code) = ${p.exact} THEN 0
             WHEN u.code ILIKE ${p.prefix} THEN 1
             WHEN s.name ILIKE ${p.prefix} THEN 2
             ELSE 3
           END                                               AS rank,
           NULL::text                                        AS sort_key
      FROM units u
      JOIN sites s ON s.id = u.site_id
      JOIN business_units b ON b.id = u.business_unit_id
     WHERE u.deleted_at IS NULL
       AND ${businessUnitScope(ctx, sql`u.business_unit_id`)}
       AND ${searchable} ILIKE ${p.contains}
  `;
}

function leasesArm(ctx: ServiceContext, p: Patterns): SQL {
  return sql`
    SELECT 'leases'::text                                    AS grp,
           l.id::text                                        AS id,
           l.lease_number::text                              AS title,
           (s.name || ' · ' || u.code)::text                 AS subtitle,
           pa.display_name::text                             AS context,
           l.status::text                                    AS status,
           NULLIF(l.annual_rent, 0)::text                    AS amount,
           ${ctx.baseCurrency}::text                          AS currency,
           l.starts_on::text                                 AS occurred_on,
           b.id::text                                        AS bu_id,
           b.name::text                                      AS bu_name,
           b.color_token::text                               AS bu_color,
           ('/rentals/lease/' || l.id::text)::text           AS href,
           CASE
             WHEN l.lease_number ILIKE ${p.contains} THEN 'number'
             WHEN l.ejari_number ILIKE ${p.contains} THEN 'number'
             ELSE 'name'
           END::text                                         AS matched_on,
           CASE
             WHEN lower(l.lease_number) = ${p.exact} THEN 0
             WHEN l.lease_number ILIKE ${p.prefix} THEN 1
             WHEN l.ejari_number ILIKE ${p.contains} THEN 2
             ELSE 3
           END                                               AS rank,
           l.starts_on::text                                 AS sort_key
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN sites s ON s.id = u.site_id
      JOIN parties pa ON pa.id = l.party_id
      JOIN business_units b ON b.id = l.business_unit_id
     WHERE l.deleted_at IS NULL
       AND ${businessUnitScope(ctx, sql`l.business_unit_id`)}
       AND (l.lease_number ILIKE ${p.contains}
            OR l.ejari_number ILIKE ${p.contains}
            OR pa.display_name ILIKE ${p.contains}
            OR (s.name || ' ' || u.code) ILIKE ${p.contains})
  `;
}

function jobsArm(ctx: ServiceContext, p: Patterns): SQL {
  return sql`
    SELECT 'jobs'::text                                      AS grp,
           j.id::text                                        AS id,
           (j.job_number || ' · ' || j.title)::text          AS title,
           (replace(j.service_kind, '_', ' ') || ' · ' ||
            to_char(j.reported_at, 'DD Mon YYYY'))::text     AS subtitle,
           COALESCE(pa.display_name, s.name)::text           AS context,
           j.status::text                                    AS status,
           COALESCE(NULLIF(j.invoiced_value, 0), j.quoted_value)::text AS amount,
           ${ctx.baseCurrency}::text                          AS currency,
           to_char(j.reported_at, 'YYYY-MM-DD')::text        AS occurred_on,
           b.id::text                                        AS bu_id,
           b.name::text                                      AS bu_name,
           b.color_token::text                               AS bu_color,
           '/services'::text                                 AS href,
           CASE WHEN j.job_number ILIKE ${p.contains} THEN 'number' ELSE 'text' END::text AS matched_on,
           CASE
             WHEN lower(j.job_number) = ${p.exact} THEN 0
             WHEN j.job_number ILIKE ${p.prefix} THEN 1
             WHEN j.title ILIKE ${p.prefix} THEN 2
             ELSE 3
           END                                               AS rank,
           to_char(j.reported_at, 'YYYY-MM-DD')::text        AS sort_key
      FROM jobs j
      JOIN business_units b ON b.id = j.business_unit_id
      LEFT JOIN parties pa ON pa.id = j.party_id
      LEFT JOIN sites s ON s.id = j.site_id
     WHERE j.deleted_at IS NULL
       AND ${businessUnitScope(ctx, sql`j.business_unit_id`)}
       AND (j.job_number ILIKE ${p.contains}
            OR j.title ILIKE ${p.contains}
            OR pa.display_name ILIKE ${p.contains})
  `;
}

function chequesArm(ctx: ServiceContext, p: Patterns): SQL {
  return sql`
    SELECT 'cheques'::text                                   AS grp,
           c.id::text                                        AS id,
           ('CHQ ' || c.cheque_number)::text                 AS title,
           (COALESCE(c.bank_name, 'Bank not recorded') || ' · ' ||
            to_char(c.cheque_date, 'DD Mon YYYY'))::text     AS subtitle,
           COALESCE(c.drawer_name, pa.display_name)::text    AS context,
           c.status::text                                    AS status,
           c.amount::text                                    AS amount,
           c.currency::text                                  AS currency,
           c.cheque_date::text                               AS occurred_on,
           b.id::text                                        AS bu_id,
           b.name::text                                      AS bu_name,
           b.color_token::text                               AS bu_color,
           '/rentals/cheques'::text                          AS href,
           CASE WHEN c.cheque_number ILIKE ${p.contains} THEN 'number' ELSE 'name' END::text AS matched_on,
           CASE
             WHEN lower(c.cheque_number) = ${p.exact} THEN 0
             WHEN c.cheque_number ILIKE ${p.prefix} THEN 1
             WHEN c.cheque_number ILIKE ${p.contains} THEN 2
             ELSE 3
           END                                               AS rank,
           c.cheque_date::text                               AS sort_key
      FROM cheques c
      JOIN business_units b ON b.id = c.business_unit_id
      LEFT JOIN parties pa ON pa.id = c.party_id
     WHERE c.deleted_at IS NULL
       AND ${businessUnitScope(ctx, sql`c.business_unit_id`)}
       AND (c.cheque_number ILIKE ${p.contains}
            OR c.drawer_name ILIKE ${p.contains}
            OR c.bank_name ILIKE ${p.contains})
  `;
}

function employeesArm(ctx: ServiceContext, p: Patterns): SQL {
  /**
   * Employees are scoped on their PRIMARY business unit only, not on their
   * `employee_assignments`. The stricter of the two readings: the employment
   * record — salary, gratuity accrual, visa expiry — belongs to the home
   * business, and a salon manager who borrows a technician for a week has no
   * claim on that technician's HR record.
   *
   * The two blind-index columns are compared, never selected. There is no
   * `emirates_id_hint` in this projection and there must not be one: a masked
   * tail on a global search screen is an identity document leaking one screen
   * at a time to anyone who holds `employee:read`.
   */
  const identity = p.bidx
    ? sql`OR e.emirates_id_bidx = ${p.bidx} OR e.passport_number_bidx = ${p.bidx}`
    : sql``;
  const identityHit = p.bidx
    ? sql`(e.emirates_id_bidx = ${p.bidx} OR e.passport_number_bidx = ${p.bidx})`
    : sql`FALSE`;
  return sql`
    SELECT 'employees'::text                                 AS grp,
           e.id::text                                        AS id,
           e.full_name::text                                 AS title,
           COALESCE(e.designation, e.employee_code)::text    AS subtitle,
           e.employee_code::text                             AS context,
           e.status::text                                    AS status,
           NULL::text                                        AS amount,
           NULL::text                                        AS currency,
           e.joined_on::text                                 AS occurred_on,
           b.id::text                                        AS bu_id,
           b.name::text                                      AS bu_name,
           b.color_token::text                               AS bu_color,
           '/hr/gratuity'::text                              AS href,
           CASE
             WHEN ${identityHit} THEN 'identity'
             WHEN e.phone ILIKE ${p.contains} THEN 'phone'
             WHEN e.employee_code ILIKE ${p.contains} THEN 'number'
             ELSE 'name'
           END::text                                         AS matched_on,
           CASE
             WHEN ${identityHit} THEN 0
             WHEN lower(e.full_name) = ${p.exact} THEN 1
             WHEN e.full_name ILIKE ${p.prefix} THEN 2
             ELSE 3
           END                                               AS rank,
           e.joined_on::text                                 AS sort_key
      FROM employees e
      JOIN business_units b ON b.id = e.primary_business_unit_id
     WHERE e.deleted_at IS NULL
       AND ${businessUnitScope(ctx, sql`e.primary_business_unit_id`)}
       AND (e.full_name ILIKE ${p.contains}
            OR e.employee_code ILIKE ${p.contains}
            OR e.designation ILIKE ${p.contains}
            OR e.phone ILIKE ${p.contains}
            ${identity})
  `;
}

const ARM_BUILDERS: Record<SearchGroup, (ctx: ServiceContext, p: Patterns) => SQL> = {
  parties: partiesArm,
  documents: documentsArm,
  units: unitsArm,
  leases: leasesArm,
  jobs: jobsArm,
  cheques: chequesArm,
  employees: employeesArm,
};

/**
 * Order groups get rendered in when their best hits are equally good.
 *
 * A tie-break only. The primary ordering is "which group holds the strongest
 * match", so typing an invoice number puts documents first and typing a
 * building name puts units first, without either being hard-coded.
 */
const GROUP_PRIORITY: SearchGroup[] = [
  "parties",
  "documents",
  "units",
  "leases",
  "cheques",
  "jobs",
  "employees",
];

// ════════════════════════════════════════════════════════════════════════════
//  Entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * Search everything the principal is allowed to see.
 *
 * Returns an empty result — not an error — for a query below
 * `MIN_QUERY_LENGTH`, because "type two characters" is a state of the search
 * box, not a failure. Throws `forbidden` only when the principal can read NONE
 * of the seven groups, which is a genuine permission-denied screen rather than
 * a search that found nothing.
 */
export async function search(
  ctx: ServiceContext,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const startedAt = Date.now();
  const query = rawQuery.trim().replace(/\s+/g, " ");

  const perGroup = Math.min(
    Math.max(1, Math.trunc(options.perGroup ?? DEFAULT_PER_GROUP)),
    MAX_PER_GROUP,
  );

  const requested = options.groups ?? SEARCH_GROUPS;
  const allowed = requested.filter((g) => can(ctx.principal, GROUP_PERMISSION[g]));
  const denied = requested.filter((g) => !can(ctx.principal, GROUP_PERMISSION[g]));

  // Every group refused: this principal cannot search at all. Distinguished
  // from "found nothing" so the screen can name the permissions involved
  // instead of implying the database is empty.
  if (allowed.length === 0) {
    throw new ServiceError(
      "You do not have permission to search any of the records this box covers.",
      "forbidden",
    );
  }

  if (query.length < MIN_QUERY_LENGTH) {
    return {
      query,
      groups: [],
      matched: 0,
      denied,
      identity: "not_attempted",
      tookMs: Date.now() - startedAt,
    };
  }

  // Blind index, computed ONCE in the application and sent as a parameter.
  // A keyring that will not load is reported, not swallowed: exact lookup by
  // Emirates ID silently returning zero rows is indistinguishable from the
  // person not existing.
  let bidx: string | null = null;
  let identity: IdentityLookup = "not_attempted";
  if (looksLikeIdentity(query)) {
    try {
      bidx = blindIndex(query);
      identity = "no_match";
    } catch {
      identity = "unavailable";
    }
  }

  const escaped = escapeLike(query);
  const patterns: Patterns = {
    contains: `%${escaped}%`,
    prefix: `${escaped}%`,
    exact: query.toLowerCase(),
    bidx,
  };

  const statement = sql.join(
    allowed.map((g) => arm(ARM_BUILDERS[g](ctx, patterns), perGroup)),
    sql` UNION ALL `,
  );

  const rows = await ctx.tx.execute<RawHit>(statement);

  const byGroup = new Map<SearchGroup, { total: number; hits: SearchHit[] }>();
  for (const row of rows) {
    const group = row.grp as SearchGroup;
    const total = Number(row.grp_total); // money-guard-ignore: a row count from count(*) OVER (), not an amount
    const bucket = byGroup.get(group) ?? { total, hits: [] };
    if (row.matched_on === "identity") identity = "matched";
    bucket.hits.push({
      group,
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      context: row.context,
      status: row.status,
      amount: row.amount === null ? null : M.fromDb(row.amount),
      currency: row.currency,
      occurredOn: row.occurred_on,
      businessUnit:
        row.bu_id && row.bu_name
          ? { id: row.bu_id, name: row.bu_name, colorToken: row.bu_color ?? "slate" }
          : null,
      // `/crm` is the one list screen that reads a free-text `q`, and the term
      // it wants is the party's own name rather than what was typed — searching
      // "marina" and landing on a customer list still filtered to "marina" hides
      // the row the user just clicked. Encoded here rather than in SQL because
      // Postgres has no URL encoder and `replace(name,' ','+')` is not one.
      href: group === "parties" ? `/crm?q=${encodeURIComponent(row.title)}` : row.href,
      matchedOn: row.matched_on as SearchMatch,
    });
    byGroup.set(group, bucket);
  }

  const groups: SearchGroupResult[] = [...byGroup.entries()]
    .map(([group, bucket]) => ({
      group,
      label: GROUP_LABEL[group],
      total: bucket.total,
      capped: bucket.total >= COUNT_CAP,
      hits: bucket.hits,
      moreHref:
        bucket.total > bucket.hits.length
          ? (GROUP_MORE_HREF[group]?.(query) ?? null)
          : null,
    }))
    .sort((a, b) => {
      const rank = (g: SearchGroupResult) =>
        g.hits[0]?.matchedOn === "identity" ? 0 : g.hits[0]?.matchedOn === "number" ? 1 : 2;
      return rank(a) - rank(b) || GROUP_PRIORITY.indexOf(a.group) - GROUP_PRIORITY.indexOf(b.group);
    });

  return {
    query,
    groups,
    matched: groups.reduce((n, g) => n + g.total, 0),
    denied,
    identity,
    tookMs: Date.now() - startedAt,
  };
}
