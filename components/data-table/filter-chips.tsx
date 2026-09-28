// A segmented set of filter links (All / Active / Churned / Archived). URL
// state, like every other table control: each chip is a link to the filtered
// view, on page one.
import { NavChip } from "@/components/dashboard/nav-chip";

export interface FilterChip {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /** Optional count shown after the label. */
  readonly count?: number;
}

interface FilterChipsProps {
  /** Accessible group name, e.g. "Filter customers by status". */
  label: string;
  chips: readonly FilterChip[];
  active: string;
}

export function FilterChips({ label, chips, active }: FilterChipsProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"
    >
      {chips.map((chip) => (
        <NavChip key={chip.key} href={chip.href} active={chip.key === active}>
          {chip.label}
          {chip.count !== undefined ? (
            <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
              {chip.count}
            </span>
          ) : null}
        </NavChip>
      ))}
    </div>
  );
}
