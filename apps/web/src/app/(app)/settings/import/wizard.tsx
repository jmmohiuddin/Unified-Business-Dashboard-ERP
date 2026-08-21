"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import type { ImportDiff } from "@nexus/core";
import { commitImportAction, previewImportAction } from "@/lib/actions/import";

/**
 * THE IMPORT WIZARD — WF-05 §13.
 *
 * Four steps, and nothing commits before step three. The wireframe states
 * "Nothing has been saved yet" on the review step in so many words, because
 * dry-run imports that silently commit are the classic way migration goes
 * wrong.
 *
 * WHY THIS IS A CLIENT COMPONENT, in an application where almost nothing is.
 *
 * The file has to survive the round trip between "show me what this would do"
 * and "do it". There are only three places it can live in between: the
 * database, a temporary file, or the browser. The first two mean a staging area
 * — half-uploaded batches to expire, an extra table, and a window in which a
 * spreadsheet full of Emirates IDs sits on the server belonging to nobody. The
 * browser costs one re-upload of a few hundred kilobytes and needs none of
 * that, so the file stays here, in memory, until the user either imports it or
 * closes the tab.
 *
 * WHAT IS DELIBERATELY NOT TRUSTED FROM HERE. Nothing that decides what lands
 * in the ledger. The commit re-reads the file and re-plans from scratch on the
 * server; all this component sends back is the fingerprint and the four counts
 * the user actually looked at, and the server refuses if either has moved. A
 * tampered count fails against the recomputed plan; a tampered fingerprint
 * fails against the recomputed digest. See `commitImport`.
 *
 * THE 1 MB WALL. A Server Action request is capped at 1 MB by Next's default
 * `serverActions.bodySizeLimit`. A wide employee file can reach that before it
 * reaches the 5,000-row ceiling, and the framework's own error for it is
 * unreadable. So the size is checked here, before the upload, and reported as a
 * sentence about the file rather than as a stack trace about a body.
 */

/** Below Next's 1 MB action body limit, with room for the rest of the payload. */
const MAX_BYTES = 900_000;

export interface KindOption {
  kind: string;
  label: string;
  description: string;
  requiresBusinessUnit: boolean;
  template: string[];
  /** False when the signed-in user may not run this importer. */
  permitted: boolean;
  permission: string;
}

export interface BusinessOption {
  id: string;
  name: string;
}

type Step = "choose" | "review" | "done";

