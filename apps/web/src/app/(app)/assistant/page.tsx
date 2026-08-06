import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import {
  SUGGESTED_QUESTIONS,
  askAssistant,
  assistantCapabilities,
  isAssistantConfigured,
  type AssistantAnswer,
} from "@/lib/assistant";
import { Card, CardHeader, Chip } from "@/components/ui";
import { PageHeader } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * Ask Nexus.
 *
 * A form post rather than a streaming chat, deliberately for now: the answer is
 * only trustworthy once every tool call has returned, and streaming a partial
 * financial claim that a later tool contradicts is worse than a two-second wait.
 * Streaming lands in Phase 3 alongside the conversation thread.
 *
 * Note what is shown *under* every answer: the metrics consulted, each linking
 * to the screen with the underlying rows. An AI figure the owner cannot verify
 * is a liability, not a feature.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { q, error } = await searchParams;
  const configured = isAssistantConfigured();
  const capabilities = assistantCapabilities(session);

  let answer: AssistantAnswer | null = null;
  let failure: string | null = null;

  if (q && configured) {
    try {
      answer = await askAssistant(session, q);
    } catch (err) {
      failure = (err as Error).message;
    }
  }

  async function ask(formData: FormData) {
    "use server";
    const question = String(formData.get("q") ?? "").trim();
    if (!question) redirect("/assistant");
    redirect(`/assistant?q=${encodeURIComponent(question)}`);
  }

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="Ask Nexus"
        subtitle="Answers computed from your ledger — never generated from memory"
        actions={
          <Chip tone={configured ? "positive" : "caution"}>
            {configured ? "connected" : "not configured"}
          </Chip>
        }
      />

      <Card className="p-4" as="div">
        <form action={ask} className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Which business earned the most this month?"
            aria-label="Ask a question about your business"
            autoComplete="off"
            className="flex-1 px-3 py-2 rounded-[var(--radius-md)] text-sm"
            style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
            disabled={!configured}
          />
          <button type="submit" className="btn btn-primary text-xs" disabled={!configured}>
            Ask
          </button>
        </form>

        {!configured && (
          <p
            className="text-xs mt-3 px-3 py-2 rounded-[var(--radius-md)] leading-relaxed"
            style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
          >
            Set <code className="text-2xs">ANTHROPIC_API_KEY</code> in <code className="text-2xs">.env</code>{" "}
            to enable the assistant. Everything below still describes exactly what it can reach —
            the metric layer is live either way, and it is what the dashboard already uses.
          </p>
        )}

        {configured && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {SUGGESTED_QUESTIONS.map((s) => (
              <Link
                key={s}
                href={`/assistant?q=${encodeURIComponent(s)}`}
                className="px-2.5 py-1 rounded-full text-2xs transition-colors"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
              >
                {s}
              </Link>
            ))}
          </div>
        )}
      </Card>

      {(failure || error) && (
        <Card className="p-4" as="div">
          <p className="text-xs" style={{ color: "var(--negative)" }}>
            The assistant could not answer: {failure ?? "unknown error"}
          </p>
        </Card>
      )}

      {answer && (
        <Card>
          <CardHeader title="Answer" subtitle={q} />
          <div className="px-4 pb-4">
            <div className="text-sm leading-relaxed space-y-3">
              {answer.text.split(/\n{2,}/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>

            {answer.evidence.length > 0 && (
              <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--border)" }}>
                <p className="label mb-2">
                  Computed from {answer.evidence.length}{" "}
                  {answer.evidence.length === 1 ? "metric" : "metrics"} — click to see the rows
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {answer.evidence.map((e) =>
                    e.href ? (
                      <Link
                        key={e.metricId}
                        href={e.href}
                        className="px-2.5 py-1 rounded-[var(--radius-md)] text-2xs transition-colors hover:opacity-80"
                        style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                      >
                        {e.title}: <span className="font-semibold tnum">{e.display}</span> →
                      </Link>
                    ) : (
                      <span
                        key={e.metricId}
                        className="px-2.5 py-1 rounded-[var(--radius-md)] text-2xs"
                        style={{ background: "var(--surface-3)", color: "var(--text-muted)" }}
                      >
                        {e.title}: <span className="font-semibold tnum">{e.display}</span>
                      </span>
                    ),
                  )}
                </div>
              </div>
            )}

            <p className="text-2xs text-subtle mt-3">
              {answer.model} · {answer.toolRounds} tool{" "}
              {answer.toolRounds === 1 ? "round" : "rounds"} ·{" "}
              {(answer.latencyMs / 1000).toFixed(1)}s ·{" "}
              {answer.inputTokens + answer.outputTokens} tokens
            </p>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="What it can reach"
          subtitle={`${capabilities.length} metrics, filtered to your permissions`}
        />
        <div className="px-4 pb-4 grid gap-1 sm:grid-cols-2">
          {capabilities.map((c) => (
            <div key={c.id} className="flex items-baseline gap-2 py-0.5">
              <span className="text-subtle text-2xs" aria-hidden>
                ◦
              </span>
              <span className="text-xs">{c.title}</span>
            </div>
          ))}
        </div>
        <p className="text-2xs text-subtle px-4 pb-4 leading-relaxed">
          The assistant has no SQL access and no ability to browse tables. It selects from these
          metric functions — the same ones that render the dashboard — so its numbers and your
          screen can never disagree, and it cannot reach a business you are not scoped to. If a
          question falls outside this list it will say so rather than guess.
        </p>
      </Card>
    </div>
  );
}
