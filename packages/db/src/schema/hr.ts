import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  attendanceStatus,
  commissionBasis,
  employmentStatus,
  payBasis,
} from "./_enums.ts";
import { metadata, money, pk, qty, rate, timestamps } from "./_shared.ts";
import { businessUnits, locations, tenants } from "./tenancy.ts";
import { parties } from "./parties.ts";
import { users } from "./identity.ts";

/**
 * Employee is a *role* a party plays, not a separate person record — same
 * reasoning as customers/suppliers. A barber who also rents a shop from the
 * owner must not be two humans in this database.
 *
 * `userId` is nullable on purpose: most field staff and barbers will never log
 * in. Requiring a user account per employee is a classic ERP mistake that makes
 * payroll depend on IT onboarding.
 */
export const employees = pgTable(
  "employees",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Home business; `employeeAssignments` allows working across businesses. */
    primaryBusinessUnitId: uuid("primary_business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),

    employeeCode: varchar("employee_code", { length: 30 }).notNull(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    designation: varchar("designation", { length: 100 }),
    department: varchar("department", { length: 100 }),
    phone: varchar("phone", { length: 40 }),
    email: varchar("email", { length: 320 }),
    nationalId: varchar("national_id", { length: 60 }),
    photoUrl: text("photo_url"),

    status: employmentStatus("status").notNull().default("active"),
    joinedOn: date("joined_on").notNull(),
    probationEndsOn: date("probation_ends_on"),
    leftOn: date("left_on"),

    payBasis: payBasis("pay_basis").notNull().default("monthly"),

    /**
     * UAE salary structure. The split is NOT cosmetic.
     *
     * End-of-service gratuity is calculated on BASIC salary only, not total
     * package. A business that stores one lumped "salary" figure cannot compute
     * its gratuity liability, which for a company with long-serving staff is one
     * of the largest numbers on its balance sheet — and one that owners are
     * routinely shocked by when someone resigns.
     */
    baseSalary: money("base_salary").notNull().default("0"),
    housingAllowance: money("housing_allowance").notNull().default("0"),
    transportAllowance: money("transport_allowance").notNull().default("0"),
    otherAllowance: money("other_allowance").notNull().default("0"),
    hourlyRate: money("hourly_rate"),
    /** Additional contractual components kept as data so payroll rules differ
     *  per country without a code change. */
    payComponents: jsonb("pay_components").notNull().default(sql`'[]'::jsonb`),

    /**
     * Accrued end-of-service gratuity (Federal Decree-Law 33 of 2021, art. 51):
     * 21 days' basic wage per year for the first five years, 30 days per year
     * thereafter, capped at two years' total wage. Recalculated nightly and
     * posted as a provision, because it is a liability that accrues every single
     * day whether or not anyone is looking at it.
     */
    gratuityAccrued: money("gratuity_accrued").notNull().default("0"),
    gratuityAsOf: date("gratuity_as_of"),

    /**
     * The date a NEW period of continuous service began, after an earlier one
     * was settled and paid out. Null for everyone who has never been settled,
     * which is almost everyone.
     *
     * This exists so `joinedOn` never has to be rewritten. Edge case EC-05:
     * an employee is paid AED 84,000 of end-of-service benefit, leaves, and is
     * hired back six months later. Their service clock must restart — the first
     * period has been bought and paid for — but their joining date is evidence.
     * It is on the labour contract, on the visa file, in the MOHRE record and in
     * every earlier settlement; moving it to make the arithmetic come out would
     * destroy the only proof that the first period ever happened, and would make
     * the payout that discharged it unreconcilable.
     *
     * So the original dates stay and the clock is DERIVED. Nothing reads this
     * column directly: `resolveGratuityServiceStart` in
     * `packages/core/src/services/gratuity-payout.ts` combines it with the
     * settled periods in `gratuity_settlements` and takes the later of the two,
     * so a day of service that has already been paid for can never be paid for
     * again — even if this column is wrong, missing, or set by hand.
     */
    serviceRestartedOn: date("service_restarted_on"),

    /** WPS (Wage Protection System) — salaries must be paid through an approved
     *  agent and reported to MOHRE, or the establishment is blocked from issuing
     *  new work permits. These fields are what the SIF export needs.
     *  The IBAN is encrypted; the routing code is a public bank identifier. */
    wpsPersonId: varchar("wps_person_id", { length: 20 }),
    wpsRoutingCode: varchar("wps_routing_code", { length: 20 }),
    ibanEnc: text("iban_enc"),
    ibanHint: varchar("iban_hint", { length: 16 }),

    /**
     * Residency and labour documents.
     *
     * The identifiers themselves are ENCRYPTED at rest (AES-256-GCM, see
     * packages/core/src/security/pii.ts). An Emirates ID, a passport number and
     * an IBAN together are enough to attempt identity fraud, and RLS does
     * nothing against a stolen backup or a support engineer with psql.
     *
     * Each protected field is three columns:
     *   `_enc`  the envelope, including the key id so keys can be rotated
     *   `_bidx` a keyed HMAC for exact lookup — encrypted columns cannot be
     *           queried with `=`, and a deterministic cipher would leak equality
     *   `_hint` a masked last-four for display, so a list screen never has to
     *           decrypt hundreds of rows to render `••••1234`
     *
     * The expiry DATES are deliberately left in plaintext: they drive the
     * compliance watchlist and are not identifying on their own.
     */
    emiratesIdEnc: text("emirates_id_enc"),
    emiratesIdBidx: varchar("emirates_id_bidx", { length: 32 }),
    emiratesIdHint: varchar("emirates_id_hint", { length: 16 }),

    visaNumberEnc: text("visa_number_enc"),
    visaExpiry: date("visa_expiry"),

    labourCardEnc: text("labour_card_number_enc"),
    labourCardExpiry: date("labour_card_expiry"),

    passportNumberEnc: text("passport_number_enc"),
    passportNumberBidx: varchar("passport_number_bidx", { length: 32 }),
    passportNumberHint: varchar("passport_number_hint", { length: 16 }),
    passportExpiry: date("passport_expiry"),

    nationality: varchar("nationality", { length: 60 }),

    /** Field-service dispatch inputs. */
    isFieldStaff: boolean("is_field_staff").notNull().default(false),
    skills: jsonb("skills").notNull().default(sql`'[]'::jsonb`),
    homeLat: varchar("home_lat", { length: 24 }),
    homeLng: varchar("home_lng", { length: 24 }),
    /** Van/toolkit stock location for this technician. */
    defaultWarehouseId: uuid("default_warehouse_id"),

    /** Rolling performance rollups refreshed nightly. */
    revenueMtd: money("revenue_mtd").notNull().default("0"),
    jobsCompletedMtd: integer("jobs_completed_mtd").notNull().default(0),
    avgCustomerRating: rate("avg_customer_rating"),
    utilizationRate: rate("utilization_rate"),

    emergencyContact: varchar("emergency_contact", { length: 200 }),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("employees_code_uq").on(t.tenantId, t.employeeCode),
    index("employees_bu_status_idx").on(t.primaryBusinessUnitId, t.status),
    index("employees_field_idx").on(t.tenantId, t.isFieldStaff),
    // Blind indexes: exact lookup over encrypted identifiers. Unique on
    // Emirates ID because two active employees cannot share one.
    uniqueIndex("employees_emirates_id_bidx_uq").on(t.tenantId, t.emiratesIdBidx),
    index("employees_passport_bidx").on(t.tenantId, t.passportNumberBidx),
  ],
);

/** Lets one employee work in several businesses with a cost split. */
export const employeeAssignments = pgTable(
  "employee_assignments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    /** 0.6 = 60% of this person's cost is charged to that business. */
    costAllocation: rate("cost_allocation").notNull().default("1"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    ...timestamps,
  },
  (t) => [uniqueIndex("employee_assignments_uq").on(t.employeeId, t.businessUnitId)],
);

export const attendance = pgTable(
  "attendance",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    onDate: date("on_date").notNull(),
    status: attendanceStatus("status").notNull().default("present"),
    checkIn: time("check_in"),
    checkOut: time("check_out"),
    workedMinutes: integer("worked_minutes"),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    lateMinutes: integer("late_minutes").notNull().default(0),
    /** Source matters for trust: a selfie+GPS punch is evidence, a manual entry
     *  by the manager is an assertion. Payroll disputes hinge on this. */
    source: varchar("source", { length: 20 }).notNull().default("manual"),
    lat: varchar("lat", { length: 24 }),
    lng: varchar("lng", { length: 24 }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [uniqueIndex("attendance_uq").on(t.employeeId, t.onDate)],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    leaveType: varchar("leave_type", { length: 40 }).notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    days: qty("days").notNull(),
    isPaid: boolean("is_paid").notNull().default(true),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    reason: text("reason"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("leave_requests_emp_idx").on(t.employeeId, t.startsOn)],
);

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    periodLabel: varchar("period_label", { length: 20 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    grossTotal: money("gross_total").notNull().default("0"),
    deductionTotal: money("deduction_total").notNull().default("0"),
    netTotal: money("net_total").notNull().default("0"),
    employeeCount: integer("employee_count").notNull().default(0),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    paidOn: date("paid_on"),
    journalId: uuid("journal_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("payroll_runs_uq").on(t.tenantId, t.businessUnitId, t.periodLabel)],
);

export const payslips = pgTable(
  "payslips",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    payrollRunId: uuid("payroll_run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    baseAmount: money("base_amount").notNull().default("0"),
    overtimeAmount: money("overtime_amount").notNull().default("0"),
    commissionAmount: money("commission_amount").notNull().default("0"),
    allowanceAmount: money("allowance_amount").notNull().default("0"),
    deductionAmount: money("deduction_amount").notNull().default("0"),
    advanceDeduction: money("advance_deduction").notNull().default("0"),
    grossAmount: money("gross_amount").notNull().default("0"),
    netAmount: money("net_amount").notNull().default("0"),
    /** Full breakdown snapshot so a reprint years later is byte-identical. */
    breakdown: metadata("breakdown"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("payslips_uq").on(t.payrollRunId, t.employeeId)],
);

/**
 * Commission rules. The salon runs on these (barbers take a cut of every
 * service) and so does retail. Keeping them as rows with a scope means the
 * owner can change Karim's rate for hair colouring without a deploy.
 */
export const commissionRules = pgTable(
  "commission_rules",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    basis: commissionBasis("basis").notNull().default("revenue_percent"),
    rate: rate("rate").notNull().default("0"),
    flatAmount: money("flat_amount"),
    /** Narrowing scope: null = applies to everything at this level. */
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "cascade" }),
    itemId: uuid("item_id"),
    categoryId: uuid("category_id"),
    /** Tiers: [{ from: 0, to: 50000, rate: 0.05 }, ...] */
    tiers: jsonb("tiers").notNull().default(sql`'[]'::jsonb`),
    minTargetAmount: money("min_target_amount"),
    priority: integer("priority").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("commission_rules_bu_idx").on(t.businessUnitId, t.isActive)],
);

export const commissionEntries = pgTable(
  "commission_entries",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => commissionRules.id, { onDelete: "set null" }),
    sourceTable: varchar("source_table", { length: 63 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    baseAmount: money("base_amount").notNull(),
    commissionAmount: money("commission_amount").notNull(),
    earnedOn: date("earned_on").notNull(),
    payslipId: uuid("payslip_id").references(() => payslips.id, { onDelete: "set null" }),
    isPaid: boolean("is_paid").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("commission_entries_emp_idx").on(t.employeeId, t.earnedOn),
    index("commission_entries_unpaid_idx").on(t.tenantId, t.isPaid),
  ],
);

/** Salary advances — ubiquitous in this market and a real cash-flow drain if
 *  untracked. Deducted automatically at the next payroll run. */
export const salaryAdvances = pgTable(
  "salary_advances",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    amount: money("amount").notNull(),
    outstanding: money("outstanding").notNull(),
    issuedOn: date("issued_on").notNull(),
    monthlyDeduction: money("monthly_deduction").notNull(),
    reason: text("reason"),
    approvedByUserId: uuid("approved_by_user_id"),
    ...timestamps,
  },
  (t) => [index("salary_advances_emp_idx").on(t.employeeId)],
);

/**
 * END-OF-SERVICE SETTLEMENTS — the row that discharges the gratuity liability.
 *
 * `employees.gratuity_accrued` and the GRATUITY_PROVISION account have been
 * accumulating since the first migration, and until this table nothing in the
 * product could ever take money back out of them. An employee owed AED 84,000
 * was paid outside the system and the liability sat on the balance sheet
 * forever. One row here is the payment: what was calculated, on which rules, on
 * which dates, how much of it came out of the provision that was already
 * carried and how much hit this month's profit, and which journal moved it.
 *
 * Three things make this a record rather than a receipt.
 *
 *  1. IT IS A SNAPSHOT, NOT A POINTER. Basic salary, total package, joining
 *     date, service days, daily wage, day counts and the engine's own
 *     plain-language explanation are all copied in at settlement time. An
 *     employee's salary changes; a settlement figure computed from today's
 *     salary two years after they left is not the figure that was paid, and a
 *     register that cannot reproduce the number it paid is worth nothing in a
 *     MOHRE dispute.
 *
 *  2. IT BOUNDS A PERIOD OF SERVICE. `service_period_start` and
 *     `service_period_end` say exactly which days were bought. That is what
 *     makes edge case EC-05 — rehire after a payout — safe: the service clock
 *     for any later period starts after the last settled day, so no day can be
 *     paid for twice, and it is derived from these columns rather than from a
 *     joining date somebody remembered to edit. See
 *     `employees.service_restarted_on`.
 *
 *  3. IT RECORDS WHICH LEGAL READING WAS APPLIED. `reason` is stored as given,
 *     not collapsed to an amount, and `forfeiture_assumed` marks the one case
 *     where the figure rests on an unconfirmed position — open question Q-2b,
 *     whether an Article 44 gross-misconduct dismissal still forfeits the
 *     Article 51 benefit. If the answer comes back the other way, this column
 *     is how you find the settlements that have to be revisited. Without it the
 *     zeros are indistinguishable from employees who were simply under a year.
 *
 * Rows are never deleted and `employee_id` is `restrict` for the same reason:
 * this is the evidence that a statutory payment was made.
 */
export const gratuitySettlements = pgTable(
  "gratuity_settlements",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "restrict" }),

    /** Human-facing reference, from the `gratuity_settlement` number series. */
    settlementNumber: varchar("settlement_number", { length: 40 }).notNull(),
    /** resignation · termination · gross_misconduct — passed to the engine as given. */
    reason: varchar("reason", { length: 30 }).notNull(),

    lastWorkingDay: date("last_working_day").notNull(),
    /** Posting date of the journal. Usually the last working day. */
    settledOn: date("settled_on").notNull(),

    /** Snapshots — see (1) above. `joined_on` is copied, never followed. */
    joinedOn: date("joined_on").notNull(),
    servicePeriodStart: date("service_period_start").notNull(),
    servicePeriodEnd: date("service_period_end").notNull(),
    unpaidLeaveDays: integer("unpaid_leave_days").notNull().default(0),
    basicSalary: money("basic_salary").notNull(),
    totalSalary: money("total_salary").notNull(),

    serviceDays: integer("service_days").notNull(),
    serviceYears: qty("service_years").notNull(),
    dailyBasicWage: money("daily_basic_wage").notNull(),
    /** Days of wage earned — the 21/30 band arithmetic, before the cap. */
    gratuityDays: qty("gratuity_days").notNull(),

    gratuityGross: money("gratuity_gross").notNull(),
    /** The two-year total-wage ceiling, when it actually bit. Null otherwise. */
    gratuityCap: money("gratuity_cap"),
    gratuityAmount: money("gratuity_amount").notNull(),

    /**
     * The three-way split that keeps the payout off the P&L except where it
     * belongs. `provision_applied` is what was already carried for this person
     * and is released in full; the difference against the entitlement is either
     * a shortfall (an expense this month, because the accrual under-provided) or
     * an excess (a credit, because it over-provided). Exactly one of the last
     * two is non-zero.
     */
    provisionApplied: money("provision_applied").notNull().default("0"),
    expenseShortfall: money("expense_shortfall").notNull().default("0"),
    provisionReleased: money("provision_released").notNull().default("0"),

    /** Everything else owed on the last day. Entered, not derived — nothing in
     *  the product accrues leave or notice yet. */
    unpaidSalary: money("unpaid_salary").notNull().default("0"),
    leaveEncashment: money("leave_encashment").notNull().default("0"),
    noticePay: money("notice_pay").notNull().default("0"),
    otherEarnings: money("other_earnings").notNull().default("0"),
    /** Outstanding salary advances cleared against the settlement. */
    advanceRecovered: money("advance_recovered").notNull().default("0"),

    netPayable: money("net_payable").notNull(),
    /** bank_transfer · wps · cash · payable (settle later through the bank run) */
    settledVia: varchar("settled_via", { length: 20 }).notNull().default("bank_transfer"),

    /** True when the amount rests on the unconfirmed Q-2b forfeiture reading. */
    forfeitureAssumed: boolean("forfeiture_assumed").notNull().default(false),
    /** The engine's own sentence, stored verbatim so the row explains itself. */
    explanation: text("explanation").notNull(),
    /** Full input and result snapshot — the reprint contract `payslips` uses. */
    breakdown: metadata("breakdown"),

    journalId: uuid("journal_id"),
    settledByUserId: uuid("settled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("gratuity_settlements_number_uq").on(t.tenantId, t.settlementNumber),
    // The lookup that resolves the service clock: latest settled day per
    // employee. Descending because it is always the most recent one that
    // matters.
    index("gratuity_settlements_emp_idx").on(t.employeeId, t.servicePeriodEnd),
  ],
);

export const employeesRelations = relations(employees, ({ one, many }) => ({
  party: one(parties, { fields: [employees.partyId], references: [parties.id] }),
  businessUnit: one(businessUnits, {
    fields: [employees.primaryBusinessUnitId],
    references: [businessUnits.id],
  }),
  assignments: many(employeeAssignments),
  attendance: many(attendance),
}));
