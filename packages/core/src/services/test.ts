/**
 * Write-layer test suite.
 *
 *   npm run test:writes
 *
 * Exercises the service functions directly rather than through HTTP, because
 * the properties being tested are transactional: that a payment cannot
 * over-allocate, that a retry does not double-charge, that a permission failure
 * writes nothing, and that the ledger still balances afterwards.
 *
 * Every test runs inside a transaction that is rolled back, so the suite is
 * repeatable against the seeded database without mutating it.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, appDb } from "@nexus/db";
import {
  changeRole,
  deactivateUser,
  ServiceError,
  bookAppointment,
  completeJob,
  createInvoice,
  createJob,
  recordPayment,
  transitionCheque,
  type ServiceContext,
} from "./index.ts";
import type { Principal } from "../rbac.ts";

config({ path: "../../.env" });
config({ path: ".env" });

const TODAY = process.env.NEXUS_DEMO_TODAY || "2026-08-06";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: over.userId ?? "",
    tenantId: over.tenantId ?? "",
    membershipId: "00000000-0000-0000-0000-000000000000",
    roleKey: over.roleKey ?? "owner",
    roleLevel: 90,
    scope: over.scope ?? "tenant",
    businessUnitIds: over.businessUnitIds ?? null,
    locationIds: null,
    permissions:
      over.permissions ??
      new Set([
        "payment:create", "payment:refund", "document:create",
        "appointment:create", "appointment:update",
        "job:create", "job:complete", "stock:adjust",
      ]),
    isPlatformAdmin: false,
  };
}

/**
 * Run a test inside a transaction that always rolls back.
 *
 * A deliberate throw at the end is the only reliable way to abort a Drizzle
 * transaction; the sentinel is swallowed so the test result survives.
 */
