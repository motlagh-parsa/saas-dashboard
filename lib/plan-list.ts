/**
 * URL state for the plans table: the shared `?q ?sort ?dir ?page ?per_page`
 * (lib/list-state.ts) plus `?status=` — All / Active / Archived.
 */
import {
  DEFAULT_PER_PAGE,
  parseChoice,
  type ListConfig,
  type ListExtras,
  type SortOption,
} from "@/lib/list-state";

export type PlanSortKey = "name" | "price" | "subscriptions" | "mrr";

export const PLAN_SORTS: readonly SortOption<PlanSortKey>[] = [
  { key: "name", label: "Name", initialDirection: "asc" },
  // Sorted per month, so "$490 / year" sits between "$29 / month" and "$79 / month".
  { key: "price", label: "Price", initialDirection: "desc" },
  { key: "subscriptions", label: "Active subscriptions", initialDirection: "desc" },
  { key: "mrr", label: "MRR", initialDirection: "desc" },
];

export const PLANS_PATH = "/dashboard/plans";

export const PLAN_LIST: ListConfig<PlanSortKey> = {
  path: PLANS_PATH,
  sorts: PLAN_SORTS,
  defaultSort: "mrr",
  defaultDir: "desc",
  defaultPerPage: DEFAULT_PER_PAGE,
};

export type PlanFilter = "all" | "active" | "archived";

export const PLAN_FILTERS: readonly { readonly key: PlanFilter; readonly label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
];

export function parsePlanFilter(raw: string | string[] | undefined): PlanFilter {
  return parseChoice(
    raw,
    PLAN_FILTERS.map((filter) => filter.key),
    "all",
  );
}

export function planExtras(filter: PlanFilter): ListExtras {
  return { status: filter === "all" ? undefined : filter };
}
