import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { hash as argon2Hash } from "@node-rs/argon2";
import { calculateGratuity } from "@nexus/core/uae";
import { protect } from "@nexus/core/security";
import { adminDb } from "../client.ts";
import * as s from "../schema/index.ts";
import { uuidv7 } from "../uuid.ts";
import { addDays, atTime, isoDate, makeRng, money } from "./rng.ts";
import {
  CHART_OF_ACCOUNTS,
  NORMAL_BALANCE,
  PERMISSIONS,
  SYSTEM_ROLES,
  UAE_TAX_CODES,
  expandPermissions,
} from "./reference.ts";
import {
  ACCESSORIES,
  BANK_ROUTING,
  COURIERS,
  DUBAI_AREAS,
  ECOM_CHANNELS,
  MATERIALS,
  NAME_POOL,
  ONLINE_ITEMS,
  OPERATING_COSTS,
  PHONES,
  SALON_SERVICES,
  STAFF,
  SUPPLIERS,
  TECH_SERVICES,
  UAE_BANKS,
  splitSalary,
} from "./uae-data.ts";

config({ path: "../../.env" });
config({ path: "../../.env.example" });

const db = adminDb();
const rng = makeRng(20260806);

/** Anchor date. Fixed so "this month" is reproducible across machines. */
const TODAY = new Date("2026-08-06T00:00:00.000Z");
/** Mid-afternoon "now", so today is a realistic *partial* trading day. */
const NOW = new Date("2026-08-06T14:30:00.000Z");
const HISTORY_DAYS = 200;
const START = addDays(TODAY, -HISTORY_DAYS);

/** UAE VAT standard rate — Federal Decree-Law No. 8 of 2017. */
const VAT = 0.05;

const id = () => uuidv7();
const pick = <T,>(a: readonly T[]) => rng.pick(a);
const uaePhone = () => `+9715${pick([0, 2, 4, 5, 6, 8])}${rng.int(1000000, 9999999)}`;
const emiratesId = () =>
  `784-${rng.int(1968, 2004)}-${String(rng.int(1000000, 9999999))}-${rng.int(1, 9)}`;
const uaeIban = () =>
  `AE${rng.int(10, 99)}${rng.int(100, 999)}${rng.int(1000000, 9999999)}${rng.int(100000000, 999999999)}`;

const personName = (): string => pick(rng.weighted(NAME_POOL));

/** Chunked insert — Postgres has a hard parameter limit per statement. */
async function insertMany<T extends Record<string, unknown>>(table: any, rows: T[], chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(table).values(rows.slice(i, i + chunk) as any);
  }
  return rows;
}

async function wipe() {
  console.log("· Clearing existing data…");
  const tables = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
}

