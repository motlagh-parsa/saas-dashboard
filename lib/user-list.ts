/**
 * URL state for the users table: `?q=`, `?sort=`, `?dir=`.
 *
 * Everything here narrows an UNTRUSTED query param to a value the page can hand
 * to Prisma — the same contract as `lib/invoice-filter.ts`. Sort keys come from a
 * fixed whitelist, the direction from two literals, and the search text is only
 * ever used as a `contains` value, never as SQL.
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

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
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

/**
 * The href a column header links to: the same column flips direction, a new
 * column starts at its natural direction. The search text rides along.
 */
export function userSortHref(
  basePath: string,
  query: string,
  current: { readonly sort: UserSortKey; readonly dir: SortDirection },
  target: UserSortOption,
): string {
  const dir: SortDirection =
    current.sort === target.key
      ? current.dir === "asc"
        ? "desc"
        : "asc"
      : target.initialDirection;

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("sort", target.key);
  params.set("dir", dir);
  return `${basePath}?${params.toString()}`;
}
