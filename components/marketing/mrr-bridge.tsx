// The revenue bridge as one line of arithmetic: last month's MRR, plus what
// came in, minus what went out, equals this month's. It is the question
// Meridian answers ("why did MRR move?"), so the landing page and the sign-in
// panel lead with it.
//
// The figures are an EXAMPLE and say so. They add up: 40,120 + 3,480 + 1,240
// − 610 − 1,980 = 42,250.
import { cn } from "@/lib/utils";

interface Term {
  readonly sign: "" | "+" | "−" | "=";
  readonly amount: string;
  readonly label: string;
  readonly tone: "neutral" | "positive" | "negative" | "result";
}

const TERMS: readonly Term[] = [
  { sign: "", amount: "$40,120", label: "MRR on June 1", tone: "neutral" },
  { sign: "+", amount: "$3,480", label: "new customers", tone: "positive" },
  { sign: "+", amount: "$1,240", label: "upgrades", tone: "positive" },
  { sign: "−", amount: "$610", label: "downgrades", tone: "negative" },
  { sign: "−", amount: "$1,980", label: "churn", tone: "negative" },
  { sign: "=", amount: "$42,250", label: "MRR on July 1", tone: "result" },
];

const TONE: Record<Term["tone"], string> = {
  neutral: "text-foreground",
  positive: "text-positive",
  negative: "text-negative",
  result: "text-brand",
};

interface MrrBridgeProps {
  size?: "large" | "compact";
  className?: string;
}

export function MrrBridge({ size = "large", className }: MrrBridgeProps) {
  const large = size === "large";
  return (
    <figure className={cn("w-full", className)}>
      <dl
        className={cn(
          "flex flex-wrap items-end",
          large ? "gap-x-4 gap-y-6 lg:gap-x-5" : "gap-x-3 gap-y-3",
        )}
      >
        {TERMS.map((term) => (
          <div key={term.label} className="flex items-end gap-2">
            {term.sign ? (
              <span
                aria-hidden
                className={cn(
                  "font-heading text-muted-foreground",
                  large ? "pb-6 text-2xl lg:text-3xl" : "pb-4 text-base",
                )}
              >
                {term.sign}
              </span>
            ) : null}
            <div className="flex flex-col">
              <dd
                className={cn(
                  "order-1 font-heading font-semibold tracking-tight tabular-nums",
                  TONE[term.tone],
                  large ? "text-3xl lg:text-[2.75rem]" : "text-lg",
                )}
              >
                <span className="sr-only">{term.sign === "−" ? "minus " : term.sign === "+" ? "plus " : term.sign === "=" ? "equals " : ""}</span>
                {term.amount}
              </dd>
              <dt className={cn("order-2 text-muted-foreground", large ? "mt-1 text-sm" : "mt-0.5 text-[0.6875rem]")}>
                {term.label}
              </dt>
            </div>
          </div>
        ))}
      </dl>
      <figcaption className={cn("text-muted-foreground", large ? "mt-6 text-sm" : "mt-4 text-[0.6875rem]")}>
        An example month, broken down the way Meridian shows yours.
      </figcaption>
    </figure>
  );
}
