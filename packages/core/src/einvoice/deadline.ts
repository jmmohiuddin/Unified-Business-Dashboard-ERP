/**
 * THE ONLY DATE IN THIS PRODUCT THAT IS SET BY LAW.
 *
 * Every other deadline Nexus tracks — a licence, a visa, a VAT return — is
 * derived from a row in the database and moves when that row moves. These two
 * do not. UAE e-invoicing is mandatory from 1 July 2027, and the accredited
 * service provider through which every document must pass has to be appointed
 * by 31 March 2027. Miss the appointment and the go-live date is not
 * recoverable by working harder in June: the ASP onboarding, the TRN
 * validation and the test transmissions all sit inside that window.
 *
 * They live here, as constants, for one reason: the prior audit found the
 * requirement was implemented nowhere — zero occurrences of `einvoice`,
 * `PINT`, or `taxIdentificationNumber` anywhere in the repository — while the
 * localisation notes recorded it as "the UAE mandate phases in from 2026; not
 * implemented". A statutory date recorded only in prose is a date nothing can
 * count down to.
 *
 * WHAT IS *NOT* HERE. The penalty schedule (open question Q-3) and the final
 * PINT AE mandatory field list (Q-4) are unresolved. Nothing in this file
 * asserts a fine, a rate, or a field. The two dates below are the part that is
 * certain; guessing the rest would be exactly the failure mode the audit
 * flagged elsewhere — a legal claim stated as fact and pinned in place by a
 * passing test.
 */

/** ASP appointed by this date. The gate that opens the go-live window. */
export const EINVOICE_ASP_APPOINTMENT_DEADLINE = "2027-03-31";

/** Transmission mandatory from this date. */
export const EINVOICE_GO_LIVE_DEADLINE = "2027-07-01";

/**
 * When the countdown starts being shown at all.
 *
 * WF-05 §10.3 asks for the row to be "included from day one with a countdown,
 * so the deadline is visible for the 231 days before it becomes urgent rather
 * than the week after". Its worked example is 231 days out, so the wireframe's
 * own baseline is roughly a year of runway. A deadline shown only once it is
 * urgent has already failed at the one job a countdown has.
 */
export const EINVOICE_COUNTDOWN_WINDOW_DAYS = 540;

/** Inside this many days, the appointment stops being a plan and becomes work. */
export const EINVOICE_URGENT_WITHIN_DAYS = 120;

export type EInvoiceUrgency = "not_started" | "planning" | "urgent" | "overdue" | "live";

export interface EInvoiceCountdown {
  /** ISO date the appointment is due. */
  appointBy: string;
  /** ISO date transmission becomes mandatory. */
  liveBy: string;
  /** Whole days from `today` to `appointBy`. Negative once it has passed. */
  daysToAppoint: number;
  daysToGoLive: number;
  urgency: EInvoiceUrgency;
  /**
   * 0..1 — elapsed share of the runway, for a progress bar.
   *
   * Measured from the window opening (`EINVOICE_COUNTDOWN_WINDOW_DAYS` before
   * the appointment date), not from an arbitrary project start, so the bar
   * means the same thing on every tenant regardless of when they signed up.
   * Clamped, because a bar that runs past its track reads as a rendering bug
   * rather than as a missed deadline.
   */
  elapsedFraction: number;
}

/** Whole days between two ISO dates, matching `daysUntil` in format.ts. */
function wholeDaysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Where the group stands against the mandate, as at `today`.
 *
 * `today` is passed in rather than read from the clock. Every other date-aware
 * function in this codebase does the same, and for the same reason: the demo
 * dataset is anchored to a fixed day, the e2e run pins the clock, and a
 * countdown that consults `new Date()` cannot be tested at either boundary.
 *
 * `appointed` is the fact recorded on the legal entity, not a guess from the
 * calendar. An entity that has appointed its ASP is out of the countdown even
 * if the date has not arrived; one that has not is still counting even if it
 * believes it is ready.
 */
export function eInvoiceCountdown(today: string, appointed = false): EInvoiceCountdown {
  const daysToAppoint = wholeDaysBetween(today, EINVOICE_ASP_APPOINTMENT_DEADLINE);
  const daysToGoLive = wholeDaysBetween(today, EINVOICE_GO_LIVE_DEADLINE);

  const urgency: EInvoiceUrgency = appointed
    ? "live"
    : daysToAppoint < 0
      ? "overdue"
      : daysToAppoint <= EINVOICE_URGENT_WITHIN_DAYS
        ? "urgent"
        : daysToAppoint <= EINVOICE_COUNTDOWN_WINDOW_DAYS
          ? "planning"
          : "not_started";

  const elapsed = (EINVOICE_COUNTDOWN_WINDOW_DAYS - daysToAppoint) / EINVOICE_COUNTDOWN_WINDOW_DAYS;

  return {
    appointBy: EINVOICE_ASP_APPOINTMENT_DEADLINE,
    liveBy: EINVOICE_GO_LIVE_DEADLINE,
    daysToAppoint,
    daysToGoLive,
    urgency,
    elapsedFraction: Math.min(1, Math.max(0, elapsed)),
  };
}
