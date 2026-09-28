import type { NetRevenueRetentionResult } from "@/lib/metrics";
import { cn } from "@/lib/utils";
import {
  EM_DASH,
  formatCount,
  formatMoney,
  formatMoneyMovement,
  formatPercent,
} from "@/lib/format";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

interface NRRLedgerProps {
  result: NetRevenueRetentionResult;
  currency: string;
  /** Reads as the tail of "vs …", e.g. "previous 30 days". */
  comparison: string;
}

/**
 * Net revenue retention, shown as the arithmetic that produces it.
 *
 * NRR is not a number, it is a bridge: starting cohort MRR, plus expansion,
 * minus contraction, minus churn, equals ending MRR. Printing "112%" alone hides
 * whether the cohort grew because upgrades outran churn or because nothing moved
 * at all. So this is set as a ledger — leader rules tying each label to its
 * figure, a rule before the total, right-aligned monospaced amounts — and the
 * five lines sum in front of the reader.
 *
 * Movement rows carry a small semantic mark; the amounts stay in the text token
 * and let the sign do the work.
 */
export function NRRLedger({ result, currency, comparison }: NRRLedgerProps) {
  const {
    cohortCustomers,
    startingMRRCents,
    endingMRRCents,
    expansionMRRCents,
    contractionMRRCents,
    churnedMRRCents,
    nrr,
  } = result;

  const caption =
    nrr === null
      ? "The cohort held no revenue at the start of this period, so retention has no defined value yet."
      : nrr >= 1
        ? "The opening cohort is worth more than it was, before counting a single new customer."
        : "The opening cohort is worth less than it was. Expansion did not cover what left.";

  return (
    <Card className="h-full">
      <CardHeader>
        <h2 className="font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          Net revenue retention
        </h2>
      </CardHeader>

      <CardContent>
        <p className="font-mono text-3xl tracking-[-0.02em] text-foreground tabular-nums">
          {nrr === null ? EM_DASH : formatPercent(nrr, 1)}
        </p>
        {/* The brass rule marks the figure the panel exists to deliver. */}
        <span aria-hidden className="mt-2.5 block h-px w-10 bg-brand" />
        <p className="mt-2.5 text-xs text-muted-foreground text-balance">{caption}</p>
      </CardContent>

      {cohortCustomers === 0 ? (
        <CardContent>
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground text-balance">
            No customer was paying when this period opened. Retention starts
            being measurable once a cohort exists to follow.
          </p>
        </CardContent>
      ) : (
        <CardContent className="flex flex-col">
          <LedgerRow label="Starting MRR" amount={formatMoney(startingMRRCents, currency)} />
          <LedgerRow
            label="Expansion"
            amount={formatMoneyMovement(expansionMRRCents, currency, "add")}
            tone="positive"
          />
          <LedgerRow
            label="Contraction"
            amount={formatMoneyMovement(contractionMRRCents, currency, "subtract")}
            tone="negative"
          />
          <LedgerRow
            label="Churned"
            amount={formatMoneyMovement(churnedMRRCents, currency, "subtract")}
            tone="negative"
          />
          <LedgerRow
            label="Ending MRR"
            amount={formatMoney(endingMRRCents, currency)}
            total
          />
        </CardContent>
      )}

      {/* mt-auto pins the cohort line to the bottom when this rail is stretched
          to match the taller headline panel beside it. */}
      <CardFooter className="mt-auto text-xs text-muted-foreground">
        {cohortCustomers === 0
          ? `Measured over the last ${comparison.replace("previous ", "")}`
          : `${formatCount(cohortCustomers)} paying ${cohortCustomers === 1 ? "customer" : "customers"} in the opening cohort`}
      </CardFooter>
    </Card>
  );
}

interface LedgerRowProps {
  label: string;
  amount: string;
  tone?: "positive" | "negative";
  total?: boolean;
}

function LedgerRow({ label, amount, tone, total = false }: LedgerRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-[0.5rem_auto_1fr_auto] items-center gap-x-2 py-1.5 text-[0.8125rem]",
        total && "mt-1 border-t border-border pt-2.5",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-[1px]",
          tone === "positive" && "bg-positive",
          tone === "negative" && "bg-negative",
        )}
      />
      <span className={cn("text-muted-foreground", total && "text-foreground")}>
        {label}
      </span>
      {/* Leader rule — the ledger device that ties a label to a figure across a gap. */}
      <span aria-hidden className="h-px bg-border" />
      <span
        className={cn(
          "text-right font-mono tabular-nums",
          total ? "font-medium text-foreground" : "text-foreground",
        )}
      >
        {amount}
      </span>
    </div>
  );
}
