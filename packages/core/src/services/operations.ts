import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ServiceError,
  nextDocumentNumber,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * Operational writes: bookings and jobs.
 *
 * These are the ones front-line staff touch dozens of times a day, so the
 * design priority is "impossible to get wrong in a hurry" rather than
 * completeness of options.
 */

/**
 * Detect a specific database constraint violation through however many layers
 * of error wrapping sit between the driver and here.
 *
 * Worth doing properly: the difference between "that chair is already booked"
 * and a generic 500 is the difference between a receptionist rebooking in five
 * seconds and one phoning support.
 */
function isConstraintViolation(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as { message?: string; constraint_name?: string; cause?: unknown };
    if (e.constraint_name === constraint) return true;
    if (typeof e.message === "string" && e.message.includes(constraint)) return true;
    current = e.cause;
  }
  // Last resort: the name may only survive in the serialised form.
  try {
    return JSON.stringify(err, Object.getOwnPropertyNames(Object(err))).includes(constraint);
  } catch {
    return false;
  }
}

// ── Appointments ────────────────────────────────────────────────────────────

export const bookAppointmentInput = z.object({
  businessUnitId: z.uuid(),
  resourceId: z.uuid(),
  employeeId: z.uuid().nullable().optional(),
  itemId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  /** Existing customer, OR a walk-in name — never both required. */
  partyId: z.uuid().nullable().optional(),
  walkInName: z.string().max(150).optional(),
  walkInPhone: z.string().max(40).optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Book a chair.
 *
 * A walk-in does NOT require creating a customer record first. That one
 * decision is worth more to adoption than any feature on the roadmap: if the
 * barber has to fill in a customer form before ringing up a AED 60 haircut,
 * they will stop using the system by Wednesday and every number in it becomes
 * fiction.
 */
export async function bookAppointment(ctx: ServiceContext, raw: unknown) {
  const input = bookAppointmentInput.parse(raw);
  requirePermission(ctx, "appointment:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  if (!input.partyId && !input.walkInName) {
    throw new ServiceError("Give a customer or a walk-in name.", "invalid");
  }

  return withIdempotency(ctx, input.idempotencyKey, "bookAppointment", async () => {
    const svc = await ctx.tx.execute<{
      name: string; duration: number | null; price: string;
    }>(sql`
      SELECT name, duration_minutes AS duration, sale_price AS price
        FROM items WHERE id = ${input.itemId}::uuid
    `);
    if (svc.length === 0) throw new ServiceError("Service not found.", "not_found");

    const duration = svc[0]!.duration ?? 30;
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(+startsAt + duration * 60_000);

    const reference = await nextDocumentNumber(
      ctx, input.businessUnitId, "appointment", "APT",
    );

    // The database enforces no-overlap via a GiST exclusion constraint, so the
    // check here is only to turn a constraint violation into a usable message.
    // The guarantee lives in Postgres, not in this function.
    try {
      const appt = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO appointments
          (id, tenant_id, business_unit_id, reference, party_id, walk_in_name, walk_in_phone,
           resource_id, employee_id, status, starts_at, ends_at, estimated_value, source, notes)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
           ${reference}, ${input.partyId ?? null}::uuid, ${input.walkInName ?? null},
           ${input.walkInPhone ?? null}, ${input.resourceId}::uuid,
           ${input.employeeId ?? null}::uuid, 'booked',
           ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
           ${svc[0]!.price}, ${input.partyId ? "phone" : "walk_in"}, ${input.notes ?? null})
        RETURNING id
      `);
      const appointmentId = appt[0]!.id;

      await ctx.tx.execute(sql`
        INSERT INTO appointment_services
          (id, tenant_id, appointment_id, item_id, employee_id, price, duration_minutes)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${appointmentId}::uuid,
           ${input.itemId}::uuid, ${input.employeeId ?? null}::uuid, ${svc[0]!.price}, ${duration})
      `);

      await writeAudit(ctx, {
        action: "appointment.book",
        entityTable: "appointments",
        entityId: appointmentId,
        businessUnitId: input.businessUnitId,
        diff: { reference, service: svc[0]!.name, startsAt: startsAt.toISOString() },
      });

      return { appointmentId, reference, endsAt: endsAt.toISOString() };
    } catch (err) {
      // Drizzle wraps driver errors, so the constraint name can be on the
      // original error, its `cause`, or only in the serialised text. Walk the
      // whole chain rather than trusting one shape.
      if (isConstraintViolation(err, "appointments_no_resource_overlap")) {
        throw new ServiceError(
          "That chair is already booked for part of this slot.",
          "conflict",
        );
      }
      throw err;
    }
  });
}

export const setAppointmentStatusInput = z.object({
  appointmentId: z.uuid(),
  status: z.enum(["confirmed", "checked_in", "in_service", "completed", "no_show", "cancelled"]),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function setAppointmentStatus(ctx: ServiceContext, raw: unknown) {
  const input = setAppointmentStatusInput.parse(raw);
  requirePermission(ctx, "appointment:update");

  const rows = await ctx.tx.execute<{ business_unit_id: string; status: string }>(sql`
    SELECT business_unit_id, status::text FROM appointments
     WHERE id = ${input.appointmentId}::uuid FOR UPDATE
  `);
  if (rows.length === 0) throw new ServiceError("Appointment not found.", "not_found");
  requireBusinessUnit(ctx, rows[0]!.business_unit_id);

  const stamp =
    input.status === "checked_in" ? sql`checked_in_at = now(),`
    : input.status === "in_service" ? sql`service_started_at = now(),`
    : input.status === "completed" ? sql`completed_at = now(),`
    : sql``;

  await ctx.tx.execute(sql`
    UPDATE appointments SET ${stamp} status = ${input.status}::appointment_status,
           updated_at = now()
     WHERE id = ${input.appointmentId}::uuid
  `);

  await writeAudit(ctx, {
    action: `appointment.${input.status}`,
    entityTable: "appointments",
    entityId: input.appointmentId,
    businessUnitId: rows[0]!.business_unit_id,
    diff: { from: rows[0]!.status, to: input.status },
  });

  return { appointmentId: input.appointmentId, status: input.status };
}

// ── Field-service jobs ──────────────────────────────────────────────────────

export const createJobInput = z.object({
  businessUnitId: z.uuid(),
  serviceKind: z.string().min(1).max(40),
  title: z.string().min(1).max(250),
  description: z.string().max(2000).optional(),
  partyId: z.uuid().nullable().optional(),
  siteId: z.uuid().nullable().optional(),
  /** Set when the work is on one of the owner's OWN rental units. */
  unitId: z.uuid().nullable().optional(),
  priority: z.enum(["low", "normal", "high", "emergency"]).default("normal"),
  itemId: z.uuid().nullable().optional(),
  assignEmployeeId: z.uuid().nullable().optional(),
  scheduledStart: z.iso.datetime({ offset: true }).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Raise a work order.
 *
 * SLA targets are derived from priority rather than typed in, because a target
 * nobody sets is a target nobody misses — and the SLA-breach count is the single
 * best predictor of complaints in this business.
 */
export async function createJob(ctx: ServiceContext, raw: unknown) {
  const input = createJobInput.parse(raw);
  requirePermission(ctx, "job:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "createJob", async () => {
    const jobNumber = await nextDocumentNumber(ctx, input.businessUnitId, "job", "JOB");

    const respondHours = input.priority === "emergency" ? 4 : input.priority === "high" ? 8 : 24;
    const completeHours = input.priority === "emergency" ? 8 : input.priority === "high" ? 24 : 72;

    let quoted: string | null = null;
    let duration = 60;
    if (input.itemId) {
      const item = await ctx.tx.execute<{ sale_price: string; duration_minutes: number | null }>(sql`
        SELECT sale_price, duration_minutes FROM items WHERE id = ${input.itemId}::uuid
      `);
      quoted = item[0]?.sale_price ?? null;
      duration = item[0]?.duration_minutes ?? 60;
    }

    const job = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO jobs
        (id, tenant_id, business_unit_id, job_number, service_kind, title, description,
         party_id, site_id, unit_id, status, priority, reported_at, respond_by, complete_by,
         estimated_value, quoted_value, owner_user_id)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${jobNumber}, ${input.serviceKind}, ${input.title}, ${input.description ?? null},
         ${input.partyId ?? null}::uuid, ${input.siteId ?? null}::uuid,
         ${input.unitId ?? null}::uuid,
         ${input.scheduledStart ? "scheduled" : "request"}::job_status,
         ${input.priority}::job_priority, now(),
         now() + (${respondHours}::int * interval '1 hour'),
         now() + (${completeHours}::int * interval '1 hour'),
         ${quoted}, ${quoted}, ${ctx.principal.userId}::uuid)
      RETURNING id
    `);
    const jobId = job[0]!.id;

    if (input.scheduledStart) {
      const start = new Date(input.scheduledStart);
      await ctx.tx.execute(sql`
        INSERT INTO job_visits
          (id, tenant_id, job_id, seq, employee_id, status, scheduled_start, scheduled_end)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${jobId}::uuid, 1,
           ${input.assignEmployeeId ?? null}::uuid, 'planned',
           ${start.toISOString()}::timestamptz,
           ${new Date(+start + duration * 60_000).toISOString()}::timestamptz)
      `);
    }

    await writeAudit(ctx, {
      action: "job.create",
      entityTable: "jobs",
      entityId: jobId,
      businessUnitId: input.businessUnitId,
      diff: { jobNumber, serviceKind: input.serviceKind, priority: input.priority,
        internal: Boolean(input.unitId) },
    });

    return { jobId, jobNumber };
  });
}

