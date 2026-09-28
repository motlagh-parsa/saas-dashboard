/**
 * URL state for the users table: `?q=`, `?sort=`, `?dir=`, `?page=`, `?per_page=`.
 *
 * Everything here narrows an UNTRUSTED query param to a value the page can hand
 * to Prisma — the same contract as `lib/invoice-filter.ts`. Sort keys come from a
 * fixed whitelist, the direction from two literals, the page and page size from
 * bounded integers, and the search text is only ever used as a `contains` value,
 * never as SQL.
 *
 * `usersHref` is the one place a users-table URL is built, so every link keeps
 * the same shape and defaults stay out of the address bar.
 */

export type UserSortKey = "name" | "email" | "joined" | "role";
export type SortDirection = "asc" | "desc";

export interface UserSortOption {
  readonly key: UserSortKey;
  /** Column header text. */
  readonly label: string;
  /** Direction on first click. Text sorts A→Z; dates newest first; roles owners first. */
  readonly initialDirection: SortDirection;
}

export const USER_SORTS: readonly UserSortOption[] = [
  { key: "name", label: "Name", initialDirection: "asc" },
  { key: "email", label: "Email", initialDirection: "asc" },
  { key: "role", label: "Role", initialDirection: "asc" },
  { key: "joined", label: "Joined", initialDirection: "desc" },
];

export const DEFAULT_USER_SORT: UserSortKey = "joined";
export const DEFAULT_SORT_DIRECTION: SortDirection = "desc";

/** Longer than any name or email worth typing; stops a pasted essay reaching the query. */
export const USER_QUERY_MAX = 100;

export const DEFAULT_PER_PAGE = 20;
/** A page is one query's worth of rows; past this, paging is the right tool. */
export const MAX_PER_PAGE = 100;

export const USERS_PATH = "/dashboard/users";

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A whole number in [min, max], or `fallback` for anything else. */
function boundedInt(raw: string | string[] | undefined, min: number, max: number, fallback: number): number {
  const value = first(raw);
  if (value === undefined || !/^\d{1,6}$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

/** Trimmed search text, capped, or "" for none. */
export function parseUserQuery(raw: string | string[] | undefined): string {
  return (first(raw) ?? "").trim().slice(0, USER_QUERY_MAX);
}

export function parseUserSort(raw: string | string[] | undefined): UserSortKey {
  const value = first(raw);
  const match = USER_SORTS.find((option) => option.key === value);
  return match ? match.key : DEFAULT_USER_SORT;
}

export function parseSortDirection(raw: string | string[] | undefined): SortDirection {
  const value = first(raw);
  return value === "asc" || value === "desc" ? value : DEFAULT_SORT_DIRECTION;
}

/** 1-indexed. Anything malformed is page one; a page past the end is clamped by the page. */
export function parsePage(raw: string | string[] | undefined): number {
  return boundedInt(raw, 1, 1_000_000, 1);
}

export function parsePerPage(raw: string | string[] | undefined): number {
  return boundedInt(raw, 1, MAX_PER_PAGE, DEFAULT_PER_PAGE);
}

export interface UserListState {
  readonly query: string;
  readonly sort: UserSortKey;
  readonly dir: SortDirection;
  readonly page: number;
  readonly perPage: number;
}

/** The canonical URL for a table state. Defaults are omitted, so page one of the default view is the bare path. */
export function usersHref(state: UserListState): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.sort !== DEFAULT_USER_SORT || state.dir !== DEFAULT_SORT_DIRECTION) {
    params.set("sort", state.sort);
    params.set("dir", state.dir);
  }
  if (state.page > 1) params.set("page", String(state.page));
  if (state.perPage !== DEFAULT_PER_PAGE) params.set("per_page", String(state.perPage));
  const search = params.toString();
  return search ? `${USERS_PATH}?${search}` : USERS_PATH;
}

/**
 * The href a column header links to: the same column flips direction, a new
 * column starts at its natural direction. A new order is a new result set, so it
 * goes back to page one; the search text and page size ride along.
 */
export function userSortHref(current: UserListState, target: UserSortOption): string {
  const dir: SortDirection =
    current.sort === target.key
      ? current.dir === "asc"
        ? "desc"
        : "asc"
      : target.initialDirection;
  return usersHref({ ...current, sort: target.key, dir, page: 1 });
}

export function totalPages(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * The page buttons to draw: first, last, and current ±1, with `"gap"` where
 * pages are skipped. A gap that would hide exactly one page shows that page
 * instead — "1 … 3" is worse than "1 2 3".
 */
export function pageWindow(current: number, last: number): readonly (number | "gap")[] {
  const wanted = new Set<number>([1, last, current - 1, current, current + 1]);
  const pages = [...wanted].filter((page) => page >= 1 && page <= last).sort((a, b) => a - b);

  const out: (number | "gap")[] = [];
  for (const page of pages) {
    const previous = out.length > 0 ? out[out.length - 1] : null;
    if (typeof previous === "number" && page - previous === 2) out.push(previous + 1);
    else if (typeof previous === "number" && page - previous > 2) out.push("gap");
    out.push(page);
  }
  return out;
}
