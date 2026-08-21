import Link from "next/link";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import { previewInvite, security, type InviteStatus } from "@nexus/core";
import { rateLimit } from "@/lib/rate-limit";
import { acceptInviteAction } from "@/lib/actions/invites";
import { ActionForm, Field } from "@/components/action-form";

export const dynamic = "force-dynamic";

/**
 * ACCEPT AN INVITATION.
 *
 * The only page in the product that does real work for a caller with no
 * session, which makes it the newest attack surface the app exposes. Four
 * things follow from that and each is deliberate:
 *
 *  1. IT THROTTLES ON RENDER, not only on submit. Loading this page performs
 *     the same token lookup the submission does, so limiting only the POST
 *     would leave the enumeration path wide open behind a GET. Same key as the
 *     action's limiter, so the two share one budget rather than two.
 *
 *  2. IT DISCLOSES NOTHING UNTIL THE TOKEN MATCHES. The tenant id sits in the
 *     URL — see `acceptInvite` for why it has to — so a stranger can put any
 *     UUID there. With a bad token they are told the link is not valid and
 *     learn nothing else: not the company's name, not whether that tenant
 *     exists, not whether the address is registered.
 *
 *  3. IT NEVER SAYS "that email already has an account". `acceptInvite` links
 *     an existing account rather than overwriting its password, and the
 *     difference is visible only after redemption, to the person who redeemed
 *     it — never to someone probing the form.
 *
 *  4. IT IS OUTSIDE THE (app) GROUP. There is no shell, no navigation and no
 *     `requireSession()`, because the person reading it is not a user yet.
 *
 * On the five states in WF-05 §0: default, loading (loading.tsx beside this
 * file) and error (every unusable-link state below) are all built. `empty` and
 * `permission-denied` do not exist here — the screen is a single record, and
 * an unauthenticated screen has no permissions to deny. The invalid-link state
 * is the honest equivalent of both.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One message per unusable state. Distinguishing them is safe — the reader
 *  already holds the token — and telling somebody their link expired is the
 *  difference between asking for a new one and giving up. */
const DEAD_LINK: Record<Exclude<InviteStatus, "valid">, { title: string; detail: string }> = {
  expired: {
    title: "This invitation has expired",
    detail:
      "Invitations are good for three days. Ask whoever invited you to send a new link.",
  },
  used: {
    title: "This invitation has already been used",
    detail: "If that was you, sign in with the password you chose.",
  },
  revoked: {
    title: "This invitation was cancelled",
    detail: "Ask whoever invited you if you should still have access.",
  },
  unknown: {
    title: "This invitation link is not valid",
    detail:
      "Check that you copied the whole link — they are long and easily cut short by a chat app.",
  },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8">
          <div
            className="w-7 h-7 rounded-lg grid place-items-center text-xs font-bold"
            style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
          >
            N
          </div>
          <span className="font-semibold tracking-tight">Nexus</span>
        </div>
        {children}
      </div>
    </main>
  );
}

function DeadLink({ title, detail }: { title: string; detail: string }) {
  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-xs text-muted mt-2 leading-relaxed">{detail}</p>
      <Link href="/login" className="btn btn-primary w-full mt-6 inline-flex justify-center">
        Go to sign in
      </Link>
    </Shell>
  );
}

export default async function AcceptInvitePage({
  // Next 16: params is a Promise.
  params,
}: {
  params: Promise<{ tenant: string; token: string }>;
}) {
  const { tenant, token } = await params;

  // A malformed tenant id would be interpolated into a `::uuid` cast and
  // become a database error rather than an answer. Refused here, with the same
  // message a wrong token gets, so the shape of the id leaks nothing either.
  if (!UUID.test(tenant)) return <DeadLink {...DEAD_LINK.unknown} />;

  const h = await headers();
  const ip = h.get("x-client-ip") ?? "local";
  const limit = await rateLimit(`invite:ip:${ip}`, 20, 300);
  if (!limit.allowed) {
    security.throttled({
      ip,
      userAgent: h.get("user-agent") ?? undefined,
      detail: { surface: "invite.preview" },
    });
    return (
      <DeadLink
        title="Too many attempts"
        detail="Wait a few minutes and open the link again."
      />
    );
  }

  const preview = await withTenant({ tenantId: tenant }, (tx) => previewInvite(tx, token));
  if (preview.status !== "valid") return <DeadLink {...DEAD_LINK[preview.status]} />;

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight">
        Join {preview.tenantName}
      </h1>
      <p className="text-xs text-muted mt-2 leading-relaxed">
        You were invited as <strong className="font-medium">{preview.roleName}</strong>, at{" "}
        {preview.email}. Choose a password and you are in.
      </p>

      <div className="mt-6">
        <ActionForm action={acceptInviteAction} submitLabel="Create my account" className="space-y-3">
          <input type="hidden" name="tenantId" value={tenant} />
          <input type="hidden" name="token" value={token} />
          <Field name="fullName" label="Your name" required placeholder="Maya Rahman" />
          <Field name="password" label="Password" type="password" required />
          <p className="text-2xs text-subtle leading-relaxed">
            At least 12 characters. Long is better than complicated.
          </p>
        </ActionForm>
      </div>

      <p className="text-2xs text-subtle mt-6 leading-relaxed">
        Already have a Nexus account with this address? Use the same button.
        This invitation will attach {preview.tenantName} to that account and
        will not change its password — you then{" "}
        <Link href="/login" className="underline">
          sign in
        </Link>{" "}
        as you always have.
      </p>
    </Shell>
  );
}
