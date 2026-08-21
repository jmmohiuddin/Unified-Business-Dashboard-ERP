import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/page";

/**
 * The pieces every entry form in this module shares.
 *
 * Server components, no client JavaScript. The reason they are shared rather
 * than copied four times is the one the layout primitives already make: four
 * hand-rolled versions of the same form drift, and the amount field is the one
 * control in the product that has to behave identically every time because it
 * is used one-handed without looking.
 */

/**
 * The amount, as the hero.
 *
 * `autoFocus` and `inputMode="decimal"` are the two attributes that make this
 * a fifteen-second entry on a phone: the keyboard is already up and it is the
 * numeric one. `step="0.01"` keeps the browser from rejecting fils, and the
 * value goes to the server as text — it becomes exact decimal the moment it
 * crosses into the service and is never arithmetic'd as a float.
 */
export function AmountField({
  label = "How much?",
  currency = "AED",
}: {
  label?: string;
  currency?: string;
}) {
  return (
    <div className="text-center py-2">
      <label htmlFor="amount" className="label block mb-1">
        {label}
      </label>
      <div className="flex items-baseline justify-center gap-2">
        <span className="text-lg text-subtle">{currency}</span>
        <input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          required
          autoFocus
          inputMode="decimal"
          placeholder="0.00"
          className="tnum text-3xl font-semibold tracking-tight bg-transparent text-center w-[8ch] outline-none border-b-2 pb-1"
          style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
        />
      </div>
    </div>
  );
}

/** Back to the chooser, plus the sentence that explains what this screen does. */
export function EntryShell({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[560px] mx-auto space-y-4">
      <PageHeader title={title} subtitle={lede} back={{ href: "/cash", label: "Cash" }} />
      {children}
    </div>
  );
}

/**
 * The refusal shown instead of a form, rather than a form that fails on submit.
 *
 * WF-05 §3.7 puts the permission-denied state at the entry point: a control the
 * user is not allowed to use should not be rendered as one. This still is not
 * the authorisation — that is `requirePermission` in the service — it is the
 * courtesy of saying so before the amount has been typed.
 */
export function NotAllowed({ what, permission }: { what: string; permission: string }) {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[560px] mx-auto space-y-4">
      <PageHeader title={what} back={{ href: "/cash", label: "Cash" }} />
      <Card className="p-6" as="div">
        <p className="text-xs font-semibold">Not on this account.</p>
        <p className="text-2xs text-subtle mt-1.5 leading-relaxed max-w-[52ch]">
          This needs the <code className="text-2xs">{permission}</code> permission. Ask the
          owner or the accountant. If you are holding money that has to be recorded now, ask
          someone who can — <Link href="/cash" className="underline">the other entry types</Link>{" "}
          may still be open to you.
        </p>
      </Card>
    </div>
  );
}

/**
 * The line above the button that tells the user what this will do to something
 * they actually understand.
 *
 * WF-05 §3.2 calls the two lines above the record button "the design's whole
 * argument": the first states the effect on the float in their pocket, the
 * second explains a tax rule in one clause at the moment it applies, rather
 * than in a settings page nobody reads.
 */
export function EffectNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-2xs leading-relaxed px-3 py-2 rounded-[var(--radius-md)] mb-3"
      style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
    >
      {children}
    </div>
  );
}

/** Business-unit picker. Always present: a posting has to belong somewhere. */
export function businessOptions(units: { id: string; name: string }[]) {
  return units.map((u) => ({ value: u.id, label: u.name }));
}

/**
 * Cash-point picker options, or null when there is nothing to choose.
 *
 * WF-05 §3.2 shows the field "only if >1 cash point". Where a business has no
 * configured till the entry posts to its 1100 cash account and the user is
 * never asked a question with one answer.
 */
export function cashPointOptions(
  points: { id: string | null; name: string; businessUnitName: string }[],
) {
  const configured = points.filter((p) => p.id !== null);
  if (configured.length === 0) return null;
  return configured.map((p) => ({
    value: p.id!,
    label: `${p.name} · ${p.businessUnitName}`,
  }));
}
