"use client";

// Optional columns a reader can hide. Client state on purpose: kept across page
// turns (the table island stays mounted), reset by a reload. The page keys the
// table by workspace, so hidden columns never carry into another workspace.
import * as React from "react";
import { Columns3 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONTROL_HEIGHT } from "@/components/data-table/styles";

export interface OptionalColumn<C extends string> {
  readonly key: C;
  readonly label: string;
}

export interface ColumnVisibility<C extends string> {
  readonly shows: (column: C) => boolean;
  readonly toggle: (column: C, visible: boolean) => void;
}

export function useColumnVisibility<C extends string>(): ColumnVisibility<C> {
  const [hidden, setHidden] = React.useState<ReadonlySet<C>>(new Set());
  return {
    shows: (column) => !hidden.has(column),
    toggle: (column, visible) =>
      setHidden((previous) => {
        const next = new Set(previous);
        if (visible) next.delete(column);
        else next.add(column);
        return next;
      }),
  };
}

interface ColumnVisibilityMenuProps<C extends string> {
  /** The column that identifies a row — listed, checked and locked. */
  fixedLabel: string;
  columns: readonly OptionalColumn<C>[];
  visibility: ColumnVisibility<C>;
}

export function ColumnVisibilityMenu<C extends string>({
  fixedLabel,
  columns,
  visibility,
}: ColumnVisibilityMenuProps<C>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className={cn("px-3", CONTROL_HEIGHT)}>
          <Columns3 aria-hidden />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* The identifying column cannot be hidden. */}
        <DropdownMenuCheckboxItem checked disabled>
          {fixedLabel}
        </DropdownMenuCheckboxItem>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={visibility.shows(column.key)}
            onCheckedChange={(checked) => visibility.toggle(column.key, checked === true)}
            // Keep the menu open, so several columns can be toggled in one go.
            onSelect={(event) => event.preventDefault()}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
