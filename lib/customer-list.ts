/**
 * URL state for the customers table: the shared `?q ?sort ?dir ?page ?per_page`
 * (lib/list-state.ts) plus `?status=` — All / Active / Churned / Archived.
 *
 * Plain data and pure functions, so the server page and the client table build
 * the same links.
 */
import {
  DEFAULT_PER_PAGE,
  parseChoice,
  type ListConfig,
  type ListExtras,
  type SortOption,
} from "@/lib/list-state";

export type CustomerSortKey = "name" | "mrr" | "since";

export const CUSTOMER_SORTS: readonly SortOption<CustomerSortKey>[] = [
  { key: "name", label: "Customer", initialDirection: "asc" },
  { key: "mrr", label: "Current MRR", initialDirection: "desc" },
  { key: "since", label: "Customer since", initialDirection: "desc" },
];

export const CUSTOMERS_PATH = "/dashboard/customers";

export const CUSTOMER_LIST: ListConfig<CustomerSortKey> = {
  path: CUSTOMERS_PATH,
  sorts: CUSTOMER_SORTS,
  defaultSort: "mrr",
  defaultDir: "desc",
  defaultPerPage: DEFAULT_PER_PAGE,
};

/** "All" leaves archived customers out — archiving exists to get them out of the way. */
export type CustomerFilter = "all" | "active" | "churned" | "archived";

export const CUSTOMER_FILTERS: readonly { readonly key: CustomerFilter; readonly label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "churned", label: "Churned" },
  { key: "archived", label: "Archived" },
];

export function parseCustomerFilter(raw: string | string[] | undefined): CustomerFilter {
  return parseChoice(
    raw,
    CUSTOMER_FILTERS.map((filter) => filter.key),
    "all",
  );
}

export function customerExtras(filter: CustomerFilter): ListExtras {
  return { status: filter === "all" ? undefined : filter };
}

/** Where a customer stands now. `none`: no subscription has billed anything yet. */
export type CustomerStatus = "active" | "past_due" | "churned" | "none";

export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  active: "Active",
  past_due: "Past due",
  churned: "Churned",
  none: "No subscription",
};

/** The customer detail page. */
export function customerHref(customerId: string): string {
  return `${CUSTOMERS_PATH}/${encodeURIComponent(customerId)}`;
}
