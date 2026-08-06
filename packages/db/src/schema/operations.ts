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
  appointmentStatus,
  chargeFrequency,
  collectionMethod,
  jobPriority,
  jobStatus,
  leaseStatus,
  projectStatus,
  resourceKind,
  unitKind,
  unitStatus,
  visitStatus,
} from "./_enums.ts";
import { metadata, money, pk, qty, rate, timestamps } from "./_shared.ts";
import { businessUnits, locations, tenants } from "./tenancy.ts";
import { parties } from "./parties.ts";
import { items } from "./catalog.ts";
import { users } from "./identity.ts";

// ════════════════════════════════════════════════════════════════════════════
//  SITES — the shared "where does work happen / what is rentable" spine
// ════════════════════════════════════════════════════════════════════════════

/**
 * A property, lot or customer premises.
 *
 * Unifying "the apartment building I own", "the car park I run" and "the
 * customer address where my plumber is going" into one table is what enables
 * the feature no off-the-shelf ERP gives this owner: when his own AC company
 * services his own rental flat, both sides reference the SAME site, the job
 * cost lands on that unit's P&L, and an inter-company invoice is generated.
 */
export const sites = pgTable(
  "sites",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** NULL when the site is a customer's premises rather than an owned asset. */
    ownerBusinessUnitId: uuid("owner_business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    /** Set when the site belongs to an external customer. */
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    code: varchar("code", { length: 30 }),
    name: varchar("name", { length: 200 }).notNull(),
    addressLine: text("address_line"),
    city: varchar("city", { length: 100 }),
    area: varchar("area", { length: 100 }),
    lat: varchar("lat", { length: 24 }),
    lng: varchar("lng", { length: 24 }),
    isOwnedAsset: boolean("is_owned_asset").notNull().default(false),
    accessNotes: text("access_notes"),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    index("sites_tenant_idx").on(t.tenantId),
    index("sites_party_idx").on(t.partyId),
    uniqueIndex("sites_code_uq").on(t.tenantId, t.code),
  ],
);

// ════════════════════════════════════════════════════════════════════════════
//  RENTALS — apartments AND parking bays. One module.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A rentable unit. `unitKind` distinguishes a 3-bed flat from parking bay B-14.
 *
 * The brief listed "Apartment & Property Rental" and "Parking Business" as two
 * separate businesses. Operationally they are: different customers, different
 * pricing. Structurally they are identical — a space, let to a party, for a
 * term, at a recurring charge, with an occupancy rate. Building them twice
 * would double the code and halve the quality of both.
 */
export const units = pgTable(
  "units",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 150 }),
    kind: unitKind("kind").notNull(),
    status: unitStatus("status").notNull().default("available"),
    floor: varchar("floor", { length: 20 }),
    areaSqft: qty("area_sqft"),
    bedrooms: integer("bedrooms"),
    bathrooms: integer("bathrooms"),
    /** The advertised rate; the lease may differ after negotiation. */
    listRent: money("list_rent").notNull().default("0"),
    listFrequency: chargeFrequency("list_frequency").notNull().default("monthly"),
    depositMonths: qty("deposit_months").notNull().default("1"),
    /** Acquisition/build cost — required to report yield, not just revenue. */
    acquisitionCost: money("acquisition_cost"),
    amenities: jsonb("amenities").notNull().default(sql`'[]'::jsonb`),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("units_site_code_uq").on(t.siteId, t.code),
    index("units_bu_status_idx").on(t.businessUnitId, t.status),
  ],
);

