"use client";

import { useActionState, useId, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/actions";

/**
 * Form wrapper for every mutation in the product.
 *
 * Three behaviours it guarantees so no individual form has to remember them:
 *
 *  1. IDEMPOTENCY. A key describing WHAT IS BEING SUBMITTED goes with every
 *     submit. A double-tapped button, or a retry after the connection drops
 *     mid-request, replays the original result instead of taking the money a
 *     second time. This is the single most valuable behaviour in the file —
 *     staff record payments from basement car parks.
 *  2. DISABLED WHILE PENDING. Not just cosmetic; it removes the most common
 *     way a user creates a duplicate.
 *  3. INLINE RESULT. Success and failure render next to the button, not as a
 *     page-level flash the user has already scrolled past.
 *
 * This is the only client component in the app. Everything else is server
 * rendered — interactivity is the exception, not the default.
 */

const IDEMPOTENCY_FIELD = "idempotencyKey";

/**
 * Distinguishes this page load from the last one.
 *
 * Without it, "mark all read" — a form with nothing in it but a button —
 * submits the identical payload on every visit forever, and the server, doing
 * exactly what it is told, replays the first visit's result and leaves the new
 * notifications unread. A reload is the user starting over, and the key has to
 * say so.
 */
const CLIENT_EPOCH =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * How many times each distinct intent has already SUCCEEDED in this page load.
 *
 * This is what separates "the request I just made did not come back, let me
 * press it again" from "I have now been handed a second, genuinely identical
 * payment". The first must deduplicate and the second must not, and the payload
 * alone cannot tell them apart. A failed submit never counts, so the retry path
 * — the one that protects money — keys identically to the attempt it retries.
 *
 * Module scope, keyed by the intent rather than held per component, for two
 * reasons: a remount between the failure and the retry must not lose the count
 * and cause a second posting, and one form succeeding must not shift the key
 * another form is about to retry with.
 */
const succeededIntents = new Map<string, number>();

/**
 * Canonical serialisation of what the user actually submitted.
 *
 * Sorted, so a form that renders its fields in a different order on a re-render
 * still describes the same intent; length-prefixed, so no value can forge a
 * field boundary — a payment reference typed as `amount=250&` must not
 * fingerprint as a different field list.
 */
function canonicalIntent(formData: FormData): string {
  const fields: string[] = [];
  for (const [name, value] of formData.entries()) {
    if (name === IDEMPOTENCY_FIELD) continue;
    const text = typeof value === "string" ? value : `file:${value.name}:${value.size}`;
    fields.push(`${name.length}:${name}=${text.length}:${text}`);
  }
  fields.sort();
  return fields.join("&");
}

/**
 * FNV-1a, 128 bits.
 *
 * Used only where `crypto.subtle` is absent — it needs a secure context, and
 * this form has to keep working if one is not available rather than fall back
 * to a random key, which would mean no deduplication at all and a double-tap
 * taking the money twice. A non-cryptographic digest is adequate here because
 * the key is a deduplication fingerprint scoped to one tenant and one
 * operation, not an authorisation token: the only thing a collision can buy an
 * attacker is the replay of a result they could produce themselves. 128 bits
 * puts accidental collisions out of reach, which is the failure that matters.
 */
function fnv1a128(bytes: Uint8Array): string {
  const OFFSET_BASIS = 0x6c62272e07bb014262b821756295c58dn;
  const PRIME = 0x0000000001000000000000000000013bn;
  const MASK = (1n << 128n) - 1n;
  let hash = OFFSET_BASIS;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  return hash.toString(16).padStart(32, "0");
}

/**
 * The idempotency key: a digest of the intent, not of the form instance.
 *
 * The previous key was one UUID per MOUNTED FORM, reused for every submit. A
 * cashier took AED 100 from Ahmed, the panel reset but stayed mounted, she then
 * took AED 250 from Fatima — and the server, keyed only on that UUID, replayed
 * the AED 100 result. The UI reported a payment number for money that was never
 * posted. Deriving the key from the payload makes two different intents two
 * different keys by construction, while an unchanged payload keys the same and
 * still deduplicates.
 *
 * Truncated to 128 bits so the key fits the server's `varchar(120)` column
 * alongside the operation name it is namespaced with.
 */
async function digestIntent(intent: string, generation: number): Promise<string> {
  const bytes = new TextEncoder().encode(`${CLIENT_EPOCH}\n${generation}\n${intent}`);
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) return fnv1a128(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
}: {
  label: string;
  pendingLabel?: string;
  variant?: "primary" | "ghost" | "danger";
}) {
  const { pending } = useFormStatus();
  const style =
    variant === "danger"
      ? { background: "var(--negative)", color: "var(--text-inverse)" }
      : variant === "ghost"
        ? { background: "var(--surface-2)", color: "var(--text-muted)" }
        : undefined;
  return (
    <button
      type="submit"
      disabled={pending}
      className={`btn text-xs ${variant === "primary" ? "btn-primary" : ""}`}
      style={{ ...style, opacity: pending ? 0.6 : 1 }}
    >
      {pending ? (pendingLabel ?? "Working…") : label}
    </button>
  );
}

