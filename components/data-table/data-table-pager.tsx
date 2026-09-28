"use client";

// The pager under a server-paged table: "Showing 21–40 of 312 users", then
// Previous, a window of page numbers, and Next — all plain links.
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCount } from "@/lib/format";
import { pageWindow } from "@/lib/list-state";
import { NavChip } from "@/components/dashboard/nav-chip";
import { plural } from "@/components/data-table/row-selection";

interface DataTablePagerProps {
  page: number;
  lastPage: number;
  from: number;
  to: number;
  matching: number;
  /** Singular noun for "of 312 users". */
  noun: string;
  hrefFor: (page: number) => string;
}

const PAGER_EDGE =
  "inline-flex h-11 items-center gap-1 rounded-md px-3 text-xs font-medium md:h-8";

export function DataTablePager({ page, lastPage, from, to, matching, noun, hrefFor }: DataTablePagerProps) {
  const onFirst = page <= 1;
  const onLast = page >= lastPage;

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="font-mono text-xs text-muted-foreground tabular-nums">
        Showing {formatCount(from)}–{formatCount(to)} of {plural(matching, noun)}
      </p>

      {lastPage > 1 ? (
        <div className="flex flex-wrap items-center gap-0.5">
          {onFirst ? (
            <span aria-disabled="true" className={cn(PAGER_EDGE, "text-muted-foreground/50")}>
              <ChevronLeft aria-hidden className="size-3.5" />
              Previous
            </span>
          ) : (
            <NavChip href={hrefFor(page - 1)} label="Previous page">
              <ChevronLeft aria-hidden className="size-3.5" />
              Previous
            </NavChip>
          )}

          {pageWindow(page, lastPage).map((entry, index) =>
            entry === "gap" ? (
              <span
                key={`gap-${index}`}
                aria-hidden
                className="inline-flex h-11 w-6 items-center justify-center text-xs text-muted-foreground md:h-8"
              >
                …
              </span>
            ) : (
              <NavChip
                key={entry}
                href={hrefFor(entry)}
                active={entry === page}
                label={entry === page ? `Page ${entry}, current page` : `Page ${entry}`}
                className="min-w-9 justify-center px-2 font-mono tabular-nums"
              >
                {entry}
              </NavChip>
            ),
          )}

          {onLast ? (
            <span aria-disabled="true" className={cn(PAGER_EDGE, "text-muted-foreground/50")}>
              Next
              <ChevronRight aria-hidden className="size-3.5" />
            </span>
          ) : (
            <NavChip href={hrefFor(page + 1)} label="Next page">
              Next
              <ChevronRight aria-hidden className="size-3.5" />
            </NavChip>
          )}
        </div>
      ) : null}
    </nav>
  );
}
