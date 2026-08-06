/**
 * Reference data: chart of accounts, permission catalogue, system roles.
 *
 * This is the part of an ERP that decides whether the accounting is real or
 * decorative. The chart below is a small, opinionated set — big enough to
 * produce a genuine P&L, balance sheet and cash-flow statement, small enough
 * that a non-accountant owner is not asked to choose between 400 accounts.
 *
 * Localised for the UAE (Dubai mainland). The UAE-specific accounts are not
 * decoration; each one exists because leaving it out produces a wrong number:
 *
 *  • PDC control accounts — a year of post-dated cheques in the safe is neither
 *    cash nor a receivable, and booking it as either misstates the balance sheet
 *    by an entire year's rent.
 *  • End-of-service gratuity provision — a liability that accrues daily under
 *    Federal Decree-Law 33/2021 and that owners routinely discover only when
 *    someone resigns.
 *  • Irrecoverable input VAT — residential rent is exempt, so VAT on the costs
 *    of those flats is an expense, not a reclaim.
 *  • Corporate tax provision — 9% above AED 375,000 since June 2023.
 */

export interface AccountSeed {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  systemKey?: string;
  cashFlowSection?: "operating" | "investing" | "financing";
  isPostable?: boolean;
}

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // ── Assets ────────────────────────────────────────────────────────────────
  { code: "1000", name: "Assets", type: "asset", isPostable: false },
  { code: "1100", name: "Cash in Hand", type: "asset", systemKey: "CASH", cashFlowSection: "operating" },
  { code: "1110", name: "Bank Accounts", type: "asset", systemKey: "BANK", cashFlowSection: "operating" },
  { code: "1120", name: "Card Settlement in Transit", type: "asset", systemKey: "CARD_CLEARING", cashFlowSection: "operating" },
  { code: "1130", name: "Cash with Courier (COD float)", type: "asset", systemKey: "COD_FLOAT", cashFlowSection: "operating" },
  /** Post-dated cheques physically held. Not cash — not yet bankable. */
  { code: "1140", name: "Post-Dated Cheques on Hand", type: "asset", systemKey: "PDC_ON_HAND", cashFlowSection: "operating" },
  { code: "1150", name: "Cheques Deposited (uncleared)", type: "asset", systemKey: "PDC_DEPOSITED", cashFlowSection: "operating" },
  { code: "1200", name: "Accounts Receivable", type: "asset", systemKey: "AR", cashFlowSection: "operating" },
  { code: "1210", name: "Rent Receivable", type: "asset", systemKey: "AR_RENT", cashFlowSection: "operating" },
  { code: "1220", name: "Installments Receivable", type: "asset", systemKey: "AR_INSTALLMENT", cashFlowSection: "operating" },
  { code: "1300", name: "Inventory", type: "asset", systemKey: "INVENTORY", cashFlowSection: "operating" },
  { code: "1400", name: "Staff Advances", type: "asset", systemKey: "STAFF_ADVANCE", cashFlowSection: "operating" },
  /** Refundable deposits are everywhere in the UAE: DEWA, landlord, Ejari. */
  { code: "1410", name: "Refundable Deposits Paid (DEWA / Landlord)", type: "asset", systemKey: "DEPOSITS_PAID", cashFlowSection: "operating" },
  { code: "1500", name: "Property & Equipment", type: "asset", systemKey: "PPE", cashFlowSection: "investing" },
  { code: "1510", name: "Accumulated Depreciation", type: "asset", systemKey: "ACCUM_DEP", cashFlowSection: "investing" },
  { code: "1600", name: "Recoverable Input VAT", type: "asset", systemKey: "VAT_INPUT", cashFlowSection: "operating" },
  { code: "1700", name: "Due from Group Companies", type: "asset", systemKey: "INTERCO_DUE_FROM", cashFlowSection: "operating" },

  // ── Liabilities ───────────────────────────────────────────────────────────
  { code: "2000", name: "Liabilities", type: "liability", isPostable: false },
  { code: "2100", name: "Accounts Payable", type: "liability", systemKey: "AP", cashFlowSection: "operating" },
  { code: "2200", name: "Output VAT", type: "liability", systemKey: "VAT_OUTPUT", cashFlowSection: "operating" },
  { code: "2210", name: "VAT Payable to FTA", type: "liability", systemKey: "VAT_PAYABLE", cashFlowSection: "operating" },
  { code: "2300", name: "Salaries Payable (WPS)", type: "liability", systemKey: "SALARY_PAYABLE", cashFlowSection: "operating" },
  { code: "2310", name: "Commission Payable", type: "liability", systemKey: "COMMISSION_PAYABLE", cashFlowSection: "operating" },
  /** Accrues every day of every employee's service. */
  { code: "2320", name: "End-of-Service Gratuity Provision", type: "liability", systemKey: "GRATUITY_PROVISION", cashFlowSection: "operating" },
  { code: "2330", name: "Leave Salary Provision", type: "liability", systemKey: "LEAVE_PROVISION", cashFlowSection: "operating" },
  { code: "2400", name: "Tenant Security Deposits", type: "liability", systemKey: "TENANT_DEPOSIT", cashFlowSection: "financing" },
  /** Cheques received for periods not yet invoiced — the contra to 1140. */
  { code: "2410", name: "Rent Received in Advance", type: "liability", systemKey: "RENT_IN_ADVANCE", cashFlowSection: "operating" },
  { code: "2500", name: "Customer Advances", type: "liability", systemKey: "CUSTOMER_ADVANCE", cashFlowSection: "operating" },
  { code: "2510", name: "Deferred Revenue (Memberships)", type: "liability", systemKey: "DEFERRED_REVENUE", cashFlowSection: "operating" },
  { code: "2600", name: "Loans Payable", type: "liability", systemKey: "LOAN", cashFlowSection: "financing" },
  { code: "2700", name: "Due to Group Companies", type: "liability", systemKey: "INTERCO_DUE_TO", cashFlowSection: "operating" },
  { code: "2800", name: "Corporate Tax Payable", type: "liability", systemKey: "CORP_TAX_PAYABLE", cashFlowSection: "operating" },

  // ── Equity ────────────────────────────────────────────────────────────────
  { code: "3000", name: "Equity", type: "equity", isPostable: false },
  { code: "3100", name: "Owner Capital", type: "equity", systemKey: "CAPITAL", cashFlowSection: "financing" },
  /**
   * The account that saves owner-operated groups from themselves. Without a
   * dedicated drawings account, personal spending is booked as business expense
   * and every profit figure in the system is wrong.
   */
  { code: "3200", name: "Owner Drawings", type: "equity", systemKey: "DRAWINGS", cashFlowSection: "financing" },
  { code: "3300", name: "Retained Earnings", type: "equity", systemKey: "RETAINED", cashFlowSection: "financing" },

  // ── Income ────────────────────────────────────────────────────────────────
  { code: "4000", name: "Income", type: "income", isPostable: false },
  { code: "4100", name: "Service Revenue", type: "income", systemKey: "REV_SERVICE" },
  { code: "4200", name: "Product Sales", type: "income", systemKey: "REV_PRODUCT" },
  /** VAT-EXEMPT under UAE VAT law — kept in its own account so the VAT return's
   *  exempt-supplies box and the input-apportionment ratio are both derivable. */
  { code: "4300", name: "Residential Rental Income (VAT exempt)", type: "income", systemKey: "REV_RENT" },
  /** Standalone parking is a STANDARD-rated supply at 5%, unlike the flats. */
  { code: "4310", name: "Parking Income (standard rated)", type: "income", systemKey: "REV_PARKING" },
  { code: "4320", name: "Commercial Rental Income (standard rated)", type: "income", systemKey: "REV_RENT_COMMERCIAL" },
  { code: "4400", name: "Contract Revenue", type: "income", systemKey: "REV_CONTRACT" },
  { code: "4500", name: "Other Income", type: "income", systemKey: "REV_OTHER" },
  { code: "4600", name: "Sales Discounts", type: "income", systemKey: "DISCOUNT" },

  // ── Expense ───────────────────────────────────────────────────────────────
  { code: "5000", name: "Expenses", type: "expense", isPostable: false },
  { code: "5100", name: "Cost of Goods Sold", type: "expense", systemKey: "COGS" },
  { code: "5110", name: "Materials & Consumables", type: "expense", systemKey: "MATERIALS" },
  { code: "5120", name: "Subcontractor Costs", type: "expense", systemKey: "SUBCONTRACTOR" },
  { code: "5200", name: "Salaries & Wages", type: "expense", systemKey: "SALARY" },
  { code: "5210", name: "Staff Commission", type: "expense", systemKey: "COMMISSION" },
  { code: "5300", name: "Rent & Premises", type: "expense", systemKey: "RENT_EXPENSE" },
  { code: "5310", name: "Utilities", type: "expense", systemKey: "UTILITIES" },
  { code: "5400", name: "Marketing & Advertising", type: "expense", systemKey: "MARKETING" },
  { code: "5500", name: "Transport & Fuel", type: "expense", systemKey: "TRANSPORT" },
  { code: "5600", name: "Repairs & Maintenance", type: "expense", systemKey: "REPAIRS" },
  { code: "5700", name: "Professional Fees", type: "expense", systemKey: "PROFESSIONAL" },
  { code: "5800", name: "Bank & Payment Charges", type: "expense", systemKey: "BANK_CHARGES" },
  /** Bounced-cheque charges are a recurring, avoidable cost worth isolating. */
  { code: "5810", name: "Returned Cheque Charges", type: "expense", systemKey: "CHEQUE_CHARGES" },
  { code: "5900", name: "Depreciation", type: "expense", systemKey: "DEPRECIATION" },
  { code: "5950", name: "Bad Debt Written Off", type: "expense", systemKey: "BAD_DEBT" },

  // ── UAE-specific operating costs ──────────────────────────────────────────
  { code: "5230", name: "End-of-Service Gratuity Expense", type: "expense", systemKey: "GRATUITY_EXPENSE" },
  { code: "5240", name: "Visa, Labour Card & Medical", type: "expense", systemKey: "VISA_COSTS" },
  { code: "5710", name: "Trade Licence & Government Fees", type: "expense", systemKey: "LICENSE_FEES" },
  /** Input VAT that cannot be reclaimed because it relates to exempt
   *  (residential) supplies. It is a real cost and must hit the P&L. */
  { code: "5720", name: "Irrecoverable Input VAT", type: "expense", systemKey: "VAT_IRRECOVERABLE" },
  { code: "5980", name: "Corporate Tax Expense", type: "expense", systemKey: "CORP_TAX_EXPENSE" },
  { code: "5990", name: "Other Expenses", type: "expense", systemKey: "OTHER_EXPENSE" },
];

