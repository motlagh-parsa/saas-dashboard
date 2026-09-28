// The strip above a table: search on the left, the view controls (filters,
// columns, export) pushed to the right. Layout only.
import type { ReactNode } from "react";

interface DataTableToolbarProps {
  search: ReactNode;
  children?: ReactNode;
}

export function DataTableToolbar({ search, children }: DataTableToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      {search}
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