export const completeJobInput = z.object({
  jobId: z.uuid(),
  /** Raise the invoice at the same time — the normal case on completion. */
  invoice: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function completeJob(ctx: ServiceContext, raw: unknown) {
  const input = completeJobInput.parse(raw);
  requirePermission(ctx, "job:complete");

  const rows = await ctx.tx.execute<{
    business_unit_id: string; status: string; job_number: string; unit_id: string | null;
  }>(sql`
    SELECT business_unit_id, status::text, job_number, unit_id
      FROM jobs WHERE id = ${input.jobId}::uuid FOR UPDATE
  `);
  const job = rows[0];
  if (!job) throw new ServiceError("Job not found.", "not_found");
  requireBusinessUnit(ctx, job.business_unit_id);
  if (["completed", "invoiced", "cancelled"].includes(job.status)) {
    throw new ServiceError(`Job is already ${job.status}.`, "conflict");
  }

  await ctx.tx.execute(sql`
    UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE id = ${input.jobId}::uuid
  `);
  await ctx.tx.execute(sql`
    UPDATE job_visits SET status = 'done', actual_end = now(), updated_at = now()
     WHERE job_id = ${input.jobId}::uuid AND status NOT IN ('done','cancelled')
  `);

  await writeAudit(ctx, {
    action: "job.complete",
    entityTable: "jobs",
    entityId: input.jobId,
    businessUnitId: job.business_unit_id,
    diff: { jobNumber: job.job_number, from: job.status },
  });

  return { jobId: input.jobId, jobNumber: job.job_number, internal: Boolean(job.unit_id) };
}
