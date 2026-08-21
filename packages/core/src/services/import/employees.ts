import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { blindIndex, encryptPii, maskHint, protect } from "../../security/pii.ts";
import { normaliseToken } from "./lookups.ts";
import {
  CellError,
  byRowNumber,
  readDate,
  readEnum,
  readMoney,
  readText,
  toIssue,
} from "./source.ts";
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
 * EMPLOYEES, WITH THEIR CONTRACTS AND PAY COMPONENTS.
 *
 * The import that carries the most personal data and the most legal weight.
 *
 * PERSONAL DATA. Emirates ID, passport, visa, labour card and IBAN are
 * encrypted at rest under `encryptPii` before they touch a column, and the
 * plaintext exists only as a local inside `apply`. It is never put in the diff,
 * the audit record, an error message or a log line — including the error
 * messages for duplicates, which name the EMPLOYEE, not the document. An
 * importer that reports "Emirates ID 784-1985-1234567-1 is already used" has
 * published the number to anyone who can see a screenshot.
 *
 * DUPLICATE DETECTION WITHOUT DECRYPTION. `employees_emirates_id_bidx_uq` is a
 * unique index over the blind index, which is what stops the same person being
 * onboarded twice. Duplicates are found here by computing the blind index of
 * the incoming value and comparing it against the ones already stored — no
 * ciphertext is ever decrypted to run this check, and the database still has
 * the last word.
 *
 * WHAT IS DELIBERATELY NOT IMPORTED. Accrued gratuity. It is a computed
 * liability under Federal Decree-Law 33/2021, it depends on the reason service
 * ends (open questions Q-2 and Q-2b), and importing a number somebody typed
 * into a spreadsheet would overwrite a figure the product is supposed to derive
 * and defend. The gratuity provision arrives as an opening balance on account
 * 2320 like any other liability; the per-employee accrual is recomputed from
 * the joining date and salary this importer does load.
 */

const COLUMNS = [
  "employee_code",
  "full_name",
  "designation",
  "department",
  "phone",
  "email",
  "joined_on",
  "status",
  "pay_basis",
  "base_salary",
  "housing_allowance",
  "transport_allowance",
  "other_allowance",
  "nationality",
  "emirates_id",
  "passport_number",
  "passport_expiry",
  "visa_number",
  "visa_expiry",
  "labour_card_number",
  "labour_card_expiry",
  "iban",
  "wps_person_id",
  "wps_routing_code",
] as const;

const STATUSES = [
  "applicant",
  "probation",
  "active",
  "on_leave",
  "suspended",
  "resigned",
  "terminated",
] as const;

const PAY_BASES = ["monthly", "daily", "hourly", "commission_only", "base_plus_commission"] as const;

export interface EmployeePlanRow {
  employeeCode: string;
  fullName: string;
  designation: string | null;
  department: string | null;
  phone: string | null;
  email: string | null;
  joinedOn: string;
  status: (typeof STATUSES)[number];
  payBasis: (typeof PAY_BASES)[number];
  baseSalary: M.Money;
  housingAllowance: M.Money;
  transportAllowance: M.Money;
  otherAllowance: M.Money;
  nationality: string | null;
  /** Raw identity documents. Encrypted in `apply`, never serialised. */
  emiratesId: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  visaNumber: string | null;
  visaExpiry: string | null;
  labourCardNumber: string | null;
  labourCardExpiry: string | null;
  iban: string | null;
  wpsPersonId: string | null;
  wpsRoutingCode: string | null;
}

