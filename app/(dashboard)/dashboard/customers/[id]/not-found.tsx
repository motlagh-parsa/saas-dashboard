// A customer id outside the active workspace — deleted, mistyped, or another
// workspace's. All three look the same on purpose: the page never says whether
// an id exists somewhere the caller cannot see.
import Link from "next/link";
import { UserX } from "lucide-react";

import { CUSTOMERS_PATH } from "@/lib/customer-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";

export default function CustomerNotFound() {
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <EmptyState
        icon={UserX}
        title="Customer not found"
        description="There's no customer with this link in the workspace you're viewing. It may have been deleted, or it belongs to another workspace — switch workspaces to look there."
        action={
          <Button asChild className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
            <Link href={CUSTOMERS_PATH}>All customers</Link>
          </Button>
        }
        className="rise mt-2"
      />
    </main>
  );
}
