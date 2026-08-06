"use client";

import { useActionState, useId, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/actions";

/**
 * Form wrapper for every mutation in the product.
 *
 * Three behaviours it guarantees so no individual form has to remember them:
 *
 *  1. IDEMPOTENCY. A key is generated once per mounted form and submitted with
 *     it. A double-tapped button, or a retry after the connection drops
 *     mid-request, replays the original result instead of taking the money a
 *     second time. This is the single most valuable line in the file — staff
 *     record payments from basement car parks.
 *  2. DISABLED WHILE PENDING. Not just cosmetic; it removes the most common
 *     way a user creates a duplicate.
 *  3. INLINE RESULT. Success and failure render next to the button, not as a
 *     page-level flash the user has already scrolled past.
 *
 * This is the only client component in the app. Everything else is server
 * rendered — interactivity is the exception, not the default.
 */

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
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // Generated once on mount and reused for every submit of THIS form instance,
  // which is exactly the semantics an idempotency key needs.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const [state, formAction] = useActionState(
    async (_prev: ActionResult | null, formData: FormData) => {
      const result = await action(formData);
      if (result.ok) {
        formRef.current?.reset();
        onDone?.();
      }
      return result;
    },
    null,
  );

  return (
    <form ref={formRef} action={formAction} className={className}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {Object.entries(hidden ?? {}).map(([k, v]) =>
        v === undefined ? null : <input key={k} type="hidden" name={k} value={v} />,
      )}
      {children}
      <div className="flex items-center gap-2 flex-wrap">
        <SubmitButton label={submitLabel} pendingLabel={pendingLabel} variant={variant} />
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