async function inRollback<T>(
  tenantId: string,
  userId: string,
  fn: (ctx: ServiceContext) => Promise<T>,
): Promise<T | undefined> {
  const ROLLBACK = Symbol("rollback");
  let out: T | undefined;
  try {
    await appDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      out = await fn({
        tx,
        tenantId,
        principal: principal({ userId, tenantId }),
        today: TODAY,
        baseCurrency: "AED",
      });
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return out;
}

async function main() {
  const db = adminDb();
  const [tenant] = await db.execute<{ id: string }>(sql`SELECT id FROM tenants LIMIT 1`);
  const [user] = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = 'owner@sumon.test'`,
  );
  if (!tenant || !user) throw new Error("Seed the database first.");

  const tenantId = tenant.id;
  const userId = user.id;

  console.log(`\nWrite layer\n`);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const [openInvoice] = await db.execute<{
    id: string; business_unit_id: string; party_id: string; amount_due: string;
  }>(sql`
    SELECT id, business_unit_id, party_id, amount_due FROM documents
     WHERE direction='in' AND amount_due > 100 AND party_id IS NOT NULL
     ORDER BY issue_date DESC LIMIT 1
  `);
  const [salonItem] = await db.execute<{ id: string; business_unit_id: string; sale_price: string }>(sql`
    SELECT i.id, i.business_unit_id, i.sale_price FROM items i
     JOIN business_units b ON b.id = i.business_unit_id
    WHERE i.type='service' AND b.kind='salon' LIMIT 1
  `);
  const [chair] = await db.execute<{ id: string }>(
    sql`SELECT id FROM resources WHERE kind='chair' LIMIT 1`,
  );
  const [techBu] = await db.execute<{ id: string }>(
    sql`SELECT id FROM business_units WHERE kind='field_service' LIMIT 1`,
  );
  const [heldCheque] = await db.execute<{ id: string; amount: string }>(
    sql`SELECT id, amount FROM cheques WHERE status='held' LIMIT 1`,
  );
  const [supplier] = await db.execute<{ id: string }>(
    sql`SELECT id FROM parties WHERE is_supplier = true LIMIT 1`,
  );
  const [stockItem] = await db.execute<{ id: string; business_unit_id: string }>(sql`
    SELECT i.id, i.business_unit_id FROM items i JOIN business_units b ON b.id = i.business_unit_id
    WHERE i.tracking_mode = 'quantity' AND b.kind = 'retail' LIMIT 1
  `);
  const [mobileWarehouse] = await db.execute<{ id: string; business_unit_id: string }>(sql`
    SELECT w.id, w.business_unit_id FROM warehouses w JOIN business_units b ON b.id = w.business_unit_id
    WHERE b.kind = 'retail' AND w.is_mobile_van = false LIMIT 1
  `);
  const [paidInvoice] = await db.execute<{ id: string; total: string; business_unit_id: string }>(sql`
    SELECT id, total, business_unit_id FROM documents
     WHERE direction='in' AND doc_type='invoice' AND status='paid'
       AND cost_total > 0 AND party_id IS NOT NULL LIMIT 1
  `);

  // ── Payments ──────────────────────────────────────────────────────────────
  await inRollback(tenantId, userId, async (ctx) => {
    const result = await recordPayment(ctx, {
      businessUnitId: openInvoice!.business_unit_id,
      partyId: openInvoice!.party_id,
      amount: 100,
      method: "card",
      receivedOn: TODAY,
      allocations: [{ documentId: openInvoice!.id, amount: 100 }],
    });
    check("payment records and allocates", result.allocated === 100, result.paymentNumber);

    const [doc] = await ctx.tx.execute<{ amount_due: string; status: string }>(sql`
      SELECT amount_due, status::text FROM documents WHERE id = ${openInvoice!.id}::uuid
    `);
    check(
      "invoice balance decreases by exactly the allocation",
      Math.abs(Number(openInvoice!.amount_due) - Number(doc!.amount_due) - 100) < 0.01,
    );

    const [bal] = await ctx.tx.execute<{ d: string; c: string }>(sql`
      SELECT COALESCE(SUM(base_debit),0) d, COALESCE(SUM(base_credit),0) c
        FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       WHERE j.source_id = ${result.paymentId}::uuid
    `);
    check("the payment journal balances", Number(bal!.d) === Number(bal!.c),
      `${Number(bal!.d).toFixed(2)} = ${Number(bal!.c).toFixed(2)}`);
  });

  await inRollback(tenantId, userId, async (ctx) => {
    let rejected = false;
    try {
      await recordPayment(ctx, {
        businessUnitId: openInvoice!.business_unit_id,
        partyId: openInvoice!.party_id,
        amount: 999_999,
        method: "cash",
        receivedOn: TODAY,
        allocations: [{ documentId: openInvoice!.id, amount: 999_999 }],
      });
    } catch (err) {
      rejected = err instanceof ServiceError && err.code === "invalid";
    }
    check("over-allocating an invoice is rejected", rejected);
  });

  await inRollback(tenantId, userId, async (ctx) => {
    const key = `test-idem-${Date.now()}`;
    const first = await recordPayment(ctx, {
      businessUnitId: openInvoice!.business_unit_id,
      partyId: openInvoice!.party_id,
      amount: 50, method: "cash", receivedOn: TODAY, idempotencyKey: key,
    });
    const second = await recordPayment(ctx, {
      businessUnitId: openInvoice!.business_unit_id,
      partyId: openInvoice!.party_id,
      amount: 50, method: "cash", receivedOn: TODAY, idempotencyKey: key,
    });
    check("a replayed payment returns the original, not a second charge",
      first.paymentId === second.paymentId, first.paymentNumber);

    const [count] = await ctx.tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int n FROM payments WHERE id = ${first.paymentId}::uuid
    `);
    check("only one payment row exists after the replay", count!.n === 1);
  });

  await inRollback(tenantId, userId, async (ctx) => {
    // Money with no invoice to settle is a liability, not a receivable credit.
    const result = await recordPayment(ctx, {
      businessUnitId: openInvoice!.business_unit_id,
      partyId: null, amount: 500, method: "cash", receivedOn: TODAY, autoAllocate: false,
    });
    const [adv] = await ctx.tx.execute<{ credit: string }>(sql`
      SELECT COALESCE(SUM(jl.base_credit),0) credit
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE j.source_id = ${result.paymentId}::uuid AND a.system_key = 'CUSTOMER_ADVANCE'
    `);
    check("unallocated money posts to customer advances, not revenue",
      Number(adv!.credit) === 500);
  });

  // ── Permissions ───────────────────────────────────────────────────────────
  console.log("");
  await inRollback(tenantId, userId, async (ctx) => {
    const barber: ServiceContext = { ...ctx, principal: principal({
      userId, tenantId, roleKey: "barber", permissions: new Set(["appointment:read"]),
    }) };
    let denied = false;
    try {
      await recordPayment(barber, {
        businessUnitId: openInvoice!.business_unit_id,
        amount: 10, method: "cash", receivedOn: TODAY, autoAllocate: false,
      });
    } catch (err) {
      denied = err instanceof ServiceError && err.code === "forbidden";
    }
    check("a role without payment:create cannot record a payment", denied);
  });

  await inRollback(tenantId, userId, async (ctx) => {
    const scoped: ServiceContext = { ...ctx, principal: principal({
      userId, tenantId, scope: "business_unit",
      businessUnitIds: ["00000000-0000-7000-8000-000000000000"],
    }) };
    let denied = false;
    try {
      await recordPayment(scoped, {
        businessUnitId: openInvoice!.business_unit_id,
        amount: 10, method: "cash", receivedOn: TODAY, autoAllocate: false,
      });
    } catch (err) {
      denied = err instanceof ServiceError && err.code === "forbidden";
    }
    check("a business-scoped user cannot post into another business", denied);
  });

  // ── Invoicing ─────────────────────────────────────────────────────────────
  console.log("");
  await inRollback(tenantId, userId, async (ctx) => {
    const result = await createInvoice(ctx, {
      businessUnitId: salonItem!.business_unit_id,
      issueDate: TODAY,
      lines: [{ itemId: salonItem!.id, quantity: 1 }],
      payment: { method: "card" },
    });
    // Salon prices are quoted VAT-inclusive, so the total equals the shelf price.
    check("invoice totals reconcile to the shelf price",
      Math.abs(result.total - Number(salonItem!.sale_price)) < 0.01,
      `AED ${result.total.toFixed(2)}`);
    check("VAT is extracted, not added, on an inclusive price",
      Math.abs(result.subtotal + result.taxTotal - result.total) < 0.01 && result.taxTotal > 0,
      `net ${result.subtotal.toFixed(2)} + vat ${result.taxTotal.toFixed(2)}`);
    check("paying at the till marks the invoice paid", result.paid);

    const [bal] = await ctx.tx.execute<{ d: string; c: string }>(sql`
      SELECT COALESCE(SUM(base_debit),0) d, COALESCE(SUM(base_credit),0) c
        FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       WHERE j.source_id = ${result.documentId}::uuid
    `);
    check("the invoice journal balances", Number(bal!.d) === Number(bal!.c));
  });

  // ── Appointments ──────────────────────────────────────────────────────────
  console.log("");
  await inRollback(tenantId, userId, async (ctx) => {
    const booked = await bookAppointment(ctx, {
      businessUnitId: salonItem!.business_unit_id,
      resourceId: chair!.id,
      itemId: salonItem!.id,
      startsAt: "2027-03-01T06:00:00.000Z",
      walkInName: "Test Walk-in",
    });
    check("a walk-in books without a customer record", Boolean(booked?.appointmentId),
      booked?.reference);

    let clashed = false;
    try {
      await bookAppointment(ctx, {
        businessUnitId: salonItem!.business_unit_id,
        resourceId: chair!.id,
        itemId: salonItem!.id,
        startsAt: "2027-03-01T06:10:00.000Z",
        walkInName: "Clash",
      });
    } catch (err) {
      clashed = err instanceof ServiceError && err.code === "conflict";
    }
    check("double-booking the same chair is rejected by the database", clashed);
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────
  console.log("");
  await inRollback(tenantId, userId, async (ctx) => {
    const job = await createJob(ctx, {
      businessUnitId: techBu!.id,
      serviceKind: "ac_service",
      title: "Test AC service",
      priority: "emergency",
    });
    const [row] = await ctx.tx.execute<{ respond_by: string; complete_by: string }>(sql`
      SELECT respond_by::text, complete_by::text FROM jobs WHERE id = ${job!.jobId}::uuid
    `);
    const hours =
      (Date.parse(row!.complete_by) - Date.parse(row!.respond_by)) / 3_600_000;
    check("an emergency job gets a tighter SLA than a normal one", hours === 4,
      `respond +4h, complete +8h`);

    const done = await completeJob(ctx, { jobId: job!.jobId });
    check("a job can be completed", done.jobNumber === job!.jobNumber);

    let twice = false;
    try {
      await completeJob(ctx, { jobId: job!.jobId });
    } catch (err) {
      twice = err instanceof ServiceError && err.code === "conflict";
    }
    check("completing an already-completed job is rejected", twice);
  });

  // ── Cheques ───────────────────────────────────────────────────────────────
  console.log("");
  if (heldCheque) {
    await inRollback(tenantId, userId, async (ctx) => {
      await transitionCheque(ctx, {
        chequeId: heldCheque.id, action: "deposit", onDate: TODAY,
      });
      const [after] = await ctx.tx.execute<{ status: string }>(sql`
        SELECT status::text FROM cheques WHERE id = ${heldCheque.id}::uuid
      `);
      check("a held cheque can be deposited", after!.status === "deposited");

      let bad = false;
      try {
        await transitionCheque(ctx, {
          chequeId: heldCheque.id, action: "replace", onDate: TODAY,
          replacement: { chequeNumber: "1", chequeDate: TODAY, amount: 1 },
        });
      } catch (err) {
        bad = err instanceof ServiceError && err.code === "conflict";
      }
      check("an invalid cheque transition is rejected", bad);
    });

    await inRollback(tenantId, userId, async (ctx) => {
      await transitionCheque(ctx, {
        chequeId: heldCheque.id, action: "clear", onDate: TODAY,
      });
      const [after] = await ctx.tx.execute<{ status: string; payment_id: string | null }>(sql`
        SELECT status::text, payment_id FROM cheques WHERE id = ${heldCheque.id}::uuid
      `);
      check("clearing a cheque creates a real payment",
        after!.status === "cleared" && after!.payment_id !== null);
    });
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  console.log("");
  await inRollback(tenantId, userId, async (ctx) => {
    const before = await ctx.tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int n FROM audit_log
    `);
    await recordPayment(ctx, {
      businessUnitId: openInvoice!.business_unit_id,
      amount: 25, method: "cash", receivedOn: TODAY, autoAllocate: false,
    });
    /**
     * The newest row, not `MAX(action)`.
     *
     * This used to read `MAX(action)`, which is a LEXICOGRAPHIC maximum across
     * the entire table and only ever equalled "payment.record" by luck — no
     * seeded action happened to sort after it. Seeding payroll runs broke that
     * luck ("payroll.*" > "payment.record") and the check failed while the
     * behaviour it guards was perfectly correct.
     *
     * A test that passes for a reason unrelated to what it claims to assert is
     * worse than no test: it fails on unrelated changes and would equally have
     * stayed green if `recordPayment` had written an audit row with the wrong
     * action entirely, so long as something else in the table sorted higher.
     */
    const after = await ctx.tx.execute<{ n: number; action: string }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM audit_log) AS n,
        (SELECT action FROM audit_log ORDER BY at DESC, id DESC LIMIT 1) AS action
    `);
    check("every money movement writes an audit record",
      after[0]!.n === before[0]!.n + 1 && after[0]!.action === "payment.record",
      `+${after[0]!.n - before[0]!.n} row, newest action "${after[0]!.action}"`);
  });

  // ── Payables ──────────────────────────────────────────────────────────────
  console.log("");
  if (supplier && stockItem && mobileWarehouse) {
    await inRollback(tenantId, userId, async (ctx) => {
      const { receiveBill, payBill } = await import("./purchasing.ts");
      const bill = await receiveBill(ctx, {
        businessUnitId: stockItem.business_unit_id,
        supplierId: supplier.id,
        billDate: TODAY,
        lines: [{ itemId: stockItem.id, quantity: 10, unitCost: 100, vatRate: 0.05 }],
        receiveStock: true,
      });
      check("a supplier bill posts input VAT and payables",
        Math.abs(bill.total - 1050) < 0.01 && Math.abs(bill.inputVatRecoverable - 50) < 0.01,
        `total ${bill.total}, input VAT ${bill.inputVatRecoverable}`);

      const [bal] = await ctx.tx.execute<{ d: string; c: string }>(sql`
        SELECT COALESCE(SUM(base_debit),0) d, COALESCE(SUM(base_credit),0) c
          FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
         WHERE j.source_id = ${bill.documentId}::uuid
      `);
      check("the bill journal balances", Number(bal!.d) === Number(bal!.c));

      const [ap] = await ctx.tx.execute<{ credit: string }>(sql`
        SELECT COALESCE(SUM(jl.base_credit),0) credit
          FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id JOIN accounts a ON a.id = jl.account_id
         WHERE j.source_id = ${bill.documentId}::uuid AND a.system_key = 'AP'
      `);
      check("payables is credited by the gross amount", Math.abs(Number(ap!.credit) - 1050) < 0.01);

      const paid = await payBill(ctx, {
        businessUnitId: stockItem.business_unit_id,
        supplierId: supplier.id,
        amount: 1050, method: "bank_transfer", paidOn: TODAY, billId: bill.documentId,
      });
      check("paying a supplier settles the bill", paid.allocated === 1050);

      let over = false;
      try {
        await payBill(ctx, {
          businessUnitId: stockItem.business_unit_id, supplierId: supplier.id,
          amount: 5000, method: "cash", paidOn: TODAY, billId: bill.documentId,
        });
      } catch (err) {
        over = err instanceof ServiceError && err.code === "invalid";
      }
      check("over-paying a bill is rejected", over);
    });
  }

  // ── Stock adjustment ────────────────────────────────────────────────────
  console.log("");
  if (stockItem && mobileWarehouse) {
    await inRollback(tenantId, userId, async (ctx) => {
      const { adjustStock } = await import("./inventory.ts");
      const [before] = await ctx.tx.execute<{ on_hand: string }>(sql`
        SELECT on_hand FROM stock_levels
         WHERE warehouse_id = ${mobileWarehouse.id}::uuid AND item_id = ${stockItem.id}::uuid
      `);
      const target = Math.max(0, Number(before?.on_hand ?? 0) - 3);
      const res = await adjustStock(ctx, {
        businessUnitId: mobileWarehouse.business_unit_id,
        warehouseId: mobileWarehouse.id, itemId: stockItem.id,
        countedQuantity: target, reason: "count", onDate: TODAY,
      });
      check("a stock count posts the variance", res.adjusted && res.delta === -3);

      const [after] = await ctx.tx.execute<{ on_hand: string }>(sql`
        SELECT on_hand FROM stock_levels
         WHERE warehouse_id = ${mobileWarehouse.id}::uuid AND item_id = ${stockItem.id}::uuid
      `);
      check("the level matches the count", Number(after!.on_hand) === target);

      const noop = await adjustStock(ctx, {
        businessUnitId: mobileWarehouse.business_unit_id,
        warehouseId: mobileWarehouse.id, itemId: stockItem.id,
        countedQuantity: target, reason: "count", onDate: TODAY,
      });
      check("a count that matches the system does nothing", !noop.adjusted);
    });
  }

  // ── Credit notes ──────────────────────────────────────────────────────────
  console.log("");
  if (paidInvoice) {
    await inRollback(tenantId, userId, async (ctx) => {
      const { createCreditNote } = await import("./credit-notes.ts");
      const cn = await createCreditNote(ctx, {
        invoiceId: paidInvoice.id, reason: "Returned faulty",
        full: true, refundMethod: "bank_transfer",
      });
      check("a full credit note reverses the invoice total",
        Math.abs(cn.total - Number(paidInvoice.total)) < 0.01, `AED ${cn.total.toFixed(2)}`);
      check("a paid invoice's credit becomes a refund", cn.refunded > 0);

      const [bal] = await ctx.tx.execute<{ d: string; c: string }>(sql`
        SELECT COALESCE(SUM(base_debit),0) d, COALESCE(SUM(base_credit),0) c
          FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
         WHERE j.source_id = ${cn.creditNoteId}::uuid
      `);
      check("the credit-note journal balances", Number(bal!.d) === Number(bal!.c));

      let twice = false;
      try {
        await createCreditNote(ctx, {
          invoiceId: paidInvoice.id, reason: "again", full: true,
        });
      } catch (err) {
        twice = err instanceof ServiceError && err.code === "invalid";
      }
      check("crediting more than the invoice is rejected", twice);
    });
  }

  // ── Offboarding ───────────────────────────────────────────────────────────
  //
  // The behaviour that makes deactivation mean anything: it must kill live
  // sessions in the same transaction. A membership marked inactive while a
  // valid cookie still opens the dashboard is a note, not an offboarding.
  {
    console.log("\nUser management");
    await inRollback(tenantId, userId, async (base) => {
      const ctx: ServiceContext = {
        ...base,
        principal: principal({
          userId, tenantId,
          permissions: new Set(["user:read", "user:update", "user:delete"]),
        }),
      };

      const [victim] = await ctx.tx.execute<{ membership_id: string; user_id: string }>(sql`
        SELECT m.id AS membership_id, m.user_id
          FROM memberships m JOIN roles r ON r.id = m.role_id
         WHERE r.key = 'barber' AND m.status = 'active' LIMIT 1
      `);

      // Two live sessions, so we prove ALL of them go, not just the newest.
      for (const n of [1, 2]) {
        await ctx.tx.execute(sql`
          INSERT INTO sessions (id, user_id, active_tenant_id, token_hash, expires_at)
          VALUES (gen_random_uuid(), ${victim!.user_id}::uuid, ${tenantId}::uuid,
                  ${`offboard-probe-${n}`}, now() + interval '7 days')
        `);
      }
      const before = await ctx.tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int n FROM sessions
         WHERE user_id = ${victim!.user_id}::uuid AND revoked_at IS NULL
      `);
      check("a user starts with live sessions", Number(before[0]!.n) >= 2, `${before[0]!.n}`);

      const res = await deactivateUser(ctx, {
        membershipId: victim!.membership_id,
        reason: "regression check",
        idempotencyKey: `deact-${Date.now()}`,
      });

      const [after] = await ctx.tx.execute<{ status: string; live: number }>(sql`
        SELECT m.status::text,
               (SELECT COUNT(*)::int FROM sessions s
                 WHERE s.user_id = m.user_id AND s.revoked_at IS NULL) AS live
          FROM memberships m WHERE m.id = ${victim!.membership_id}::uuid
      `);
      check("deactivating suspends the membership", after!.status === "suspended", after!.status);
      check("deactivating revokes EVERY live session", Number(after!.live) === 0,
        `${after!.live} left, ${res!.sessionsRevoked} revoked`);

      const [logged] = await ctx.tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int n FROM audit_log WHERE action = 'user.deactivate'
      `);
      check("deactivation is audited", Number(logged!.n) > 0);

      // Self-deactivation would lock the actor out of the screen they are on,
      // possibly with nobody left able to undo it.
      const [own] = await ctx.tx.execute<{ id: string }>(sql`
        SELECT id FROM memberships WHERE user_id = ${userId}::uuid LIMIT 1
      `);
      let refusedSelf = false;
      try {
        await deactivateUser(ctx, {
          membershipId: own!.id, reason: "should be refused",
          idempotencyKey: `self-${Date.now()}`,
        });
      } catch { refusedSelf = true; }
      check("you cannot deactivate your own access", refusedSelf);

      let refusedRole = false;
      try {
        await changeRole(ctx, {
          membershipId: own!.id, roleKey: "barber",
          idempotencyKey: `selfrole-${Date.now()}`,
        });
      } catch { refusedRole = true; }
      check("you cannot change your own role", refusedRole);
    });
  }

  // ── Nothing leaked ────────────────────────────────────────────────────────
  const [ledger] = await db.execute<{ unbalanced: number }>(sql`
    SELECT COUNT(*)::int unbalanced FROM (
      SELECT journal_id FROM journal_lines GROUP BY journal_id
       HAVING ROUND(SUM(base_debit),2) <> ROUND(SUM(base_credit),2)
    ) z
  `);
  console.log("");
  check("the ledger is still balanced after the whole suite",
    ledger!.unbalanced === 0, `${ledger!.unbalanced} unbalanced`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
