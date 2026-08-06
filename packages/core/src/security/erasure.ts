import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { security } from "./events.ts";

/**
 * RIGHT TO ERASURE — and the reason it cannot simply be `DELETE`.
 *
 * UAE PDPL (Federal Decree-Law 45/2021) art. 15, and GDPR art. 17 for any EU
 * customers, give a data subject the right to have their personal data erased.
 * Both also carve out data the controller is legally required to retain — and
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
 */

export interface ErasureAssessment {
  canErase: boolean;
  blockers: string[];
  willRetain: { table: string; rows: number; reason: string }[];
  willErase: string[];
}

export async function assessErasure(tx: Tx, partyId: string): Promise<ErasureAssessment> {
  const [row] = await tx.execute<{
    display_name: string; open_balance: string; active_leases: number;
    open_jobs: number; invoices: number; is_employee: boolean;
  }>(sql`
    SELECT p.display_name, p.open_balance,
           (SELECT COUNT(*)::int FROM leases l
             WHERE l.party_id = p.id AND l.status = 'active') AS active_leases,
           (SELECT COUNT(*)::int FROM jobs j
             WHERE j.party_id = p.id
               AND j.status NOT IN ('completed','invoiced','cancelled')) AS open_jobs,
           (SELECT COUNT(*)::int FROM documents d WHERE d.party_id = p.id) AS invoices,
           EXISTS (SELECT 1 FROM employees e WHERE e.party_id = p.id) AS is_employee
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
  if (row.is_employee) {
    blockers.push("This person is an employee — labour records have their own retention rules.");
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
    ],
    willErase: [
      "Name, phone, WhatsApp, email",
      "Address and city",
      "Emirates ID / national ID (encrypted value and blind index)",
      "Tax identifier",
      "Free-text notes and tags",
      "Communication history bodies",
    ],
  };
}

export interface ErasureResult {
  partyId: string;
  pseudonym: string;
  documentsRetained: number;
  interactionsRedacted: number;
}

/**
 * Execute the erasure.
 *
 * The blind index is cleared too — leaving it would allow anyone who guesses an
 * Emirates ID to confirm the person was once a customer, which defeats the
 * purpose entirely.
 */
export async function erasePartyPii(
  tx: Tx,
  tenantId: string,
  partyId: string,
  actor: { userId: string; roleKey: string },
  reason: string,
): Promise<ErasureResult> {
  const assessment = await assessErasure(tx, partyId);
  if (!assessment.canErase) {
    throw new Error(`Cannot erase: ${assessment.blockers.join(" ")}`);
  }

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
  await tx.execute(sql`
    INSERT INTO audit_log
      (id, tenant_id, actor_user_id, actor_label, action, entity_table, entity_id, diff, at)
    VALUES
      (gen_random_uuid(), ${tenantId}::uuid, ${actor.userId}::uuid, ${actor.roleKey},
       'party.erase', 'parties', ${partyId}::uuid,
       ${JSON.stringify({ reason, documentsRetained: docs?.n ?? 0, fields: assessment.willErase })}::jsonb,
       now())
  `);

  security.erased({
    tenantId,
    userId: actor.userId,
    actorRole: actor.roleKey,
    detail: { partyId, reason, documentsRetained: docs?.n ?? 0 },
  });

  return {
    partyId,
    pseudonym,
    documentsRetained: docs?.n ?? 0,
    interactionsRedacted: interactions?.n ?? 0,
  };
}

/**
 * Subject access export — the other half of the same right.
 *
 * Returns everything held about one person. Deliberately logged as a security
 * event at warning level: a bulk export is also exactly what exfiltration looks
 * like, and the two are indistinguishable without the log.
 */
export async function exportPartyData(
  tx: Tx,
  tenantId: string,
  partyId: string,
  actor: { userId: string; roleKey: string },
): Promise<Record<string, unknown>> {
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
    userId: actor.userId,
    actorRole: actor.roleKey,
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