/**
 * UAE VAT codes.
 *
 * Note that VAT5 and PARKING both charge 5% but exist separately from RENT_EXEMPT
 * — the whole point is that treatment, not rate, decides input recovery.
 */
export interface TaxCodeSeed {
  code: string;
  name: string;
  rate: string;
  treatment: "standard" | "zero_rated" | "exempt" | "reverse_charge" | "out_of_scope";
  inputRecoverable: boolean;
  isInclusive: boolean;
  /** VAT201 box this supply feeds. */
  reportingCode: string;
}

export const UAE_TAX_CODES: TaxCodeSeed[] = [
  {
    code: "VAT5",
    name: "VAT 5% (standard rated)",
    rate: "0.050000",
    treatment: "standard",
    inputRecoverable: true,
    // Retail here quotes VAT-inclusive prices; B2B quotes exclusive. Inclusive
    // is the safer default because a shelf price is what the customer pays.
    isInclusive: true,
    reportingCode: "VAT201-Box1",
  },
  {
    code: "VAT0",
    name: "Zero rated (exports, new residential)",
    rate: "0.000000",
    treatment: "zero_rated",
    inputRecoverable: true,
    isInclusive: false,
    reportingCode: "VAT201-Box4",
  },
  {
    code: "EXEMPT",
    name: "Exempt — residential rent",
    rate: "0.000000",
    treatment: "exempt",
    // The critical flag. Input VAT on maintaining exempt property is a cost.
    inputRecoverable: false,
    isInclusive: false,
    reportingCode: "VAT201-Box5",
  },
  {
    code: "RCM",
    name: "Reverse charge (imported services)",
    rate: "0.050000",
    treatment: "reverse_charge",
    inputRecoverable: true,
    isInclusive: false,
    reportingCode: "VAT201-Box3",
  },
  {
    code: "OOS",
    name: "Out of scope",
    rate: "0.000000",
    treatment: "out_of_scope",
    inputRecoverable: false,
    isInclusive: false,
    reportingCode: "-",
  },
];

