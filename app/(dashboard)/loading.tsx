// Route-group loading fallback for the (dashboard) segment. Minimal + functional;
// ui-designer will replace this with real skeletons.
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-8">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-40 w-full" />
    </main>
  );
}