export function ImportWizard({
  kinds,
  businesses,
  warehouses,
  today,
}: {
  kinds: KindOption[];
  businesses: BusinessOption[];
  warehouses: string[];
  today: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const formId = useId();

  const [kind, setKind] = useState(kinds[0]?.kind ?? "opening_balances");
  const [businessUnitId, setBusinessUnitId] = useState(businesses[0]?.id ?? "");
  const [asOf, setAsOf] = useState(today);
  const [warehouse, setWarehouse] = useState(warehouses[0] ?? "");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [step, setStep] = useState<Step>("choose");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; batchId: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = kinds.find((k) => k.kind === kind);

  function reset() {
    setDiff(null);
    setDone(null);
    setError(null);
    setStep("choose");
    setFilename("");
    setContent("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onFile(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(
        `That file is ${Math.round(file.size / 1000)} KB. Files over ${Math.round(
          MAX_BYTES / 1000,
        )} KB have to be split — the batch is the unit you can reverse, and a very large one ` +
          `is not something anyone reverses in a single act.`,
      );
      return;
    }
    setFilename(file.name);
    setContent(await file.text());
    setDiff(null);
  }

  function runDryRun() {
    if (content === "") {
      setError("Choose a file first.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await previewImportAction({
        kind,
        filename,
        content,
        businessUnitId: selected?.requiresBusinessUnit ? businessUnitId : undefined,
        asOf: kind === "opening_balances" ? asOf : undefined,
        warehouse: kind === "stock" ? warehouse : undefined,
      });
      if (!result.ok || !result.diff) {
        setError(result.message ?? "That file could not be read.");
        return;
      }
      setDiff(result.diff);
      setStep("review");
    });
  }

  function commit() {
    if (!diff) return;
    setError(null);
    startTransition(async () => {
      const result = await commitImportAction({
        kind,
        filename,
        content,
        businessUnitId: selected?.requiresBusinessUnit ? businessUnitId : undefined,
        asOf: kind === "opening_balances" ? asOf : undefined,
        warehouse: kind === "stock" ? warehouse : undefined,
        approved: {
          fingerprint: diff.fingerprint,
          create: diff.counts.create,
          update: diff.counts.update,
          skip: diff.counts.skip,
          reject: diff.counts.reject,
        },
        // Derived from what is being imported, not from this component's
        // lifetime: a double-click replays the first result instead of
        // importing the books twice, while a corrected file keys differently
        // and imports properly.
        idempotencyKey: `${diff.fingerprint.slice(0, 24)}-${diff.counts.create}-${diff.counts.update}`,
      });
      if (!result.ok || !result.batchId) {
        setError(result.message ?? "Nothing was imported.");
        return;
      }
      setDone({ message: result.message ?? "Imported.", batchId: result.batchId });
      setStep("done");
    });
  }

  const blocked = (diff?.blockers.length ?? 0) > 0;
  const nothingToDo = diff !== null && diff.counts.create === 0 && diff.counts.update === 0;

  return (
    <div className="space-y-4">
      <Steps current={step} />

      {error && (
        <p
          className="text-xs px-3 py-2 rounded-[var(--radius-md)]"
          role="alert"
          style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
        >
          {error}
        </p>
      )}

      {step === "choose" && (
        <div className="space-y-4">
          <fieldset className="space-y-1.5">
            <legend className="label mb-1.5">What are you importing?</legend>
            {kinds.map((k) => (
              <label
                key={k.kind}
                htmlFor={`${formId}-${k.kind}`}
                className="flex gap-2.5 items-start px-3 py-2 rounded-[var(--radius-md)] cursor-pointer"
                style={{
                  background: k.kind === kind ? "var(--surface-2)" : "transparent",
                  opacity: k.permitted ? 1 : 0.45,
                }}
              >
                <input
                  id={`${formId}-${k.kind}`}
                  type="radio"
                  name={`${formId}-kind`}
                  value={k.kind}
                  checked={k.kind === kind}
                  disabled={!k.permitted}
                  onChange={() => {
                    setKind(k.kind);
                    setDiff(null);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-xs font-medium block">{k.label}</span>
                  <span className="text-2xs text-subtle block">
                    {k.permitted
                      ? k.description
                      : `You do not have the ${k.permission} permission for this.`}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            {selected?.requiresBusinessUnit && (
              <Labelled label="Which business">
                <select
                  className={FIELD_CLASS} style={FIELD_STYLE}
                  value={businessUnitId}
                  onChange={(e) => setBusinessUnitId(e.target.value)}
                >
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Labelled>
            )}
            {kind === "opening_balances" && (
              <Labelled label="Balances as at">
                <input
                  type="date"
                  className={FIELD_CLASS} style={FIELD_STYLE}
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                />
              </Labelled>
            )}
            {kind === "stock" && (
              <Labelled label="Warehouse">
                <select
                  className={FIELD_CLASS} style={FIELD_STYLE}
                  value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}
                >
                  {warehouses.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </Labelled>
            )}
          </div>

          <div>
            <p className="label mb-1">Your file</p>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="text-xs"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            {selected && (
              <p className="text-2xs text-subtle mt-1.5">
                Columns it reads: {selected.template.join(", ")}. Extra columns are ignored;
                capitalisation and spacing do not matter.
              </p>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary text-xs"
            disabled={pending || content === "" || !selected?.permitted}
            onClick={runDryRun}
          >
            {pending ? "Reading…" : "See what this would do"}
          </button>
        </div>
      )}

      {step === "review" && diff && (
        <div className="space-y-4">
          <p
            className="text-xs px-3 py-2 rounded-[var(--radius-md)] font-medium"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
          >
            Nothing has been saved yet. This is what {diff.filename} would do.
          </p>

          <div className="flex gap-4 flex-wrap text-xs tnum">
            <Count label="to create" value={diff.counts.create} tone="positive" />
            <Count label="to update" value={diff.counts.update} tone="accent" />
            <Count label="skipped" value={diff.counts.skip} />
            <Count label="rejected" value={diff.counts.reject} tone="negative" />
          </div>

          {diff.totals.length > 0 && (
            <div className="rounded-[var(--radius-md)] overflow-hidden" style={{ background: "var(--surface-2)" }}>
              {diff.totals.map((t) => (
                <div
                  key={t.label}
                  className="flex justify-between gap-3 px-3 py-1.5 text-xs border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span className="text-muted">{t.label}</span>
                  <span
                    className="tnum font-medium"
                    style={{ color: t.isProblem ? "var(--negative)" : "var(--text)" }}
                  >
                    {t.amount}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diff.blockers.map((b) => (
            <p
              key={b}
              className="text-xs px-3 py-2 rounded-[var(--radius-md)]"
              role="alert"
              style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
            >
              {b}
            </p>
          ))}

          {diff.rejected.length > 0 && (
            <details open>
              <summary className="text-xs font-semibold cursor-pointer" style={{ color: "var(--negative)" }}>
                {diff.rejected.length} row(s) could not be read
              </summary>
              <ul className="mt-1.5 space-y-1">
                {diff.rejected.map((r) => (
                  <li key={`${r.rowNumber}-${r.column ?? ""}`} className="text-2xs">
                    <span className="tnum font-semibold">Row {r.rowNumber}</span>
                    {r.column && <span className="text-subtle"> · {r.column}</span>} — {r.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {diff.rows.length > 0 && (
            <details>
              <summary className="text-xs font-semibold cursor-pointer" style={{ color: "var(--accent)" }}>
                Every row, line by line
              </summary>
              <ul className="mt-1.5 space-y-1 max-h-80 overflow-y-auto">
                {diff.rows.map((r) => (
                  <li key={r.rowNumber} className="text-2xs flex gap-2">
                    <span className="tnum text-subtle w-8 shrink-0">{r.rowNumber}</span>
                    <span
                      className="w-14 shrink-0 font-semibold"
                      style={{
                        color:
                          r.action === "create"
                            ? "var(--positive)"
                            : r.action === "update"
                              ? "var(--accent)"
                              : "var(--text-subtle)",
                      }}
                    >
                      {r.action}
                    </span>
                    <span className="min-w-0 flex-1">
                      {r.label}
                      {r.detail && <span className="text-subtle"> · {r.detail}</span>}
                    </span>
                    {r.amount && <span className="tnum shrink-0">{r.amount}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {diff.notes.length > 0 && (
            <ul className="text-2xs text-subtle space-y-0.5">
              {diff.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className="btn text-xs" onClick={() => setStep("choose")}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              disabled={pending || blocked || nothingToDo}
              onClick={commit}
            >
              {pending ? "Importing…" : `Import ${diff.counts.create + diff.counts.update} record(s)`}
            </button>
            {blocked && (
              <span className="text-2xs" style={{ color: "var(--negative)" }}>
                Fix the problem above and upload again. There is no import-anyway.
              </span>
            )}
            {!blocked && nothingToDo && (
              <span className="text-2xs text-subtle">Every row is already on file.</span>
            )}
          </div>
        </div>
      )}

      {step === "done" && done && (
        <div className="space-y-3">
          <p
            className="text-xs px-3 py-2 rounded-[var(--radius-md)]"
            role="status"
            style={{ background: "var(--positive-soft)", color: "var(--positive)" }}
          >
            {done.message}
          </p>
          <div className="flex gap-2 flex-wrap">
            <Link href={`/settings/import/${done.batchId}`} className="btn btn-primary text-xs">
              Open the reconciliation
            </Link>
            <button type="button" className="btn text-xs" onClick={reset}>
              Import something else
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "choose", label: "1 Choose" },
    { key: "review", label: "2 Review" },
    { key: "done", label: "3 Done" },
  ];
  return (
    <ol className="flex gap-1.5 text-2xs font-semibold">
      {steps.map((s) => (
        <li
          key={s.key}
          className="px-2.5 py-1 rounded-[var(--radius-md)]"
          aria-current={s.key === current ? "step" : undefined}
          style={
            s.key === current
              ? { background: "var(--accent)", color: "var(--text-inverse)" }
              : { background: "var(--surface-2)", color: "var(--text-muted)" }
          }
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "positive" | "accent" | "negative";
}) {
  const color =
    value === 0
      ? "var(--text-subtle)"
      : tone === "positive"
        ? "var(--positive)"
        : tone === "accent"
          ? "var(--accent)"
          : tone === "negative"
            ? "var(--negative)"
            : "var(--text)";
  return (
    <span>
      <span className="text-lg font-semibold tnum" style={{ color }}>
        {value}
      </span>{" "}
      <span className="text-2xs text-muted">{label}</span>
    </span>
  );
}

/**
 * A label wrapped AROUND its control rather than pointing at it by id.
 *
 * The `htmlFor`/`id` pair is the usual form, but it only works when the label
 * points at the input itself. Pointing it at a wrapper element is worse than
 * omitting it: assistive technology reports a label on something that is not a
 * control, and the real control announces as unlabelled.
 */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label block mb-1">{label}</span>
      {children}
    </label>
  );
}

/** Matches `Field` in components/action-form.tsx. There is no `.field` class. */
const FIELD_CLASS = "w-full px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs";
const FIELD_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
} as const;
