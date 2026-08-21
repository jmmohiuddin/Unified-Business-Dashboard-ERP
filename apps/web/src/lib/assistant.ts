import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { withTenant, type Tx } from "@nexus/db";
import {
  METRICS_BY_ID,
  formatMetricValue,
  metricsAsAiTools,
  runMetric,
  type MetricContext,
  type MetricResult,
} from "@nexus/core";
import { resolveToday } from "./data";
import type { SessionUser } from "./session";

/**
 * THE AI ASSISTANT.
 *
 * Claude is given exactly one capability: call the metric functions that the
 * dashboard already uses. It cannot write SQL, read tables, or reach the
 * filesystem.
 *
 * That is a deliberate ceiling, and the reasoning is empirical. Anthropic's own
 * data team reported their internal analytics agent going from 21% to ~95%
 * accuracy — the fix was not a better model or better SQL generation, it was
 * putting a curated semantic layer in front of the warehouse. Accuracy is a
 * context and verification problem.
 *
 * What this buys:
 *   • The AI and the dashboard cannot disagree about what "revenue" means.
 *   • Every claim carries the metric id and value that produced it, so the
 *     owner can click through to the rows.
 *   • Permissions are enforced inside runMetric, so the assistant can never
 *     surface payroll to a receptionist or another business to a scoped user.
 *   • Answers are reproducible against the deterministic seed, which is what
 *     makes an evaluation suite possible at all.
 *
 * The cost: a question nobody anticipated cannot be answered. For a business
 * owner making decisions with money, "I don't have a metric for that" is
 * strictly better than a confident wrong number.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRANSACTION DISCIPLINE — the rule this file exists to keep (audit D4).
 *
 * A previous version of this file opened ONE `withTenant(...)` and ran the
 * entire tool loop inside it: up to five `messages.create` round trips, then
 * the two conversation INSERTs. A `withTenant` callback is one `appDb()`
 * transaction, so a pooled connection sat `idle in transaction` for the full
 * model latency — tens of seconds. The pool is `max: 20` (packages/db/src/
 * client.ts). Ten people asking a question at once consumed half of it, and on
 * serverless, where each function instance holds its own pool, that is a
 * connection-exhaustion path that takes down the WHOLE application, not just
 * the assistant. It also pinned an MVCC snapshot open for the duration, so
 * autovacuum could not reclaim anything the conversation outlived.
 *
 * So: **no `client.beta.messages.create` call in this file may be reachable
 * from inside a `withTenant` callback.** The database is touched in three
 * kinds of short transaction, each of which opens and closes around its own
 * queries:
 *
 *   1. `preflight()`      — budget + business list + conversation history.
 *   2. `runToolRound()`   — one transaction per round of metric calls.
 *   3. `persistExchange()`— the two INSERTs, after the model is done.
 *
 * Between them the connection is back in the pool. Read `askAssistant` below
 * and note that every `await withTenant(...)` completes before the next
 * `await client.beta.messages.create(...)` begins; they are siblings in the
 * loop body, never nested. If you ever need a value from the database in the
 * middle of a round, fetch it in `runToolRound` — do not widen a transaction
 * to reach the model call.
 */

/**
 * The model.
 *
 * Claude Opus 5 is the current default. Thinking is ON by default on this
 * model — omitting the `thinking` parameter runs adaptive thinking — and
 * `max_tokens` caps thinking PLUS response text together, which is why
 * MAX_OUTPUT_TOKENS below is generous rather than the 1,400 that was here when
 * this file targeted a non-thinking model.
 */
const MODEL = process.env.AI_MODEL?.trim() || "claude-opus-5";

/**
 * How hard the model works per question. `effort` is the cost/quality knob on
 * Claude Opus 5; `medium` is the balance point for "pick some metrics and
 * interpret them", which is not a reasoning-heavy task. Raise it to `high` if
 * answers start missing the obvious follow-up metric.
 */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];
const EFFORT: Effort = (() => {
  const raw = process.env.AI_EFFORT?.trim() as Effort | undefined;
  return raw && EFFORT_LEVELS.includes(raw) ? raw : "medium";
})();

/**
 * Hard per-question ceilings. These bound the cost of a single question even
 * if the model decides to call every metric it can see, forever.
 */