export function planEmployees(
  rows: SourceRow[],
  existingCodes: Set<string>,
  existingEmiratesIdIndexes: Set<string>,
  today: string,
): ImportPlan {
  const planned: PlannedRow<EmployeePlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const codesSeen = new Map<string, number>();
  const idsSeen = new Map<string, number>();

  let monthlyPayroll = M.ZERO;
  let creates = 0;
  let withoutEmiratesId = 0;

  for (const row of rows) {
    try {
      const employeeCode = readText(row, "employee_code", { max: 30, required: true });
      const codeKey = normaliseToken(employeeCode);
      const duplicate = codesSeen.get(codeKey);
      if (duplicate !== undefined) {
        throw new CellError(
          "employee_code",
          `Employee number ${employeeCode} is already on row ${duplicate}.`,
        );
      }
      codesSeen.set(codeKey, row.rowNumber);

      const fullName = readText(row, "full_name", { max: 200, required: true });
      const joinedOn = readDate(row, "joined_on");
      if (joinedOn > today) {
        throw new CellError(
          "joined_on",
          `${fullName} is shown as joining on ${joinedOn}, which is in the future. ` +
            `Import them when they start.`,
        );
      }

      const baseSalary = readMoney(row, "base_salary", M.ZERO);
      if (M.isNegative(baseSalary)) throw new CellError("base_salary", "Salary cannot be negative.");

      const emiratesId = readText(row, "emirates_id", { max: 40 }) || null;
      if (emiratesId) {
        /**
         * Compared as a blind index, and reported by NAME.
         *
         * The message deliberately says "the same Emirates ID as row 12" rather
         * than echoing the number: a row-level error report is the most
         * screenshotted, most pasted-into-chat artefact this feature produces,
         * and an identity document in it is a disclosure that no amount of
         * encryption at rest undoes.
         */
        const index = blindIndex(emiratesId);
        if (index) {
          const seenAt = idsSeen.get(index);
          if (seenAt !== undefined) {
            throw new CellError(
              "emirates_id",
              `This is the same Emirates ID as row ${seenAt}. One person, one record.`,
            );
          }
          if (existingEmiratesIdIndexes.has(index)) {
            throw new CellError(
              "emirates_id",
              `Someone already on file has this Emirates ID. Check whether ${fullName} is ` +
                `already an employee before importing them again.`,
            );
          }
          idsSeen.set(index, row.rowNumber);
        }
      } else {
        withoutEmiratesId++;
      }

      const payload: EmployeePlanRow = {
        employeeCode,
        fullName,
        designation: readText(row, "designation", { max: 100 }) || null,
        department: readText(row, "department", { max: 100 }) || null,
        phone: readText(row, "phone", { max: 40 }) || null,
        email: readText(row, "email", { max: 320 }) || null,
        joinedOn,
        status: readEnum(row, "status", STATUSES, "active"),
        payBasis: readEnum(row, "pay_basis", PAY_BASES, "monthly"),
        baseSalary,
        housingAllowance: readMoney(row, "housing_allowance", M.ZERO),
        transportAllowance: readMoney(row, "transport_allowance", M.ZERO),
        otherAllowance: readMoney(row, "other_allowance", M.ZERO),
        nationality: readText(row, "nationality", { max: 60 }) || null,
        emiratesId,
        passportNumber: readText(row, "passport_number", { max: 40 }) || null,
        passportExpiry: row.has("passport_expiry") ? readDate(row, "passport_expiry") : null,
        visaNumber: readText(row, "visa_number", { max: 40 }) || null,
        visaExpiry: row.has("visa_expiry") ? readDate(row, "visa_expiry") : null,
        labourCardNumber: readText(row, "labour_card_number", { max: 40 }) || null,
        labourCardExpiry: row.has("labour_card_expiry") ? readDate(row, "labour_card_expiry") : null,
        iban: readText(row, "iban", { max: 40 }) || null,
        wpsPersonId: readText(row, "wps_person_id", { max: 40 }) || null,
        wpsRoutingCode: readText(row, "wps_routing_code", { max: 20 }) || null,
      };

      if (payload.iban && !/^AE\d{21}$/i.test(payload.iban.replace(/\s+/g, ""))) {
        // Format only — the value itself never appears in the message.
        throw new CellError(
          "iban",
          "That is not a UAE IBAN. A UAE IBAN is AE followed by 21 digits, and WPS will " +
            "reject anything else.",
        );
      }

      const gross = M.sum([
        payload.baseSalary,
        payload.housingAllowance,
        payload.transportAllowance,
        payload.otherAllowance,
      ]);

      if (existingCodes.has(codeKey)) {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: `${employeeCode} · ${fullName}`,
          detail: "Already on file. Employee records are never overwritten by an import.",
          payload,
        });
        continue;
      }

      creates++;
      if (payload.payBasis === "monthly" || payload.payBasis === "base_plus_commission") {
        monthlyPayroll = M.add(monthlyPayroll, gross);
      }

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: `${employeeCode} · ${fullName}`,
        detail: `${payload.status} · joined ${joinedOn} · ${M.toDisplay(gross)} ${payload.payBasis}`,
        amount: gross,
        payload,
      });
    } catch (err) {
      rejected.push(toIssue(row.rowNumber, err));
    }
  }

  const notes = [
    "Identity documents and IBANs are encrypted on the way in and shown only as ••••1234.",
    "Accrued gratuity is not imported. It comes in as an opening balance on 2320 and is " +
      "recomputed per employee from the joining date and salary.",
    "Employees already on file are skipped, never overwritten.",
  ];
  if (withoutEmiratesId > 0) {
    notes.push(
      `${withoutEmiratesId} row(s) have no Emirates ID. They will import, but the ` +
        `duplicate-person check cannot protect them.`,
    );
  }

  return {
    rows: planned,
    rejected: rejected.sort(byRowNumber),
    blockers: [],
    totals: [
      { label: "Employees to create", amount: M.money(creates) },
      { label: "Monthly payroll cost", amount: M.quantize(monthlyPayroll) },
    ],
    notes,
    expectedLines: [],
    totalDebit: M.ZERO,
    totalCredit: M.ZERO,
  };
}

