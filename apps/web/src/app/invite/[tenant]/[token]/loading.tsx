/**
 * The loading state for the acceptance screen.
 *
 * Worth having even though the page does one indexed lookup: this is the first
 * thing an invited employee ever sees, it is reached from a chat message on a
 * phone, and a blank tab while the token is verified reads as a dead link — the
 * one interpretation that makes them give up rather than wait.
 */
export default function Loading() {
  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-sm animate-pulse">
        <div className="h-7 w-7 rounded-lg mb-8" style={{ background: "var(--surface-2)" }} />
        <div className="h-6 w-2/3 rounded" style={{ background: "var(--surface-2)" }} />
        <div className="h-3 w-full rounded mt-3" style={{ background: "var(--surface-2)" }} />
        <div className="h-3 w-4/5 rounded mt-2" style={{ background: "var(--surface-2)" }} />
        <div className="h-9 w-full rounded-[var(--radius-md)] mt-8" style={{ background: "var(--surface-2)" }} />
        <div className="h-9 w-full rounded-[var(--radius-md)] mt-3" style={{ background: "var(--surface-2)" }} />
      </div>
    </main>
  );
}
