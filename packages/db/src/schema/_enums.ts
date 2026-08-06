import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Enums are deliberately coarse. Every place where a business will want its own
 * vocabulary (job types, lead sources, expense categories) is a lookup *table*,
 * not an enum — enums require a migration to extend and tenants cannot be
 * trusted to wait for one.
 */

// ── Tenancy ─────────────────────────────────────────────────────────────────

/**
 * The single most important decision in this schema.
 *
 * The brief listed 11 businesses. They are not 11 domains. Plumbing, electrical,
 * handyman, AC maintenance, cleaning and construction all share one lifecycle:
 * customer -> site -> scheduled visit -> technician + materials -> invoice.
 * They are ONE module (`field_service`) differentiated by service catalogue and
 * settings. Likewise a parking bay is a rentable unit with a lease, exactly like
 * an apartment. Collapsing these takes the build surface down by ~60%.
 */
export const businessKind = pgEnum("business_kind", [
  "salon", // appointment + chair/resource utilisation
  "retail", // counter POS, serialised goods (IMEI), warranty
  "ecommerce", // online channels, fulfilment
  "rental", // apartments, shops, parking bays — any leased space
  "field_service", // plumbing, electrical, AC, handyman, cleaning
  "construction", // projects: field_service + budgets, phases, retention
  "professional", // catch-all consulting/agency
  "other",
]);

export const moduleKey = pgEnum("module_key", [
  "crm",
  "sales",
  "pos",
  "inventory",
  "accounting",
  "hr",
  "rentals",
  "appointments",
  "field_service",
  "projects",
  "ecommerce",
  "marketing",
  "ai",
]);

// ── Identity & access ───────────────────────────────────────────────────────

export const membershipStatus = pgEnum("membership_status", [
  "invited",
  "active",
  "suspended",
  "removed",
]);

export const scopeLevel = pgEnum("scope_level", [
  "tenant", // every business
  "business_unit", // named businesses only
  "location", // named branches only
  "self", // only rows the user owns (a barber sees their own bookings)
]);

// ── Parties ─────────────────────────────────────────────────────────────────

export const partyType = pgEnum("party_type", ["person", "company"]);

export const leadStatus = pgEnum("lead_status", [
  "new",
  "contacted",
  "qualified",
  "quoted",
  "won",
  "lost",
  "dormant",
]);

// ── Catalogue & inventory ───────────────────────────────────────────────────

export const itemType = pgEnum("item_type", [
  "product", // stocked, physical
  "service", // labour / time
  "bundle", // composed of other items
  "fee", // delivery, callout, late fee
  "rent", // recurring charge line for leases
]);

export const trackingMode = pgEnum("tracking_mode", [
  "none", // consumables
  "quantity", // normal stock
  "serial", // IMEI, appliance serials — one row per physical unit
  "batch", // lot + expiry
]);

export const stockMoveReason = pgEnum("stock_move_reason", [
  "purchase",
  "sale",
  "return_in",
  "return_out",
  "transfer",
  "adjustment",
  "consumption", // used on a job
  "damage",
  "opening",
]);

// ── Documents & money ───────────────────────────────────────────────────────

/**
 * One polymorphic `documents` table instead of eight near-identical tables.
 * Quotation -> sales order -> invoice -> credit note is the same shape with a
 * different `doc_type` and posting rule. This is what makes "convert quote to
 * invoice" a one-row insert instead of a data migration.
 */
export const docType = pgEnum("doc_type", [
  "quotation",
  "sales_order",
  "invoice",
  "credit_note",
  "purchase_order",
  "bill",
  "debit_note",
]);

export const docStatus = pgEnum("doc_status", [
  "draft",
  "sent",
  "accepted",
  "confirmed",
  "partially_paid",
  "paid",
  "overdue",
  "cancelled",
  "void",
]);

export const paymentDirection = pgEnum("payment_direction", ["in", "out"]);

export const paymentMethod = pgEnum("payment_method", [
  "cash",
  "card", // card penetration in the UAE is very high
  "bank_transfer",
  "cheque", // includes cleared post-dated cheques — see the `cheques` register
  "digital_wallet", // Apple Pay / Samsung Pay / Google Pay
  "bnpl", // Tabby / Tamara — now mainstream for handset retail here
  "gateway", // Network International / Telr / PayTabs / Stripe
  "credit", // on account
  "adjustment",
]);

/**
 * How a lease is actually collected. In the UAE the default is a set of
 * post-dated cheques handed over when the tenancy contract is signed; bank
 * transfer is increasingly common but far from universal.
 */
export const collectionMethod = pgEnum("collection_method", [
  "post_dated_cheques",
  "bank_transfer",
  "direct_debit",
  "cash",
  "mixed",
]);

/**
 * Life of a physical cheque.
 *
 * This is a state machine, not a boolean, because each transition has real
 * consequences: a cheque sitting in the safe is not revenue, a bounced cheque
 * triggers a replacement chain and a bank charge, and the landlord must be able
 * to prove which physical instrument covered which rental period.
 */
export const chequeStatus = pgEnum("cheque_status", [
  "held", // in the safe, not yet due
  "deposited", // presented to the bank, awaiting clearance
  "cleared", // funds received
  "bounced", // returned unpaid
  "replaced", // swapped for a new cheque after a bounce or renegotiation
  "returned", // handed back to the drawer (early settlement, lease ended)
  "cancelled",
]);

