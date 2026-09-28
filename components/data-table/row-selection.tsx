"use client";

// Bulk selection for one server page of rows.
//
// The selection is tagged with the VIEW it was made in (the table's canonical
// href): a different page, search, sort, filter or page size is a different
// view, so the old selection simply stops applying — no effect needed to clear
// it. Pruning against the selectable rows also drops rows a bulk action (or
// another tab) has removed.
import * as React from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { formatCount } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CHECKBOX_CLASS } from "@/components/data-table/styles";

export interface RowSelection<Row> {
  readonly selected: readonly Row[];
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly isSelected: (id: string) => boolean;
  readonly setSelected: (ids: Iterable<string>) => void;
  readonly toggleRow: (id: string, checked: boolean) => void;
  readonly selectAll: (checked: boolean) => void;
  readonly selectableCount: number;
}

export function useRowSelection<Row extends { readonly id: string }>(
  view: string,
  selectable: readonly Row[],
): RowSelection<Row> {
  const [selection, setSelection] = React.useState<{
    readonly view: string;
    readonly ids: ReadonlySet<string>;
  }>({ view, ids: new Set() });

  const selected = selection.view === view ? selectable.filter((row) => selection.ids.has(row.id)) : [];
  const allSelected = selectable.length > 0 && selected.length === selectable.length;

  function setSelected(ids: Iterable<string>): void {
    setSelection({ view, ids: new Set(ids) });
  }

  return {
    selected,
    allSelected,
    someSelected: selected.length > 0 && !allSelected,
    isSelected: (id) => selected.some((row) => row.id === id),
    setSelected,
    toggleRow: (id, checked) => {
      const next = new Set(selected.map((row) => row.id));
      if (checked) next.add(id);
      else next.delete(id);
      setSelected(next);
    },
    selectAll: (checked) => setSelected(checked ? selectable.map((row) => row.id) : []),
    selectableCount: selectable.length,
  };
}

interface SelectAllCheckboxProps {
  label: string;
  selection: RowSelection<{ readonly id: string }>;
  disabled: boolean;
}

export function SelectAllCheckbox({ label, selection, disabled }: SelectAllCheckboxProps) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className={CHECKBOX_CLASS}
      checked={selection.allSelected}
      ref={(element) => {
        if (element) element.indeterminate = selection.someSelected;
      }}
      disabled={selection.selectableCount === 0 || disabled}
      onChange={(event) => selection.selectAll(event.target.checked)}
    />
  );
}

interface RowCheckboxProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  /** Why the box is disabled, shown on hover. */
  title?: string;
  onChange: (checked: boolean) => void;
}

export function RowCheckbox({ label, checked, disabled, title, onChange }: RowCheckboxProps) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={title}
      className={CHECKBOX_CLASS}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

interface SelectionBarProps {
  /** "3 users selected" — already pluralized. */
  summary: string;
  busy: boolean;
  onClear: () => void;
  /** The bulk action buttons. */
  children: ReactNode;
}

/** Shown only while something is selected. */
export function SelectionBar({ summary, busy, onClear, children }: SelectionBarProps) {
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-4 py-2"
    >
      <span className="text-sm font-medium" aria-live="polite">
        {summary}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          onClick={onClear}
          aria-label="Clear selection"
          className="size-11 sm:size-9"
        >
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** `3 users` / `1 user`. */
export function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}