const MAX_TOOL_ROUNDS = 5;
const MAX_OUTPUT_TOKENS = 8_000;
/** How many prior turns of a conversation are replayed. Bounds input tokens. */
const MAX_HISTORY_MESSAGES = 8;

/**
 * PRICES, in USD micros per token, from the published list rates.
 *
 * Integer micros rather than dollars-as-float on purpose: $5 per million input
 * tokens is exactly 5 micros per token, so cost accounting here is exact
 * integer arithmetic with no rounding to accumulate. (This is telemetry, not
 * ledger money — it never reaches `journal_lines` — so it does not go through
 * `packages/core/src/money`. It is still integer-exact, because a spend cap
 * computed from drifting floats is not a cap.)
 */
interface ModelPrice {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
}
const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  "claude-opus-4-8": { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  "claude-opus-4-7": { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  "claude-sonnet-5": { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  "claude-sonnet-4-6": { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  "claude-haiku-4-5": { inputMicrosPerToken: 1, outputMicrosPerToken: 5 },
  "claude-fable-5": { inputMicrosPerToken: 10, outputMicrosPerToken: 50 },
};

/**
 * What an unrecognised model id costs, for accounting purposes.
 *
 * The most expensive rate we know of, deliberately. If someone points
 * `AI_MODEL` at a model released after this table was written, the budget must
 * over-report rather than under-report — a cap that silently stops counting is
 * not a cap, and "we spent nothing" is the failure mode that lets a bill run.
 */
const UNPRICED_MODEL: ModelPrice = { inputMicrosPerToken: 10, outputMicrosPerToken: 50 };

export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? UNPRICED_MODEL;
}

/** Cost of one exchange, in USD micros. Exact integer arithmetic. */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return inputTokens * p.inputMicrosPerToken + outputTokens * p.outputMicrosPerToken;
}

/**
 * THE SPEND CAP (FR-P06: "per-tenant cost tracked and capped").
 *
 * A calendar-month ceiling per tenant, defaulting to USD 20. It is enforced in
 * two places, because one is not enough:
 *
 *   • Before the first model call — a tenant already over its cap never starts
 *     a question.
 *   • Between tool rounds — a single question that turns out to be expensive
 *     stops mid-loop and answers with the metrics it already has, rather than
 *     spending an unbounded amount to finish.
 *
 * The ceiling is per tenant rather than per user because the bill is per
 * tenant. A generous single-user cap multiplied by fourteen staff is not a cap.
 */
const DEFAULT_MONTHLY_BUDGET_USD = 20;
export const MONTHLY_BUDGET_MICROS = (() => {
  const raw = Number(process.env.AI_MONTHLY_BUDGET_USD ?? DEFAULT_MONTHLY_BUDGET_USD);
  const usd = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MONTHLY_BUDGET_USD;
  return Math.round(usd * 1_000_000);
})();

export interface AssistantBudget {
  /** Micros already spent this calendar month, across every user in the tenant. */
  spentMicros: number;
  capMicros: number;
  remainingMicros: number;
  exhausted: boolean;
}

export function isAssistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export interface Evidence {
  metricId: string;
  title: string;
  /** The figure, formatted the way the dashboard would format it. */
  display: string;
  /** Where the rows behind the figure live. Absent = no drill-down exists. */
  href?: string;
  /** Prior-period comparison, when the metric defines one. */
  priorDisplay?: string;
  changeRatio?: number | null;
  /** Top contributors, capped — this is what makes an answer checkable. */
  breakdown?: { label: string; display: string }[];
}

export interface AssistantAnswer {
  conversationId: string;
  text: string;
  evidence: Evidence[];
  /**
   * True when the assistant could not ground the answer in the metric layer.
   * The UI renders WF-05 §12.1 ("I can't answer that from the numbers I have")
   * rather than the prose, because an ungrounded figure in an ERP is worse
   * than no figure. See `answerIsGrounded`.
   */
  cannotAnswer: boolean;
  toolRounds: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  model: string;
  /** Budget as it stands AFTER this exchange, for the meter in the composer. */
  budget: AssistantBudget;
  /** Set when the tool loop was cut short by the spend cap. */
  stoppedForBudget: boolean;
}

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "budget_exhausted"
      | "no_metrics"
      | "declined"
      | "upstream",
  ) {
    super(message);
    this.name = "AssistantError";
  }
}

