"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/**
 * The `find` affordance from WF-05 §1.1 and §1.2.
 *
 * Both wireframes put it in the shell on both breakpoints and neither rendered
 * it. This is that control. It has two jobs and they pull in opposite
 * directions, which is why it is written the way it is.
 *
 * IT MUST WORK WITHOUT JAVASCRIPT. It is a real `<form method="get">` pointing
 * at `/search`. Typing and pressing Enter navigates, hydrated or not. Every
 * other piece of persistent chrome in this product — the nav, the `More`
 * disclosure, the sign-out button — is a server component or a plain form for
 * the same reason: chrome that breaks when hydration fails takes the whole
 * product with it, and this box is the only route to a specific record.
 *
 * IT MUST FEEL LIKE A SEARCH BOX, NOT A FORM. Once hydrated, typing debounces
 * for `DEBOUNCE_MS` and then replaces the URL, so results refine as you type
 * without a history entry per keystroke — press Back once and you are on the
 * screen you came from, not thirteen prefixes deep. `router.replace` is what
 * makes that true; `push` would make the Back button unusable.
 *
 * `useTransition` gives the pending flag. It is deliberately NOT used to hide
 * the results: the previous result set stays on screen, dimmed, while the next
 * one loads, because a search box that blanks between keystrokes reads as
 * broken and makes the product feel slower than the 6 ms the query takes.
 *
 * ── WHERE THIS MOUNTS ───────────────────────────────────────────────────────
 *
 * `apps/web/src/app/(app)/layout.tsx`, which this agent does not own. See the
 * accompanying report for the exact two insertion points and the permission
 * the mount is gated on.
 */

/**
 * 250 ms.
 *
 * Below about 150 ms the debounce stops debouncing and every keystroke becomes
 * a request; above about 400 ms the box feels like it is thinking rather than
 * responding. 250 also comfortably exceeds the measured 4-9 ms server time, so
 * the wait the user perceives is this timer plus a round trip, not the query.
 */
const DEBOUNCE_MS = 250;

/** Mirrors `MIN_QUERY_LENGTH` in the service. Below it, nothing is sent. */
const MIN_LENGTH = 2;

export function SearchBox({
  /** Current query, when the box is rendered on `/search` itself. */
  defaultValue = "",
  /**
   * `shell` is the compact box in the header; `page` is the wide one on the
   * results screen, which also takes focus on arrival.
   */
  variant = "shell",
  className = "",
}: {
  defaultValue?: string;
  variant?: "shell" | "page";
  className?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // The URL is the source of truth. When it changes underneath us — the user
  // pressed Back, or followed a "see all" link that carries a different term —
  // the box has to follow it, or it starts lying about what is on screen.
  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  /**
   * Debounced navigation.
   *
   * Skipped entirely while the box still shows what the URL already says,
   * which is the state on first render — otherwise every mount would fire a
   * redundant `replace` and the results screen would re-render itself once for
   * free on arrival.
   */
  useEffect(() => {
    if (value === defaultValue) return;
    const trimmed = value.trim();
    // Clearing the box goes back to the empty-query state rather than leaving
    // the last results on screen under an empty input.
    if (trimmed.length > 0 && trimmed.length < MIN_LENGTH) return;
    const timer = setTimeout(() => {
      startTransition(() => {
        router.replace(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, defaultValue, router]);

  useEffect(() => {
    if (variant === "page") inputRef.current?.focus();
  }, [variant]);

  const compact = variant === "shell";

  return (
    <form
      action="/search"
      method="get"
      role="search"
      className={`relative flex items-center ${className}`}
      // The submit is the no-JavaScript path AND the "I pressed Enter before
      // the debounce fired" path. Cancelling the debounce is not necessary —
      // it targets the same URL — but going now rather than in 250 ms is.
      onSubmit={(e) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        e.preventDefault();
        startTransition(() => {
          router.push(`/search?q=${encodeURIComponent(trimmed)}`);
        });
      }}
    >
      <span
        aria-hidden
        className={`absolute left-2.5 ${compact ? "text-xs" : "text-sm"} text-subtle`}
      >
        ⌕
      </span>
      <input
        ref={inputRef}
        name="q"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={compact ? "find" : "Name, invoice number, unit, cheque…"}
        aria-label="Search everything"
        autoComplete="off"
        // `spellCheck` off because invoice numbers and unit codes are not words
        // and a red squiggle under INV-SALON-01669 is noise.
        spellCheck={false}
        className={
          compact
            ? "w-full pl-7 pr-2 py-1.5 rounded-[var(--radius-md)] text-xs"
            : "w-full pl-8 pr-2 py-2.5 rounded-[var(--radius-md)] text-sm"
        }
        style={{
          background: "var(--surface)",
          border: `1px solid var(--border${compact ? "" : "-strong"})`,
        }}
      />
      {pending && (
        <span
          className="absolute right-2.5 text-2xs text-subtle"
          role="status"
          aria-live="polite"
        >
          {/* A word, not a spinner: the codebase ships no animation primitive
              and this is the only place one would be needed. WF-05's state
              table asks for a debounced indicator, and this is one. */}
          …
        </span>
      )}
      {/* Submit is reachable by keyboard and by a no-JS browser, and invisible
          otherwise — the wireframe's header has a field, not a field and a
          button. */}
      <button type="submit" className="sr-only">
        Search
      </button>
    </form>
  );
}
