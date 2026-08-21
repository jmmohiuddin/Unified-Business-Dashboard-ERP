import { sql } from "drizzle-orm";
import { requirePermission, ServiceError, type ServiceContext } from "../services/context.ts";
import { security } from "./events.ts";

/**
 * RIGHT TO ERASURE — and the reason it cannot simply be `DELETE`.
 *
 * UAE PDPL (Federal Decree-Law 45/2021) art. 15 gives a data subject the right
 * to have their personal data erased. This is the governing regime here: the
 * controller is in Dubai and the data subjects are in the UAE. GDPR art. 17 is
 * the analogous right for any EU customer and the mechanics below satisfy both,
 * but PDPL is the one that binds.
 *
 * PDPL also carves out data the controller is legally required to retain — and
 * UAE tax law requires invoices and their supporting records to be kept for
 * five years (fifteen for real-estate records).
 *
 * Those two obligations look contradictory and are not. The resolution:
 *
 *   ERASE the identifying data — name, phone, email, address, Emirates ID.
 *   KEEP  the transaction — amounts, dates, VAT, the document number.
 *
 * So this is PSEUDONYMISATION, not deletion. The invoice survives with a
 * tombstoned counterparty; the person becomes unidentifiable. Deleting the
 * invoice instead would unbalance the ledger, break the VAT return for a filed
 * period, and expose the business to a tax penalty for destroying records —
 * a worse outcome for everyone including the data subject.
 *
 * This function refuses to run on anyone with live obligations, because erasing
 * a tenant mid-lease or a customer with an unpaid balance destroys the evidence
 * the business needs to enforce its own contract.
 *
 * ── AUTHORISATION ───────────────────────────────────────────────────────────
 *
 * Every function here takes a `ServiceContext` and checks a permission, for the
 * same reason every other mutation in the product does. Erasure previously took
 * the actor as a plain `{ userId, roleKey }` parameter with no check at all, and
 * its only caller passed a hardcoded `owner@sumon.test` looked up by email — so
 * the audit record and the `data.erased` security event named the seeded owner
 * regardless of who actually ran it. An accountability record that is wrong by
 * construction is worse than none, because it will be believed.
 *
 * The actor now comes from `ctx.principal` and cannot be supplied by the caller.
 */

/** How long labour and payroll records must be kept after employment ends.
 *
 *  MOHRE requires the personnel file for two years after the end of service
 *  (Cabinet Resolution 1/2022 art. 16); payroll feeds the ledger, so the FTA's
 *  five-year record-keeping obligation (Federal Decree-Law 28/2022) is the
 *  binding one. Erasure before this date would destroy records the business is
 *  required to be able to produce. */
export const EMPLOYEE_RETENTION_YEARS = 5;

export interface ErasureAssessment {
  canErase: boolean;
  blockers: string[];
  willRetain: { table: string; rows: number; reason: string }[];
  willErase: string[];
  /** Set when the subject is or was an employee, so a caller can explain the
   *  extra permission and the extra columns rather than just refusing. */
  employee?: {
    status: string;
    leftOn: string | null;
    /** The date the labour-record retention period expires, if it can be
     *  computed. Null when no leaving date has been recorded. */
    retainUntil: string | null;
    retentionExpired: boolean;
  };
}

