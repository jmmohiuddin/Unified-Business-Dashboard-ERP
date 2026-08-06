import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { appointmentStatusAction, bookAppointmentAction } from "@/lib/actions";
import { DataTable, PageHeader, StatStrip, StatusPill, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

const OPEN_HOUR = 10;
const CLOSE_HOUR = 22;

/**
 * Salon day view — a chair-by-chair timeline.
 *
 * Rendered as a CSS grid of absolutely positioned blocks rather than a table,
 * because the thing a salon manager needs to see is *gaps*: an empty 40 minutes
 * on chair 2 at 4pm is a booking opportunity, and it is invisible in a list.
 *
 * Server-rendered, no client JavaScript. Overlaps are impossible by
 * construction — a GiST exclusion constraint on (resource, time range) rejects
 * a double-booking at the database.
 */
export default async function SalonPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const today = resolveToday(session.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date! : today;
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [{ metricId: "appointments_today" }]);
  const appts = metric(m, "appointments_today");

  const { chairs, bookings, staff, services, salonBu } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const chairs = await tx.execute<{ id: string; name: string; employee: string | null }>(sql`
        SELECT r.id, r.name, e.full_name AS employee
          FROM resources r
          LEFT JOIN employees e ON e.id = r.default_employee_id
         WHERE r.kind = 'chair' AND r.is_active = true
         ORDER BY r.code
      `);

      const bookings = await tx.execute<{
        id: string; reference: string; resource_id: string | null; status: string;
        starts_at: string; ends_at: string; party: string | null; walk_in: string | null;
        value: string; service: string | null; employee: string | null; source: string;
      }>(sql`
        SELECT a.id, a.reference, a.resource_id, a.status::text,
               to_char(a.starts_at AT TIME ZONE 'Asia/Dubai', 'HH24:MI') AS starts_at,
               to_char(a.ends_at   AT TIME ZONE 'Asia/Dubai', 'HH24:MI') AS ends_at,
               p.display_name AS party, a.walk_in_name AS walk_in,
               a.estimated_value AS value, i.name AS service,
               e.full_name AS employee, a.source
          FROM appointments a
          LEFT JOIN parties p ON p.id = a.party_id
          LEFT JOIN employees e ON e.id = a.employee_id
          LEFT JOIN appointment_services asv ON asv.appointment_id = a.id
          LEFT JOIN items i ON i.id = asv.item_id
         WHERE a.starts_at >= ${date}::date
           AND a.starts_at <  ${date}::date + 1
         ORDER BY a.starts_at
      `);

      const staff = await tx.execute<{
        name: string; services: number; revenue: string; commission: string;
      }>(sql`
        SELECT e.full_name AS name, COUNT(a.id)::int AS services,
               COALESCE(SUM(a.estimated_value), 0) AS revenue,
               COALESCE(SUM(a.estimated_value) * 0.25, 0) AS commission
          FROM appointments a JOIN employees e ON e.id = a.employee_id
         WHERE a.starts_at >= date_trunc('month', ${date}::date)
           AND a.status = 'completed'
         GROUP BY e.full_name ORDER BY 3 DESC
      `);

      const services = await tx.execute<{ id: string; name: string; price: string }>(sql`
        SELECT i.id, i.name, i.sale_price AS price
          FROM items i JOIN business_units b ON b.id = i.business_unit_id
         WHERE i.type = 'service' AND b.kind = 'salon' AND i.is_active = true
         ORDER BY i.name
      `);
      const [salonBu] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM business_units WHERE kind = 'salon' LIMIT 1
      `);
      return { chairs, bookings, staff, services, salonBu };
    },
  );

  const toMin = (hhmm: string) => {
    const [h, m2] = hhmm.split(":").map(Number);
    return h! * 60 + m2!;
  };
  const dayStart = OPEN_HOUR * 60;
  const dayEnd = CLOSE_HOUR * 60;
  const dayLength = dayEnd - dayStart;

  const active = bookings.filter((b) => !["cancelled", "no_show"].includes(b.status));
  const bookedMinutes = active.reduce(
    (t, b) => t + (toMin(b.ends_at) - toMin(b.starts_at)),
    0,
  );
  const capacity = chairs.length * dayLength;
  const utilisation = capacity ? Math.round((bookedMinutes / capacity) * 100) : 0;
  const dayValue = active.reduce((t, b) => t + Number(b.value), 0);
  const noShows = bookings.filter((b) => b.status === "no_show").length;

  const prev = new Date(`${date}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const hours = Array.from({ length: CLOSE_HOUR - OPEN_HOUR + 1 }, (_, i) => OPEN_HOUR + i);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Salon"
        subtitle={new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
          weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
        })}
        actions={
          <div className="flex gap-1.5">
            <a href={`/salon?date=${iso(prev)}`} className="btn btn-ghost text-xs">←</a>
            <a href="/salon" className="btn btn-ghost text-xs">Today</a>
            <a href={`/salon?date=${iso(next)}`} className="btn btn-ghost text-xs">→</a>
          </div>
        }
      />

      <StatStrip
        stats={[
          { label: "Appointments", value: String(bookings.length) },
          {
            label: "Chair utilisation",
            value: `${utilisation}%`,
            tone: utilisation >= 60 ? "positive" : utilisation >= 35 ? "caution" : "negative",
            hint: `${Math.round(bookedMinutes / 60)}h of ${Math.round(capacity / 60)}h`,
          },
          { label: "Booked value", value: formatMoney(dayValue, ccy, 0), tone: "accent" },
          {
            label: "No-shows",
            value: String(noShows),
            tone: noShows > 0 ? "negative" : "positive",
          },
          {
            label: "Walk-ins",
            value: String(bookings.filter((b) => b.source === "walk_in").length),
            hint: "No customer record required",
          },
        ]}
      />

      {/* ── Chair timeline ─────────────────────────────────────────────── */}
      <Card>
        {/* A walk-in must NOT require creating a customer first. If the barber
            has to fill a form before ringing up a AED 60 haircut, they stop
            using the system by Wednesday and every number becomes fiction. */}
        <Disclosure summary="+ Book a chair">
          <ActionForm
            action={bookAppointmentAction}
            submitLabel="Book"
            pendingLabel="Booking…"
            className="space-y-3"
            hidden={{ businessUnitId: salonBu?.id, date }}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Chair" name="resourceId" required
                options={chairs.map((c) => ({ value: c.id, label: c.name }))} />
              <Field label="Service" name="itemId" required
                options={services.map((sv) => ({
                  value: sv.id,
                  label: `${sv.name} — AED ${Math.round(Number(sv.price))}`,
                }))} />
              <Field label="Time" name="time" type="time" defaultValue="10:00" required />
              <Field label="Customer name" name="walkInName" placeholder="Walk-in" />
              <Field label="Phone" name="walkInPhone" placeholder="+9715…" />
            </div>
            <p className="text-2xs text-subtle leading-relaxed">
              Booking on {date}. A clashing slot is rejected by the database, not by this form —
              a GiST exclusion constraint makes double-booking a chair impossible.
            </p>
          </ActionForm>
        </Disclosure>

        <CardHeader
          title="Chairs"
          subtitle="Gaps are booking opportunities — double-booking is rejected by the database"
        />
        <div className="px-4 pb-4 overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Hour ruler */}
            <div className="flex text-2xs text-subtle mb-1" style={{ paddingLeft: "5.5rem" }}>
              {hours.slice(0, -1).map((h) => (
                <div key={h} style={{ width: `${(60 / dayLength) * 100}%` }} className="tnum">
                  {String(h).padStart(2, "0")}
                </div>
              ))}
            </div>

            {chairs.map((chair) => {
              const slots = active.filter((b) => b.resource_id === chair.id);
              return (
                <div key={chair.id} className="flex items-stretch mb-1.5">
                  <div className="w-22 shrink-0 pr-2" style={{ width: "5.5rem" }}>
                    <p className="text-xs font-medium truncate">{chair.name}</p>
                    <p className="text-2xs text-subtle truncate">{chair.employee}</p>
                  </div>
                  <div
                    className="relative flex-1 rounded-[var(--radius-sm)] h-11"
                    style={{ background: "var(--surface-2)" }}
                  >
                    {slots.map((b) => {
                      const s = Math.max(dayStart, toMin(b.starts_at));
                      const e = Math.min(dayEnd, toMin(b.ends_at));
                      if (e <= s) return null;
                      const left = ((s - dayStart) / dayLength) * 100;
                      const width = ((e - s) / dayLength) * 100;
                      const done = b.status === "completed";
                      return (
                        <div
                          key={b.id}
                          className="absolute top-0.5 bottom-0.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 overflow-hidden"
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            background: done ? "var(--surface-3)" : "var(--accent-soft)",
                            border: `1px solid ${done ? "var(--border-strong)" : "var(--accent-border)"}`,
                          }}
                          title={`${b.starts_at}–${b.ends_at} · ${b.service} · ${b.party ?? b.walk_in}`}
                        >
                          <p
                            className="text-2xs font-semibold truncate leading-tight"
                            style={{ color: done ? "var(--text-muted)" : "var(--accent)" }}
                          >
                            {b.service}
                          </p>
                          <p className="text-2xs text-subtle truncate leading-tight">
                            {b.party ?? b.walk_in}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {chairs.length === 0 && (
              <EmptyState title="No chairs configured" detail="Add a resource to start booking." icon="○" />
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Bookings" subtitle="In time order" />
          <DataTable
            rows={bookings}
            rowKey={(b) => b.id}
            empty={<TableEmpty title="Nothing booked" detail="No appointments on this day." />}
            columns={[
              { key: "time", header: "Time", render: (b) => <span className="tnum font-medium">{b.starts_at}</span> },
              { key: "service", header: "Service", render: (b) => b.service ?? "—" },
              {
                key: "client", header: "Client",
                render: (b) => (
                  <div className="min-w-0">
                    <p className="truncate">{b.party ?? b.walk_in ?? "Walk-in"}</p>
                    <p className="text-2xs text-subtle">{b.source.replace(/_/g, " ")}</p>
                  </div>
                ),
              },
              { key: "staff", header: "Stylist", render: (b) => b.employee ?? "—" },
              { key: "status", header: "Status", render: (b) => <StatusPill status={b.status} /> },
              { key: "value", header: "Value", numeric: true, render: (b) => formatMoney(Number(b.value), ccy, 0) },
              {
                key: "do", header: "", numeric: true,
                render: (b) =>
                  b.status === "booked" || b.status === "confirmed" ? (
                    <div className="flex gap-1 justify-end">
                      <ActionForm action={appointmentStatusAction} submitLabel="Check in"
                        pendingLabel="…" variant="ghost"
                        hidden={{ appointmentId: b.id, status: "checked_in" }} />
                      <ActionForm action={appointmentStatusAction} submitLabel="No-show"
                        pendingLabel="…" variant="ghost"
                        hidden={{ appointmentId: b.id, status: "no_show" }} />
                    </div>
                  ) : b.status === "checked_in" || b.status === "in_service" ? (
                    <ActionForm action={appointmentStatusAction} submitLabel="Done"
                      pendingLabel="…" hidden={{ appointmentId: b.id, status: "completed" }} />
                  ) : null,
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Stylist commission" subtitle="Month to date, 25% of service revenue" />
          <div className="px-4 pb-4">
            {staff.length === 0 ? (
              <TableEmpty title="No completed services" detail="Nothing this month." />
            ) : (
              staff.map((s) => (
                <div
                  key={s.name}
                  className="py-2 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium truncate">{s.name}</span>
                    <span className="text-xs tnum font-semibold shrink-0">
                      {formatMoney(Number(s.commission), ccy, 0)}
                    </span>
                  </div>
                  <p className="text-2xs text-subtle">
                    {s.services} services · {formatMoney(Number(s.revenue), ccy, 0)} revenue
                  </p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