// ── The prompt ──────────────────────────────────────────────────────────────

function systemPrompt(session: SessionUser, today: string, businesses: string): string {
  return [
    `You are the business analyst for ${session.tenantName}, a group of businesses in Dubai, UAE.`,
    `Today is ${today}. All money is in ${session.baseCurrency}. VAT is 5%.`,
    ``,
    `The businesses are: ${businesses}.`,
    ``,
    `HOW YOU WORK`,
    `You have no direct access to the database. You answer by calling the metric`,
    `tools provided. Each tool returns a verified figure computed by the same code`,
    `that renders the dashboard, so your numbers and the owner's screen always agree.`,
    ``,
    `RULES`,
    `1. Never state a figure you did not get from a tool. If no tool covers the`,
    `   question, say plainly what you cannot answer and which metric would be needed.`,
    `2. Call several tools when a question needs them. Prefer one round of parallel`,
    `   calls over many sequential ones.`,
    `3. Answer like a sharp finance director talking to the owner: lead with the`,
    `   answer, then the number, then what to do about it. No preamble.`,
    `4. Be concise — 3 to 6 sentences unless asked for detail. Use short paragraphs,`,
    `   not bullet lists, unless comparing several businesses.`,
    `5. Interpret, do not just report. "Revenue is down 3%" is a reading; "Revenue is`,
    `   down 3% but that is the mobile shop, and the salon is up 12%" is an answer.`,
    `6. Flag when a figure is misleading. Month-to-date profit is negative early in`,
    `   every month because rent and payroll post on day one while revenue accrues`,
    `   daily — say so rather than alarming the owner.`,
    `7. UAE specifics you should reason about correctly: residential rent is`,
    `   VAT-exempt so its input VAT is NOT recoverable; parking is standard-rated;`,
    `   gratuity is a real accrued liability; a lapsed trade licence freezes bank`,
    `   accounts.`,
    `8. You are advisory. Never claim to have taken an action — you cannot.`,
    `9. Do not give tax or legal advice. Point to the accountant for filing positions.`,
  ].join("\n");
}

// ── Grounding ───────────────────────────────────────────────────────────────

/** Any digit run that reads as a quantity rather than an ordinal in prose. */
const FIGURE_PATTERN = /\d/;

/**
 * Is this answer allowed to be rendered as an answer?
 *
 * The PRD is absolute: "Every numeric claim carries a link to its rows. A claim
 * without evidence is not rendered." The case that actually produces a
 * fabricated number is the one where the model answered from its own head
 * without calling a single metric — so that is the case this gate catches: text
 * containing a figure, with no evidence behind it, is refused and the UI shows
 * the §12.1 "I can't answer that" state instead.
 *
 * What it deliberately does NOT do is try to match each individual numeral in
 * the prose against the evidence list. That check sounds stronger and is worse:
 * the model legitimately restates a tool figure rounded ("about 14 thousand"),
 * quotes a date, or cites a percentage it derived from two tool values, and a
 * matcher that rejects those trains the owner to ignore the warning. The
 * enforceable invariant is "no figures without a tool call", and that is what
 * is enforced here; per-figure attribution is what the evidence cards are for.
 */
export function answerIsGrounded(text: string, evidence: Evidence[]): boolean {
  if (evidence.length > 0) return true;
  return !FIGURE_PATTERN.test(text);
}

/**
 * How a breakdown row is displayed: a plain grouped number, never a currency.
 *
 * `MetricBreakdownRow` carries no unit of its own — the unit lives on the
 * metric — and the rows are NOT all in it. `net_profit_mtd` is a currency
 * metric whose breakdown is `income`, `expense` and `elapsed`, where `elapsed`
 * is a day count; formatting every row with the metric's unit renders "Days
 * elapsed · AED 6.00", which is a wrong figure sitting inside the component
 * whose entire job is to be checkable.
 *
 * Since the unit of a row is genuinely unknowable from here, this claims none.
 * The headline value above it carries the currency; the rows carry magnitudes.
 * The proper fix is a `unit` on `MetricBreakdownRow` in the metric registry,
 * which is outside this feature's files.
 */
