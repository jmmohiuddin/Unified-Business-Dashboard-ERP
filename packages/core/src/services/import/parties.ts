import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { protect } from "../../security/pii.ts";
import { Index, normalisePhone, normaliseToken, partyIndex } from "./lookups.ts";
import { CellError, byRowNumber, readEnum, readInteger, readMoney, readText, toIssue } from "./source.ts";
import type {
  ApplyOutcome,
  BatchRecorder,
  ImportContext,
  ImportPlan,
  Importer,
  PlannedRow,
  RowIssue,
  SourceRow,
} from "./types.ts";

/**
 * CUSTOMERS, SUPPLIERS AND TENANTS — one importer, because they are one table.
 *
 * `parties` is deliberately not three tables: in this portfolio the same human
 * is routinely a salon customer, the tenant in flat 4B and the electrician you
 * subcontract to. The importer honours that. A file of "customers" and a file
 * of "suppliers" that both contain Ahmed produce ONE party with two role flags,
 * not two records that will diverge for the rest of the system's life.
 *
 * TWO RULES THAT LOOK CONSERVATIVE AND ARE NOT.
 *
 *  1. AN UPDATE NEVER CLEARS A FIELD. A cell left blank in the spreadsheet means
 *     "I did not export that column", not "delete what you have". An importer
 *     that treats absence as deletion wipes phone numbers on the second run of
 *     a file the owner exported from a system that did not have them.
 *
 *  2. A ROLE FLAG IS ONLY EVER TURNED ON. Importing the supplier list must not
 *     stop someone being a customer. Turning a flag off hides a record from the
 *     screen that manages it, which reads to the user as data loss and is
 *     indistinguishable from it.
 *
 * PERSONAL DATA. Emirates ID and TRN go through `protect()` — AES-256-GCM with
 * a blind index for exact lookup — and the raw value never reaches a log, an
 * error message or the diff. The diff shows the masked hint, which is enough
 * for a human to confirm the right record and useless to anyone who steals the
 * table. See packages/core/src/security/pii.ts.
 */

const COLUMNS = [
  "code",
  "name",
  "type",
  "roles",
  "phone",
  "whatsapp",
  "email",
  "emirates_id",
  "trn",
  "address",
  "city",
  "country",
  "credit_limit",
  "credit_term_days",
  "notes",
] as const;

const PARTY_TYPES = ["person", "company"] as const;

/** Columns an update is allowed to touch, and the SQL column each maps to. */
const UPDATABLE: Record<string, string> = {
  name: "display_name",
  phone: "primary_phone",
  whatsapp: "whatsapp",
  email: "email",
  address: "address_line",
  city: "city",
  country: "country_code",
  credit_limit: "credit_limit",
  credit_term_days: "credit_term_days",
  notes: "notes",
};

interface PartyFields {
  code: string | null;
  displayName: string;
  type: "person" | "company";
  isCustomer: boolean;
  isSupplier: boolean;
  isTenantRenter: boolean;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  emiratesId: string | null;
  trn: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  creditLimit: M.Money | null;
  creditTermDays: number | null;
  notes: string | null;
  /** Which columns the file actually supplied. Absence is not deletion. */
  supplied: Set<string>;
}

export interface PartyPlanRow {
  existingId: string | null;
  fields: PartyFields;
}

const ROLE_TOKENS: Record<string, keyof Pick<PartyFields, "isCustomer" | "isSupplier" | "isTenantRenter">> =
  {
    customer: "isCustomer",
    customers: "isCustomer",
    client: "isCustomer",
    supplier: "isSupplier",
    suppliers: "isSupplier",
    vendor: "isSupplier",
    tenant: "isTenantRenter",
    tenants: "isTenantRenter",
    renter: "isTenantRenter",
  };

