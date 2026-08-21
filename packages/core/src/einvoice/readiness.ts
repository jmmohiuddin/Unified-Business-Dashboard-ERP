/**
 * READINESS: what the group would be missing if the mandate started tomorrow.
 *
 * WF-05 §10.3 specifies this screen's content precisely — legal entities, TINs
 * recorded, provider appointed, B2B documents identified — and the reason it
 * is worth building two years early is that every row is a lead-time problem,
 * not a build problem. Appointing an ASP is a procurement cycle. Collecting
 * four hundred customers' tax numbers is a quarter of phone calls. Neither
 * compresses because the deadline arrived.
 *
 * EVERY COUNT IS A FRACTION, NEVER A BOOLEAN. "TINs recorded 2 of 3" tells the
 * owner both that there is a gap and how big it is; "TINs: incomplete" tells
 * them to go and count. The wireframe draws fractions throughout and that is
 * the right instinct — this screen exists to be glanced at.
 *
 * PERMISSION. Entity registration data and the group's document mix are
 * settings-grade information, so this requires `settings:read`, matching the
 * /compliance nav entry it sits under. The guard is here rather than only on
 * the page, because a screen hiding a card is not access control.
 */

import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { ForbiddenError } from "../rbac.ts";
import { eInvoiceCountdown, type EInvoiceCountdown } from "./deadline.ts";

export interface ReadinessCheck {
  key: "entities" | "tins" | "provider" | "in_scope_documents" | "buyer_tins";
  label: string;
  done: number;
  total: number;
  /**
   * `info` is not a soft pass. The B2B document count is a measurement, not a
   * target — three transmittable documents out of eight hundred is neither
   * good nor bad, it is the shape of this group's trade — and painting it green
   * would tell the owner a number is "ok" when nobody has judged it.
   */
  status: "ok" | "gap" | "info" | "none";
  detail: string;
}

export interface EInvoiceReadiness {
  countdown: EInvoiceCountdown;
  checks: ReadinessCheck[];
  /** The quarter the document counts were taken over, for the caption. */
  periodStart: string;
  periodEnd: string;
  /** True once at least one entity has an ASP recorded. */
  providerAppointed: boolean;
}

/** Calendar quarter containing `today`, as [start, endExclusive). */
export function quarterOf(today: string): { start: string; endExclusive: string; label: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const q = Math.floor((month - 1) / 3); // 0..3
  const startMonth = q * 3 + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = `${year}-${pad(startMonth)}-01`;
  const endExclusive =
    startMonth === 10 ? `${year + 1}-01-01` : `${year}-${pad(startMonth + 3)}-01`;
  return { start, endExclusive, label: `Q${q + 1} ${year}` };
}

export async function loadEInvoiceReadiness(
  tx: Tx,
  tenantId: string,
  permissions: Set<string> | "all",
  today: string,
): Promise<EInvoiceReadiness> {
  if (permissions !== "all" && !permissions.has("settings:read")) {
    throw new ForbiddenError("settings:read");
  }

  const { start, endExclusive, label } = quarterOf(today);

  const entities = await tx.execute<{
    entities: number;
    with_tin: number;
    with_provider: number;
  }>(sql`
    SELECT COUNT(*)::int AS entities,
           COUNT(tax_identification_number)::int AS with_tin,
           COUNT(einvoice_provider_key)::int AS with_provider
      FROM legal_entities
     WHERE is_active = true AND deleted_at IS NULL
  `);

  const units = await tx.execute<{ units: number; mapped: number }>(sql`
    SELECT COUNT(*)::int AS units,
           COUNT(legal_entity_id)::int AS mapped
      FROM business_units
     WHERE is_active = true AND deleted_at IS NULL
  `);

  /**
   * The document mix for the quarter.
   *
   * `direction = 'in'` is a SALES document — money coming in — which is the
   * only side that transmits: an e-invoice is issued BY the supplier, so a
   * purchase bill is somebody else's transmission, not ours.
   *
   * The scope rule is `scope.ts`'s, expressed in SQL because counting four
   * hundred documents one row at a time through a JavaScript predicate would
   * be four hundred round trips to answer a headline number. The two must
   * agree; the condition below is `documentInScope`'s organisation test and
   * nothing more, and the unit test in `einvoice.test.ts` pins the shape of
   * that rule so a change to one is a visible change to the other.
   *
   * Drafts, cancellations and voids are excluded. Nothing that was never
   * issued can be late, and counting them would make the denominator move
   * every time somebody opened a draft.
   */
  const docs = await tx.execute<{
    total: number;
    in_scope: number;
    in_scope_without_buyer_tin: number;
  }>(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE p.type = 'company')::int AS in_scope,
           COUNT(*) FILTER (WHERE p.type = 'company' AND p.tax_id_hint IS NULL)::int
             AS in_scope_without_buyer_tin
      FROM documents d
      LEFT JOIN parties p ON p.id = d.party_id
     WHERE d.direction = 'in'
       AND d.doc_type IN ('invoice', 'credit_note')
       AND d.status NOT IN ('draft', 'cancelled', 'void')
       AND d.deleted_at IS NULL
       AND d.issue_date >= ${start}::date
       AND d.issue_date < ${endExclusive}::date
  `);

  const e = entities[0] ?? { entities: 0, with_tin: 0, with_provider: 0 };
  const u = units[0] ?? { units: 0, mapped: 0 };
  const d = docs[0] ?? { total: 0, in_scope: 0, in_scope_without_buyer_tin: 0 };

  const providerAppointed = e.with_provider > 0;

  const checks: ReadinessCheck[] = [
    {
      key: "entities",
      label: "Businesses mapped to a legal entity",
      done: u.mapped,
      total: u.units,
      status: u.units === 0 ? "none" : u.mapped === u.units ? "ok" : "gap",
      detail:
        "An invoice is issued by a registered company, not by a shop floor. An unmapped business has no TIN to put on one.",
    },
    {
      key: "tins",
      label: "TINs recorded",
      done: e.with_tin,
      total: e.entities,
      status: e.entities === 0 ? "none" : e.with_tin === e.entities ? "ok" : "gap",
      detail:
        "The 15-digit TRN of each registered entity. An entity below the registration threshold legitimately has none — record which is which.",
    },
    {
      key: "provider",
      label: "Accredited provider appointed",
      done: e.with_provider,
      total: e.entities,
      status: providerAppointed ? "ok" : "gap",
      detail:
        "Nexus never connects to the network itself. The provider relationship is the compliance mechanism, and it is a procurement cycle, not a configuration change.",
    },
    {
      key: "in_scope_documents",
      label: `Documents that would transmit · ${label}`,
      done: d.in_scope,
      total: d.total,
      status: d.total === 0 ? "none" : "info",
      detail:
        "Business-to-business only. Salon walk-ins, counter sales and direct e-commerce orders keep producing a local tax invoice and are never transmitted.",
    },
    {
      key: "buyer_tins",
      label: "Business customers with a tax number on file",
      done: d.in_scope - d.in_scope_without_buyer_tin,
      total: d.in_scope,
      status:
        d.in_scope === 0 ? "none" : d.in_scope_without_buyer_tin === 0 ? "ok" : "gap",
      detail:
        "Counted over the documents that would transmit. Collected one customer at a time, which makes this the row with the longest lead time on the page.",
    },
  ];

  return {
    countdown: eInvoiceCountdown(today, providerAppointed),
    checks,
    periodStart: start,
    periodEnd: endExclusive,
    providerAppointed,
  };
}