export const leases = pgTable(
  "leases",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    leaseNumber: varchar("lease_number", { length: 40 }).notNull(),
    status: leaseStatus("status").notNull().default("draft"),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    /** Auto-renew rolls the term forward; the expiry watcher skips these. */
    autoRenew: boolean("auto_renew").notNull().default(false),
    noticePeriodDays: integer("notice_period_days").notNull().default(30),

    /**
     * UAE tenancy contracts are quoted and registered ANNUALLY, then collected
     * in instalments. Storing the annual figure as the contractual truth and
     * deriving the monthly accrual from it — rather than the reverse — is what
     * makes the lease agree with the Ejari certificate and the cheque bundle.
     */
    annualRent: money("annual_rent").notNull().default("0"),
    rentAmount: money("rent_amount").notNull(),
    frequency: chargeFrequency("frequency").notNull().default("monthly"),
    /** Day of month rent falls due — drives the billing job and the AR ageing. */
    billingDay: integer("billing_day").notNull().default(1),

    /** How the tenant actually pays: cheque bundle, transfer, or a mix. */
    collectionMethod: collectionMethod("collection_method").notNull().default("post_dated_cheques"),
    /** 1, 2, 4, 6 or 12 — the negotiating currency of a UAE tenancy. Fewer
     *  cheques means a lower rent; more cheques means a premium. */
    chequeCount: integer("cheque_count"),

    /**
     * Ejari registration. Legally mandatory in Dubai: an unregistered tenancy
     * cannot be enforced at the Rental Dispute Centre, and the tenant cannot
     * activate DEWA. An unregistered active lease is a live compliance risk, so
     * it is a column rather than a note.
     */
    ejariNumber: varchar("ejari_number", { length: 40 }),
    ejariRegisteredOn: date("ejari_registered_on"),
    dewaPremiseNumber: varchar("dewa_premise_number", { length: 40 }),

    depositAmount: money("deposit_amount").notNull().default("0"),
    depositHeld: money("deposit_held").notNull().default("0"),
    /** Annual uplift, e.g. 0.05 for 5%. Applied by the escalation job. */
    escalationRate: rate("escalation_rate").notNull().default("0"),
    lateFeeRate: rate("late_fee_rate").notNull().default("0"),
    graceDays: integer("grace_days").notNull().default(5),

    /** Denormalised collection health — powers the "overdue tenants" widget. */
    balanceDue: money("balance_due").notNull().default("0"),
    lastPaidOn: date("last_paid_on"),
    consecutiveLateMonths: integer("consecutive_late_months").notNull().default(0),

    terminatedOn: date("terminated_on"),
    terminationReason: text("termination_reason"),
    documentUrl: text("document_url"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("leases_number_uq").on(t.tenantId, t.leaseNumber),
    index("leases_unit_idx").on(t.unitId, t.status),
    index("leases_party_idx").on(t.partyId),
    index("leases_status_end_idx").on(t.tenantId, t.status, t.endsOn),
  ],
);

/** Recurring charge schedule attached to a lease: rent, service charge,
 *  utilities, parking add-on. Each generates an invoice line on its cycle. */
export const leaseCharges = pgTable(
  "lease_charges",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    leaseId: uuid("lease_id")
      .notNull()
      .references(() => leases.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    label: varchar("label", { length: 120 }).notNull(),
    amount: money("amount").notNull(),
    frequency: chargeFrequency("frequency").notNull().default("monthly"),
    /** Metered charges are amount × reading delta rather than a flat fee. */
    isMetered: boolean("is_metered").notNull().default(false),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    lastBilledOn: date("last_billed_on"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("lease_charges_lease_idx").on(t.leaseId)],
);

export const meterReadings = pgTable(
  "meter_readings",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    meterType: varchar("meter_type", { length: 20 }).notNull(),
    readOn: date("read_on").notNull(),
    reading: qty("reading").notNull(),
    previousReading: qty("previous_reading"),
    consumption: qty("consumption"),
    photoUrl: text("photo_url"),
    ...timestamps,
  },
  (t) => [uniqueIndex("meter_readings_uq").on(t.unitId, t.meterType, t.readOn)],
);

// ════════════════════════════════════════════════════════════════════════════
//  FIELD SERVICE — plumbing, electrical, AC, handyman, cleaning, construction
// ════════════════════════════════════════════════════════════════════════════

/**
 * Work order. The brief listed six trades as six businesses; they differ only
 * in service catalogue, required skill and default duration. `serviceKind` is a
 * free string (seeded per business) rather than an enum precisely so adding
 * "pest control" next year needs no migration.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    jobNumber: varchar("job_number", { length: 40 }).notNull(),
    serviceKind: varchar("service_kind", { length: 40 }).notNull(),
    title: varchar("title", { length: 250 }).notNull(),
    description: text("description"),

    partyId: uuid("party_id").references(() => parties.id, { onDelete: "restrict" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    /** Set when the work is on the owner's own rental unit → inter-company. */
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    projectId: uuid("project_id"),

    status: jobStatus("status").notNull().default("request"),
    priority: jobPriority("priority").notNull().default("normal"),

    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    /** SLA target. Breach is what the alerting engine watches. */
    respondBy: timestamp("respond_by", { withTimezone: true }),
    completeBy: timestamp("complete_by", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    estimatedValue: money("estimated_value"),
    quotedValue: money("quoted_value"),
    /** Actuals accumulated from visits + consumed materials. Job-level margin
     *  is the number that tells this owner which trade is actually worth doing. */
    laborCost: money("labor_cost").notNull().default("0"),
    materialCost: money("material_cost").notNull().default("0"),
    invoicedValue: money("invoiced_value").notNull().default("0"),

    /** Recurring maintenance contracts (AMC) — the AC and cleaning businesses
     *  live on these, and they are the most predictable revenue in the group. */
    contractId: uuid("contract_id"),
    isWarrantyWork: boolean("is_warranty_work").notNull().default(false),

    assignedTeamId: uuid("assigned_team_id"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    customerRating: integer("customer_rating"),
    customerFeedback: text("customer_feedback"),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("jobs_number_uq").on(t.tenantId, t.jobNumber),
    index("jobs_bu_status_idx").on(t.businessUnitId, t.status),
    index("jobs_party_idx").on(t.partyId),
    index("jobs_sla_idx").on(t.tenantId, t.status, t.completeBy),
    index("jobs_unit_idx").on(t.unitId),
  ],
);

