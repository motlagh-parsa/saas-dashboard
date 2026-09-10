// The placeholder body for a route that exists in the nav but has no feature
// behind it yet. Presentational and server-only — it holds no state, fetches
// nothing, and each calling page owns its own `requireSession()` gate.
//
// Why this is shared: four routes (Customers, Reports, Notifications, Settings)
// are structurally identical right now — a title, a one-line promise, an icon,
// and a status marker. Four copy-pasted blocks would drift the moment one of
// them ships, so the shape lives here and the pages stay thin.
import type { ComponentType } from "react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/empty-state";

/**
 * The default status marker. Deliberately quiet: `variant="secondary"` in the
 * mono-caps voice the app already uses for scope tags, not a primary-colored
 * chip. This is a state, not an alert.
 */
const DEFAULT_STATUS = "Coming soon";

/**
 * One shared headline for every unbuilt route.
 *
 * It states the STATE of the page. The `description` states the CONTENT of the
 * page, and the page's own `<h1>` states its IDENTITY. Three separate jobs, so
 * nothing is said twice — which is why there is no subtitle under the `<h1>`
 * here the way there is on the pages that report real figures.
 */
const HEADLINE = "This page is still being built";

type ComingSoonProps = {
  /** Page name. Rendered as the `<h1>`, matching every other dashboard page. */
  title: string;
  /** One line on what will eventually live here. Said here and nowhere else. */
  description: string;
  /** The same icon this route uses in the sidebar, for visual continuity. */
  icon: ComponentType<{ className?: string }>;
  /** Overridable for a route that is partially built, e.g. "In development". */
  status?: string;
};

export function ComingSoon({
  title,
  description,
  icon,
  status = DEFAULT_STATUS,
}: ComingSoonProps) {
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise">
        <h1 className="font-heading text-xl font-semibold tracking-tight">{title}</h1>
      </header>

      <EmptyState
        icon={icon}
        title={HEADLINE}
        description={description}
        action={
          <Badge
            variant="secondary"
            className="bg-muted font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase"
          >
            {status}
          </Badge>
        }
        className="rise mt-3 [animation-delay:60ms]"
      />
    </main>
  );
}