export const employeesImporter: Importer = {
  kind: "employees",
  label: "Employees",
  description: "Your staff, their contracts and their pay components.",
  template: [...COLUMNS],
  required: ["employee_code", "full_name", "joined_on"],
  permission: "employee:create",
  requiresBusinessUnit: true,

  async plan(ctx, rows) {
    const existing = await ctx.tx.execute<{
      employee_code: string;
      emirates_id_bidx: string | null;
    }>(sql`
      SELECT employee_code, emirates_id_bidx FROM employees WHERE deleted_at IS NULL
    `);
    return planEmployees(
      rows,
      new Set(existing.map((e) => normaliseToken(e.employee_code))),
      new Set(existing.map((e) => e.emirates_id_bidx).filter((b): b is string => !!b)),
      ctx.today,
    );
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    for (const row of plan.rows) {
      if (row.action !== "create") continue;
      const e = row.payload as EmployeePlanRow;

      // Every identity document is encrypted here, at the last possible moment,
      // and the plaintext dies with this iteration.
      const emiratesId = protect(e.emiratesId);
      const passport = protect(e.passportNumber);
      const iban = e.iban ? encryptPii(e.iban.replace(/\s+/g, "").toUpperCase()) : null;
      const ibanHint = e.iban ? maskHint(e.iban.replace(/\s+/g, "")) : null;
      const visa = e.visaNumber ? encryptPii(e.visaNumber) : null;
      const labourCard = e.labourCardNumber ? encryptPii(e.labourCardNumber) : null;

      const inserted = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO employees
          (id, tenant_id, primary_business_unit_id, employee_code, full_name, designation,
           department, phone, email, status, joined_on, pay_basis, base_salary,
           housing_allowance, transport_allowance, other_allowance, nationality,
           emirates_id_enc, emirates_id_bidx, emirates_id_hint,
           passport_number_enc, passport_number_bidx, passport_number_hint, passport_expiry,
           visa_number_enc, visa_expiry, labour_card_number_enc, labour_card_expiry,
           iban_enc, iban_hint, wps_person_id, wps_routing_code)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.businessUnitId}::uuid,
           ${e.employeeCode}, ${e.fullName}, ${e.designation}, ${e.department},
           ${e.phone}, ${e.email}, ${e.status}::employment_status, ${e.joinedOn}::date,
           ${e.payBasis}::pay_basis, ${M.toDb(e.baseSalary)},
           ${M.toDb(e.housingAllowance)}, ${M.toDb(e.transportAllowance)},
           ${M.toDb(e.otherAllowance)}, ${e.nationality},
           ${emiratesId.enc}, ${emiratesId.bidx}, ${emiratesId.hint},
           ${passport.enc}, ${passport.bidx}, ${passport.hint}, ${e.passportExpiry}::date,
           ${visa}, ${e.visaExpiry}::date, ${labourCard}, ${e.labourCardExpiry}::date,
           ${iban}, ${ibanHint}, ${e.wpsPersonId}, ${e.wpsRoutingCode})
        RETURNING id
      `);
      await into.record({
        rowNumber: row.rowNumber,
        action: "create",
        entityTable: "employees",
        entityId: inserted[0]!.id,
      });
    }
    return {};
  },
};
