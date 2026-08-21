import { createEmailProvider, readEmailEnv } from "./email.ts";
import type { DeliveryChannel, DeliveryProvider, DeliveryResult } from "./types.ts";

/**
 * THE KILL SWITCH, AND WHAT IS BEHIND IT.
 *
 * PRD FR-P03 requires "a kill switch that stops all outbound delivery
 * immediately" and roadmap risk R4 rates a runaway automation messaging
 * thousands of customers as Critical. Before this file `grep -ri kill.switch`
 * over the repository returned nothing.
 *
 * There are TWO switches and they answer different questions, because one
 * cannot answer both:
 *
 *   1. `NEXUS_DELIVERY_ENABLED` — the deployment switch, read here. It must be
 *      the exact string "true". Unset, empty, "1", "yes", "TRUE" and a typo all
 *      mean OFF. This is the fail-closed default: a fresh environment, a
 *      preview deployment, a `vercel env pull` that missed a variable, and
 *      every CI run all send nothing without anyone having to remember to
 *      disable them. It is the right default and the WRONG panic button —
 *      changing it on Vercel needs a redeploy, and "immediately" does not mean
 *      "after a build".
 *
 *   2. `tenants.settings->>'delivery_paused'` — the operational switch, read
 *      and written by `pauseDelivery`/`resumeDelivery` in `outbox.ts`. One
 *      UPDATE, effective on the next claim, no redeploy, per tenant, and it
 *      records who pulled it and why. That is the panic button, and it lives in
 *      the database precisely so that the person who notices at 21:00 that the
 *      review-request automation is working through the whole customer list can
 *      stop it from a screen rather than from a deploy pipeline.
 *
 * Both are checked. Either one being off stops delivery, and the outbox reports
 * WHICH — an operator who has flipped one and is watching nothing happen needs
 * to know the other is also holding the line.
 */

/** The exact string, and only the exact string. */
export function deliveryEnabledInEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXUS_DELIVERY_ENABLED === "true";
}

/**
 * Per-day ceiling on messages that leave the tenant, across every automation.
 *
 * `automations.max_runs_per_day` already caps each RULE (runner.ts honours it,
 * truncating the match set and recording `cappedAt`). That is a per-rule guard
 * and it is genuinely enforced, so nothing here duplicates it. What it cannot
 * do is bound the TOTAL: thirteen rules each capped at their 500 default is
 * 6,500 messages, and a rule whose cap was raised once for a legitimate backlog
 * keeps the raised cap forever.
 *
 * This is the ceiling on the pipe rather than on any rule feeding it, which is
 * the only place a runaway can be stopped without knowing which rule ran away.
 * In-app notifications are exempt: they reach an inbox, not a person's phone,
 * and capping them would hide the alert telling the owner what is happening.
 */
export function dailyExternalCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NEXUS_DELIVERY_DAILY_CAP ?? 200); // money-guard-ignore: a message count, not an amount.
  return Number.isInteger(raw) && raw >= 0 ? raw : 200;
}

/**
 * Distinct external recipients in one cycle above which a human must say yes.
 *
 * FR-P03's acceptance criteria list an approval gate, and `automations
 * .requires_approval` provides one — but only for a rule an operator already
 * suspected. The gate here is on the shape of the batch rather than on the
 * identity of its author: any cycle about to contact more than this many
 * distinct people is held, whatever produced it, including a hand-written
 * import or a bug in a rule nobody flagged.
 *
 * Held, not dropped. The messages stay `pending` with the reason recorded, so
 * approving is re-running with `approvedBy` set and nothing has to be rebuilt.
 */
export function approvalThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NEXUS_DELIVERY_APPROVAL_THRESHOLD ?? 50); // money-guard-ignore: a recipient count, not an amount.
  return Number.isInteger(raw) && raw >= 0 ? raw : 50;
}

export interface ResolvedProvider {
  provider: DeliveryProvider;
  /** Channels with a genuinely configured provider behind them. */
  configured: DeliveryChannel[];
  /** Human-readable, secret-free reasons a channel is unavailable. */
  issues: string[];
}

/**
 * A provider that answers honestly for every channel nobody has configured.
 *
 * The alternative — returning `null` and letting each caller decide — is how
 * "no provider" became "console provider" the first time. A channel with no
 * implementation has one correct behaviour and it is expressed once, here.
 */
function unconfigured(reason: string): DeliveryProvider {
  return {
    name: "unconfigured",
    channels: ["in_app", "email", "sms", "whatsapp", "push"],
    async send(): Promise<DeliveryResult> {
      return { outcome: "not_configured", reason };
    },
  };
}

/**
 * Route each channel to whatever is actually configured for it.
 *
 * `in_app` is deliberately NOT routed to a provider. An in-app notification is
 * already delivered the moment its row exists — `loadInbox` reads
 * `notifications` regardless of `status` — so handing it to a sender would be
 * inventing a network hop for a message that has already arrived. The outbox
 * settles it directly; see `dispatchOutbox`.
 */
export function resolveProvider(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const issues: string[] = [];
  const configured: DeliveryChannel[] = [];
  const byChannel = new Map<DeliveryChannel, DeliveryProvider>();

  const email = readEmailEnv(env);
  if (email.config) {
    byChannel.set("email", createEmailProvider(email.config));
    configured.push("email");
  } else {
    issues.push(`email: ${email.issues.map((i) => i.message).join("; ")}`);
  }

  // No SMS, WhatsApp or push provider exists. Saying so is the point — FR-P03
  // asks for ONE real channel, and a `review_request` automation defaulting to
  // `whatsapp` (runner.ts) must not silently believe it has one.
  for (const channel of ["sms", "whatsapp", "push"] as const) {
    issues.push(`${channel}: no provider is implemented for this channel`);
  }

  return {
    configured,
    issues,
    provider: {
      name: "registry",
      channels: [...byChannel.keys()],
      async send(message) {
        const target = byChannel.get(message.channel);
        if (!target) {
          return {
            outcome: "not_configured",
            reason:
              message.channel === "email"
                ? `email delivery is not configured — ${email.issues.map((i) => i.message).join("; ")}`
                : `no provider is implemented for the ${message.channel} channel`,
          };
        }
        return target.send(message);
      },
    },
  };
}

export { unconfigured };
