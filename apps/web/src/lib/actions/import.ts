"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import {
  ServiceError,
  commitImport,
  previewImport,
  reportError,
  reverseImportBatch,
  signOffReconciliation,
  type ImportDiff,
  type ServiceContext,
} from "@nexus/core";
import { requireSession } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { resolveToday } from "@/lib/data";
import type { ActionResult } from "@/lib/actions";

/**
 * SERVER ACTIONS FOR THE IMPORT WIZARD — FR-D01.
 *
 * A thin adapter, like every other action module: build a ServiceContext, call
 * the service, translate the outcome for a form. All validation, permission
 * checking, ledger posting and auditing live in `@nexus/core/services/import`,
 * so the future mobile API and any bulk-load CLI get identical behaviour rather
 * than a second implementation with its own rounding bugs.
 *
 * THE ONE THING THIS FILE ADDS, and it is the important one: the dry run and
 * the commit are two different server actions, reachable only from two
 * different buttons. There is no `commit: boolean` on one action, because a
 * boolean is a thing that can be defaulted wrong, forgotten in a refactor, or
 * flipped by a client that shouldn't. Two functions cannot be confused for each
 * other, and the review screen's promise — "Nothing has been saved yet" — is
 * then a property of which function ran, not of an argument to it.
 *
 * The file's own content never leaves the request. It is parsed, planned and
 * discarded; nothing is staged on the server between the dry run and the
 * commit, so there is no half-uploaded batch to leak or to clean up. The cost
 * is that the browser holds the text between the two steps and sends it twice,
 * which is the right trade for files of a few hundred rows and is why
 * `MAX_ROWS` exists.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Session = Awaited<ReturnType<typeof requireSession>>;

async function buildContext(tx: Tx, session: Session): Promise<ServiceContext> {
  const h = await headers();
  const ip = h.get("x-client-ip");
  return {
    tx,
    tenantId: session.tenantId,
    principal: session.principal,
    today: resolveToday(session.timezone),
    baseCurrency: session.baseCurrency,
    ipAddress: ip && ip !== "local" ? ip : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}

/** Write throttle, keyed by user. Same budget as every other write path. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return { ok: false, message: "Too many changes in a short time. Wait a moment and try again." };
}

function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Some of those values are not valid." };
  }
  reportError(err, "import-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

export interface PreviewResult extends ActionResult {
  diff?: ImportDiff;
}

/**
 * THE DRY RUN.
 *
 * Read-only end to end. It still opens a transaction because every read in this
 * app goes through `withTenant`, which is what sets the tenant for RLS — a
 * query outside it sees nothing at all rather than seeing too much.
 *
 * It is rate-limited on the same budget as the writes, deliberately: planning a
 * 5,000-row file is the most expensive read in the product, and an unthrottled
 * one is a denial-of-service primitive that happens to be spelled "preview".
 */
export async function previewImportAction(input: {
  kind: string;
  filename: string;
  content: string;
  businessUnitId?: string;
  asOf?: string;
  warehouse?: string;
}): Promise<PreviewResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const diff = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        previewImport(await buildContext(tx, session), {
          kind: input.kind,
          filename: input.filename,
          content: input.content,
          businessUnitId: input.businessUnitId ?? null,
          options: { asOf: input.asOf, warehouse: input.warehouse },
        }),
    );
    return { ok: true, diff };
  } catch (err) {
    return toResult(err);
  }
}

export interface CommitResult extends ActionResult {
  batchId?: string;
  needsSignOff?: boolean;
}

/**
 * THE COMMIT.
 *
 * Takes the fingerprint and the four counts the user actually looked at. The
 * service re-reads the file and refuses if either has moved — see
 * `commitImport`. Nothing about that check can be satisfied by the client
 * lying: a forged fingerprint fails against the recomputed one, and forged
 * counts fail against the recomputed plan.
 */
export async function commitImportAction(input: {
  kind: string;
  filename: string;
  content: string;
  businessUnitId?: string;
  asOf?: string;
  warehouse?: string;
  approved: { fingerprint: string; create: number; update: number; skip: number; reject: number };
  idempotencyKey: string;
}): Promise<CommitResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        commitImport(await buildContext(tx, session), {
          kind: input.kind,
          filename: input.filename,
          content: input.content,
          businessUnitId: input.businessUnitId ?? null,
          options: { asOf: input.asOf, warehouse: input.warehouse },
          approved: input.approved,
          idempotencyKey: input.idempotencyKey,
        }),
    );
    revalidatePath("/settings/import");
    revalidatePath("/");
    return {
      ok: true,
      batchId: result.batchId,
      needsSignOff: result.needsSignOff,
      message:
        `Imported. ${result.counts.create} created, ${result.counts.update} updated, ` +
        `${result.counts.skip} skipped.` +
        (result.needsSignOff
          ? " The reconciliation still needs the accountant's signature before go-live."
          : ""),
    };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Reverse a batch.
 *
 * Uses the `ActionForm` contract because it is irreversible in the other
 * direction and therefore wants the `confirm` interstitial, which that
 * component provides for form actions only.
 */
export async function reverseImportBatchAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        reverseImportBatch(await buildContext(tx, session), {
          batchId: str(formData, "batchId"),
          reason: str(formData, "reason"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/settings/import");
    revalidatePath("/");
    return {
      ok: true,
      message:
        `Reversed. ${result.rowsRemoved} record(s) removed, ${result.rowsRestored} restored` +
        (result.reversalJournalId ? ", and a reversing journal posted" : "") +
        (result.signOffCleared ? ". The sign-off on this batch has been cleared" : "") +
        ".",
    };
  } catch (err) {
    return toResult(err);
  }
}

/** The accountant's signature over the reconciliation. Decision D5's gate. */
export async function signOffImportAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        signOffReconciliation(await buildContext(tx, session), {
          batchId: str(formData, "batchId"),
          accountantTotal: str(formData, "accountantTotal"),
          note: str(formData, "note"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/settings/import");
    return {
      ok: true,
      message: `Signed off at AED ${result.signedTotal}. Go-live is no longer blocked on this.`,
    };
  } catch (err) {
    return toResult(err);
  }
}