async function main() {
  const t0 = Date.now();
  await wipe();
  await db.execute(sql`ALTER TABLE journal_lines DISABLE TRIGGER journal_balance_check`);

  // ── Tenant & businesses ───────────────────────────────────────────────────
  console.log("· Tenant and businesses (Dubai, AED)…");
  const tenantId = id();
  await db.insert(s.tenants).values({
    id: tenantId,
    slug: "sumon-group",
    name: "Sumon Group",
    baseCurrency: "AED",
    timezone: "Asia/Dubai",
    countryCode: "AE",
    emirate: "Dubai",
    fiscalYearStartMonth: 1, // UAE businesses run a calendar year
    vatFilingFrequency: "quarterly",
    plan: "owner",
  });

  /**
   * Trade licence expiries are deliberately staggered, with two falling due
   * inside 120 days. An expired UAE licence freezes bank accounts and blocks
   * visa renewals, so this belongs on the dashboard, not in a drawer.
   */
  const buDefs = [
    { code: "SALON", name: "Royal Cuts Gents Salon", kind: "salon" as const, color: "violet",
      icon: "scissors", area: "Al Barsha", licenceDays: 210, legal: false },
    { code: "MOBILE", name: "Sumon Telecom LLC", kind: "retail" as const, color: "blue",
      icon: "smartphone", area: "Deira", licenceDays: 47, legal: true },
    { code: "ONLINE", name: "Nexus Online Store", kind: "ecommerce" as const, color: "cyan",
      icon: "shopping-cart", area: "Dubai Silicon Oasis", licenceDays: 154, legal: false },
    { code: "PROP", name: "Sumon Properties", kind: "rental" as const, color: "amber",
      icon: "building-2", area: "Jumeirah Village Circle", licenceDays: 289, legal: true },
    { code: "PARK", name: "Bay Square Parking", kind: "rental" as const, color: "lime",
      icon: "car", area: "Business Bay", licenceDays: 122, legal: false },
    { code: "TECH", name: "Sumon Technical Services LLC", kind: "field_service" as const,
      color: "orange", icon: "wrench", area: "Al Quoz", licenceDays: 331, legal: true },
    { code: "BUILD", name: "Sumon Contracting LLC", kind: "construction" as const, color: "rose",
      icon: "hard-hat", area: "Al Quoz", licenceDays: 96, legal: true },
  ];

  const bus = buDefs.map((b, i) => ({
    id: id(), tenantId, code: b.code, name: b.name, kind: b.kind, currency: "AED",
    colorToken: b.color, icon: b.icon, sortOrder: i,
    isSeparateLegalEntity: b.legal,
    taxRegistrationNo: `1001${rng.int(10000000, 99999999)}${rng.int(100, 999)}`,
    tradeLicenseNo: `CN-${rng.int(1000000, 9999999)}`,
    licensingAuthority: "Dubai Department of Economy & Tourism",
    tradeLicenseExpiry: isoDate(addDays(TODAY, b.licenceDays)),
    establishmentCardNo: String(rng.int(100000000, 999999999)),
    establishmentCardExpiry: isoDate(addDays(TODAY, b.licenceDays + rng.int(-20, 20))),
    startedOn: isoDate(addDays(START, -rng.int(400, 2600))),
  }));
  await insertMany(s.businessUnits, bus);
  const BU = Object.fromEntries(bus.map((b) => [b.code, b.id])) as Record<string, string>;

  const MODULES_BY_KIND: Record<string, s.ModuleKey[]> = {
    salon: ["crm", "sales", "pos", "inventory", "accounting", "hr", "appointments", "marketing", "ai"],
    retail: ["crm", "sales", "pos", "inventory", "accounting", "hr", "marketing", "ai"],
    ecommerce: ["crm", "sales", "inventory", "accounting", "ecommerce", "marketing", "ai"],
    rental: ["crm", "sales", "accounting", "rentals", "field_service", "ai"],
    field_service: ["crm", "sales", "inventory", "accounting", "hr", "field_service", "ai"],
    construction: ["crm", "sales", "inventory", "accounting", "hr", "field_service", "projects", "ai"],
  };
  await insertMany(
    s.businessUnitModules,
    bus.flatMap((b) =>
      (MODULES_BY_KIND[b.kind] ?? []).map((m) => ({
        id: id(), tenantId, businessUnitId: b.id, module: m, isEnabled: true,
      })),
    ),
  );

  const locations = bus.map((b, i) => ({
    id: id(), tenantId, businessUnitId: b.id, code: "MAIN",
    name: `${b.name} — ${buDefs[i]!.area}`,
    addressLine: `Unit ${rng.int(1, 40)}, ${pick(["Al Manara Building", "Bay Square Tower 8", "Oasis Centre", "Golden Sands", "Al Waseem Residence", "Prime Business Centre"])}, ${buDefs[i]!.area}`,
    city: "Dubai", phone: uaePhone(),
    isStockLocation: ["MOBILE", "ONLINE", "TECH", "BUILD", "SALON"].includes(b.code),
  }));
  await insertMany(s.locations, locations);
  const LOC = Object.fromEntries(bus.map((b, i) => [b.code, locations[i]!.id]));

  await insertMany(
    s.numberSeries,
    bus.flatMap((b) =>
      ["invoice", "quotation", "payment", "job", "lease", "appointment"].map((k) => ({
        id: id(), tenantId, businessUnitId: b.id, key: k,
        prefix: `${k.slice(0, 3).toUpperCase()}-${b.code}`, nextValue: 1,
      })),
    ),
  );

  // ── Chart of accounts & VAT codes ─────────────────────────────────────────
  console.log("· UAE chart of accounts and VAT codes…");
  const accounts = CHART_OF_ACCOUNTS.map((a) => ({
    id: id(), tenantId, code: a.code, name: a.name, type: a.type,
    normalBalance: NORMAL_BALANCE[a.type], isPostable: a.isPostable !== false,
    isSystem: Boolean(a.systemKey), systemKey: a.systemKey ?? null,
    cashFlowSection: a.cashFlowSection ?? null,
  }));
  await insertMany(s.accounts, accounts);
  const ACC = Object.fromEntries(
    accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]),
  ) as Record<string, string>;

  const taxCodes = UAE_TAX_CODES.map((t) => ({
    id: id(), tenantId, code: t.code, name: t.name, rate: t.rate,
    treatment: t.treatment, inputRecoverable: t.inputRecoverable,
    isInclusive: t.isInclusive, reportingCode: t.reportingCode,
    outputAccountId: ACC.VAT_OUTPUT, inputAccountId: ACC.VAT_INPUT,
  }));
  await insertMany(s.taxCodes, taxCodes);
  const TAX = Object.fromEntries(taxCodes.map((t) => [t.code, t.id])) as Record<string, string>;

  // ── RBAC ──────────────────────────────────────────────────────────────────
  console.log("· Roles and permissions…");
  const permRows = PERMISSIONS.map((p) => {
    const [resource, action] = p.key.split(":");
    return { id: id(), key: p.key, resource: resource!, action: action!, module: p.module,
      description: p.description, isSensitive: Boolean(p.sensitive) };
  });
  await insertMany(s.permissions, permRows);
  const permByKey = new Map(permRows.map((p) => [p.key, p.id]));
  const allPermKeys = permRows.map((p) => p.key);

  const roleRows = SYSTEM_ROLES.map((r) => ({
    id: id(), tenantId: null, key: r.key, name: r.name,
    description: r.description, isSystem: true, level: r.level,
  }));
  await insertMany(s.roles, roleRows);
  const ROLE = Object.fromEntries(roleRows.map((r) => [r.key, r.id])) as Record<string, string>;
  await insertMany(
    s.rolePermissions,
    SYSTEM_ROLES.flatMap((r) =>
      expandPermissions(r.permissions, allPermKeys).map((k) => ({
        roleId: ROLE[r.key]!, permissionId: permByKey.get(k)!,
      })),
    ),
  );

  // ── Users ─────────────────────────────────────────────────────────────────
  /**
   * Real argon2id hashes, with the same parameters the app verifies against.
   * Hashed once and reused across the demo accounts — deriving 9 separate
   * 64 MiB hashes would add several seconds to every seed for no benefit.
   */
  const DEMO_HASH = await argon2Hash("demo1234", {
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    outputLen: 32,
  });
  const userDefs = [
    { name: "Sumon Rahman", email: "owner@sumon.test", role: "owner", scope: "tenant" as const, bus: [] },
    { name: "Layla Haddad", email: "gm@sumon.test", role: "general_manager", scope: "tenant" as const, bus: [] },
    { name: "Rafiq Ahmed", email: "accounts@sumon.test", role: "accountant", scope: "tenant" as const, bus: [] },
    { name: "Tarek Mansour", email: "salon@sumon.test", role: "salon_manager", scope: "business_unit" as const, bus: ["SALON"] },
    { name: "Imran Malik", email: "barber@sumon.test", role: "barber", scope: "self" as const, bus: ["SALON"] },
    { name: "Rajesh Nair", email: "property@sumon.test", role: "property_manager", scope: "business_unit" as const, bus: ["PROP", "PARK"] },
    { name: "Suresh Kumar", email: "tech@sumon.test", role: "maintenance_staff", scope: "self" as const, bus: ["TECH"] },
    { name: "Angelica Cruz", email: "shop@sumon.test", role: "sales_staff", scope: "business_unit" as const, bus: ["MOBILE"] },
    { name: "External Auditor", email: "auditor@sumon.test", role: "auditor", scope: "tenant" as const, bus: [] },
  ];
  const users = userDefs.map((u) => ({
    id: id(), email: u.email, fullName: u.name, passwordHash: DEMO_HASH,
    emailVerifiedAt: new Date(), phone: uaePhone(),
    defaultTenantId: tenantId, isPlatformAdmin: u.role === "owner",
  }));
  await insertMany(s.users, users);

  const memberships = userDefs.map((u, i) => ({
    id: id(), tenantId, userId: users[i]!.id, roleId: ROLE[u.role]!,
    status: "active" as const, scope: u.scope,
    title: SYSTEM_ROLES.find((r) => r.key === u.role)!.name, acceptedAt: new Date(),
  }));
  await insertMany(s.memberships, memberships);
  await insertMany(
    s.membershipScopes,
    userDefs.flatMap((u, i) =>
      u.bus.map((code) => ({
        id: id(), tenantId, membershipId: memberships[i]!.id, businessUnitId: BU[code]!,
      })),
    ),
  );
  const OWNER_USER = users[0]!.id;

  // ── Parties ───────────────────────────────────────────────────────────────
  console.log("· Customers, tenants and suppliers…");
  const parties: any[] = [];
  const usedNames = new Set<string>();
  const makeParty = (over: Partial<any> = {}) => {
    let name = (over.displayName as string) ?? personName();
    let n = 2;
    while (usedNames.has(name)) name = `${(over.displayName as string) ?? personName()} ${n++}`;
    usedNames.add(name);
    const phone = uaePhone();
    const p = {
      id: id(), tenantId, type: "person" as const, displayName: name,
      isCustomer: true, isSupplier: false, isTenantRenter: false, isEmployeeParty: false,
      primaryPhone: phone, whatsapp: phone,
      email: rng.bool(0.55)
        ? `${name.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@gmail.com`
        : null,
      city: "Dubai", countryCode: "AE",
      creditLimit: money(0), creditTermDays: 0, currency: "AED",
      lifetimeValue: "0", openBalance: "0", visitCount: 0,
      source: pick(["walk_in", "referral", "instagram", "google", "repeat", "sign_board", "whatsapp"]),
      ...over,
    };
    p.whatsapp = p.primaryPhone;
    parties.push(p);
    return p;
  };

  const salonCustomers = Array.from({ length: 130 }, () => makeParty());
  const shopCustomers = Array.from({ length: 95 }, () => makeParty());
  const onlineCustomers = Array.from({ length: 85 }, () => makeParty());
  const serviceCustomers = Array.from({ length: 75 }, () =>
    makeParty({ creditTermDays: rng.weighted([[0, 6], [14, 2], [30, 2]]) }),
  );
  const renters = Array.from({ length: 46 }, () => {
    // Landlords hold a copy of every tenant's Emirates ID for the Ejari filing,
    // which makes the rental business the densest concentration of identity
    // documents in the group — and the reason this column is encrypted.
    const eid = protect(emiratesId());
    return makeParty({
      isTenantRenter: true,
      nationalIdEnc: eid.enc, nationalIdBidx: eid.bidx, nationalIdHint: eid.hint,
    });
  });
  const corporates = Array.from({ length: 8 }, () =>
    makeParty({
      type: "company" as const,
      displayName: `${pick(["Al Futtaim", "Meraas", "Majid Group", "Gulf Horizon", "Arabian Star", "Oasis", "Falcon", "Zenith"])} ${pick(["Properties LLC", "Holdings LLC", "Trading LLC", "Investments LLC"])}`,
      creditTermDays: 60, creditLimit: money(500000),
    }),
  );
  const suppliers = SUPPLIERS.map((n) =>
    makeParty({ type: "company" as const, displayName: n, isCustomer: false, isSupplier: true,
      creditTermDays: pick([30, 45, 60]) }),
  );
  await insertMany(s.parties, parties);

  const linkPB = (list: any[], code: string) =>
    list.map((p) => ({
      id: id(), tenantId, partyId: p.id, businessUnitId: BU[code]!,
      firstSeenAt: addDays(START, rng.int(0, 60)),
    }));
  await insertMany(s.partyBusinessUnits, [
    ...linkPB(salonCustomers, "SALON"), ...linkPB(shopCustomers, "MOBILE"),
    ...linkPB(onlineCustomers, "ONLINE"), ...linkPB(serviceCustomers, "TECH"),
    ...linkPB(renters.slice(0, 16), "PROP"), ...linkPB(renters.slice(16), "PARK"),
    ...linkPB(corporates, "BUILD"),
  ]);
  await insertMany(
    s.supplierProfiles,
    suppliers.map((p) => ({
      id: id(), tenantId, partyId: p.id,
      paymentTermDays: money(rng.int(30, 60)), leadTimeDays: money(rng.int(2, 14)),
      reliabilityScore: money(rng.int(70, 99) / 100),
    })),
  );

  // ── Employees, with gratuity from real service dates ──────────────────────
  console.log("· Employees, visas and gratuity…");
  const employees = STAFF.map((e) => {
    const pay = splitSalary(e.total);
    const bank = pick(UAE_BANKS);
    const joinedOn = addDays(TODAY, -Math.round(e.yearsService * 365));
    const g = calculateGratuity({
      basicSalary: pay.basic, totalSalary: e.total,
      joinedOn: isoDate(joinedOn), asOf: isoDate(TODAY),
    });
    return {
      id: id(), tenantId, primaryBusinessUnitId: BU[e.bu]!, locationId: LOC[e.bu]!,
      employeeCode: e.code, fullName: e.name, designation: e.role,
      department: e.field ? "Operations" : "Admin",
      phone: uaePhone(), status: "active" as const, joinedOn: isoDate(joinedOn),
      payBasis: e.field || e.role.includes("Barber")
        ? ("base_plus_commission" as const) : ("monthly" as const),
      baseSalary: money(pay.basic),
      housingAllowance: money(pay.housing),
      transportAllowance: money(pay.transport),
      otherAllowance: money(pay.other),
      gratuityAccrued: money(Math.round(g.amount * 100) / 100),
      gratuityAsOf: isoDate(TODAY),
      isFieldStaff: e.field, skills: e.skills, nationality: e.nationality,
      // Identity documents are encrypted at rest with a searchable blind index.
      ...(() => {
        const eid = protect(emiratesId());
        const passport = protect(`${pick(["A", "B", "C", "K", "P"])}${rng.int(1000000, 9999999)}`);
        const iban = protect(uaeIban());
        const visa = protect(`${rng.int(100, 999)}/${rng.int(2020, 2025)}/${rng.int(1000000, 9999999)}`);
        const labour = protect(String(rng.int(10000000, 99999999)));
        return {
          emiratesIdEnc: eid.enc, emiratesIdBidx: eid.bidx, emiratesIdHint: eid.hint,
          passportNumberEnc: passport.enc, passportNumberBidx: passport.bidx,
          passportNumberHint: passport.hint,
          ibanEnc: iban.enc, ibanHint: iban.hint,
          visaNumberEnc: visa.enc,
          labourCardEnc: labour.enc,
        };
      })(),
      wpsPersonId: String(rng.int(10000000000000, 99999999999999)),
      wpsRoutingCode: BANK_ROUTING[bank] ?? "402010101",
      // Two visas expiring soon, so the compliance watchlist is not empty.
      visaExpiry: isoDate(addDays(TODAY, rng.weighted([[25, 1], [180, 3], [420, 4], [700, 2]]))),
      labourCardExpiry: isoDate(addDays(TODAY, rng.int(30, 700))),
      passportExpiry: isoDate(addDays(TODAY, rng.int(90, 2200))),
    };
  });
  await insertMany(s.employees, employees);
  const EMP = Object.fromEntries(STAFF.map((e, i) => [e.code, employees[i]!.id])) as Record<string, string>;
  const barbers = ["E001", "E002", "E003"].map((c) => EMP[c]!);

  await insertMany(s.commissionRules, [
    { id: id(), tenantId, businessUnitId: BU.SALON!, name: "Barber service commission",
      basis: "revenue_percent" as const, rate: "0.250000" },
    { id: id(), tenantId, businessUnitId: BU.MOBILE!, name: "Handset sales commission",
      basis: "revenue_percent" as const, rate: "0.015000" },
    { id: id(), tenantId, businessUnitId: BU.TECH!, name: "Technician job commission",
      basis: "profit_percent" as const, rate: "0.100000" },
  ]);

  // ── Catalogue ─────────────────────────────────────────────────────────────
  console.log("· Catalogue and stock…");
  const items: any[] = [];
  // Return type annotated explicitly. Spreading a `Partial<any>` into an object
  // literal makes TypeScript infer the result from the *defaults only*, so every
  // field the caller passes — name, durationMinutes, sku — vanished from the
  // type and 15 downstream reads failed to compile. This file was never
  // type-checked (CI only ran `next build`, which does not cover packages/db),
  // so nobody found out. The collection is already `any[]`; this just makes the
  // factory agree with it.
  const addItem = (o: Partial<any>): any => {
    const it = { id: id(), tenantId, type: "product" as const, uom: "unit",
      trackingMode: "none" as const, isSellable: true, isPurchasable: true,
      salePrice: "0", costPrice: "0", ...o };
    items.push(it);
    return it;
  };

  const salonServices = SALON_SERVICES.map(([n, p, d, skill]) =>
    addItem({ businessUnitId: BU.SALON, type: "service", name: n,
      salePrice: money(p), costPrice: money(Math.round(p * 0.12)),
      durationMinutes: d, requiresSkillKey: skill, commissionRate: "0.250000",
      taxCodeId: TAX.VAT5 }),
  );
  const phones = PHONES.map(([n, p, c], i) =>
    addItem({ businessUnitId: BU.MOBILE, type: "product", name: n,
      sku: `PH-${String(i + 1).padStart(3, "0")}`, barcode: `62911${10000 + i}`,
      trackingMode: "serial", salePrice: money(p), costPrice: money(c),
      reorderPoint: money(3), reorderQty: money(10), leadTimeDays: 7, taxCodeId: TAX.VAT5 }),
  );
  const accessories = ACCESSORIES.map(([n, p, c], i) =>
    addItem({ businessUnitId: BU.MOBILE, type: "product", name: n,
      sku: `AC-${String(i + 1).padStart(3, "0")}`, barcode: `62912${10000 + i}`,
      trackingMode: "quantity", salePrice: money(p), costPrice: money(c),
      reorderPoint: money(15), reorderQty: money(50), leadTimeDays: 5, taxCodeId: TAX.VAT5 }),
  );
  const onlineItems = ONLINE_ITEMS.map(([n, p, c], i) =>
    addItem({ businessUnitId: BU.ONLINE, type: "product", name: n,
      sku: `ON-${String(i + 1).padStart(3, "0")}`, trackingMode: "quantity",
      salePrice: money(p), costPrice: money(c),
      reorderPoint: money(10), reorderQty: money(30), leadTimeDays: 12, taxCodeId: TAX.VAT5 }),
  );
  const techServices = TECH_SERVICES.map(([n, p, k, d]) =>
    addItem({ businessUnitId: BU.TECH, type: "service", name: n,
      salePrice: money(p), costPrice: money(Math.round(p * 0.35)),
      durationMinutes: d, requiresSkillKey: k, taxCodeId: TAX.VAT5 }),
  );
  const materials = MATERIALS.map(([n, p, c], i) =>
    addItem({ businessUnitId: null, type: "product", name: n,
      sku: `MT-${String(i + 1).padStart(3, "0")}`, trackingMode: "quantity",
      salePrice: money(p), costPrice: money(c),
      reorderPoint: money(20), reorderQty: money(100), leadTimeDays: 3, taxCodeId: TAX.VAT5 }),
  );

  // Residential rent is VAT EXEMPT; parking and commercial rent are standard rated.
  const rentItem = addItem({ businessUnitId: BU.PROP, type: "rent", name: "Residential Rent",
    salePrice: "0", taxCodeId: TAX.EXEMPT });
  const parkingItem = addItem({ businessUnitId: BU.PARK, type: "rent", name: "Monthly Parking Bay",
    salePrice: "0", taxCodeId: TAX.VAT5 });
  const contractItem = addItem({ businessUnitId: BU.BUILD, type: "service",
    name: "Construction Progress Claim", salePrice: "0", taxCodeId: TAX.VAT5 });
  await insertMany(s.items, items);

  const warehouses = [
    { code: "MOB", bu: "MOBILE", name: "Deira Shop Floor", van: false },
    { code: "ONL", bu: "ONLINE", name: "Silicon Oasis Fulfilment", van: false },
    { code: "TEC", bu: "TECH", name: "Al Quoz Store", van: false },
    { code: "VAN1", bu: "TECH", name: "Van 1 — Suresh", van: true },
    { code: "VAN2", bu: "TECH", name: "Van 2 — Asif", van: true },
    { code: "BLD", bu: "BUILD", name: "Site Store", van: false },
    { code: "SAL", bu: "SALON", name: "Salon Backroom", van: false },
  ].map((w) => ({
    id: id(), tenantId, businessUnitId: BU[w.bu]!, locationId: LOC[w.bu]!,
    code: w.code, name: w.name, isMobileVan: w.van,
  }));
  await insertMany(s.warehouses, warehouses);
  const WH = Object.fromEntries(
    warehouses.map((w, i) => [["MOB", "ONL", "TEC", "VAN1", "VAN2", "BLD", "SAL"][i]!, w.id]),
  ) as Record<string, string>;

  const stockLevels: any[] = [];
  const stockMoves: any[] = [];
  const serials: any[] = [];
  const openingDate = addDays(START, -1);

  for (const it of [...accessories, ...materials]) {
    for (const whKey of it.businessUnitId === BU.MOBILE ? ["MOB"] : ["TEC", "VAN1", "VAN2", "BLD"]) {
      const onHand = rng.int(8, 120);
      stockLevels.push({ id: id(), tenantId, warehouseId: WH[whKey]!, itemId: it.id,
        onHand: money(onHand), reserved: "0", avgCost: it.costPrice });
      stockMoves.push({ id: id(), tenantId, businessUnitId: it.businessUnitId ?? BU.TECH!,
        warehouseId: WH[whKey]!, itemId: it.id, quantity: money(onHand),
        unitCost: it.costPrice, reason: "opening" as const, occurredAt: openingDate });
    }
  }
  for (const it of onlineItems) {
    const onHand = rng.int(5, 60);
    stockLevels.push({ id: id(), tenantId, warehouseId: WH.ONL!, itemId: it.id,
      onHand: money(onHand), reserved: "0", avgCost: it.costPrice });
    stockMoves.push({ id: id(), tenantId, businessUnitId: BU.ONLINE!, warehouseId: WH.ONL!,
      itemId: it.id, quantity: money(onHand), unitCost: it.costPrice,
      reason: "opening" as const, occurredAt: openingDate });
  }
  let imei = 350000000000000;
  const availableSerials: Record<string, string[]> = {};
  for (const ph of phones) {
    availableSerials[ph.id] = [];
    for (let i = 0; i < rng.int(6, 14); i++) {
      const su = { id: id(), tenantId, itemId: ph.id, serialNo: String(++imei),
        warehouseId: WH.MOB!, status: "in_stock", purchaseCost: ph.costPrice,
        soldToPartyId: null as string | null, soldOn: null as string | null,
        soldPrice: null as string | null, warrantyEndsOn: null as string | null };
      serials.push(su);
      availableSerials[ph.id]!.push(su.id);
    }
    stockLevels.push({ id: id(), tenantId, warehouseId: WH.MOB!, itemId: ph.id,
      onHand: money(availableSerials[ph.id]!.length), reserved: "0", avgCost: ph.costPrice });
  }
  await insertMany(s.serialUnits, serials.map(({ soldToPartyId, soldOn, soldPrice, warrantyEndsOn, ...r }) => r));
  await insertMany(s.stockLevels, stockLevels);
  await insertMany(s.stockMoves, stockMoves);

  // ── Sites, units, leases ──────────────────────────────────────────────────
  console.log("· Properties, Ejari leases and cheque bundles…");
  const propSite = { id: id(), tenantId, ownerBusinessUnitId: BU.PROP!,
    name: "Al Waseem Residence, JVC", code: "SITE-01",
    addressLine: "Al Waseem Residence, District 12, Jumeirah Village Circle",
    city: "Dubai", area: "Jumeirah Village Circle", isOwnedAsset: true };
  const parkSite = { id: id(), tenantId, ownerBusinessUnitId: BU.PARK!,
    name: "Bay Square Parking, Business Bay", code: "SITE-02",
    addressLine: "Bay Square Building 8, Business Bay", city: "Dubai",
    area: "Business Bay", isOwnedAsset: true };
  const custSites = serviceCustomers.slice(0, 45).map((p, i) => ({
    id: id(), tenantId, partyId: p.id, name: `${p.displayName} — Residence`,
    addressLine: `Apt ${rng.int(101, 2205)}, ${pick(["Al Manara Tower", "Zenith Building", "Marina Heights", "Silicon Gates", "Green Park Residence", "The Onyx"])}`,
    city: "Dubai", area: pick(DUBAI_AREAS), isOwnedAsset: false,
    code: `SITE-C${String(i + 1).padStart(3, "0")}`,
  }));
  await insertMany(s.sites, [propSite, parkSite, ...custSites]);

  /** JVC pricing: 1-beds ~AED 58–70k/yr, 2-beds ~AED 88–108k/yr. */
  const apartments = Array.from({ length: 16 }, (_, i) => {
    const floor = Math.floor(i / 2) + 1;
    const side = i % 2 === 0 ? "A" : "B";
    const twoBed = i >= 6;
    const annual = twoBed ? rng.int(88, 108) * 1000 : rng.int(58, 70) * 1000;
    return { id: id(), tenantId, businessUnitId: BU.PROP!, siteId: propSite.id,
      code: `${floor}0${side}`, name: `Flat ${floor}0${side}`, kind: "apartment" as const,
      status: "available" as const, floor: String(floor),
      areaSqft: money(twoBed ? rng.int(1050, 1400) : rng.int(650, 850)),
      bedrooms: twoBed ? 2 : 1, bathrooms: twoBed ? 2 : 1,
      listRent: money(Math.round(annual / 12)),
      depositMonths: money(0.6), // Dubai: 5% of annual ≈ 0.6 months
      acquisitionCost: money(twoBed ? rng.int(950, 1400) * 1000 : rng.int(600, 850) * 1000),
      metadata: { annualRent: annual, furnished: false } };
  });
  const bays = Array.from({ length: 40 }, (_, i) => ({
    id: id(), tenantId, businessUnitId: BU.PARK!, siteId: parkSite.id,
    code: `P-${String(i + 1).padStart(2, "0")}`, kind: "parking_bay" as const,
    status: "available" as const,
    listRent: money(rng.int(500, 700)), depositMonths: money(1),
  }));
  await insertMany(s.units, [...apartments, ...bays]);

  const leases: any[] = [];
  const leaseCharges: any[] = [];
  const occupiedUnitIds = new Set<string>();
  let leaseSeq = 0;

  const makeLease = (unit: any, party: any, buCode: string, monthsAgo: number, residential: boolean) => {
    const startsOn = addDays(TODAY, -monthsAgo * 30);
    const monthly = Number(unit.listRent);
    const annual = monthly * 12;
    // Cheque bundles dominate residential; parking is more often a transfer.
    const usesCheques = residential ? rng.bool(0.78) : rng.bool(0.45);
    const chequeCount = usesCheques
      ? rng.weighted([[1, 1], [2, 2], [4, 5], [6, 4], [12, 2]] as const)
      : null;
    const l = {
      id: id(), tenantId, businessUnitId: BU[buCode]!, unitId: unit.id, partyId: party.id,
      leaseNumber: `LSE-${buCode}-${String(++leaseSeq).padStart(4, "0")}`,
      status: "active" as const,
      startsOn: isoDate(startsOn), endsOn: isoDate(addDays(startsOn, 365)),
      annualRent: money(annual), rentAmount: money(monthly),
      frequency: "monthly" as const, billingDay: rng.int(1, 5),
      collectionMethod: usesCheques ? ("post_dated_cheques" as const) : ("bank_transfer" as const),
      chequeCount,
      // A few unregistered leases keep the compliance watchlist honest.
      ejariNumber: rng.bool(0.88) ? `E-${rng.int(10000000, 99999999)}` : null,
      ejariRegisteredOn: rng.bool(0.88) ? isoDate(addDays(startsOn, rng.int(1, 20))) : null,
      dewaPremiseNumber: residential ? String(rng.int(1000000, 9999999)) : null,
      depositAmount: money(Math.round(annual * 0.05)),
      depositHeld: money(Math.round(annual * 0.05)),
      escalationRate: "0.000000", // the RERA index caps most Dubai renewals at 0%
      lateFeeRate: "0.000000", graceDays: 7,
      balanceDue: "0", consecutiveLateMonths: 0,
    };
    leases.push(l);
    occupiedUnitIds.add(unit.id);
    leaseCharges.push({ id: id(), tenantId, leaseId: l.id,
      itemId: residential ? rentItem.id : parkingItem.id,
      label: residential ? "Residential Rent" : "Monthly Parking",
      amount: money(monthly), frequency: "monthly" as const, startsOn: l.startsOn });
    return l;
  };

  const propRenters = renters.slice(0, 16);
  const parkRenters = renters.slice(16);
  apartments.slice(0, 13).forEach((u, i) => makeLease(u, propRenters[i]!, "PROP", rng.int(2, 22), true));
  bays.slice(0, 28).forEach((u, i) => makeLease(u, parkRenters[i % parkRenters.length]!, "PARK", rng.int(1, 18), false));
  await insertMany(s.leases, leases);
  await insertMany(s.leaseCharges, leaseCharges);
  await db.update(s.units).set({ status: "occupied" }).where(
    sql`id = ANY(${sql.raw(`ARRAY[${[...occupiedUnitIds].map((x) => `'${x}'::uuid`).join(",")}]`)})`,
  );

  // ── Salon resources ───────────────────────────────────────────────────────
  const chairs = ["C1", "C2", "C3"].map((c, i) => ({
    id: id(), tenantId, businessUnitId: BU.SALON!, locationId: LOC.SALON!,
    kind: "chair" as const, code: c, name: `Chair ${i + 1}`, defaultEmployeeId: barbers[i]!,
  }));
  await insertMany(s.resources, chairs);
  await insertMany(s.membershipPlans, [
    { id: id(), tenantId, businessUnitId: BU.SALON!, name: "Gold — 10 Haircuts",
      price: money(500), validityDays: 365, includedVisits: 10, discountRate: "0.170000" },
    { id: id(), tenantId, businessUnitId: BU.SALON!, name: "Grooming Credit AED 1,000",
      price: money(880), validityDays: 180, creditAmount: money(1000) },
  ]);

  // ════════════════════════════════════════════════════════════════════════
  //  TRANSACTIONS
  // ════════════════════════════════════════════════════════════════════════
  console.log("· Generating 200 days of trading…");

  const documents: any[] = [];
  const docLines: any[] = [];
  const payments: any[] = [];
  const allocations: any[] = [];
  const journals: any[] = [];
  const journalLines: any[] = [];
  const appointments: any[] = [];
  const apptServices: any[] = [];
  const jobs: any[] = [];
  const jobVisits: any[] = [];
  const jobLines: any[] = [];
  const commissionEntries: any[] = [];
  const installmentPlans: any[] = [];
  const installmentRows: any[] = [];
  const chequeRows: any[] = [];

  const counters: Record<string, number> = {};
  const nextNo = (key: string) => (counters[key] = (counters[key] ?? 0) + 1);

  let journalSeq = 0;
  const addJournal = (
    postingDate: string, source: s.JournalSource, sourceTable: string, sourceId: string,
    legs: { account: string; bu: string | null; debit?: number; credit?: number; partyId?: string | null }[],
    narration: string,
  ) => {
    const jid = id();
    journals.push({ id: jid, tenantId, journalNumber: `JV-${String(++journalSeq).padStart(6, "0")}`,
      source, sourceTable, sourceId, postingDate, narration, postedByUserId: OWNER_USER });
    legs.forEach((leg, i) => {
      journalLines.push({
        id: id(), tenantId, journalId: jid, lineNo: i + 1, accountId: leg.account,
        businessUnitId: leg.bu, debit: money(leg.debit ?? 0), credit: money(leg.credit ?? 0),
        baseDebit: money(leg.debit ?? 0), baseCredit: money(leg.credit ?? 0),
        currency: "AED", partyId: leg.partyId ?? null,
      });
    });
  };

  type VatMode = "inclusive" | "exclusive" | "exempt";

  /**
   * Creates invoice + lines + journal, optionally with payment.
   *
   * `vatMode` matters: retail and services here are quoted VAT-inclusive (the
   * shelf price is what the customer pays), rent and B2B are quoted exclusive,
   * and residential rent is exempt with no VAT line at all.
   */
  const addSale = (opts: {
    buCode: string; date: Date; party: any; revenueAccount: string;
    lines: { item: any; qty: number; price: number; cost: number; employeeId?: string;
      jobId?: string; leaseId?: string; projectId?: string; serialUnitId?: string;
      periodStart?: string; periodEnd?: string }[];
    vatMode: VatMode; paid: boolean; method?: s.PaymentMethod; dueDays?: number;
    channelSource?: string;
  }) => {
    const { buCode, date, party, lines, revenueAccount, paid, vatMode } = opts;
    const buId = BU[buCode]!;
    const docId = id();
    let subtotal = 0, taxTotal = 0, costTotal = 0;

    lines.forEach((l, i) => {
      const gross = l.qty * l.price;
      let net: number, tax: number, lineTotal: number;
      if (vatMode === "exempt") {
        net = gross; tax = 0; lineTotal = gross;
      } else if (vatMode === "inclusive") {
        net = gross / (1 + VAT); tax = gross - net; lineTotal = gross;
      } else {
        net = gross; tax = gross * VAT; lineTotal = gross + tax;
      }
      subtotal += net; taxTotal += tax; costTotal += l.qty * l.cost;
      docLines.push({
        id: id(), tenantId, documentId: docId, lineNo: i + 1, itemId: l.item.id,
        serialUnitId: l.serialUnitId ?? null, description: l.item.name,
        quantity: money(l.qty), unitPrice: money(l.price),
        taxCodeId: vatMode === "exempt" ? TAX.EXEMPT : TAX.VAT5,
        taxRate: money(vatMode === "exempt" ? 0 : VAT),
        taxAmount: money(tax), lineTotal: money(lineTotal), unitCost: money(l.cost),
        employeeId: l.employeeId ?? null, jobId: l.jobId ?? null, leaseId: l.leaseId ?? null,
        projectId: l.projectId ?? null,
        periodStart: l.periodStart ?? null, periodEnd: l.periodEnd ?? null,
      });
    });

    const total = subtotal + taxTotal;
    const dueDays = opts.dueDays ?? (paid ? 0 : party.creditTermDays || 14);
    const dueDate = addDays(date, dueDays);
    const overdue = !paid && dueDate < TODAY ? Math.floor((+TODAY - +dueDate) / 86400000) : 0;

    documents.push({
      id: docId, tenantId, businessUnitId: buId, locationId: LOC[buCode] ?? null,
      docType: "invoice" as const,
      docNumber: `INV-${buCode}-${String(nextNo(`inv-${buCode}`)).padStart(5, "0")}`,
      status: paid ? ("paid" as const) : overdue > 0 ? ("overdue" as const) : ("sent" as const),
      direction: "in" as const, partyId: party.id, partyNameSnapshot: party.displayName,
      issueDate: isoDate(date), dueDate: isoDate(dueDate), daysOverdue: overdue,
      currency: "AED", subtotal: money(subtotal), taxTotal: money(taxTotal), total: money(total),
      amountPaid: money(paid ? total : 0), amountDue: money(paid ? 0 : total),
      baseTotal: money(total), costTotal: money(costTotal),
      postedAt: date, sentAt: date,
      metadata: opts.channelSource ? { channel: opts.channelSource } : {},
    });

    const legs = [
      { account: ACC.AR!, bu: buId, debit: total, partyId: party.id },
      { account: revenueAccount, bu: buId, credit: subtotal },
    ];
    if (taxTotal > 0) legs.push({ account: ACC.VAT_OUTPUT!, bu: buId, credit: taxTotal });
    addJournal(isoDate(date), "invoice", "documents", docId, legs, `Invoice to ${party.displayName}`);

    if (costTotal > 0) {
      addJournal(isoDate(date), "invoice", "documents", docId, [
        { account: ACC.COGS!, bu: buId, debit: costTotal },
        { account: ACC.INVENTORY!, bu: buId, credit: costTotal },
      ], "Cost of goods sold");
    }

    if (paid) {
      const payId = id();
      const method = opts.method ?? "cash";
      const cashAcc = method === "cash" ? ACC.CASH!
        : method === "card" || method === "digital_wallet" ? ACC.CARD_CLEARING! : ACC.BANK!;
      payments.push({
        id: payId, tenantId, businessUnitId: buId, locationId: LOC[buCode] ?? null,
        paymentNumber: `PAY-${buCode}-${String(nextNo(`pay-${buCode}`)).padStart(5, "0")}`,
        direction: "in" as const, partyId: party.id, method, amount: money(total),
        currency: "AED", baseAmount: money(total), unallocatedAmount: "0",
        receivedOn: isoDate(date), postedAt: date, isReconciled: method !== "cash",
      });
      allocations.push({ id: id(), tenantId, paymentId: payId, documentId: docId, amount: money(total) });
      addJournal(isoDate(date), "payment", "payments", payId, [
        { account: cashAcc, bu: buId, debit: total },
        { account: ACC.AR!, bu: buId, credit: total, partyId: party.id },
      ], `Payment from ${party.displayName}`);
    }
    return { docId, total };
  };

  // ── Salon ─────────────────────────────────────────────────────────────────
  // Dubai salons trade seven days; Thursday–Saturday is the peak, and Friday
  // dips around the midday Jumu'ah prayer rather than closing.
  for (let d = 0; d <= HISTORY_DAYS; d++) {
    const day = addDays(START, d);
    const dow = day.getUTCDay(); // 0 Sun … 5 Fri, 6 Sat
    const base = dow === 4 || dow === 6 ? 13 : dow === 5 ? 8 : 9;
    const growth = 1 + (d / HISTORY_DAYS) * 0.22;
    const count = Math.max(2, Math.round(base * growth * (0.75 + rng.next() * 0.5)));

    const chairCursor = chairs.map(() => 10 * 60);
    for (let i = 0; i < count; i++) {
      const ci = i % chairs.length;
      const chair = chairs[ci]!;
      const svc = rng.weighted(salonServices.map((x, k) => [x, k === 0 ? 9 : k === 2 ? 6 : 2] as const));
      const dur = svc.durationMinutes as number;
      let startMin = chairCursor[ci]!;
      if (dow === 5 && startMin >= 12.5 * 60 && startMin < 14 * 60) startMin = 14 * 60;
      if (startMin + dur > 22 * 60) continue;
      chairCursor[ci] = startMin + dur + 5;

      const party = pick(salonCustomers);
      const startsAt = atTime(day, Math.floor(startMin / 60), startMin % 60);
      const endsAt = new Date(+startsAt + dur * 60000);
      const isPast = endsAt < NOW;
      const noShow = isPast && rng.bool(0.05);
      const emp = chair.defaultEmployeeId!;
      const apptId = id();

      appointments.push({
        id: apptId, tenantId, businessUnitId: BU.SALON!, locationId: LOC.SALON!,
        reference: `APT-${String(nextNo("appt")).padStart(6, "0")}`,
        partyId: party.id, resourceId: chair.id, employeeId: emp,
        status: !isPast ? ("booked" as const) : noShow ? ("no_show" as const) : ("completed" as const),
        startsAt, endsAt,
        checkedInAt: isPast && !noShow ? startsAt : null,
        completedAt: isPast && !noShow ? endsAt : null,
        estimatedValue: svc.salePrice,
        source: rng.weighted([["walk_in", 5], ["phone", 2], ["online", 2]] as const),
      });
      apptServices.push({ id: id(), tenantId, appointmentId: apptId, itemId: svc.id,
        employeeId: emp, price: svc.salePrice, durationMinutes: dur });

      if (isPast && !noShow) {
        const price = Number(svc.salePrice);
        addSale({
          buCode: "SALON", date: endsAt, party, revenueAccount: ACC.REV_SERVICE!,
          vatMode: "inclusive", paid: true,
          method: rng.weighted([["card", 6], ["cash", 3], ["digital_wallet", 2]] as const),
          lines: [{ item: svc, qty: 1, price, cost: Number(svc.costPrice), employeeId: emp }],
        });
        commissionEntries.push({
          id: id(), tenantId, employeeId: emp, sourceTable: "appointments", sourceId: apptId,
          baseAmount: money(price), commissionAmount: money(Math.round(price * 0.25 * 100) / 100),
          earnedOn: isoDate(endsAt), isPaid: endsAt < addDays(TODAY, -35),
        });
      }
    }
  }

  // ── Mobile shop ───────────────────────────────────────────────────────────
  for (let d = 0; d <= HISTORY_DAYS; d++) {
    const day = addDays(START, d);
    const count = rng.int(2, 7);
    for (let i = 0; i < count; i++) {
      const party = pick(shopCustomers);
      const when = atTime(day, rng.int(10, 21), rng.int(0, 59));
      if (when > NOW) continue;
      const lines: any[] = [];

      const sellsPhone = rng.bool(0.45);
      let serialUnitId: string | undefined;
      let phoneItem: any;
      if (sellsPhone) {
        phoneItem = pick(phones);
        const pool = availableSerials[phoneItem.id]!;
        if (pool.length > 0) {
          serialUnitId = pool.pop();
          lines.push({ item: phoneItem, qty: 1, price: Number(phoneItem.salePrice),
            cost: Number(phoneItem.costPrice), serialUnitId });
        }
      }
      const accCount = rng.int(sellsPhone ? 0 : 1, 3);
      for (let a = 0; a < accCount; a++) {
        const acc = pick(accessories);
        lines.push({ item: acc, qty: rng.int(1, 2), price: Number(acc.salePrice), cost: Number(acc.costPrice) });
      }
      if (lines.length === 0) continue;

      const gross = lines.reduce((t, l) => t + l.qty * l.price, 0);
      // Handsets above AED 800 commonly go on Tabby/Tamara or in-house terms.
      const onInstallment = sellsPhone && serialUnitId && gross > 800 && rng.bool(0.32);
      const paid = !onInstallment && rng.bool(0.92);

      const { docId, total } = addSale({
        buCode: "MOBILE", date: when, party, revenueAccount: ACC.REV_PRODUCT!,
        vatMode: "inclusive", paid,
        method: rng.weighted([["card", 6], ["cash", 2], ["digital_wallet", 2], ["bnpl", 1]] as const),
        lines, dueDays: onInstallment ? 0 : undefined,
      });

      if (serialUnitId) {
        const su = serials.find((x) => x.id === serialUnitId)!;
        su.status = "sold"; su.soldToPartyId = party.id; su.soldOn = isoDate(when);
        su.soldPrice = money(Number(phoneItem.salePrice));
        su.warrantyEndsOn = isoDate(addDays(when, 365));
      }

      if (onInstallment) {
        const planId = id();
        const down = Math.round(total * 0.25);
        const n = pick([3, 4, 6, 6, 12]);
        const per = Math.round(((total - down) * 1.04) / n);
        installmentPlans.push({
          id: planId, tenantId, businessUnitId: BU.MOBILE!, documentId: docId, partyId: party.id,
          principal: money(total), downPayment: money(down), serviceChargeRate: "0.040000",
          installmentCount: n, frequency: "monthly", startsOn: isoDate(addDays(when, 30)),
          status: "active", collateralSerialUnitId: serialUnitId ?? null,
        });
        installmentRows.push(...Array.from({ length: n }, (_, k) => {
          const dueOn = addDays(when, 30 * (k + 1));
          const isPast = dueOn < TODAY;
          const paidIt = isPast && rng.bool(0.88);
          return { id: id(), tenantId, planId, seq: k + 1, dueOn: isoDate(dueOn),
            amountDue: money(per), amountPaid: money(paidIt ? per : 0),
            status: paidIt ? ("paid" as const) : isPast ? ("overdue" as const) : ("scheduled" as const),
            paidOn: paidIt ? isoDate(dueOn) : null };
        }));
      }
    }
  }

  // ── Online store ──────────────────────────────────────────────────────────
  const onlineChannels = ECOM_CHANNELS.map((name, i) => ({
    id: id(), tenantId, businessUnitId: BU.ONLINE!,
    kind: (i === 3 ? "own_store" : i === 2 ? "social" : "marketplace") as any,
    name, commissionRate: i === 3 ? "0" : i === 2 ? "0.020000" : "0.150000",
  }));
  await insertMany(s.channels, onlineChannels);
  const fulfilments: any[] = [];

  for (let d = 0; d <= HISTORY_DAYS; d++) {
    const day = addDays(START, d);
    const count = rng.int(1, 5);
    for (let i = 0; i < count; i++) {
      const when = atTime(day, rng.int(9, 23), rng.int(0, 59));
      if (when > NOW) continue;
      const party = pick(onlineCustomers);
      const ch = rng.weighted(onlineChannels.map((c, k) => [c, k === 0 ? 5 : k === 1 ? 4 : 2] as const));
      const lines = Array.from({ length: rng.int(1, 3) }, () => {
        const it = pick(onlineItems);
        return { item: it, qty: rng.int(1, 2), price: Number(it.salePrice), cost: Number(it.costPrice) };
      });
      // COD matters in the UAE but far less than in South Asia.
      const isCod = rng.bool(0.28);
      const delivered = addDays(when, rng.int(1, 3)) < NOW;
      const { docId, total } = addSale({
        buCode: "ONLINE", date: when, party, revenueAccount: ACC.REV_PRODUCT!,
        vatMode: "inclusive", paid: !isCod || delivered,
        method: isCod ? "cash" : "gateway", lines, channelSource: ch.name,
      });
      fulfilments.push({
        id: id(), tenantId, documentId: docId,
        status: delivered ? (rng.bool(0.06) ? ("returned" as const) : ("delivered" as const)) : ("shipped" as const),
        carrier: pick(COURIERS), trackingNumber: `TRK${rng.int(100000, 999999)}`,
        shippingCost: money(rng.int(12, 30)),
        isCod, codAmount: money(isCod ? total : 0),
        shippedAt: addDays(when, 1), deliveredAt: delivered ? addDays(when, rng.int(1, 3)) : null,
      });
    }
  }
  await insertMany(s.fulfilments, fulfilments);

  // ── Field service ─────────────────────────────────────────────────────────
  const SKILL_TO_EMP: Record<string, string[]> = {
    ac_service: [EMP.E007!], plumbing: [EMP.E008!], electrical: [EMP.E009!, EMP.E007!],
    handyman: [EMP.E008!, EMP.E009!], cleaning: [EMP.E010!],
  };
  for (let d = 0; d <= HISTORY_DAYS; d++) {
    const day = addDays(START, d);
    const month = day.getUTCMonth();
    // Dubai summer: AC work roughly doubles between May and September.
    const acSeason = month >= 4 && month <= 8;
    const count = rng.int(2, acSeason ? 7 : 5);
    for (let i = 0; i < count; i++) {
      const kind = rng.weighted([
        ["ac_service", acSeason ? 9 : 4], ["plumbing", 3], ["electrical", 3],
        ["handyman", 2], ["cleaning", 3],
      ] as const);
      const svc = pick(techServices.filter((x) => x.requiresSkillKey === kind));
      const emp = pick(SKILL_TO_EMP[kind]!);

      // ~18% of jobs are on the owner's OWN rental units → inter-company.
      const internal = rng.bool(0.18);
      const unit = internal ? pick(apartments) : null;
      const party = internal ? null : pick(serviceCustomers);
      const site = internal ? propSite : pick(custSites);

      const reportedAt = atTime(day, rng.int(8, 18), rng.int(0, 59));
      const isPast = reportedAt < addDays(NOW, -1);
      const priority = rng.weighted([["normal", 6], ["high", 2], ["emergency", 1], ["low", 1]] as const);
      const status = !isPast
        ? rng.weighted([["scheduled", 3], ["request", 1], ["dispatched", 1]] as const)
        : rng.weighted([["completed", 7], ["invoiced", 6], ["in_progress", 1], ["cancelled", 1]] as const);

      const jobId = id();
      const price = Number(svc.salePrice);
      const matCost = rng.int(0, 3) * rng.int(15, 180);
      const labCost = Number(svc.costPrice);

      jobs.push({
        id: jobId, tenantId, businessUnitId: BU.TECH!,
        jobNumber: `JOB-${String(nextNo("job")).padStart(6, "0")}`,
        serviceKind: kind, title: svc.name, description: `${svc.name} at ${site.name}`,
        partyId: party?.id ?? null, siteId: site.id, unitId: unit?.id ?? null,
        status, priority, reportedAt,
        respondBy: new Date(+reportedAt + (priority === "emergency" ? 4 : 24) * 3600000),
        completeBy: new Date(+reportedAt + (priority === "emergency" ? 8 : 72) * 3600000),
        completedAt: ["completed", "invoiced"].includes(status) ? addDays(reportedAt, rng.int(0, 2)) : null,
        estimatedValue: money(price), quotedValue: money(price),
        laborCost: money(labCost), materialCost: money(matCost),
        invoicedValue: money(status === "invoiced" ? price : 0),
        customerRating: status === "invoiced" && rng.bool(0.5) ? rng.int(3, 5) : null,
        ownerUserId: OWNER_USER,
      });

      const vStart = addDays(reportedAt, rng.int(0, 2));
      jobVisits.push({
        id: id(), tenantId, jobId, seq: 1, employeeId: emp,
        status: ["completed", "invoiced"].includes(status) ? ("done" as const)
          : status === "in_progress" ? ("on_site" as const) : ("planned" as const),
        scheduledStart: vStart,
        scheduledEnd: new Date(+vStart + (svc.durationMinutes as number) * 60000),
        actualStart: ["completed", "invoiced"].includes(status) ? vStart : null,
        actualEnd: ["completed", "invoiced"].includes(status)
          ? new Date(+vStart + (svc.durationMinutes as number) * 60000) : null,
        workMinutes: ["completed", "invoiced"].includes(status) ? svc.durationMinutes : null,
        travelMinutes: rng.int(15, 55),
      });
      jobLines.push({ id: id(), tenantId, jobId, itemId: svc.id, description: svc.name,
        quantity: "1", unitCost: money(labCost), unitPrice: money(price),
        isBillable: true, isInvoiced: status === "invoiced", employeeId: emp });

      if (status === "invoiced") {
        const when = addDays(reportedAt, rng.int(0, 3));
        if (internal) {
          /**
           * Inter-company, with the VAT subtlety that matters: Tech Services
           * charges 5% output VAT, but Properties makes EXEMPT residential
           * supplies and therefore cannot reclaim it. The input VAT is expensed
           * to irrecoverable VAT. Booking it as a reclaim would be an FTA
           * assessment risk, and it is exactly the mistake spreadsheets make.
           */
          const docId = id();
          const net = price;
          const tax = price * VAT;
          const gross = net + tax;
          documents.push({
            id: docId, tenantId, businessUnitId: BU.TECH!, locationId: LOC.TECH!,
            docType: "invoice" as const,
            docNumber: `INV-TECH-${String(nextNo("inv-TECH")).padStart(5, "0")}`,
            status: "paid" as const, direction: "in" as const,
            partyNameSnapshot: "Sumon Properties (inter-company)",
            counterpartyBusinessUnitId: BU.PROP!,
            issueDate: isoDate(when), dueDate: isoDate(when), daysOverdue: 0,
            currency: "AED", subtotal: money(net), taxTotal: money(tax), total: money(gross),
            amountPaid: money(gross), amountDue: "0", baseTotal: money(gross),
            costTotal: money(labCost + matCost), postedAt: when,
          });
          docLines.push({ id: id(), tenantId, documentId: docId, lineNo: 1, itemId: svc.id,
            description: `${svc.name} — ${unit!.name}`, quantity: "1", unitPrice: money(net),
            taxCodeId: TAX.VAT5, taxRate: money(VAT), taxAmount: money(tax),
            lineTotal: money(gross), unitCost: money(labCost), jobId });
          addJournal(isoDate(when), "inter_company", "documents", docId, [
            { account: ACC.INTERCO_DUE_FROM!, bu: BU.TECH!, debit: gross },
            { account: ACC.REV_SERVICE!, bu: BU.TECH!, credit: net },
            { account: ACC.VAT_OUTPUT!, bu: BU.TECH!, credit: tax },
            { account: ACC.REPAIRS!, bu: BU.PROP!, debit: net },
            { account: ACC.VAT_IRRECOVERABLE!, bu: BU.PROP!, debit: tax },
            { account: ACC.INTERCO_DUE_TO!, bu: BU.PROP!, credit: gross },
          ], `Inter-company: ${svc.name} on ${unit!.name}`);
        } else {
          addSale({
            buCode: "TECH", date: when, party: party!, revenueAccount: ACC.REV_SERVICE!,
            vatMode: "inclusive", paid: rng.bool(0.8),
            method: rng.weighted([["card", 4], ["cash", 4], ["bank_transfer", 2]] as const),
            lines: [{ item: svc, qty: 1, price, cost: labCost + matCost, employeeId: emp, jobId }],
          });
        }
      }
    }
  }

  // ── Rent: monthly accrual invoices + cheque bundles ───────────────────────
  console.log("· Rent invoicing and post-dated cheques…");
  for (const lease of leases) {
    const residential = lease.businessUnitId === BU.PROP;
    const buCode = residential ? "PROP" : "PARK";
    const item = residential ? rentItem : parkingItem;
    const revAcc = residential ? ACC.REV_RENT! : ACC.REV_PARKING!;
    const party = parties.find((p) => p.id === lease.partyId)!;
    const leaseStart = new Date(`${lease.startsOn}T00:00:00Z`);
    const monthly = Number(lease.rentAmount);
    const usesCheques = lease.collectionMethod === "post_dated_cheques";

    // 1) Monthly accrual invoices — correct P&L regardless of how it is collected.
    const rentInvoices: { docId: string; periodStart: Date; total: number; paid: boolean }[] = [];
    const cursor = new Date(Math.max(+leaseStart, +START));
    cursor.setUTCDate(lease.billingDay);
    while (cursor <= TODAY) {
      const periodStart = new Date(cursor);
      const periodEnd = new Date(cursor);
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
      const monthsAgo = Math.round((+TODAY - +cursor) / (30 * 86400000));
      const paidNow = usesCheques ? false : monthsAgo >= 1 ? rng.bool(0.9) : rng.bool(0.6);

      const { docId, total } = addSale({
        buCode, date: new Date(cursor), party, revenueAccount: revAcc,
        vatMode: residential ? "exempt" : "exclusive",
        paid: paidNow, method: "bank_transfer", dueDays: 7,
        lines: [{ item, qty: 1, price: monthly, cost: 0, leaseId: lease.id,
          periodStart: isoDate(periodStart), periodEnd: isoDate(periodEnd) }],
      });
      rentInvoices.push({ docId, periodStart, total, paid: paidNow });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    if (!usesCheques || !lease.chequeCount) continue;

    // 2) The cheque bundle handed over when the tenancy was signed.
    const n = lease.chequeCount as number;
    const annual = Number(lease.annualRent);
    const perCheque = Math.round((annual / n) * 100) / 100;
    const monthsPer = 12 / n;
    const bank = pick(UAE_BANKS);

    for (let c = 0; c < n; c++) {
      const chequeDate = new Date(leaseStart);
      chequeDate.setUTCMonth(chequeDate.getUTCMonth() + Math.round(c * monthsPer));
      const coverStart = new Date(chequeDate);
      const coverEnd = new Date(chequeDate);
      coverEnd.setUTCMonth(coverEnd.getUTCMonth() + Math.round(monthsPer));

      const chequeId = id();
      const daysFromNow = Math.floor((+chequeDate - +TODAY) / 86400000);
      const bounced = daysFromNow < -5 && rng.bool(0.045);

      let status: "held" | "deposited" | "cleared" | "bounced";
      if (daysFromNow > 3) status = "held";
      else if (daysFromNow >= -3) status = "deposited";
      else if (bounced) status = "bounced";
      else status = "cleared";

      chequeRows.push({
        id: chequeId, tenantId, businessUnitId: BU[buCode]!, direction: "in" as const,
        partyId: party.id, leaseId: lease.id,
        chequeNumber: String(rng.int(100000, 999999)),
        bankName: bank, drawerName: party.displayName,
        chequeDate: isoDate(chequeDate), amount: money(perCheque), currency: "AED",
        status,
        periodStart: isoDate(coverStart), periodEnd: isoDate(coverEnd),
        receivedOn: lease.startsOn,
        depositedOn: status !== "held" ? isoDate(addDays(chequeDate, 1)) : null,
        clearedOn: status === "cleared" ? isoDate(addDays(chequeDate, 2)) : null,
        bouncedOn: status === "bounced" ? isoDate(addDays(chequeDate, 2)) : null,
        bounceReason: status === "bounced"
          ? pick(["Insufficient funds", "Account closed", "Signature mismatch", "Payment stopped"])
          : null,
        bankChargeAmount: money(status === "bounced" ? 100 : 0),
        custodyLocation: status === "held" ? "Head office safe" : bank,
      });

      if (status === "cleared") {
        const covered = rentInvoices.filter(
          (r) => r.periodStart >= coverStart && r.periodStart < coverEnd && !r.paid,
        );
        if (covered.length === 0) continue;
        const payId = id();
        let remaining = perCheque;
        let allocated = 0;
        for (const inv of covered) {
          const doc = documents.find((x) => x.id === inv.docId)!;
          const amt = Math.min(remaining, Number(doc.amountDue));
          if (amt <= 0.001) continue;
          allocations.push({ id: id(), tenantId, paymentId: payId, documentId: inv.docId,
            amount: money(amt) });
          doc.amountPaid = money(Number(doc.amountPaid) + amt);
          doc.amountDue = money(Math.max(0, Number(doc.total) - Number(doc.amountPaid)));
          doc.status = Number(doc.amountDue) <= 0.01 ? "paid" : "partially_paid";
          if (Number(doc.amountDue) <= 0.01) { doc.daysOverdue = 0; inv.paid = true; }
          remaining -= amt;
          allocated += amt;
        }
        if (allocated <= 0.001) continue;
        payments.push({
          id: payId, tenantId, businessUnitId: BU[buCode]!,
          paymentNumber: `PAY-${buCode}-${String(nextNo(`pay-${buCode}`)).padStart(5, "0")}`,
          direction: "in" as const, partyId: party.id, method: "cheque" as const,
          amount: money(allocated), currency: "AED", baseAmount: money(allocated),
          unallocatedAmount: "0", receivedOn: isoDate(addDays(chequeDate, 2)),
          reference: `Cheque cleared`, postedAt: addDays(chequeDate, 2), isReconciled: true,
        });
        addJournal(isoDate(addDays(chequeDate, 2)), "payment", "cheques", chequeId, [
          { account: ACC.BANK!, bu: BU[buCode]!, debit: allocated },
          { account: ACC.AR!, bu: BU[buCode]!, credit: allocated, partyId: party.id },
        ], `Cheque cleared — ${party.displayName}`);
      }

      if (status === "bounced") {
        addJournal(isoDate(addDays(chequeDate, 2)), "manual", "cheques", chequeId, [
          { account: ACC.CHEQUE_CHARGES!, bu: BU[buCode]!, debit: 100 },
          { account: ACC.BANK!, bu: BU[buCode]!, credit: 100 },
        ], `Returned cheque charge — ${party.displayName}`);
      }
    }
  }

  // ── Construction projects ─────────────────────────────────────────────────
  const projects = [
    { code: "PRJ-001", name: "Business Bay Office Fit-out", value: 1850000, pct: 0.72, status: "active" as const },
    { code: "PRJ-002", name: "Al Barsha Villa Renovation", value: 720000, pct: 1.0, status: "closed" as const },
    { code: "PRJ-003", name: "JVC Rooftop Extension", value: 1240000, pct: 0.31, status: "active" as const },
  ].map((p, i) => ({
    id: id(), tenantId, businessUnitId: BU.BUILD!, code: p.code, name: p.name,
    partyId: corporates[i]!.id, status: p.status,
    startsOn: isoDate(addDays(TODAY, -(200 - i * 40))),
    targetEndOn: isoDate(addDays(TODAY, 120 - i * 60)),
    contractValue: money(p.value), budgetCost: money(p.value * 0.74),
    actualCost: money(p.value * 0.74 * p.pct * (1 + rng.next() * 0.12)),
    percentComplete: money(p.pct), billedToDate: money(p.value * p.pct * 0.9),
    retentionRate: "0.050000", retentionHeld: money(p.value * p.pct * 0.9 * 0.05),
    managerUserId: OWNER_USER,
  }));
  await insertMany(s.projects, projects);

  for (const prj of projects) {
    const claims = Math.max(1, Math.round(Number(prj.percentComplete) * 5));
    for (let c = 0; c < claims; c++) {
      const when = addDays(TODAY, -(claims - c) * 30);
      const amount = Math.round(Number(prj.billedToDate) / claims);
      const party = corporates.find((p) => p.id === prj.partyId)!;
      addSale({
        buCode: "BUILD", date: when, party, revenueAccount: ACC.REV_CONTRACT!,
        vatMode: "exclusive", paid: c < claims - 1, method: "bank_transfer", dueDays: 60,
        lines: [{ item: contractItem, qty: 1, price: amount, cost: amount * 0.74, projectId: prj.id }],
      });
    }
  }

  // ── Expenses, payroll, gratuity, drawings ─────────────────────────────────
  console.log("· Expenses, WPS payroll and gratuity accrual…");
  const monthsBack = 7;
  const payrollTotal = STAFF.reduce((t, e) => t + e.total, 0);

  // Gratuity movement over the seeded window — post the DELTA, not the balance,
  // so the accrual is idempotent and the closing provision ties to `employees`.
  const gratuityNow = employees.reduce((t, e) => t + Number(e.gratuityAccrued), 0);
  const gratuityAtStart = STAFF.reduce((t, e, i) => {
    const g = calculateGratuity({
      basicSalary: Number(employees[i]!.baseSalary), totalSalary: e.total,
      joinedOn: employees[i]!.joinedOn, asOf: isoDate(START),
    });
    return t + g.amount;
  }, 0);
  const monthlyGratuity = Math.max(0, (gratuityNow - gratuityAtStart) / monthsBack);

  for (let m = monthsBack - 1; m >= 0; m--) {
    const when = new Date(TODAY);
    when.setUTCMonth(when.getUTCMonth() - m);
    when.setUTCDate(3);
    if (when > TODAY) continue;

    for (const [buCode, accKey, lo, hi] of OPERATING_COSTS) {
      const amt = rng.int(lo, hi);
      addJournal(isoDate(when), "manual", "expenses", id(), [
        { account: ACC[accKey]!, bu: BU[buCode]!, debit: amt },
        { account: ACC.BANK!, bu: BU[buCode]!, credit: amt },
      ], "Monthly operating expense");
    }

    addJournal(isoDate(when), "payroll", "payroll_runs", id(), [
      { account: ACC.SALARY!, bu: null, debit: payrollTotal },
      { account: ACC.BANK!, bu: null, credit: payrollTotal },
    ], "Monthly payroll (WPS)");

    if (monthlyGratuity > 0) {
      addJournal(isoDate(when), "payroll", "gratuity", id(), [
        { account: ACC.GRATUITY_EXPENSE!, bu: null, debit: monthlyGratuity },
        { account: ACC.GRATUITY_PROVISION!, bu: null, credit: monthlyGratuity },
      ], "End-of-service gratuity accrual");
    }

    // Owner drawings — equity, never expense.
    const drawings = rng.int(25000, 60000);
    addJournal(isoDate(when), "manual", "drawings", id(), [
      { account: ACC.DRAWINGS!, bu: null, debit: drawings },
      { account: ACC.BANK!, bu: null, credit: drawings },
    ], "Owner drawings");
  }

  // Annual government costs: trade licences and visas.
  for (const b of bus) {
    const when = addDays(TODAY, -rng.int(30, 180));
    const fee = rng.int(12000, 26000);
    addJournal(isoDate(when), "manual", "licence", id(), [
      { account: ACC.LICENSE_FEES!, bu: b.id, debit: fee },
      { account: ACC.BANK!, bu: b.id, credit: fee },
    ], `Trade licence renewal — ${b.name}`);
  }
  addJournal(isoDate(addDays(TODAY, -95)), "manual", "visas", id(), [
    { account: ACC.VISA_COSTS!, bu: null, debit: 38000 },
    { account: ACC.BANK!, bu: null, credit: 38000 },
  ], "Employment visas, medicals and Emirates ID renewals");

  // Opening balances (AED), including gratuity already accrued before the
  // seeded window — a real business does not start from zero.
  const openingBank = 850000, openingCash = 45000, openingInv = 420000, openingPPE = 6500000;
  const openingLoan = 3200000;
  const openingCapital =
    openingBank + openingCash + openingInv + openingPPE - openingLoan - gratuityAtStart;
  addJournal(isoDate(addDays(START, -2)), "opening", "opening", id(), [
    { account: ACC.BANK!, bu: null, debit: openingBank },
    { account: ACC.CASH!, bu: null, debit: openingCash },
    { account: ACC.INVENTORY!, bu: null, debit: openingInv },
    { account: ACC.PPE!, bu: null, debit: openingPPE },
    { account: ACC.LOAN!, bu: null, credit: openingLoan },
    { account: ACC.GRATUITY_PROVISION!, bu: null, credit: gratuityAtStart },
    { account: ACC.CAPITAL!, bu: null, credit: openingCapital },
  ], "Opening balances");

  // ── Persist ───────────────────────────────────────────────────────────────
  console.log(`· Writing ${documents.length} documents, ${journalLines.length} journal lines…`);
  await insertMany(s.appointments, appointments, 300);
  await insertMany(s.appointmentServices, apptServices, 300);
  await insertMany(s.jobs, jobs, 300);
  await insertMany(s.jobVisits, jobVisits, 300);
  await insertMany(s.jobLines, jobLines, 300);
  await insertMany(s.documents, documents, 200);
  await insertMany(s.documentLines, docLines, 300);
  await insertMany(s.payments, payments, 300);
  await insertMany(s.paymentAllocations, allocations, 500);
  await insertMany(s.cheques, chequeRows, 300);
  await insertMany(s.journals, journals, 300);
  await insertMany(s.journalLines, journalLines, 400);
  await insertMany(s.commissionEntries, commissionEntries, 500);
  await insertMany(s.installmentPlans, installmentPlans, 300);
  await insertMany(s.installments, installmentRows, 500);

  for (const su of serials.filter((x) => x.status === "sold")) {
    await db.update(s.serialUnits).set({
      status: "sold", soldToPartyId: su.soldToPartyId, soldOn: su.soldOn,
      soldPrice: su.soldPrice, warrantyEndsOn: su.warrantyEndsOn, warehouseId: null,
    }).where(sql`id = ${su.id}`);
  }

  /**
   * Sync the number series to the data just created.
   *
   * The seed allocates its own counters for speed, which leaves
   * `number_series.next_value` at 1 while thousands of documents already exist.
   * The first live invoice would then collide on the unique index — the exact
   * "forgot to bump the sequence after the import" bug that bites real ERP
   * migrations, usually on the customer's first day.
   */
  console.log("· Syncing document number series…");
  for (const [key, prefixOf] of [
    ["invoice", (c: string) => `INV-${c}`],
    ["payment", (c: string) => `PAY-${c}`],
  ] as const) {
    for (const b of bus) {
      const used = key === "invoice" ? (counters[`inv-${b.code}`] ?? 0) : (counters[`pay-${b.code}`] ?? 0);
      await db.execute(sql`
        UPDATE number_series SET next_value = ${used + 1}, prefix = ${prefixOf(b.code)}
         WHERE business_unit_id = ${b.id}::uuid AND key = ${key}
      `);
    }
  }
  await db.execute(sql`
    UPDATE number_series SET next_value = ${(counters["job"] ?? 0) + 1} WHERE key = 'job'
  `);
  await db.execute(sql`
    UPDATE number_series SET next_value = ${(counters["appt"] ?? 0) + 1} WHERE key = 'appointment'
  `);

  // ── Rollups ───────────────────────────────────────────────────────────────
  console.log("· Computing rollups…");
  await db.execute(sql`
    UPDATE parties p SET
      lifetime_value = COALESCE(x.total, 0),
      open_balance   = COALESCE(x.due, 0),
      visit_count    = COALESCE(x.cnt, 0),
      last_transaction_at = x.last_at,
      rfm_recency    = CASE WHEN x.last_at IS NULL THEN NULL
                            ELSE EXTRACT(DAY FROM ${isoDate(TODAY)}::timestamptz - x.last_at)::int END,
      rfm_frequency  = COALESCE(x.cnt, 0),
      churn_risk     = CASE
                         WHEN x.last_at IS NULL THEN NULL
                         WHEN x.last_at < ${isoDate(TODAY)}::timestamptz - interval '120 days' THEN 'high'
                         WHEN x.last_at < ${isoDate(TODAY)}::timestamptz - interval '60 days'  THEN 'medium'
                         ELSE 'low' END
    FROM (
      SELECT party_id, SUM(total) AS total, SUM(amount_due) AS due,
             COUNT(*) AS cnt, MAX(issue_date)::timestamptz AS last_at
        FROM documents WHERE party_id IS NOT NULL AND doc_type = 'invoice'
       GROUP BY party_id
    ) x WHERE x.party_id = p.id
  `);
  await db.execute(sql`
    UPDATE leases l SET balance_due = COALESCE(x.due, 0)
    FROM (
      SELECT dl.lease_id, SUM(d.amount_due) AS due
        FROM document_lines dl JOIN documents d ON d.id = dl.document_id
       WHERE dl.lease_id IS NOT NULL GROUP BY dl.lease_id
    ) x WHERE x.lease_id = l.id
  `);
  await db.execute(sql`
    UPDATE employees e SET revenue_mtd = COALESCE(x.rev, 0)
    FROM (
      SELECT dl.employee_id, SUM(dl.line_total) AS rev
        FROM document_lines dl JOIN documents d ON d.id = dl.document_id
       WHERE dl.employee_id IS NOT NULL
         AND d.issue_date >= date_trunc('month', ${isoDate(TODAY)}::date)
       GROUP BY dl.employee_id
    ) x WHERE e.id = x.employee_id
  `);
  await db.execute(sql`
    INSERT INTO kpi_snapshots (id, tenant_id, business_unit_id, on_date, metric_key, value, computed_at)
    SELECT gen_random_uuid(), tenant_id, business_unit_id, issue_date, 'revenue', SUM(subtotal), now()
      FROM documents WHERE doc_type = 'invoice' AND status <> 'cancelled'
     GROUP BY tenant_id, business_unit_id, issue_date
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO kpi_snapshots (id, tenant_id, business_unit_id, on_date, metric_key, value, computed_at)
    SELECT gen_random_uuid(), tenant_id, business_unit_id, issue_date, 'gross_profit',
           SUM(subtotal - cost_total), now()
      FROM documents WHERE doc_type = 'invoice' AND status <> 'cancelled'
     GROUP BY tenant_id, business_unit_id, issue_date
    ON CONFLICT DO NOTHING
  `);

  // ── Automations ───────────────────────────────────────────────────────────
  await insertMany(s.automations, [
    { id: id(), tenantId, name: "Bank the cheques due this week", trigger: "schedule" as const,
      triggerConfig: { cron: "0 7 * * 0", entity: "cheques", window: "+7d" },
      conditions: [{ field: "status", op: "=", value: "held" }],
      actions: [{ type: "notify_user", role: "accountant", severity: "warning" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Bounced cheque escalation", trigger: "status_changed" as const,
      triggerConfig: { entity: "cheques", to: "bounced" },
      actions: [{ type: "notify_user", role: "owner", severity: "critical" },
        { type: "create_draft", entity: "replacement_cheque_request" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Trade licence renewal (60 days)", trigger: "date_offset" as const,
      triggerConfig: { entity: "business_units", dateField: "trade_license_expiry", offsetDays: -60 },
      actions: [{ type: "notify_user", role: "owner", severity: "critical" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Employee visa expiry (45 days)", trigger: "date_offset" as const,
      triggerConfig: { entity: "employees", dateField: "visa_expiry", offsetDays: -45 },
      actions: [{ type: "notify_user", role: "hr", severity: "warning" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Ejari registration missing", trigger: "record_created" as const,
      triggerConfig: { entity: "leases" },
      conditions: [{ field: "ejari_number", op: "is_null" }],
      actions: [{ type: "notify_user", role: "property_manager", severity: "warning" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "VAT return reminder (quarterly)", trigger: "schedule" as const,
      triggerConfig: { cron: "0 8 5 1,4,7,10 *" },
      actions: [{ type: "notify_user", role: "accountant", severity: "critical" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Low stock reorder proposal", trigger: "threshold_crossed" as const,
      triggerConfig: { entity: "stock_levels", metric: "available", comparator: "below_reorder_point" },
      actions: [{ type: "create_draft", entity: "purchase_order", groupBy: "supplier" }],
      isEnabled: true, requiresApproval: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Salon review request 2h after service", trigger: "status_changed" as const,
      triggerConfig: { entity: "appointments", to: "completed", delayMinutes: 120, channel: "whatsapp" },
      actions: [{ type: "send_message", channel: "whatsapp", template: "review_request" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Owner daily briefing 08:00 GST", trigger: "schedule" as const,
      triggerConfig: { cron: "0 4 * * *", timezone: "Asia/Dubai" },
      actions: [{ type: "ai_briefing", audience: "owner", channel: "push" }],
      isEnabled: true, createdByUserId: OWNER_USER },
    { id: id(), tenantId, name: "Cash drawer variance alert", trigger: "record_created" as const,
      triggerConfig: { entity: "cash_register_sessions", event: "closed" },
      conditions: [{ field: "variance", op: "abs>", value: 100 }],
      actions: [{ type: "notify_user", role: "owner", severity: "warning" }],
      isEnabled: true, createdByUserId: OWNER_USER },
  ]);

  // A demo API token for the owner, so the /api/v1 suite has a credential.
  //
  // NEVER minted outside development. The plaintext is a constant in this file,
  // which is committed to a public repository — a bearer token is checked before
  // login, MFA and the rate limiter, so seeding it into a reachable deployment
  // hands full owner access to anyone who can read the source. The e2e suite
  // needs it and only ever runs against localhost, so gate it on NODE_ENV and
  // let the suite fail loudly anywhere else rather than create a live backdoor.
  // The gate is the database HOST, not NODE_ENV. NODE_ENV is unset on a laptop,
  // so a NODE_ENV check would happily mint the token while seeding a cloud
  // database from a developer machine — which is precisely how this token first
  // reached a live deployment. "Is the target localhost?" is the question that
  // actually protects the deployment.
  const seedTarget = process.env.DATABASE_URL ?? "";
  const targetHost = (() => {
    try { return new URL(seedTarget).hostname; } catch { return ""; }
  })();
  const isLocalTarget = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(targetHost);

  if (!isLocalTarget || process.env.SEED_DEMO_TOKEN === "false") {
    console.log(`· Skipping the demo API token — target is "${targetHost || "unknown"}", not localhost.`);
  } else {
    const { createHash } = await import("node:crypto");
    const demoToken = "nxk_demo_seed_token_do_not_use_in_prod";
    await db.insert(s.apiTokens).values({
      id: id(), tenantId, membershipId: memberships[0]!.id,
      name: "Demo mobile token", prefix: demoToken.slice(0, 12),
      tokenHash: createHash("sha256").update(demoToken).digest("hex"), scopes: [],
    });
  }

  await db.execute(sql`ALTER TABLE journal_lines ENABLE TRIGGER journal_balance_check`);

  /**
   * ANALYZE after a bulk load — not optional. A freshly TRUNCATEd table has no
   * statistics, so the planner assumes tiny tables and picks nested loops over
   * 20k-row journal joins. In testing this alone was the difference between a
   * 22 ms and a 19 s dashboard.
   */
  console.log("· Analysing tables for the query planner…");
  await db.execute(sql`ANALYZE`);

  // ── Integrity ─────────────────────────────────────────────────────────────
  const unbalanced = await db.execute<{ journal_id: string }>(sql`
    SELECT journal_id FROM journal_lines GROUP BY journal_id
     HAVING ROUND(SUM(base_debit), 2) <> ROUND(SUM(base_credit), 2)
  `);
  if (unbalanced.length > 0) {
    console.error(`✗ ${unbalanced.length} unbalanced journals`);
    process.exit(1);
  }

  const counts = await db.execute<{ k: string; n: number }>(sql`
    SELECT 'documents' k, COUNT(*)::int n FROM documents
    UNION ALL SELECT 'journal_lines', COUNT(*)::int FROM journal_lines
    UNION ALL SELECT 'appointments', COUNT(*)::int FROM appointments
    UNION ALL SELECT 'jobs', COUNT(*)::int FROM jobs
    UNION ALL SELECT 'leases', COUNT(*)::int FROM leases
    UNION ALL SELECT 'cheques', COUNT(*)::int FROM cheques
    UNION ALL SELECT 'parties', COUNT(*)::int FROM parties
    UNION ALL SELECT 'payments', COUNT(*)::int FROM payments
    ORDER BY 1
  `);

  console.log(`\n✓ Seed complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const c of counts) console.log(`   ${c.k.padEnd(16)} ${c.n}`);
  console.log(`\n   Sumon Group — Dubai · AED · 5% VAT · calendar fiscal year`);
  console.log(`   Gratuity liability: AED ${gratuityNow.toLocaleString("en-AE", { maximumFractionDigits: 0 })}`);
  console.log(`   Sign in: owner@sumon.test / demo1234\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