function formatBreakdownValue(value: number): string {
  return new Intl.NumberFormat("en-AE", { maximumFractionDigits: 2 }).format(value);
}

// ── Short transactions ──────────────────────────────────────────────────────

function tenantCtx(session: SessionUser) {
  return { tenantId: session.tenantId, userId: session.userId };
}

/**
 * Month-to-date AI spend for the tenant.
 *
 * `date_trunc` on the tenant's own "today" rather than on `now()`, so a tenant
 * in Dubai does not get its budget reset four hours late.
 */
export async function readBudget(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<AssistantBudget> {
  const rows = await tx.execute<{ spent: string }>(sql`
    SELECT COALESCE(SUM(cost_micros), 0)::bigint AS spent
      FROM ai_messages
     WHERE tenant_id = ${tenantId}::uuid
       AND created_at >= date_trunc('month', ${today}::date)
  `);
  // A bigint arrives as a string. Not money in the ledger sense — see the
  // PRICES docblock — and bounded by the cap, so far from Number's safe range.
  const spentMicros = Number(rows[0]?.spent ?? 0);
  const remainingMicros = Math.max(0, MONTHLY_BUDGET_MICROS - spentMicros);
  return {
    spentMicros,
    capMicros: MONTHLY_BUDGET_MICROS,
    remainingMicros,
    exhausted: remainingMicros <= 0,
  };
}

interface Preflight {
  budget: AssistantBudget;
  businesses: string;
  history: { role: "user" | "assistant"; content: string }[];
}

/**
 * TRANSACTION 1. Everything the model call needs, read in one short pass, so
 * the connection is back in the pool before the first API round trip.
 */
async function preflight(
  session: SessionUser,
  today: string,
  conversationId: string | null,
): Promise<Preflight> {
  return withTenant(tenantCtx(session), async (tx) => {
    const budget = await readBudget(tx, session.tenantId, today);

    const businesses = (
      await tx.execute<{ name: string; kind: string }>(sql`
        SELECT name, kind::text FROM business_units WHERE is_active = true ORDER BY sort_order
      `)
    )
      .map((b) => `${b.name} (${b.kind.replace(/_/g, " ")})`)
      .join(", ");

    let history: Preflight["history"] = [];
    if (conversationId) {
      const rows = await tx.execute<{ role: string; content: string | null }>(sql`
        SELECT role, content
          FROM ai_messages
         WHERE conversation_id = ${conversationId}::uuid
         ORDER BY created_at DESC, role DESC
         LIMIT ${MAX_HISTORY_MESSAGES}
      `);
      history = rows
        .reverse()
        .filter((r) => (r.role === "user" || r.role === "assistant") && r.content?.trim())
        .map((r) => ({ role: r.role as "user" | "assistant", content: r.content!.trim() }));
    }

    return { budget, businesses, history };
  });
}

interface RoundOutcome {
  results: Anthropic.Beta.BetaToolResultBlockParam[];
  evidence: Evidence[];
}

/**
 * TRANSACTION 2..n. One round of metric calls, in and out.
 *
 * Every requested metric for THIS round runs inside a single transaction —
 * which is what the metric layer wants anyway, since a set of figures read in
 * one snapshot cannot disagree with each other — and the transaction commits
 * before control returns to the loop and the next model call.
 *
 * Failures are returned to the model as tool results rather than thrown, so it
 * can recover or say it cannot answer. A `MetricError` with code `forbidden`
 * reaches the model as text; it never becomes a number.
 */
async function runToolRound(
  session: SessionUser,
  today: string,
  uses: Anthropic.Beta.BetaToolUseBlock[],
): Promise<RoundOutcome> {
  return withTenant(tenantCtx(session), async (tx) => {
    const ctx: MetricContext = {
      tx,
      tenantId: session.tenantId,
      today,
      baseCurrency: session.baseCurrency,
      allowedBusinessUnitIds: session.principal.businessUnitIds,
    };

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    const evidence: Evidence[] = [];

    for (const use of uses) {
      const metricId = use.name.replace(/^get_/, "");
      try {
        const result: MetricResult = await runMetric(
          ctx,
          metricId,
          use.input ?? {},
          session.principal.permissions,
        );
        const def = METRICS_BY_ID[metricId];
        const show = (v: number) => formatMetricValue(v, result.unit, session.baseCurrency, false);

        evidence.push({
          metricId,
          title: def?.title ?? metricId,
          display: show(result.value),
          href: result.drilldownHref,
          priorDisplay:
            result.priorValue === null || result.priorValue === undefined
              ? undefined
              : show(result.priorValue),
          changeRatio: result.changeRatio ?? null,
          breakdown: result.breakdown?.slice(0, 5).map((b) => ({
            label: b.label,
            display: formatBreakdownValue(b.value),
          })),
        });

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify({
            metric: metricId,
            value: result.value,
            unit: result.unit,
            formatted: show(result.value),
            priorValue: result.priorValue ?? null,
            changeRatio: result.changeRatio ?? null,
            breakdown: result.breakdown ?? null,
          }),
        });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `Could not read ${metricId}: ${(err as Error).message}`,
        });
      }
    }

    return { results, evidence };
  });
}

