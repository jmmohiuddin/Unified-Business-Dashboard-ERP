import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
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
 */

const MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 5;

export function isAssistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface Evidence {
  metricId: string;
  title: string;
  display: string;
  href?: string;
}

export interface AssistantAnswer {
  text: string;
  evidence: Evidence[];
  toolRounds: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

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

/**
 * Run one question to completion, executing whatever metric tools Claude asks
 * for. Returns the answer plus the evidence trail.
 */
export async function askAssistant(
  session: SessionUser,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<AssistantAnswer> {
  const started = Date.now();
  const today = resolveToday(session.timezone);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Only metrics this user is permitted to read are even offered as tools.
  const tools = metricsAsAiTools(session.principal.permissions);

  const evidence: Evidence[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let rounds = 0;

  return withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) => {
    const businesses = (
      await tx.execute<{ name: string; kind: string }>(sql`
        SELECT name, kind::text FROM business_units WHERE is_active = true ORDER BY sort_order
      `)
    )
      .map((b) => `${b.name} (${b.kind.replace(/_/g, " ")})`)
      .join(", ");

    const ctx: MetricContext = {
      tx,
      tenantId: session.tenantId,
      today,
      baseCurrency: session.baseCurrency,
      allowedBusinessUnitIds: session.principal.businessUnitIds,
    };

    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
      { role: "user", content: question },
    ];

    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1400,
        system: systemPrompt(session, today, businesses),
        tools,
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      const toolUses = response.content.filter(
        (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
      );
      finalText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (toolUses.length === 0 || response.stop_reason !== "tool_use") break;

      rounds++;
      messages.push({ role: "assistant", content: response.content });

      // Execute every requested metric. Failures are returned to the model as
      // text rather than thrown, so it can recover or say it cannot answer.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const metricId = use.name.replace(/^get_/, "");
        try {
          const result: MetricResult = await runMetric(
            ctx,
            metricId,
            use.input ?? {},
            session.principal.permissions,
          );
          const def = METRICS_BY_ID[metricId];
          evidence.push({
            metricId,
            title: def?.title ?? metricId,
            display: formatMetricValue(result.value, result.unit, session.baseCurrency),
            href: result.drilldownHref,
          });
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify({
              metric: metricId,
              value: result.value,
              unit: result.unit,
              formatted: formatMetricValue(result.value, result.unit, session.baseCurrency),
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
      messages.push({ role: "user", content: results });
    }

    // Persist the exchange, including which metrics were consulted. This is the
    // audit trail that makes an AI answer defensible three months later.
    const convId = crypto.randomUUID();
    await tx.execute(sql`
      INSERT INTO ai_conversations (id, tenant_id, user_id, title, last_message_at)
      VALUES (${convId}, ${session.tenantId}::uuid, ${session.userId}::uuid,
              ${question.slice(0, 180)}, now())
    `);
    await tx.execute(sql`
      INSERT INTO ai_messages (id, tenant_id, conversation_id, role, content, tool_calls,
                               input_tokens, output_tokens, latency_ms, model_id)
      VALUES
        (gen_random_uuid(), ${session.tenantId}::uuid, ${convId}::uuid, 'user',
         ${question}, '[]'::jsonb, NULL, NULL, NULL, NULL),
        (gen_random_uuid(), ${session.tenantId}::uuid, ${convId}::uuid, 'assistant',
         ${finalText}, ${JSON.stringify(evidence)}::jsonb,
         ${inputTokens}, ${outputTokens}, ${Date.now() - started}, ${MODEL})
    `);

    return {
      text: finalText || "I could not produce an answer from the metrics available.",
      // Deduplicate: the model often calls the same metric across rounds.
      evidence: evidence.filter(
        (e, i) => evidence.findIndex((x) => x.metricId === e.metricId) === i,
      ),
      toolRounds: rounds,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      model: MODEL,
    };
  });
}

/** Metrics the assistant can reach, for the "what can I ask" panel. */
export function assistantCapabilities(session: SessionUser) {
  return Object.values(METRICS_BY_ID)
    .filter((m) => m.aiExposed && session.principal.permissions.has(m.permission))
    .map((m) => ({ id: m.id, title: m.title }));
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
