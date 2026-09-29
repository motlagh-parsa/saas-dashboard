// A slim strip above every dashboard page while the workspace holds sample
// data, so invented numbers are never mistaken for real ones. Owners and admins
// get the Remove control; members see the banner without it.
import { FlaskConical } from "lucide-react";

import { RemoveSampleDataDialog } from "@/components/workspace/sample-data-controls";

interface SampleDataBannerProps {
  organizationId: string;
  canRemove: boolean;
}

export function SampleDataBanner({ organizationId, canRemove }: SampleDataBannerProps) {
  return (
    <div
      role="status"
      data-testid="sample-data-banner"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-brand/25 bg-brand/8 px-4 py-2 text-[0.8125rem] sm:px-6 lg:px-8"
    >
      <FlaskConical aria-hidden className="size-3.5 shrink-0 text-brand" />
      <span className="text-foreground">You&apos;re viewing sample data.</span>
      {canRemove ? <RemoveSampleDataDialog organizationId={organizationId} variant="link" /> : null}
    </div>
  );
}
