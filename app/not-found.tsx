// The site-wide 404: any URL that matches nothing. Pages that look up a record
// (a customer, an invite) show their own message instead.
import Link from "next/link";

import { BrandMark } from "@/components/dashboard/brand-mark";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <BrandMark />
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          This address doesn&apos;t lead anywhere in Meridian. It may have been mistyped, or the page has moved.
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild className="h-11 bg-brand px-4 text-brand-foreground hover:bg-brand/90 sm:h-9">
          <Link href="/dashboard">Go to the dashboard</Link>
        </Button>
        <Button asChild variant="outline" className="h-11 px-4 sm:h-9">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