export const installmentStatus = pgEnum("installment_status", [
  "scheduled",
  "due",
  "partially_paid",
  "paid",
  "overdue",
  "written_off",
]);

// ── Accounting ──────────────────────────────────────────────────────────────

export const accountType = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

export const normalBalance = pgEnum("normal_balance", ["debit", "credit"]);

export const journalSource = pgEnum("journal_source", [
  "manual",
  "invoice",
  "bill",
  "payment",
  "payroll",
  "stock",
  "depreciation",
  "fx_revaluation",
  "opening",
  "inter_company",
]);

export const periodStatus = pgEnum("period_status", ["open", "soft_closed", "closed"]);

/**
 * UAE VAT treatment. The rate alone is NOT sufficient information.
 *
 * Zero-rated and exempt both charge 0% output VAT, but they behave completely
 * differently on the input side: a business making zero-rated supplies recovers
 * its input VAT in full, while one making exempt supplies cannot recover input
 * VAT attributable to them. For this portfolio that distinction is worth real
 * money — residential rent is EXEMPT, so VAT on maintenance of those flats is a
 * cost, not a reclaim. Collapsing both to "0%" would silently overstate the
 * recoverable position on every VAT return.
 */
export const taxTreatment = pgEnum("tax_treatment", [
  "standard", // 5%
  "zero_rated", // 0%, input VAT fully recoverable (exports, new residential)
  "exempt", // no VAT, input VAT NOT recoverable (residential rent, bare land)
  "reverse_charge", // imported services — self-accounted
  "out_of_scope",
]);

// ── Field service & projects ────────────────────────────────────────────────

export const jobStatus = pgEnum("job_status", [
  "request", // customer asked, nothing scheduled
  "quoted",
  "scheduled",
  "dispatched",
  "in_progress",
  "on_hold",
  "completed",
  "invoiced",
  "cancelled",
]);

export const jobPriority = pgEnum("job_priority", ["low", "normal", "high", "emergency"]);

export const visitStatus = pgEnum("visit_status", [
  "planned",
  "en_route",
  "on_site",
  "done",
  "failed", // customer absent, wrong parts
  "cancelled",
]);

export const projectStatus = pgEnum("project_status", [
  "planning",
  "active",
  "on_hold",
  "handover",
  "closed",
  "cancelled",
]);

// ── Appointments (salon) ────────────────────────────────────────────────────

export const appointmentStatus = pgEnum("appointment_status", [
  "booked",
  "confirmed",
  "checked_in",
  "in_service",
  "completed",
  "no_show",
  "cancelled",
]);

export const resourceKind = pgEnum("resource_kind", [
  "chair",
  "room",
  "bay",
  "equipment",
  "vehicle",
]);

// ── Rentals (property + parking) ────────────────────────────────────────────

export const unitKind = pgEnum("unit_kind", [
  "apartment",
  "room",
  "shop",
  "office",
  "warehouse",
  "parking_bay",
  "storage",
  "land",
]);

export const unitStatus = pgEnum("unit_status", [
  "available",
  "reserved",
  "occupied",
  "notice", // tenant leaving, countdown to vacancy
  "maintenance",
  "off_market",
]);

export const leaseStatus = pgEnum("lease_status", [
  "draft",
  "active",
  "expiring",
  "ended",
  "terminated",
  "defaulted",
]);

export const chargeFrequency = pgEnum("charge_frequency", [
  "one_off",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);

// ── HR ──────────────────────────────────────────────────────────────────────

export const employmentStatus = pgEnum("employment_status", [
  "applicant",
  "probation",
  "active",
  "on_leave",
  "suspended",
  "resigned",
  "terminated",
]);

export const payBasis = pgEnum("pay_basis", [
  "monthly",
  "daily",
  "hourly",
  "commission_only",
  "base_plus_commission",
]);

export const attendanceStatus = pgEnum("attendance_status", [
  "present",
  "late",
  "half_day",
  "absent",
  "leave",
  "holiday",
  "weekly_off",
]);

export const commissionBasis = pgEnum("commission_basis", [
  "revenue_percent",
  "profit_percent",
  "flat_per_unit",
  "tiered",
]);

// ── Commerce channels ───────────────────────────────────────────────────────

export const channelKind = pgEnum("channel_kind", [
  "own_store",
  "marketplace",
  "social",
  "pos",
  "phone",
  "walk_in",
]);

export const fulfilmentStatus = pgEnum("fulfilment_status", [
  "pending",
  "picking",
  "packed",
  "shipped",
  "delivered",
  "returned",
  "cancelled",
]);

// ── Platform: automation, AI, notifications ─────────────────────────────────

export const automationTrigger = pgEnum("automation_trigger", [
  "schedule",
  "record_created",
  "record_updated",
  "status_changed",
  "threshold_crossed",
  "date_offset", // "3 days before due date"
  "webhook",
]);

export const runStatus = pgEnum("run_status", [
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
]);

export const insightSeverity = pgEnum("insight_severity", [
  "info",
  "opportunity",
  "warning",
  "critical",
]);

export const insightStatus = pgEnum("insight_status", [
  "new",
  "acknowledged",
  "acted",
  "dismissed",
  "expired",
]);

export const notificationChannel = pgEnum("notification_channel", [
  "in_app",
  "email",
  "sms",
  "whatsapp",
  "push",
]);
