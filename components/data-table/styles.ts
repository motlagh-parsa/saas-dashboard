// The class vocabulary every data table shares, so a new table cannot drift from
// the Users table it was extracted from.

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
export const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

export const TABLE_HEAD =
  "h-9 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";

/** Touch first: 44px on a phone, tightened to the app's density on a pointer. */
export const CONTROL_HEIGHT = "h-11 sm:h-9";

export const CHECKBOX_CLASS =
  "size-4 cursor-pointer rounded border-input accent-brand disabled:cursor-not-allowed disabled:opacity-40";

/** A quiet mono tag — a status or source label with no semantic colour. */
export const TAG_CLASS =
  "bg-muted font-mono text-[0.625rem] font-medium tracking-[0.12em] text-muted-foreground uppercase";