function readFields(row: SourceRow): PartyFields {
  const supplied = new Set<string>();
  const take = (column: string, value: string | null): string | null => {
    if (row.has(column)) supplied.add(column);
    return value;
  };

  const displayName = readText(row, "name", { max: 200, required: true });

  const fields: PartyFields = {
    code: take("code", readText(row, "code", { max: 30 }) || null),
    displayName,
    type: readEnum(row, "type", PARTY_TYPES, "person"),
    isCustomer: false,
    isSupplier: false,
    isTenantRenter: false,
    phone: take("phone", readText(row, "phone", { max: 40 }) || null),
    whatsapp: take("whatsapp", readText(row, "whatsapp", { max: 40 }) || null),
    email: take("email", readText(row, "email", { max: 320 }) || null),
    emiratesId: readText(row, "emirates_id", { max: 60 }) || null,
    trn: readText(row, "trn", { max: 60 }) || null,
    address: take("address", readText(row, "address", { max: 500 }) || null),
    city: take("city", readText(row, "city", { max: 100 }) || null),
    country: take("country", readText(row, "country", { max: 2 }).toUpperCase() || null),
    creditLimit: row.has("credit_limit") ? readMoney(row, "credit_limit") : null,
    creditTermDays: row.has("credit_term_days")
      ? readInteger(row, "credit_term_days", { min: 0, max: 365 })
      : null,
    notes: take("notes", readText(row, "notes", { max: 2000 }) || null),
    supplied,
  };
  if (row.has("credit_limit")) supplied.add("credit_limit");
  if (row.has("credit_term_days")) supplied.add("credit_term_days");
  if (row.has("name")) supplied.add("name");

  const roles = readText(row, "roles", { max: 100 });
  if (roles !== "") {
    for (const token of roles.split(/[,;/|]/)) {
      const key = ROLE_TOKENS[normaliseToken(token).replace(/\s+/g, "")];
      if (!key) {
        throw new CellError(
          "roles",
          `"${token.trim()}" is not a role. Use customer, supplier or tenant, ` +
            `separated by commas.`,
        );
      }
      fields[key] = true;
    }
  }

  if (fields.email !== null && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(fields.email)) {
    throw new CellError("email", `"${fields.email}" is not an email address.`);
  }
  if (fields.country !== null && !/^[A-Z]{2}$/.test(fields.country)) {
    throw new CellError("country", `"${fields.country}" is not a two-letter country code.`);
  }
  if (fields.creditLimit !== null && M.isNegative(fields.creditLimit)) {
    throw new CellError("credit_limit", "A credit limit cannot be negative.");
  }

  return fields;
}

