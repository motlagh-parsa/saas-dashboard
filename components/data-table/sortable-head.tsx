"use client";

// A column header that sorts by linking to the next URL state. A plain link, so
// sorting is shareable, back-button-correct and prefetched.
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SortDirection } from "@/lib/list-state";
import { TableHead } from "@/components/ui/table";
import { TABLE_HEAD } from "@/components/data-table/styles";

interface SortableHeadProps {
  label: string;
  href: string;
  active: boolean;
  dir: SortDirection;
  className?: string;
}

export function SortableHead({ label, href, active, dir, className }: SortableHeadProps) {
  const Arrow = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
      className={cn(TABLE_HEAD, className)}
    >
      <Link
        href={href}
        scroll={false}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? <Arrow aria-hidden className="size-3" /> : null}
      </Link>
    </TableHead>
  );
}