/** One scheduled attendance on site. A job can need three visits. */
export const jobVisits = pgTable(
  "job_visits",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(1),
    employeeId: uuid("employee_id"),
    status: visitStatus("status").notNull().default("planned"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
    actualStart: timestamp("actual_start", { withTimezone: true }),
    actualEnd: timestamp("actual_end", { withTimezone: true }),
    /** Captured by the mobile app — proof of attendance for disputes. */
    checkInLat: varchar("check_in_lat", { length: 24 }),
    checkInLng: varchar("check_in_lng", { length: 24 }),
    travelMinutes: integer("travel_minutes"),
    workMinutes: integer("work_minutes"),
    failureReason: varchar("failure_reason", { length: 200 }),
    customerSignatureUrl: text("customer_signature_url"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("job_visits_job_idx").on(t.jobId, t.seq),
    index("job_visits_emp_sched_idx").on(t.employeeId, t.scheduledStart),
  ],
);

/** Labour and materials consumed. Materials generate a `consumption` stock move. */
export const jobLines = pgTable(
  "job_lines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "set null" }),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    quantity: qty("quantity").notNull().default("1"),
    unitCost: money("unit_cost").notNull().default("0"),
    unitPrice: money("unit_price").notNull().default("0"),
    isBillable: boolean("is_billable").notNull().default(true),
    isInvoiced: boolean("is_invoiced").notNull().default(false),
    employeeId: uuid("employee_id"),
    ...timestamps,
  },
  (t) => [index("job_lines_job_idx").on(t.jobId)],
);

export const jobPhotos = pgTable(
  "job_photos",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("progress"),
    caption: text("caption"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    uploadedByUserId: uuid("uploaded_by_user_id"),
    ...timestamps,
  },
  (t) => [index("job_photos_job_idx").on(t.jobId)],
);

/** Recurring maintenance contract (AMC) — auto-generates jobs on schedule. */
export const serviceContracts = pgTable(
  "service_contracts",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    contractNumber: varchar("contract_number", { length: 40 }).notNull(),
    serviceKind: varchar("service_kind", { length: 40 }).notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    visitsPerYear: integer("visits_per_year").notNull().default(4),
    contractValue: money("contract_value").notNull(),
    billingFrequency: chargeFrequency("billing_frequency").notNull().default("quarterly"),
    nextVisitDue: date("next_visit_due"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("service_contracts_number_uq").on(t.tenantId, t.contractNumber),
    index("service_contracts_due_idx").on(t.tenantId, t.nextVisitDue),
  ],
);

/** Construction projects: a budgeted container for many jobs. */
export const projects = pgTable(
  "projects",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 250 }).notNull(),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    status: projectStatus("status").notNull().default("planning"),
    startsOn: date("starts_on"),
    targetEndOn: date("target_end_on"),
    actualEndOn: date("actual_end_on"),

    contractValue: money("contract_value").notNull().default("0"),
    budgetCost: money("budget_cost").notNull().default("0"),
    actualCost: money("actual_cost").notNull().default("0"),
    /** Percent complete drives revenue recognition on long contracts. */
    percentComplete: rate("percent_complete").notNull().default("0"),
    billedToDate: money("billed_to_date").notNull().default("0"),
    /** Retention withheld by the client until defects liability expires. */
    retentionRate: rate("retention_rate").notNull().default("0"),
    retentionHeld: money("retention_held").notNull().default("0"),
    managerUserId: uuid("manager_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("projects_code_uq").on(t.tenantId, t.code),
    index("projects_bu_status_idx").on(t.businessUnitId, t.status),
  ],
);