export const NORMAL_BALANCE: Record<AccountSeed["type"], "debit" | "credit"> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  income: "credit",
};

// ── Permissions ─────────────────────────────────────────────────────────────

export interface PermissionSeed {
  key: string;
  module: string;
  description: string;
  sensitive?: boolean;
}

const crud = (
  resource: string,
  module: string,
  label: string,
  extra: string[] = [],
  sensitiveActions: string[] = [],
): PermissionSeed[] =>
  ["read", "create", "update", "delete", ...extra].map((action) => ({
    key: `${resource}:${action}`,
    module,
    description: `${action} ${label}`,
    sensitive: sensitiveActions.includes(action),
  }));

export const PERMISSIONS: PermissionSeed[] = [
  ...crud("dashboard", "dashboard", "the dashboard", ["consolidated"]).filter((p) =>
    ["dashboard:read", "dashboard:consolidated"].includes(p.key),
  ),
  ...crud("party", "crm", "customers and suppliers", ["export"], ["export"]),
  ...crud("lead", "crm", "leads", ["assign"]),
  ...crud("item", "inventory", "catalogue items"),
  ...crud("stock", "inventory", "stock", ["adjust", "transfer", "count"], ["adjust"]),
  ...crud("document", "sales", "invoices and orders", ["approve", "void", "send"], ["approve", "void"]),
  ...crud("payment", "sales", "payments", ["void", "refund"], ["void", "refund"]),
  ...crud("pos", "pos", "the point of sale", ["discount", "open_drawer"], ["discount"]),
  ...crud("journal", "accounting", "journal entries", ["post", "reverse"], ["post", "reverse"]),
  ...crud("account", "accounting", "the chart of accounts"),
  ...crud("report", "accounting", "financial reports", ["export"]),
  ...crud("bank", "accounting", "bank accounts", ["reconcile"], ["reconcile"]),
  ...crud("employee", "hr", "employees"),
  ...crud("attendance", "hr", "attendance"),
  ...crud("payroll", "hr", "payroll", ["approve", "pay"], ["read", "approve", "pay"]),
  ...crud("lease", "rentals", "leases", ["terminate"], ["terminate"]),
  ...crud("unit", "rentals", "rental units"),
  ...crud("job", "field_service", "jobs", ["assign", "complete"]),
  ...crud("appointment", "appointments", "appointments", ["checkin"]),
  ...crud("project", "projects", "projects"),
  ...crud("campaign", "marketing", "campaigns", ["send"], ["send"]),
  ...crud("automation", "ai", "automations", ["run"], ["run"]),
  ...crud("ai", "ai", "the AI assistant", ["ask"]).filter((p) =>
    ["ai:read", "ai:ask"].includes(p.key),
  ),
  ...crud("user", "settings", "users and roles", ["invite"], ["create", "update", "delete", "invite"]),
  ...crud("settings", "settings", "business settings"),
  ...crud("audit", "settings", "the audit log", []).filter((p) => p.key === "audit:read"),
];

