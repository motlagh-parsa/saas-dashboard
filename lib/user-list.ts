/**
 * URL state for the users table: `?q=`, `?sort=`, `?dir=`, `?page=`, `?per_page=`.
 *
 * The narrowing itself is the shared table contract in lib/list-state.ts; this
 * module is the Users table's configuration of it — its sort whitelist and
 * defaults — plus the names the users page, table and export already use.
 */
import {
  DEFAULT_PER_PAGE,
  LIST_QUERY_MAX,
  listHref,
  parseDirection,
  parseListQuery,
  parseSort,
  sortHref,
  type ListConfig,
  type ListState,
  type SortDirection,
  type SortOption,
} from "@/lib/list-state";

export { MAX_PER_PAGE, pageWindow, parsePage, parsePerPage, totalPages } from "@/lib/list-state";
export type { SortDirection } from "@/lib/list-state";

export type UserSortKey = "name" | "email" | "joined" | "role";

export type UserSortOption = SortOption<UserSortKey>;

export const USER_SORTS: readonly UserSortOption[] = [
  { key: "name", label: "Name", initialDirection: "asc" },
  { key: "email", label: "Email", initialDirection: "asc" },
  { key: "role", label: "Role", initialDirection: "asc" },
  { key: "joined", label: "Joined", initialDirection: "desc" },
];

export const DEFAULT_USER_SORT: UserSortKey = "joined";
export const DEFAULT_SORT_DIRECTION: SortDirection = "desc";

export const USER_QUERY_MAX = LIST_QUERY_MAX;

export const USERS_PATH = "/dashboard/users";

export const USER_LIST: ListConfig<UserSortKey> = {
  path: USERS_PATH,
  sorts: USER_SORTS,
  defaultSort: DEFAULT_USER_SORT,
  defaultDir: DEFAULT_SORT_DIRECTION,
  defaultPerPage: DEFAULT_PER_PAGE,
};

export type UserListState = ListState<UserSortKey>;

/** Trimmed search text, capped, or "" for none. */
export function parseUserQuery(raw: string | string[] | undefined): string {
  return parseListQuery(raw);
}

export function parseUserSort(raw: string | string[] | undefined): UserSortKey {
  return parseSort(USER_LIST, raw);
}

export function parseSortDirection(raw: string | string[] | undefined): SortDirection {
  return parseDirection(raw, DEFAULT_SORT_DIRECTION);
}

/** The canonical URL for a table state. Defaults are omitted, so page one of the default view is the bare path. */
export function usersHref(state: UserListState): string {
  return listHref(USER_LIST, state);
}

/** The href a column header links to — see `sortHref` in lib/list-state.ts. */
export function userSortHref(current: UserListState, target: UserSortOption): string {
  return sortHref(USER_LIST, current, target);
}
