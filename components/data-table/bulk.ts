"use client";

// Bulk actions reuse the per-row Server Actions one row at a time, in order.
// Each is its own transaction; fired in parallel against one workspace, the
// SERIALIZABLE ones (users) would abort each other as conflicting, and a
// sequence reports per-row failures by name.
import { formatCount } from "@/lib/format";
import { toast } from "@/components/dashboard/use-toast";
import { plural } from "@/components/data-table/row-selection";

interface ActionResult {
  readonly status: "idle" | "success" | "error";
  readonly message: string | null;
}

export interface BulkOutcome {
  readonly done: number;
  readonly failures: readonly string[];
}

export async function runSequentially<T>(
  targets: readonly T[],
  run: (target: T) => Promise<ActionResult>,
  nameOf: (target: T) => string,
): Promise<BulkOutcome> {
  let done = 0;
  const failures: string[] = [];
  for (const target of targets) {
    try {
      const result = await run(target);
      if (result.status === "success") done += 1;
      else failures.push(`${nameOf(target)}: ${result.message ?? "refused"}`);
    } catch {
      failures.push(`${nameOf(target)}: something went wrong`);
    }
  }
  return { done, failures };
}

/** "3 users suspended", or which ones failed and why. */
export function toastBulkOutcome(outcome: BulkOutcome, total: number, noun: string, verb: string): void {
  if (outcome.failures.length === 0) {
    toast.success(`${plural(outcome.done, noun)} ${verb}`);
  } else {
    toast.error(`${formatCount(outcome.failures.length)} of ${formatCount(total)} couldn't be ${verb}`, {
      description: outcome.failures.slice(0, 3).join(" · "),
    });
  }
}
