import Link from "next/link";
import { can } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page";
import {
  SUGGESTED_QUESTIONS,
  assistantCapabilities,
  currentBudget,
  isAssistantConfigured,
  listConversations,
  loadConversation,
  type Capability,
} from "@/lib/assistant";
import { Answer, Composer, InertChip, QuestionBubble, SuggestionRow } from "./parts";

export const dynamic = "force-dynamic";

/**
 * ASK NEXUS — the AI assistant (FR-P06, WF-05 §12).
 *
 * Decision D2 funded this and reversed the earlier decision to disable it. The
 * page it replaces was a bare `redirect("/")`, which is the worst of the
 * available options: the owner's primary call to action returned him to the
 * screen he had just left, with no explanation, and the implementation sat
 * intact in `lib/assistant.ts` looking shipped.
 *
 * The assistant answers ONLY from the metric registry
 * (`packages/core/src/metrics/**`). It generates no SQL — roadmap risk R5 and
 * PRD NG7 are both emphatic, and the reason is not squeamishness about SQL: an
 * assistant that can state a confidently wrong number destroys trust in every
 * other number in the product, including the ones that are right.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIVE STATES OF WF-05 §0:
 *
 *   permission-denied  first branch below, checked before any query runs, so a
 *                      receptionist without `ai:ask` gets a sentence rather
 *                      than the error boundary.
 *   NOT CONFIGURED     a sixth state this screen needs and the others do not.
 *                      No `ANTHROPIC_API_KEY` is provisioned in this
 *                      environment, so this is the path that actually runs
 *                      today. It says so plainly, shows the real list of
 *                      questions the assistant would be able to ground an
 *                      answer in, and names the one environment variable that
 *                      turns it on. It does not 500 and it does not redirect.
 *   empty              configured, nothing asked yet: suggested prompts and
 *                      the capability list.
 *   default            a conversation, with evidence under every figure.
 *   loading            `loading.tsx` beside this file.
 *   error              the group boundary at `app/(app)/error.tsx`.
 */

const PERMISSION = "ai:ask";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">{children}</div>
  );
}

/**
 * What the assistant can ground an answer in, for this user.
 *
 * Shown on the unconfigured and empty states. It is the metric registry
 * filtered by the caller's permissions — the same filter `metricsAsAiTools`
 * applies when building the tool list — so it is a promise the assistant can
 * actually keep, not marketing copy.
 */