export interface RoleSeed {
  key: string;
  name: string;
  level: number;
  description: string;
  /** "*" = everything; otherwise exact keys or `resource:*` wildcards. */
  permissions: string[];
}

/**
 * Sixteen roles were requested. Most are the same shape with a different scope,
 * so they are expressed as permission sets over the catalogue above rather than
 * as bespoke code paths. An owner clones any of these to make their own.
 */
export const SYSTEM_ROLES: RoleSeed[] = [
  {
    key: "super_admin",
    name: "Super Admin",
    level: 100,
    description: "Platform operator. Full access including billing and tenant settings.",
    permissions: ["*"],
  },
  {
    key: "owner",
    name: "Business Owner",
    level: 90,
    description: "Sees every business consolidated. Can do anything within the tenant.",
    permissions: ["*"],
  },
  {
    key: "general_manager",
    name: "General Manager",
    level: 80,
    description: "Runs day-to-day operations across businesses. No payroll or user admin.",
    permissions: [
      "dashboard:*", "party:*", "lead:*", "item:*", "stock:*", "document:*",
      "payment:*", "pos:*", "report:*", "employee:read", "attendance:*",
      "lease:*", "unit:*", "job:*", "appointment:*", "project:*",
      "campaign:*", "automation:read", "ai:*", "settings:read",
    ],
  },
  {
    key: "branch_manager",
    name: "Branch Manager",
    level: 60,
    description: "Scoped to one business or branch. Full operations, no accounting.",
    permissions: [
      "dashboard:read", "party:*", "lead:*", "item:read", "stock:read", "stock:count",
      "document:read", "document:create", "document:update", "document:send",
      "payment:read", "payment:create", "pos:*", "employee:read", "attendance:*",
      "job:*", "appointment:*", "ai:ask", "ai:read",
    ],
  },
  {
    key: "accountant",
    name: "Accountant",
    level: 70,
    description: "Full ledger access. Cannot change operational records.",
    permissions: [
      "dashboard:read", "dashboard:consolidated", "party:read", "document:*",
      "payment:*", "journal:*", "account:*", "report:*", "bank:*",
      "payroll:read", "payroll:approve", "audit:read", "ai:ask", "ai:read",
    ],
  },
  {
    key: "sales_staff",
    name: "Sales Staff",
    level: 30,
    description: "Sells and collects. Cannot discount beyond policy or void anything.",
    permissions: [
      "dashboard:read", "party:read", "party:create", "party:update", "lead:*",
      "item:read", "stock:read", "document:read", "document:create", "document:send",
      "payment:read", "payment:create", "pos:read", "pos:create", "pos:open_drawer",
    ],
  },
  {
    key: "receptionist",
    name: "Receptionist",
    level: 30,
    description: "Front desk: bookings, check-in, taking payment.",
    permissions: [
      "dashboard:read", "party:read", "party:create", "party:update",
      "appointment:*", "job:read", "job:create", "document:read", "document:create",
      "payment:read", "payment:create", "pos:read", "pos:create",
    ],
  },
  {
    key: "salon_manager",
    name: "Salon Manager",
    level: 55,
    description: "Runs the salon: roster, chairs, commissions, stock.",
    permissions: [
      "dashboard:read", "party:*", "item:read", "item:update", "stock:*",
      "appointment:*", "document:*", "payment:*", "pos:*",
      "employee:read", "attendance:*", "report:read", "ai:ask", "ai:read",
    ],
  },
  {
    key: "barber",
    name: "Barber / Stylist",
    level: 20,
    description: "Own schedule and own commission only.",
    permissions: [
      "appointment:read", "appointment:update", "appointment:checkin",
      "party:read", "item:read",
    ],
  },
  {
    key: "property_manager",
    name: "Property Manager",
    level: 55,
    description: "Units, tenants, leases and rent collection.",
    permissions: [
      "dashboard:read", "party:*", "unit:*", "lease:*",
      "document:read", "document:create", "document:send", "payment:read",
      "payment:create", "job:read", "job:create", "report:read", "ai:ask", "ai:read",
    ],
  },
  {
    key: "maintenance_staff",
    name: "Maintenance / Technician",
    level: 20,
    description: "Assigned jobs, van stock and job photos. Mobile app user.",
    permissions: [
      "job:read", "job:update", "job:complete", "party:read", "item:read",
      "stock:read", "stock:transfer", "attendance:create", "attendance:read",
    ],
  },
  {
    key: "warehouse_manager",
    name: "Warehouse Manager",
    level: 50,
    description: "Stock, transfers, counts and purchase receipt.",
    permissions: [
      "dashboard:read", "item:*", "stock:*", "document:read", "document:create",
      "party:read", "report:read",
    ],
  },
  {
    key: "marketing_manager",
    name: "Marketing Manager",
    level: 50,
    description: "Campaigns and customer segments. Read-only on money.",
    permissions: [
      "dashboard:read", "party:read", "party:export", "lead:*", "campaign:*",
      "report:read", "ai:ask", "ai:read", "item:read",
    ],
  },
  {
    key: "customer_support",
    name: "Customer Support",
    level: 30,
    description: "Answers customers, opens jobs, cannot change prices.",
    permissions: [
      "party:*", "lead:read", "lead:update", "job:read", "job:create", "job:update",
      "appointment:*", "document:read", "payment:read", "item:read",
    ],
  },
  {
    key: "hr",
    name: "HR Manager",
    level: 60,
    description: "People, attendance and payroll.",
    permissions: [
      "dashboard:read", "employee:*", "attendance:*", "payroll:*", "report:read",
    ],
  },
  {
    key: "auditor",
    name: "Read-only Auditor",
    level: 40,
    description: "Sees everything, changes nothing. Every view is logged.",
    permissions: [
      "dashboard:read", "dashboard:consolidated", "party:read", "item:read",
      "stock:read", "document:read", "payment:read", "journal:read", "account:read",
      "report:read", "report:export", "bank:read", "employee:read", "lease:read",
      "unit:read", "job:read", "appointment:read", "project:read", "audit:read",
    ],
  },
];

export function expandPermissions(patterns: string[], all: string[]): string[] {
  if (patterns.includes("*")) return all;
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.endsWith(":*")) {
      const prefix = p.slice(0, -1);
      for (const key of all) if (key.startsWith(prefix)) out.add(key);
    } else if (all.includes(p)) {
      out.add(p);
    }
  }
  return [...out];
}