/**
 * FINAL TRANSACTION. Persist the exchange, including which metrics were
 * consulted and what the exchange cost.
 *
 * This is the audit trail that makes an AI answer defensible three months
 * later (FR-P06: "Conversations are retained and auditable") and it is also
 * the spend ledger the cap is computed from — the two are the same rows, so a
 * conversation cannot exist without its cost being counted.
 */
async function persistExchange(
  session: SessionUser,
  args: {
    conversationId: string | null;
    question: string;
    answer: string;
    evidence: Evidence[];
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    latencyMs: number;
  },
): Promise<string> {
  return withTenant(tenantCtx(session), async (tx) => {
    let convId = args.conversationId;
    if (convId) {
      await tx.execute(sql`
        UPDATE ai_conversations
           SET last_message_at = now(), updated_at = now()
         WHERE id = ${convId}::uuid
      `);
    } else {
      convId = crypto.randomUUID();
      await tx.execute(sql`
        INSERT INTO ai_conversations (id, tenant_id, user_id, title, last_message_at)
        VALUES (${convId}, ${session.tenantId}::uuid, ${session.userId}::uuid,
                ${args.question.slice(0, 180)}, now())
      `);
    }

    await tx.execute(sql`
      INSERT INTO ai_messages (id, tenant_id, conversation_id, role, content, tool_calls,
                               input_tokens, output_tokens, cost_micros, latency_ms, model_id)
      VALUES
        (gen_random_uuid(), ${session.tenantId}::uuid, ${convId}::uuid, 'user',
         ${args.question}, '[]'::jsonb, NULL, NULL, NULL, NULL, NULL),
        (gen_random_uuid(), ${session.tenantId}::uuid, ${convId}::uuid, 'assistant',
         ${args.answer}, ${JSON.stringify(args.evidence)}::jsonb,
         ${args.inputTokens}, ${args.outputTokens}, ${args.costMicros},
         ${args.latencyMs}, ${MODEL})
    `);

    return convId;
  });
}

// ── The loop ────────────────────────────────────────────────────────────────

/**
 * Run one question to completion, executing whatever metric tools Claude asks
 * for. Returns the answer plus the evidence trail.
 *
 * Read the `await` sites in order before changing anything here: preflight
 * commits, then the model is called, then a round transaction commits, then the
 * model is called again. Nesting a model call inside any of these transactions
 * reintroduces audit finding D4.
 */