// ════════════════════════════════════════════════════════════════════════════
//  APPOINTMENTS — salon today, clinics/studios tomorrow
// ════════════════════════════════════════════════════════════════════════════

/** A bookable thing: a chair, a treatment room, a wash bay, a rental car. */
export const resources = pgTable(
  "resources",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    kind: resourceKind("kind").notNull().default("chair"),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    /** Default operator; a walk-in can be reassigned. */
    defaultEmployeeId: uuid("default_employee_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("resources_bu_code_uq").on(t.businessUnitId, t.code)],
);

export const appointments = pgTable(
  "appointments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    reference: varchar("reference", { length: 40 }).notNull(),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    /** Walk-ins have no party record yet — do not force one, it kills adoption. */
    walkInName: varchar("walk_in_name", { length: 150 }),
    walkInPhone: varchar("walk_in_phone", { length: 40 }),

    resourceId: uuid("resource_id").references(() => resources.id, { onDelete: "set null" }),
    employeeId: uuid("employee_id"),
    status: appointmentStatus("status").notNull().default("booked"),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    serviceStartedAt: timestamp("service_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    estimatedValue: money("estimated_value").notNull().default("0"),
    documentId: uuid("document_id"),
    source: varchar("source", { length: 30 }).notNull().default("walk_in"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("appointments_ref_uq").on(t.tenantId, t.reference),
    index("appointments_bu_start_idx").on(t.businessUnitId, t.startsAt),
    index("appointments_resource_start_idx").on(t.resourceId, t.startsAt),
    index("appointments_employee_start_idx").on(t.employeeId, t.startsAt),
    index("appointments_party_idx").on(t.partyId),
  ],
);

export const appointmentServices = pgTable(
  "appointment_services",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id"),
    price: money("price").notNull().default("0"),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    ...timestamps,
  },
  (t) => [index("appointment_services_appt_idx").on(t.appointmentId)],
);

/** Prepaid packages and memberships — salon "10 haircuts", gym monthly,
 *  parking season ticket. Deferred revenue until redeemed. */
export const membershipPlans = pgTable(
  "membership_plans",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 150 }).notNull(),
    price: money("price").notNull(),
    validityDays: integer("validity_days").notNull().default(365),
    /** Either a credit balance or a service count, not both. */
    creditAmount: money("credit_amount"),
    includedVisits: integer("included_visits"),
    discountRate: rate("discount_rate").notNull().default("0"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("membership_plans_bu_idx").on(t.businessUnitId)],
);

export const partyMemberships = pgTable(
  "party_memberships",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "restrict" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    purchasedOn: date("purchased_on").notNull(),
    expiresOn: date("expires_on").notNull(),
    creditRemaining: money("credit_remaining").notNull().default("0"),
    visitsRemaining: integer("visits_remaining"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("party_memberships_party_idx").on(t.partyId, t.isActive)],
);

/** Staff working hours + exceptions; the availability engine reads both. */
export const staffSchedules = pgTable(
  "staff_schedules",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").notNull(),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    /** 0 = Sunday. NULL weekday + a date = a one-off override. */
    weekday: integer("weekday"),
    onDate: date("on_date"),
    startTime: time("start_time"),
    endTime: time("end_time"),
    isAvailable: boolean("is_available").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("staff_schedules_emp_idx").on(t.employeeId, t.weekday),
    index("staff_schedules_date_idx").on(t.employeeId, t.onDate),
  ],
);

export const unitsRelations = relations(units, ({ one, many }) => ({
  site: one(sites, { fields: [units.siteId], references: [sites.id] }),
  leases: many(leases),
}));

export const leasesRelations = relations(leases, ({ one, many }) => ({
  unit: one(units, { fields: [leases.unitId], references: [units.id] }),
  party: one(parties, { fields: [leases.partyId], references: [parties.id] }),
  charges: many(leaseCharges),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  party: one(parties, { fields: [jobs.partyId], references: [parties.id] }),
  site: one(sites, { fields: [jobs.siteId], references: [sites.id] }),
  businessUnit: one(businessUnits, {
    fields: [jobs.businessUnitId],
    references: [businessUnits.id],
  }),
  visits: many(jobVisits),
  lines: many(jobLines),
}));

export const appointmentsRelations = relations(appointments, ({ one, many }) => ({
  party: one(parties, { fields: [appointments.partyId], references: [parties.id] }),
  resource: one(resources, { fields: [appointments.resourceId], references: [resources.id] }),
  services: many(appointmentServices),
}));
