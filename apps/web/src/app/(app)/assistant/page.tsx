import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Ask Nexus — TEMPORARILY DISABLED.
 *
 * The AI assistant is turned off for now because no ANTHROPIC_API_KEY is
 * provisioned in this environment. The full implementation still lives in
 * `@/lib/assistant` and in this file's git history; nothing was deleted.
 *
 * To re-enable:
 *   1. Set ANTHROPIC_API_KEY (see .env.example).
 *   2. Restore the previous version of this file:
 *        git checkout <commit-before-disable> -- apps/web/src/app/(app)/assistant/page.tsx
 *   3. Uncomment the "/assistant" entry in apps/web/src/app/(app)/layout.tsx.
 *
 * Until then any direct navigation lands back on the dashboard rather than a
 * half-working feature.
 */
export default async function AssistantPage() {
  redirect("/");
}