export async function askAssistant(
  session: SessionUser,
  question: string,
  opts: { conversationId?: string | null } = {},
): Promise<AssistantAnswer> {
  const started = Date.now();
  const today = resolveToday(session.timezone);

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new AssistantError("The assistant is not configured on this deployment.", "not_configured");
  }

  // Only metrics this user is permitted to read are even offered as tools.
  const tools = metricsAsAiTools(session.principal.permissions);
  if (tools.length === 0) {
    throw new AssistantError(
      "Your role cannot read any of the figures the assistant answers from.",
      "no_metrics",
    );
  }

  // ── Transaction 1 ─────────────────────────────────────────────────────────
  const { budget, businesses, history } = await preflight(
    session,
    today,
    opts.conversationId ?? null,
  );
  // ── Transaction 1 has committed. No connection is held from here. ─────────

  if (budget.exhausted) {
    throw new AssistantError(
      "This month's AI budget for your business is used up. It resets on the 1st.",
      "budget_exhausted",
    );
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.Beta.BetaMessageParam),
    { role: "user", content: question },
  ];

  const evidence: Evidence[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let rounds = 0;
  let finalText = "";
  let stoppedForBudget = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt(session, today, businesses),
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        tools,
        messages,
        /**
         * Server-side refusal fallback. Claude Opus 5 runs safety classifiers
         * that can decline a request outright; `"default"` lets the API re-run
         * the declined request on Anthropic's recommended substitute in the
         * same call, so a false positive on a benign question about, say, a
         * security-camera supplier invoice does not surface to the owner as a
         * dead end. Routing is by refusal category, so there is no pinned
         * model id here to go stale.
         */
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw new AssistantError(
        err instanceof Anthropic.RateLimitError
          ? "The assistant is busy right now. Try again in a moment."
          : "The assistant could not be reached. Nothing was charged.",
        "upstream",
      );
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    /**
     * Check `stop_reason` BEFORE reading `content`. A refusal returns HTTP 200
     * with an empty or partial content array; code that reaches straight for
     * `content[0]` reports it as an empty answer instead of a refusal.
     */
    if (response.stop_reason === "refusal") {
      throw new AssistantError(
        "The assistant declined to answer that. Rephrase it as a question about your numbers.",
        "declined",
      );
    }

    const toolUses = response.content.filter(
      (c): c is Anthropic.Beta.BetaToolUseBlock => c.type === "tool_use",
    );
    const text = response.content
      .filter((c): c is Anthropic.Beta.BetaTextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text) finalText = text;

    if (toolUses.length === 0 || response.stop_reason !== "tool_use") break;

    /**
     * The in-flight half of the spend cap. One question that keeps calling
     * tools is exactly the shape of an unbounded bill, so the loop stops as
     * soon as this exchange has consumed what the tenant had left and answers
     * from the metrics already gathered.
     */
    if (costMicros(MODEL, inputTokens, outputTokens) >= budget.remainingMicros) {
      stoppedForBudget = true;
      break;
    }

    rounds++;
    messages.push({ role: "assistant", content: response.content });

    // ── Transaction 2..n ───────────────────────────────────────────────────
    const outcome = await runToolRound(session, today, toolUses);
    // ── committed; connection released before the next model call ──────────

    evidence.push(...outcome.evidence);
    messages.push({ role: "user", content: outcome.results });
  }

  const spent = costMicros(MODEL, inputTokens, outputTokens);
  const latencyMs = Date.now() - started;

  // Deduplicate: the model often calls the same metric across rounds.
  const uniqueEvidence = evidence.filter(
    (e, i) => evidence.findIndex((x) => x.metricId === e.metricId) === i,
  );

  /**
   * A truncated answer says so, in the answer itself.
   *
   * The page renders from `ai_messages`, not from this return value, so a flag
   * on the object would be invisible the moment the browser follows the
   * redirect. Putting it in the persisted text means the owner sees it, and so
   * does whoever reads the conversation back six months later — which is the
   * point of keeping conversations at all. Deliberately digit-free so it
   * cannot itself trip the grounding check below.
   */
  const answerText =
    (finalText || "I could not produce an answer from the metrics available.") +
    (stoppedForBudget
      ? "\n\n(Stopped early — this month's AI budget ran out while I was working, " +
        "so this is based only on the figures I had already gathered.)"
      : "");

  const grounded = answerIsGrounded(answerText, uniqueEvidence);

  // ── Final transaction ─────────────────────────────────────────────────────
  const conversationId = await persistExchange(session, {
    conversationId: opts.conversationId ?? null,
    question,
    answer: answerText,
    evidence: uniqueEvidence,
    inputTokens,
    outputTokens,
    costMicros: spent,
    latencyMs,
  });

  const spentAfter = budget.spentMicros + spent;
  return {
    conversationId,
    text: answerText,
    evidence: uniqueEvidence,
    cannotAnswer: !grounded,
    toolRounds: rounds,
    inputTokens,
    outputTokens,
    costMicros: spent,
    latencyMs,
    model: MODEL,
    budget: {
      spentMicros: spentAfter,
      capMicros: MONTHLY_BUDGET_MICROS,
      remainingMicros: Math.max(0, MONTHLY_BUDGET_MICROS - spentAfter),
      exhausted: spentAfter >= MONTHLY_BUDGET_MICROS,
    },
    stoppedForBudget,
  };
}