export function planParties(rows: SourceRow[], existing: Index): ImportPlan {
  const planned: PlannedRow<PartyPlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const seen = new Map<string, number>();

  let creates = 0;
  let updates = 0;

  for (const row of rows) {
    try {
      const fields = readFields(row);

      // Within-file duplicates first: two rows describing the same person will
      // otherwise create one and then update it, which reads as "1 created,
      // 1 updated" for a file that meant one record.
      for (const token of [fields.code, fields.displayName, fields.phone, fields.email]) {
        if (!token) continue;
        const key = token === fields.phone ? normalisePhone(token) : normaliseToken(token);
        if (key === "") continue;
        const previous = seen.get(key);
        if (previous !== undefined) {
          throw new CellError(
            "name",
            `This is the same party as row ${previous} ("${token}"). Combine the two rows.`,
          );
        }
      }
      for (const token of [fields.code, fields.displayName, fields.email]) {
        if (token) seen.set(normaliseToken(token), row.rowNumber);
      }
      if (fields.phone) seen.set(normalisePhone(fields.phone), row.rowNumber);

      /**
       * Match on the code first, and only then on the human identifiers.
       *
       * A code is what the accountant's previous system called this record and
       * is the only token they control. Matching on name before code merges two
       * suppliers who share a trading name; matching on code alone misses every
       * record in a file that never had one.
       */
      const tokens = [fields.code, fields.phone, fields.email, fields.displayName].filter(
        (t): t is string => !!t,
      );
      let existingId: string | null = null;
      for (const token of tokens) {
        const hit = existing.resolve(token === fields.phone ? normalisePhone(token) : token);
        if (hit === "ambiguous") {
          throw new CellError(
            "name",
            `"${token}" matches more than one existing record. Add a code column so ` +
              `each row names exactly one party.`,
          );
        }
        if (hit) {
          existingId = hit.found.id;
          break;
        }
      }

      const changes = existingId
        ? [...fields.supplied].filter((c) => c in UPDATABLE)
        : [];

      if (existingId && changes.length === 0 && !fields.emiratesId && !fields.trn) {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: fields.displayName,
          detail: "Already on file, nothing in this row would change it.",
          payload: { existingId, fields },
        });
        continue;
      }

      if (existingId) updates++;
      else creates++;

      planned.push({
        rowNumber: row.rowNumber,
        action: existingId ? "update" : "create",
        label: fields.displayName,
        detail: existingId
          ? `Updates ${changes.join(", ") || "identity documents"}`
          : [
              fields.isCustomer ? "customer" : null,
              fields.isSupplier ? "supplier" : null,
              fields.isTenantRenter ? "tenant" : null,
            ]
              .filter(Boolean)
              .join(", ") || "no role flags set",
        payload: { existingId, fields },
      });
    } catch (err) {
      rejected.push(toIssue(row.rowNumber, err));
    }
  }

  const notes = [
    "A blank cell leaves the existing value alone. Nothing is cleared by an import.",
    "Role flags are only ever turned on — importing suppliers cannot stop someone " +
      "being a customer.",
  ];
  if (rows.some((r) => r.has("emirates_id") || r.has("trn"))) {
    notes.push("Emirates ID and TRN are encrypted on the way in and shown only as ••••1234.");
  }

  return {
    rows: planned,
    rejected: rejected.sort(byRowNumber),
    blockers: [],
    totals: [
      { label: "Parties to create", amount: M.money(creates) },
      { label: "Parties to update", amount: M.money(updates) },
    ],
    notes,
    expectedLines: [],
    totalDebit: M.ZERO,
    totalCredit: M.ZERO,
  };
}