function CapabilityList({ capabilities }: { capabilities: Capability[] }) {
  return (
    <Card as="section">
      <CardHeader
        title="What it can answer from"
        subtitle={`${capabilities.length} figures, the same ones your dashboard uses`}
      />
      <div className="px-4 pb-4 grid gap-1.5 sm:grid-cols-2">
        {capabilities.map((c) => (
          <div key={c.id} className="min-w-0">
            <p className="text-2xs font-semibold truncate">{c.title}</p>
            <p className="text-[10px] text-subtle leading-snug line-clamp-2">{c.description}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** The user's own question history — the visible half of "auditable". */
function RecentQuestions({
  conversations,
  activeId,
}: {
  conversations: { id: string; title: string | null; lastMessageAt: string | null }[];
  activeId?: string;
}) {
  if (conversations.length === 0) return null;
  return (
    <Card as="section">
      <CardHeader title="Earlier questions" subtitle="Kept, with the figures behind each answer" />
      <ul className="px-4 pb-4 space-y-1">
        {conversations.map((c) => (
          <li key={c.id}>
            <Link
              href={`/assistant?c=${c.id}`}
              className="text-2xs hover:underline block truncate"
              style={{ color: c.id === activeId ? "var(--text)" : "var(--accent)" }}
            >
              {c.title ?? "Untitled"}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const session = await requireSession();

  /* ── STATE: permission denied ───────────────────────────────────────────── */
  if (!can(session.principal, PERMISSION)) {
    return (
      <Shell>
        <PageHeader title="Ask Nexus" />
        <Card className="p-4" as="div">
          <p className="text-xs text-muted leading-relaxed">
            Asking the assistant needs the <code className="text-2xs">{PERMISSION}</code>{" "}
            permission. It answers from the same figures your dashboard shows, so whoever grants it
            is granting access to those numbers — ask the owner or the accountant.
          </p>
        </Card>
      </Shell>
    );
  }

  const capabilities = assistantCapabilities(session);

  /* ── STATE: not configured ──────────────────────────────────────────────── */
  /**
   * Deliberately reached without touching the database: with no API key there
   * is nothing to read, and a screen that explains why a feature is off should
   * not be able to fail for a second, unrelated reason.
   */
  if (!isAssistantConfigured()) {
    return (
      <Shell>
        <PageHeader
          title="Ask Nexus"
          subtitle="Answers about your businesses, with the figures behind them"
        />

        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--caution)" }}>
            The assistant is not switched on for this deployment.
          </p>
          <p className="text-2xs text-muted mt-1.5 leading-relaxed">
            It needs an Anthropic API key. Set{" "}
            <code className="text-[10px]">ANTHROPIC_API_KEY</code> in the environment (see{" "}
            <code className="text-[10px]">.env.example</code>) and restart — nothing else has to
            change, and no data is missing. Until then this page will not pretend to answer: a
            plausible number the assistant could not have computed is worse, in an ERP, than no
            answer at all.
          </p>
          <p className="text-2xs text-subtle mt-2 leading-relaxed">
            Everything below is real. It is the exact set of figures the assistant would be allowed
            to ground an answer in for your role — you can read every one of them on the dashboard
            today.
          </p>
        </Card>

        <div>
          <p className="text-2xs text-subtle mb-1.5">What you would be able to ask</p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_QUESTIONS.map((q) => (
              <InertChip key={q} label={q} />
            ))}
          </div>
        </div>

        {capabilities.length > 0 ? (
          <CapabilityList capabilities={capabilities} />
        ) : (
          <Card as="section">
            <EmptyState
              icon="·"
              title="No figures your role can read"
              detail="Even with a key, the assistant would have nothing to answer from — its tools are the metrics your permissions allow."
            />
          </Card>
        )}
      </Shell>
    );
  }

  /* ── Configured. ────────────────────────────────────────────────────────── */
  const { c } = await searchParams;
  const [conversation, recent, budget] = await Promise.all([
    c ? loadConversation(session, c) : Promise.resolve(null),
    listConversations(session),
    currentBudget(session),
  ]);

  const conversationId = conversation?.id;

  return (
    <Shell>
      <PageHeader
        title="Ask Nexus"
        subtitle="Answers about your businesses, with the figures behind them"
        actions={
          conversationId ? (
            <Link
              href="/assistant"
              className="btn text-xs"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
            >
              New question
            </Link>
          ) : undefined
        }
      />

      {/* ── STATE: default — the conversation ─────────────────────────────── */}
      {conversation && conversation.turns.length > 0 && (
        <Card className="p-4 space-y-4" as="section">
          {conversation.turns.map((turn) =>
            turn.role === "user" ? (
              <QuestionBubble key={turn.id} turn={turn} />
            ) : (
              <Answer
                key={turn.id}
                turn={turn}
                capabilities={capabilities}
                conversationId={conversationId}
              />
            ),
          )}
        </Card>
      )}

      {/* ── STATE: empty — configured, nothing asked yet ──────────────────── */}
      {!conversation && (
        <Card as="section">
          <EmptyState
            icon="✦"
            title="Ask anything about the numbers"
            detail="Every figure in an answer links back to the metric and the rows that produced it. If there is no metric for what you asked, it will say so rather than guess."
          />
        </Card>
      )}

      <Composer budget={budget} conversationId={conversationId} />

      <SuggestionRow
        questions={SUGGESTED_QUESTIONS.slice(0, 4)}
        enabled={!budget.exhausted}
        conversationId={conversationId}
      />

      <RecentQuestions conversations={recent} activeId={conversationId} />

      {!conversation && capabilities.length > 0 && <CapabilityList capabilities={capabilities} />}
    </Shell>
  );
}