// ── Read side ───────────────────────────────────────────────────────────────

export interface StoredTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  evidence: Evidence[];
  createdAt: string;
  /** True when the stored answer stated figures with nothing behind them. */
  cannotAnswer: boolean;
}

export interface StoredConversation {
  id: string;
  title: string | null;
  turns: StoredTurn[];
}

/**
 * Load one conversation for display.
 *
 * The page renders from these rows rather than from the value `askAssistant`
 * returned, which is what makes a browser refresh free: re-reading a stored
 * answer costs a SELECT, not another paid API call.
 */
export async function loadConversation(
  session: SessionUser,
  conversationId: string,
): Promise<StoredConversation | null> {
  return withTenant(tenantCtx(session), async (tx) => {
    const head = await tx.execute<{ id: string; title: string | null }>(sql`
      SELECT id::text, title FROM ai_conversations
       WHERE id = ${conversationId}::uuid AND user_id = ${session.userId}::uuid
       LIMIT 1
    `);
    if (head.length === 0) return null;

    const rows = await tx.execute<{
      id: string;
      role: string;
      content: string | null;
      tool_calls: unknown;
      created_at: string;
    }>(sql`
      SELECT id::text, role, content, tool_calls, created_at::text
        FROM ai_messages
       WHERE conversation_id = ${conversationId}::uuid
       ORDER BY created_at ASC, role DESC
    `);

    const turns: StoredTurn[] = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => {
        const evidence = Array.isArray(r.tool_calls) ? (r.tool_calls as Evidence[]) : [];
        const content = r.content ?? "";
        return {
          id: r.id,
          role: r.role as "user" | "assistant",
          content,
          evidence,
          createdAt: r.created_at,
          cannotAnswer: r.role === "assistant" && !answerIsGrounded(content, evidence),
        };
      });

    return { id: head[0]!.id, title: head[0]!.title, turns };
  });
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
}

/** The user's own recent questions — the visible half of "auditable". */
export async function listConversations(
  session: SessionUser,
  limit = 8,
): Promise<ConversationSummary[]> {
  return withTenant(tenantCtx(session), async (tx) => {
    const rows = await tx.execute<{
      id: string;
      title: string | null;
      last_message_at: string | null;
    }>(sql`
      SELECT id::text, title, last_message_at::text
        FROM ai_conversations
       WHERE user_id = ${session.userId}::uuid AND deleted_at IS NULL
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT ${limit}
    `);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      lastMessageAt: r.last_message_at,
    }));
  });
}

/** The tenant's month-to-date spend, for the meter under the composer. */
export async function currentBudget(session: SessionUser): Promise<AssistantBudget> {
  const today = resolveToday(session.timezone);
  return withTenant(tenantCtx(session), (tx) => readBudget(tx, session.tenantId, today));
}

// ── Capability surface ──────────────────────────────────────────────────────

export interface Capability {
  id: string;
  title: string;
  description: string;
}

/**
 * Metrics the assistant can reach for THIS user.
 *
 * Rendered on the unconfigured screen and in the §12.1 "I can't answer that"
 * state. Both are honest uses of the same list: it is the exact set of things
 * the assistant is able to ground an answer in, so it doubles as the answer to
 * "then what CAN you tell me?".
 */
export function assistantCapabilities(session: SessionUser): Capability[] {
  return Object.values(METRICS_BY_ID)
    .filter((m) => m.aiExposed && session.principal.permissions.has(m.permission))
    .map((m) => ({ id: m.id, title: m.title, description: m.description }));
}

export const SUGGESTED_QUESTIONS = [
  "Which business earned the most this month, and which is dragging?",
  "Why is net profit negative — should I be worried?",
  "How much VAT do I owe the FTA this quarter?",
  "What is my end-of-service liability if everyone resigned tomorrow?",
  "Which cheques do I need to bank this week?",
  "Who owes me the most money, and how late are they?",
  "What should I reorder before the weekend?",
  "Which customers used to come regularly but have stopped?",
];

/** USD micros as something a human reads. 12_500 → "$0.0125" is useless; "$0.01". */
export function formatSpend(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
