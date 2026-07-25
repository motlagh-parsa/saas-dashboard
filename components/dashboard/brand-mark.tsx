import { cn } from "@/lib/utils";

type BrandMarkProps = {
  /** Show the "Meridian" wordmark next to the glyph. */
  showWordmark?: boolean;
  className?: string;
};

/**
 * Product identity: a brass glyph of an upward trend tick — the signature
 * element, tying the mark to the subject (revenue moving up and to the right).
 */
export function BrandMark({ showWordmark = true, className }: BrandMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-brand text-brand-foreground shadow-sm"
      >
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 11.5 6 7l3 2.5L14 4" />
          <path d="M10.5 4H14v3.5" />
        </svg>
      </span>
      {showWordmark ? (
        <span className="font-heading text-[0.95rem] font-semibold tracking-tight">
          Meridian
        </span>
      ) : null}
    </span>
  );
}