export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  variant = "primary",
  className = "",
  hidden,
  onDone,
  confirm,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "ghost" | "danger";
  className?: string;
  /** Static values that never change between renders. */
  hidden?: Record<string, string | undefined>;
  onDone?: () => void;
  /**
   * Plain-language description of the irreversible effect, shown before the
   * write happens.
   *
   * Eight paths posted a journal on a single click with no interstitial —
   * including cheque *Bounce* as a bare button in a table row and a credit
   * note that can issue a cash refund. The idempotency key stops an accidental
   * double-post of the same intent; it does nothing about a wrong first one,
   * and there is no void UI for most of these.
   *
   * Deliberately states the EFFECT, not "are you sure?". A confirmation the
   * user cannot read is a click-through, which is worse than none because it
   * looks like a control.
   */
  confirm?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);

  const [state, formAction] = useActionState(
    async (_prev: ActionResult | null, formData: FormData) => {
      // Derived here rather than rendered as a hidden field, because the key
      // has to describe the values being sent — which are only known at the
      // moment of submission, not at the moment the form mounted.
      const intent = canonicalIntent(formData);
      const generation = succeededIntents.get(intent) ?? 0;
      formData.set(IDEMPOTENCY_FIELD, await digestIntent(intent, generation));
      const result = await action(formData);
      if (result.ok) {
        succeededIntents.set(intent, generation + 1);
        formRef.current?.reset();
        onDone?.();
      }
      return result;
    },
    null,
  );

  return (
    <form
      ref={formRef}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        // Two-step rather than window.confirm: a native dialog cannot be styled,
        // is suppressible by the browser, and reads as a bug on mobile.
        if (confirm && !pendingConfirm) {
          e.preventDefault();
          setPendingConfirm(true);
        }
      }}
    >
      {Object.entries(hidden ?? {}).map(([k, v]) =>
        v === undefined ? null : <input key={k} type="hidden" name={k} value={v} />,
      )}
      {children}

      {confirm && pendingConfirm && (
        <div
          className="text-2xs leading-relaxed px-3 py-2 mb-2 rounded-[var(--radius-md)]"
          style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
          role="alert"
        >
          {confirm}
          <button
            type="button"
            onClick={() => setPendingConfirm(false)}
            className="underline ml-1.5"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <SubmitButton
          label={confirm && pendingConfirm ? `Yes — ${submitLabel.toLowerCase()}` : submitLabel}
          pendingLabel={pendingLabel}
          variant={confirm && pendingConfirm ? "danger" : variant}
        />
        {state && (
          <span
            className="text-2xs"
            role={state.ok ? "status" : "alert"}
            style={{ color: state.ok ? "var(--positive)" : "var(--negative)" }}
          >
            {state.message ?? (state.ok ? "Saved." : "Failed.")}
          </span>
        )}
      </div>
    </form>
  );
}

/** Labelled input, so every form field looks the same without repetition. */
export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required,
  step,
  min,
  options,
  className = "",
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  placeholder?: string;
  required?: boolean;
  step?: string;
  min?: string;
  options?: { value: string; label: string }[];
  className?: string;
}) {
  const id = useId();
  const shared = {
    id,
    name,
    required,
    defaultValue,
    className: "w-full px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs",
    style: {
      background: "var(--surface)",
      border: "1px solid var(--border-strong)",
      color: "var(--text)",
    },
  };
  return (
    <div className={className}>
      <label htmlFor={id} className="label block mb-1">
        {label}
      </label>
      {options ? (
        <select {...shared}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input {...shared} type={type} placeholder={placeholder} step={step} min={min} />
      )}
    </div>
  );
}

/**
 * Collapsible panel for forms that would otherwise dominate a read-heavy
 * screen. Uses <details>, so it works with JavaScript disabled and needs no
 * state of its own.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary
        className="cursor-pointer list-none px-4 py-2.5 text-xs font-semibold select-none flex items-center gap-1.5"
        style={{ color: "var(--accent)" }}
      >
        <span className="group-open:rotate-90 transition-transform" aria-hidden>
          ›
        </span>
        {summary}
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}