/** `left_on` plus the retention period, ISO. */
function retentionEnd(leftOn: string): string {
  const d = new Date(`${leftOn}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + EMPLOYEE_RETENTION_YEARS);
  return d.toISOString().slice(0, 10);
}

const EMPLOYED_STATUSES = ["applicant", "probation", "active", "on_leave", "suspended"];

/**
 * What would happen, without doing it.
 *
 * Read-only, but gated on `party:read` all the same: the blocker list discloses
 * outstanding balances and employment status for a named person, which is not
 * information an unauthenticated or unauthorised caller should be able to pull.
 */
export async function assessErasure(
  ctx: ServiceContext,
  partyId: string,
): Promise<ErasureAssessment> {
  requirePermission(ctx, "party:read");

  const [row] = await ctx.tx.execute<{
    display_name: string; open_balance: string; active_leases: number;
    open_jobs: number; invoices: number; employee_status: string | null;
    employee_left_on: string | null;
  }>(sql`
    SELECT p.display_name, p.open_balance,
           (SELECT COUNT(*)::int FROM leases l
             WHERE l.party_id = p.id AND l.status = 'active') AS active_leases,
           (SELECT COUNT(*)::int FROM jobs j
             WHERE j.party_id = p.id
               AND j.status NOT IN ('completed','invoiced','cancelled')) AS open_jobs,
           (SELECT COUNT(*)::int FROM documents d WHERE d.party_id = p.id) AS invoices,
           (SELECT e.status::text FROM employees e WHERE e.party_id = p.id
             ORDER BY e.created_at DESC LIMIT 1) AS employee_status,
           (SELECT e.left_on::text FROM employees e WHERE e.party_id = p.id
             ORDER BY e.created_at DESC LIMIT 1) AS employee_left_on
      FROM parties p WHERE p.id = ${partyId}::uuid
  `);

  if (!row) return { canErase: false, blockers: ["No such record."], willRetain: [], willErase: [] };

  const blockers: string[] = [];
  if (Number(row.open_balance) > 0.01) {
    blockers.push(
      `Outstanding balance of ${Number(row.open_balance).toFixed(2)} — settle or write off first.`,
    );
  }
  if (row.active_leases > 0) {
    blockers.push(`${row.active_leases} active lease(s) — end the tenancy first.`);
  }
  if (row.open_jobs > 0) {
    blockers.push(`${row.open_jobs} open service job(s).`);
  }

  /**
   * The employee path.
   *
   * "This person is an employee" used to be a flat, permanent blocker with no
   * alternative — so an Emirates ID, passport, visa, labour card and IBAN
   * belonging to someone who left the company a decade ago could never be
   * erased, and the right did not exist for them at all. A retention obligation
   * has an end date; a refusal that ignores it is not compliance, it is
   * indefinite retention wearing compliance as a excuse.
   *
   * So it is a blocker only while it is true: still employed, or still inside
   * the statutory window after leaving.
   */
  let employee: ErasureAssessment["employee"];
  if (row.employee_status) {
    const leftOn = row.employee_left_on;
    const retainUntil = leftOn ? retentionEnd(leftOn) : null;
    const retentionExpired = retainUntil !== null && ctx.today >= retainUntil;
    employee = { status: row.employee_status, leftOn, retainUntil, retentionExpired };

    if (EMPLOYED_STATUSES.includes(row.employee_status)) {
      blockers.push(
        `This person is a current employee (${row.employee_status}) — labour records ` +
          "must be retained while employment continues.",
      );
    } else if (!leftOn) {
      blockers.push(
        "This person is a former employee with no leaving date recorded, so the " +
          "retention period cannot be computed. Set the leaving date first.",
      );
    } else if (!retentionExpired) {
      blockers.push(
        `Labour and payroll records must be retained until ${retainUntil} ` +
          `(${EMPLOYEE_RETENTION_YEARS} years after ${leftOn}).`,
      );
    }
  }

  const willErase = [
    "Name, phone, WhatsApp, email",
    "Address and city",
    "Emirates ID / national ID (encrypted value and blind index)",
    "Tax identifier",
    "Free-text notes and tags",
    "Communication history bodies",
  ];
  if (employee?.retentionExpired) {
    willErase.push(
      "Employee record: name, contact, nationality, emergency contact, home location",
      "Employee identity documents (Emirates ID, passport, visa, labour card) and IBAN",
      "WPS person and routing identifiers",
    );
  }

  return {
    canErase: blockers.length === 0,
    blockers,
    willRetain: [
      {
        table: "documents",
        rows: row.invoices,
        reason: "Tax invoices must be retained for 5 years under UAE VAT law.",
      },
      {
        table: "journal_lines",
        rows: 0,
        reason: "Ledger entries are immutable; deleting them would unbalance filed periods.",
      },
      ...(employee
        ? [{
            table: "employees",
            rows: 1,
            reason:
              "Employee code, service dates, salary and gratuity figures are retained — " +
              "they are payroll evidence and the basis of the end-of-service provision.",
          }]
        : []),
    ],
    willErase,
    ...(employee ? { employee } : {}),
  };
}

export interface ErasureResult {
  partyId: string;
  pseudonym: string;
  documentsRetained: number;
  interactionsRedacted: number;
  employeeRecordsErased: number;
}

/**
 * Execute the erasure.
 *
 * The blind index is cleared too — leaving it would allow anyone who guesses an
 * Emirates ID to confirm the person was once a customer, which defeats the
 * purpose entirely.
 *
 * Requires `party:delete`, and additionally `employee:delete` when the subject
 * has an employee record whose retention period has expired: erasing HR data is
 * an HR decision, and the two permissions are held by different roles.
 */
export async function erasePartyPii(
  ctx: ServiceContext,
  partyId: string,
  reason: string,
): Promise<ErasureResult> {
  requirePermission(ctx, "party:delete");

  const assessment = await assessErasure(ctx, partyId);
  if (!assessment.canErase) {
    throw new ServiceError(`Cannot erase: ${assessment.blockers.join(" ")}`, "invalid");
  }
  const eraseEmployee = assessment.employee?.retentionExpired === true;
  if (eraseEmployee) requirePermission(ctx, "employee:delete");

  const { tx, tenantId } = ctx;

  // A stable, non-reversible label so the retained invoices still read
  // sensibly — "Erased customer #a3f1" rather than an empty cell.
  const pseudonym = `Erased customer #${partyId.slice(0, 8)}`;

  const [docs] = await tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int n FROM documents WHERE party_id = ${partyId}::uuid
  `);

  await tx.execute(sql`
    UPDATE parties
       SET display_name = ${pseudonym},
           legal_name = NULL,
           primary_phone = NULL, whatsapp = NULL, email = NULL,
           national_id_enc = NULL, national_id_bidx = NULL, national_id_hint = NULL,
           tax_id_enc = NULL, tax_id_hint = NULL,
           address_line = NULL, city = NULL, birthday = NULL,
           notes = NULL, tags = '[]'::jsonb,
           is_credit_blocked = true,
           updated_at = now()
     WHERE id = ${partyId}::uuid
  `);

  // The snapshot on historical documents carried the name forward on purpose;
  // it has to be overwritten too or the erasure is cosmetic.
  await tx.execute(sql`
    UPDATE documents SET party_name_snapshot = ${pseudonym}
     WHERE party_id = ${partyId}::uuid
  `);

  const [interactions] = await tx.execute<{ n: number }>(sql`
    WITH upd AS (
      UPDATE interactions
         SET subject = '[erased]', body = NULL
       WHERE party_id = ${partyId}::uuid
      RETURNING 1
    ) SELECT COUNT(*)::int n FROM upd
  `);

  await tx.execute(sql`
    UPDATE party_contacts SET name = ${pseudonym}, phone = NULL, email = NULL
     WHERE party_id = ${partyId}::uuid
  `);

  /**
   * The employee record, when its retention period has run out.
   *
   * Identity documents and contact details go; `employee_code`, the service
   * dates, the salary breakdown and `gratuity_accrued` stay. Those are payroll
   * evidence and the basis of a liability already posted to the ledger — the
   * same reasoning that keeps the invoice. `emirates_id_bidx` is NULLed rather
   * than blanked because it carries a UNIQUE index; Postgres permits many NULLs
   * and would reject many empty strings.
   */
  let employeeRecordsErased = 0;
  if (eraseEmployee) {
    const [erased] = await tx.execute<{ n: number }>(sql`
      WITH upd AS (
        UPDATE employees
           SET full_name = ${pseudonym},
               phone = NULL, email = NULL, national_id = NULL, photo_url = NULL,
               nationality = NULL, emergency_contact = NULL,
               home_lat = NULL, home_lng = NULL,
               emirates_id_enc = NULL, emirates_id_bidx = NULL, emirates_id_hint = NULL,
               passport_number_enc = NULL, passport_number_bidx = NULL,
               passport_number_hint = NULL,
               visa_number_enc = NULL, labour_card_number_enc = NULL,
               iban_enc = NULL, iban_hint = NULL,
               wps_person_id = NULL, wps_routing_code = NULL,
               updated_at = now()
         WHERE party_id = ${partyId}::uuid
        RETURNING 1
      ) SELECT COUNT(*)::int n FROM upd
    `);
    employeeRecordsErased = erased?.n ?? 0;
  }

  // Stop any future contact attempt at the gate.
  await tx.execute(sql`
    INSERT INTO communication_consents
      (id, tenant_id, party_id, channel, allows_transactional, allows_marketing,
       opted_out_at, opted_out_reason, source)
    SELECT gen_random_uuid(), ${tenantId}::uuid, ${partyId}::uuid, ch, false, false,
           now(), 'erasure request', 'erasure'
      FROM unnest(ARRAY['email','sms','whatsapp','push']::notification_channel[]) ch
    ON CONFLICT (party_id, channel) DO UPDATE
      SET allows_transactional = false, allows_marketing = false,
          opted_out_at = now(), opted_out_reason = 'erasure request'
  `);

  // The audit entry records that an erasure happened and who asked for it —
  // deliberately WITHOUT the erased values, which would defeat the exercise.
  // The actor comes from the principal, so it is whoever actually authenticated.
  await tx.execute(sql`
    INSERT INTO audit_log
      (id, tenant_id, actor_user_id, actor_label, action, entity_table, entity_id, diff,
       ip_address, user_agent, request_id, at)
    VALUES
      (gen_random_uuid(), ${tenantId}::uuid, ${ctx.principal.userId}::uuid,
       ${ctx.principal.roleKey}, 'party.erase', 'parties', ${partyId}::uuid,
       ${JSON.stringify({
         reason,
         documentsRetained: docs?.n ?? 0,
         employeeRecordsErased,
         fields: assessment.willErase,
       })}::jsonb,
       ${ctx.ipAddress ?? null}, ${ctx.userAgent ?? null}, ${ctx.requestId ?? null},
       now())
  `);

  security.erased({
    tenantId,
    userId: ctx.principal.userId,
    actorRole: ctx.principal.roleKey,
    detail: { partyId, reason, documentsRetained: docs?.n ?? 0, employeeRecordsErased },
  });

  return {
    partyId,
    pseudonym,
    documentsRetained: docs?.n ?? 0,
    interactionsRedacted: interactions?.n ?? 0,
    employeeRecordsErased,
  };
}

/**
 * Subject access export — the other half of the same right.
 *
 * Returns everything held about one person. Deliberately logged as a security
 * event at warning level: a bulk export is also exactly what exfiltration looks
 * like, and the two are indistinguishable without the log.
 *
 * Gated on `party:export`, which the permission catalogue already marks
 * sensitive. Logging an export while letting anyone perform it records the
 * exfiltration without preventing it.
 */
export async function exportPartyData(
  ctx: ServiceContext,
  partyId: string,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, "party:export");

  const { tx, tenantId } = ctx;

  const [party] = await tx.execute<Record<string, unknown>>(sql`
    SELECT display_name, primary_phone, email, address_line, city, country_code,
           national_id_hint, tax_id_hint, created_at, lifetime_value, visit_count
      FROM parties WHERE id = ${partyId}::uuid
  `);
  const documents = await tx.execute<Record<string, unknown>>(sql`
    SELECT doc_number, doc_type::text, issue_date, total, status::text
      FROM documents WHERE party_id = ${partyId}::uuid ORDER BY issue_date
  `);
  const interactions = await tx.execute<Record<string, unknown>>(sql`
    SELECT channel, direction, subject, occurred_at
      FROM interactions WHERE party_id = ${partyId}::uuid ORDER BY occurred_at
  `);
  const consents = await tx.execute<Record<string, unknown>>(sql`
    SELECT channel::text, allows_transactional, allows_marketing, opted_out_at
      FROM communication_consents WHERE party_id = ${partyId}::uuid
  `);

  security.exported({
    tenantId,
    userId: ctx.principal.userId,
    actorRole: ctx.principal.roleKey,
    detail: { partyId, documents: documents.length },
  });

  return {
    exportedAt: new Date().toISOString(),
    // The identifiers are returned MASKED. A subject access request proves what
    // is held, not what the ciphertext is; posting a full Emirates ID into an
    // email thread would create a new exposure while answering a privacy one.
    party,
    documents,
    interactions,
    consents,
    note:
      "Identity document numbers are shown masked. Contact the data controller " +
      "in person with proof of identity to obtain the full values.",
  };
}
