import { GridSkeleton } from "@/components/ui";

/** Loading state. Per leaf route — see the note in `rentals/loading.tsx`. */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
      <div className="skeleton h-7 w-64 rounded-[var(--radius-md)]" />
      <GridSkeleton count={5} />
      <div className="skeleton h-48 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-64 rounded-[var(--radius-lg)]" />
    </div>
  );
}
