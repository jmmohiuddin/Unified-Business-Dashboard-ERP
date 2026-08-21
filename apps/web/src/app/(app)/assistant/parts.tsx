import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card } from "@/components/ui";
import { askAction } from "@/lib/actions/assistant";
import { formatSpend, type AssistantBudget, type Capability, type Evidence, type StoredTurn } from "@/lib/assistant";

/**
 * The assistant screen's pieces (WF-05 §12).
 *
 * All server components except `ActionForm`, which is the app's single client
 * component. There is no streaming token-by-token render here and that is a
 * choice, not a gap: the answer is written to `ai_messages` before the page
 * renders, so what the owner reads is exactly what was stored and what the
 * auditor will see three months later. A streamed answer that differs from the
 * persisted one — even in whitespace — makes the audit trail a second source
 * of truth, which is the failure this whole feature is built to avoid.
 */

/**
 * EVIDENCE.
 *
 * The load-bearing component on this screen. PRD FR-P06: "Every numeric claim
 * carries a link to its rows. A claim without evidence is not rendered." So
 * every answer renders the metrics it called, at the value they returned, with
 * a link to the screen that lists the rows — and `Answer` below refuses to
 * render prose that states a figure with no card under it.
 *
 * `href` is absent when the metric has no drill-down screen yet. The card still
 * renders, because the metric id and the value are themselves evidence — the
 * owner can check the figure against the same tile on the dashboard. What is
 * never allowed is a figure with no card at all.
 */
export function EvidenceCard({ evidence }: { evidence: Evidence }) {
  const pct =
    evidence.changeRatio === null || evidence.changeRatio === undefined
      ? null
      : `${evidence.changeRatio >= 0 ? "+" : ""}${(evidence.changeRatio * 100).toFixed(1)}%`;

  return (
    <div
      className="rounded-[var(--radius-md)] px-3 py-2.5"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xs font-semibold text-muted truncate">{evidence.title}</p>
        <code className="text-[10px] text-subtle shrink-0">{evidence.metricId}</code>
      </div>

      <p className="text-base font-semibold tnum tracking-tight mt-0.5">{evidence.display}</p>

      {(evidence.priorDisplay || pct) && (
        <p className="text-2xs text-subtle mt-0.5">
          {evidence.priorDisplay && <>prior {evidence.priorDisplay}</>}
          {evidence.priorDisplay && pct && " · "}
          {pct && <span className="tnum">{pct}</span>}
        </p>
      )}

      {evidence.breakdown && evidence.breakdown.length > 0 && (
        <dl className="mt-2 space-y-0.5">
          {evidence.breakdown.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-2xs text-muted truncate">{row.label}</dt>
              <dd className="text-2xs tnum shrink-0">{row.display}</dd>
            </div>
          ))}
        </dl>
      )}

      {evidence.href && (
        <Link
          href={evidence.href}
          className="inline-block text-2xs font-semibold mt-2 hover:underline"
          style={{ color: "var(--accent)" }}
        >
          See rows →
        </Link>
      )}
    </div>
  );
}

/** What the owner typed. */
export function QuestionBubble({ turn }: { turn: StoredTurn }) {
  return (
    <div className="flex justify-end">
      <p
        className="text-xs leading-relaxed px-3 py-2 rounded-[var(--radius-md)] max-w-[46ch]"
        style={{ background: "var(--surface-3)" }}
      >
        {turn.content}
      </p>
    </div>
  );
}

/**
 * WF-05 §12.1 — "I can't answer that."
 *
 * Required behaviour, not a failure state. The wireframe is explicit that the
 * alternative — a plausible number — is worse than no number in an ERP, so this
 * renders whenever the answer is not grounded in a metric call, and it says
 * what the assistant CAN show instead rather than stopping at the refusal.
 */