export const partiesImporter: Importer = {
  kind: "parties",
  label: "Customers, suppliers and tenants",
  description:
    "One row per person or company. The same row can be a customer, a supplier and " +
    "a tenant at once.",
  template: [...COLUMNS],
  required: ["name"],
  permission: "party:create",
  requiresBusinessUnit: false,

  async plan(ctx, rows) {
    return planParties(rows, await partyIndex(ctx));
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    for (const row of plan.rows) {
      if (row.action === "skip") continue;
      const { existingId, fields } = row.payload as PartyPlanRow;

      // Encrypted here and nowhere else. The plaintext exists as a local for
      // the length of this call and is never put in the diff, the audit record
      // or an error message.
      const nationalId = protect(fields.emiratesId);
      const taxId = protect(fields.trn);

      if (!existingId) {
        const inserted = await ctx.tx.execute<{ id: string }>(sql`
          INSERT INTO parties
            (id, tenant_id, type, code, display_name, is_customer, is_supplier,
             is_tenant_renter, primary_phone, whatsapp, email,
             national_id_enc, national_id_bidx, national_id_hint,
             tax_id_enc, tax_id_hint,
             address_line, city, country_code, credit_limit, credit_term_days, notes)
          VALUES
            (gen_random_uuid(), ${ctx.tenantId}::uuid, ${fields.type}::party_type,
             ${fields.code}, ${fields.displayName}, ${fields.isCustomer}, ${fields.isSupplier},
             ${fields.isTenantRenter}, ${fields.phone}, ${fields.whatsapp}, ${fields.email},
             ${nationalId.enc}, ${nationalId.bidx}, ${nationalId.hint},
             ${taxId.enc}, ${taxId.hint},
             ${fields.address}, ${fields.city}, ${fields.country ?? "AE"},
             ${fields.creditLimit ? M.toDb(fields.creditLimit) : "0"},
             ${fields.creditTermDays ?? 0}, ${fields.notes})
          RETURNING id
        `);
        const partyId = inserted[0]!.id;
        await into.record({
          rowNumber: row.rowNumber,
          action: "create",
          entityTable: "parties",
          entityId: partyId,
        });

        if (ctx.businessUnitId) {
          const link = await ctx.tx.execute<{ id: string }>(sql`
            INSERT INTO party_business_units (id, tenant_id, party_id, business_unit_id)
            VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${partyId}::uuid,
                    ${ctx.businessUnitId}::uuid)
            ON CONFLICT (party_id, business_unit_id) DO NOTHING
            RETURNING id
          `);
          if (link.length > 0) {
            await into.record({
              rowNumber: row.rowNumber,
              action: "create",
              entityTable: "party_business_units",
              entityId: link[0]!.id,
            });
          }
        }
        continue;
      }

      /**
       * An update records what it is overwriting BEFORE it overwrites it.
       *
       * Reversing an update by blanking the field would destroy the value that
       * was there, which is worse than the wrong import it was meant to undo.
       * The previous values go into `import_batch_rows.previous`, and the
       * reversal writes them back.
       */
      const columns = [
        ...[...fields.supplied].filter((c) => c in UPDATABLE).map((c) => UPDATABLE[c]!),
        // Flags and ciphertext are captured too, or the reversal restores the
        // contact details and leaves the overwritten Emirates ID in place.
        ...(fields.isCustomer ? ["is_customer"] : []),
        ...(fields.isSupplier ? ["is_supplier"] : []),
        ...(fields.isTenantRenter ? ["is_tenant_renter"] : []),
        ...(nationalId.enc ? ["national_id_enc", "national_id_bidx", "national_id_hint"] : []),
        ...(taxId.enc ? ["tax_id_enc", "tax_id_hint"] : []),
      ];
      // Column names come from this module's own constants, never from the
      // uploaded file — `sql.raw` is safe here for exactly that reason and for
      // no other.
      const before =
        columns.length === 0
          ? []
          : await ctx.tx.execute<Record<string, unknown>>(sql`
              SELECT ${sql.join(
                columns.map((c) => sql.raw(`"${c}"`)),
                sql`, `,
              )}
                FROM parties WHERE id = ${existingId}::uuid
            `);

      const assignments = [
        fields.supplied.has("name") ? sql`display_name = ${fields.displayName}` : null,
        fields.supplied.has("phone") ? sql`primary_phone = ${fields.phone}` : null,
        fields.supplied.has("whatsapp") ? sql`whatsapp = ${fields.whatsapp}` : null,
        fields.supplied.has("email") ? sql`email = ${fields.email}` : null,
        fields.supplied.has("address") ? sql`address_line = ${fields.address}` : null,
        fields.supplied.has("city") ? sql`city = ${fields.city}` : null,
        fields.supplied.has("country") ? sql`country_code = ${fields.country}` : null,
        fields.supplied.has("credit_limit") && fields.creditLimit
          ? sql`credit_limit = ${M.toDb(fields.creditLimit)}`
          : null,
        fields.supplied.has("credit_term_days") && fields.creditTermDays !== null
          ? sql`credit_term_days = ${fields.creditTermDays}`
          : null,
        fields.supplied.has("notes") ? sql`notes = ${fields.notes}` : null,
        // Flags OR in, never out. See the header.
        fields.isCustomer ? sql`is_customer = true` : null,
        fields.isSupplier ? sql`is_supplier = true` : null,
        fields.isTenantRenter ? sql`is_tenant_renter = true` : null,
        nationalId.enc
          ? sql`national_id_enc = ${nationalId.enc}, national_id_bidx = ${nationalId.bidx}, national_id_hint = ${nationalId.hint}`
          : null,
        taxId.enc ? sql`tax_id_enc = ${taxId.enc}, tax_id_hint = ${taxId.hint}` : null,
        sql`updated_at = now()`,
      ].filter((s): s is ReturnType<typeof sql> => s !== null);

      await ctx.tx.execute(sql`
        UPDATE parties SET ${sql.join(assignments, sql`, `)} WHERE id = ${existingId}::uuid
      `);

      await into.record({
        rowNumber: row.rowNumber,
        action: "update",
        entityTable: "parties",
        entityId: existingId,
        previous: before[0] ?? {},
      });
    }
    return {};
  },
};
