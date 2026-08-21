"use server";

import { redirect } from "next/navigation";
import { can, reportError } from "@nexus/core";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { AssistantError, askAssistant, isAssistantConfigured } from "../assistant";

/**
 * Assistant server actions.
 *
 * Its own module rather than a branch in the shared `lib/actions.ts`, following
 * the contract there exactly — permission checked server-side before anything
 * runs, a throttle before the expensive part, a `ServiceError`-shaped failure
 * translated into something a form can render, never a raw upstream error on
 * screen.
 *
 * Two things differ from every other action in the app, both deliberate:
 *
 *  1. IT DOES NOT WRITE THE LEDGER. Asking a question posts no journal, so
 *     there is no `postJournal`, no `withIdempotency`, and no period check. The
 *     assistant is advisory by construction (FR-P06, NG14): it has read-only
 *     metric tools and no write tool exists for it to call.
 *  2. THE THROTTLE IS ABOUT MONEY, NOT LOAD. Every question is a paid API
 *     call, so the limit here is much tighter than the 120/60 write budget —
 *     and it is only the first of two ceilings, the second being the per-tenant
 *     monthly cap enforced inside `askAssistant`.
 */

const PERMISSION = "ai:ask";

/** A question costs real money and takes tens of seconds. Twenty per five
 *  minutes is more than any human asks and far less than a stuck loop. */
const ASK_LIMIT = 20;
const ASK_WINDOW_SECONDS = 300;

/** Longer than any real question, short enough that the prompt cannot be a
 *  document paste that quietly costs a hundred times as much. */
const MAX_QUESTION_CHARS = 1_000;

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

/**
 * Ask a question.
 *
 * On success this redirects to the conversation rather than returning the
 * answer through the form: the answer is already persisted, so rendering it
 * from `ai_messages` means a refresh, a bookmark or a link shared with the
 * accountant all show the same answer with the same evidence — and none of
 * them spend another API call. `redirect` throws, so it sits outside the
 * try/catch on purpose; catching it would swallow the navigation.
 */
export async function askAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  if (!can(session.principal, PERMISSION)) {
    return { ok: false, message: "You do not have permission to ask the assistant." };
  }
  if (!isAssistantConfigured()) {
    return { ok: false, message: "The assistant is not configured on this deployment." };
  }

  const raw = formData.get("question");
  const question = typeof raw === "string" ? raw.trim() : "";
  if (!question) return { ok: false, message: "Type a question first." };
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      message: `That is longer than the ${MAX_QUESTION_CHARS} characters the assistant accepts.`,
    };
  }

  const conversationRaw = formData.get("conversationId");
  const conversationId =
    typeof conversationRaw === "string" && conversationRaw.trim() ? conversationRaw.trim() : null;

  const limit = await rateLimit(`ai:ask:${session.userId}`, ASK_LIMIT, ASK_WINDOW_SECONDS);
  if (!limit.allowed) {
    return {
      ok: false,
      message: `That is a lot of questions at once. Try again in ${limit.retryAfterSeconds}s.`,
    };
  }

  let answerConversationId: string;
  try {
    const answer = await askAssistant(session, question, { conversationId });
    answerConversationId = answer.conversationId;
  } catch (err) {
    if (err instanceof AssistantError) return { ok: false, message: err.message };
    reportError(err, "assistant-ask");
    return { ok: false, message: "The assistant failed. Nothing was saved." };
  }

  redirect(`/assistant?c=${answerConversationId}`);
}