function CannotAnswer({
  explanation,
  capabilities,
  conversationId,
}: {
  explanation: string;
  capabilities: Capability[];
  conversationId?: string;
}) {
  return (
    <div
      className="rounded-[var(--radius-md)] px-3 py-2.5"
      style={{ background: "var(--caution-soft)", border: "1px solid var(--border)" }}
    >
      <p className="text-xs font-semibold" style={{ color: "var(--caution)" }}>
        I can&apos;t answer that from the numbers I have.
      </p>
      {explanation && (
        <p className="text-xs leading-relaxed mt-1.5 whitespace-pre-wrap text-muted">
          {explanation}
        </p>
      )}
      {capabilities.length > 0 && (
        <details className="mt-2">
          <summary
            className="cursor-pointer list-none text-2xs font-semibold select-none"
            style={{ color: "var(--accent)" }}
          >
            What I can show you ({capabilities.length}) ›
          </summary>
          <div className="flex flex-wrap gap-1 mt-2">
            {capabilities.map((c) => (
              <AskChip
                key={c.id}
                question={`Show me ${c.title.toLowerCase()}.`}
                label={c.title}
                conversationId={conversationId}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * One answer.
 *
 * Two mutually exclusive renders, decided by `turn.cannotAnswer`, which is
 * recomputed from the stored text and the stored evidence on every read rather
 * than trusted from a flag written at answer time. That matters: if the
 * grounding rule is ever tightened, old answers that no longer pass it stop
 * being rendered as answers, instead of sitting in the history looking
 * authoritative.
 */
export function Answer({
  turn,
  capabilities,
  conversationId,
}: {
  turn: StoredTurn;
  capabilities: Capability[];
  conversationId?: string;
}) {
  if (turn.cannotAnswer) {
    return (
      <CannotAnswer
        explanation={turn.content}
        capabilities={capabilities}
        conversationId={conversationId}
      />
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs leading-relaxed whitespace-pre-wrap">{turn.content}</p>
      {turn.evidence.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {turn.evidence.map((e) => (
            <EvidenceCard key={e.metricId} evidence={e} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A one-click question.
 *
 * A real submit, not a link, so a suggestion goes through exactly the same
 * permission check, throttle and spend cap as a typed question. Rendered inert
 * when the assistant is unconfigured — see `SuggestionRow`.
 */
export function AskChip({
  question,
  label,
  conversationId,
}: {
  question: string;
  label?: string;
  conversationId?: string;
}) {
  return (
    <ActionForm
      action={askAction}
      submitLabel={label ?? question}
      pendingLabel="Asking…"
      variant="ghost"
      hidden={{ question, conversationId }}
      className="inline-block"
    />
  );
}

export function InertChip({ label }: { label: string }) {
  return (
    <span
      className="inline-block px-2.5 py-1 rounded-[var(--radius-md)] text-2xs"
      style={{ background: "var(--surface-2)", color: "var(--text-subtle)" }}
    >
      {label}
    </span>
  );
}

/** WF-05 §12: "Try: how much cash do I have · what is due this week · …" */
export function SuggestionRow({
  questions,
  enabled,
  conversationId,
}: {
  questions: readonly string[];
  enabled: boolean;
  conversationId?: string;
}) {
  return (
    <div>
      <p className="text-2xs text-subtle mb-1.5">Try</p>
      <div className="flex flex-wrap gap-1.5">
        {questions.map((q) =>
          enabled ? (
            <AskChip key={q} question={q} conversationId={conversationId} />
          ) : (
            <InertChip key={q} label={q} />
          ),
        )}
      </div>
    </div>
  );
}

/** The composer, plus the spend meter that makes the cap visible before it bites. */
export function Composer({
  budget,
  conversationId,
}: {
  budget: AssistantBudget;
  conversationId?: string;
}) {
  if (budget.exhausted) {
    return (
      <Card className="p-4" as="div">
        <p className="text-xs font-semibold" style={{ color: "var(--caution)" }}>
          This month&apos;s AI budget is used up.
        </p>
        <p className="text-2xs text-muted mt-1 leading-relaxed">
          {formatSpend(budget.spentMicros)} of {formatSpend(budget.capMicros)} spent. It resets on
          the 1st. Every answer already given is still on this page — reading them costs nothing.
          Raise <code className="text-[10px]">AI_MONTHLY_BUDGET_USD</code> to lift the ceiling.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4" as="div">
      <ActionForm action={askAction} submitLabel="Ask" pendingLabel="Thinking…" hidden={{ conversationId }}>
        <label htmlFor="assistant-question" className="label block mb-1">
          {conversationId ? "Follow up" : "Ask about your business"}
        </label>
        <textarea
          id="assistant-question"
          name="question"
          rows={3}
          required
          maxLength={1000}
          placeholder="Which business is losing money?"
          className="w-full px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs mb-2"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            color: "var(--text)",
          }}
        />
      </ActionForm>
      <p className="text-2xs text-subtle mt-2">
        {formatSpend(budget.spentMicros)} of {formatSpend(budget.capMicros)} of this month&apos;s AI
        budget used.
      </p>
    </Card>
  );
}
