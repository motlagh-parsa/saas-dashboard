/**
 * URL state for every server-paged table: `?q=`, `?sort=`, `?dir=`, `?page=`,
 * `?per_page=`, plus whatever filters a table adds (`?status=`, `?range=`).
 *
 * Everything here narrows an UNTRUSTED query param to a value a page can hand to
 * a query: sort keys come from the table's own whitelist, the direction from two
 * literals, the page and page size from bounded integers, and the search text is
 * only ever used as a match value, never as SQL.
 *
 * A table is described by a `ListConfig` — plain data, so the server page and the
 * client table island can both hold it and build identical links. `listHref` is
 * the one place a table URL is built: defaults stay out of the address bar, so
 * page one of the default view is the bare path.
 */

export type SortDirection = "asc" | "desc";

export interface SortOption<K extends string> {
  readonly key: K;
  /** Column header text. */
  readonly label: string;
  /** Direction on first click: text A→Z, money and dates largest/newest first. */
  readonly initialDirection: SortDirection;
}

export interface ListConfig<K extends string> {
  readonly path: string;
  readonly sorts: readonly SortOption<K>[];
  readonly defaultSort: K;
  readonly defaultDir: SortDirection;
  readonly defaultPerPage: number;
}

export interface ListState<K extends string> {
  readonly query: string;
  readonly sort: K;
  readonly dir: SortDirection;
  readonly page: number;
  readonly perPage: number;
}

/** Extra params a table carries in every link — its filters. `undefined` or "" drops one. */
export type ListExtras = Readonly<Record<string, string | undefined>>;

export type RawParams = Readonly<Record<string, string | string[] | undefined>>;

/** Longer than any name, email or id worth typing; stops a pasted essay reaching the query. */
export const LIST_QUERY_MAX = 100;

export const DEFAULT_PER_PAGE = 20;
/** A page is one query's worth of rows; past this, paging is the right tool. */
export const MAX_PER_PAGE = 100;

export function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A whole number in [min, max], or `fallback` for anything else. */
function boundedInt(raw: string | string[] | undefined, min: number, max: number, fallback: number): number {
  const value = firstParam(raw);
  if (value === undefined || !/^\d{1,6}$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

/** Trimmed search text, capped, or "" for none. */
export function parseListQuery(raw: string | string[] | undefined): string {
  return (firstParam(raw) ?? "").trim().slice(0, LIST_QUERY_MAX);
}

export function parseSort<K extends string>(config: ListConfig<K>, raw: string | string[] | undefined): K {
  const value = firstParam(raw);
  const match = config.sorts.find((option) => option.key === value);
  return match ? match.key : config.defaultSort;
}

export function parseDirection(raw: string | string[] | undefined, fallback: SortDirection): SortDirection {
  const value = firstParam(raw);
  return value === "asc" || value === "desc" ? value : fallback;
}

/** 1-indexed. Anything malformed is page one; a page past the end is clamped by the page. */
export function parsePage(raw: string | string[] | undefined): number {
  return boundedInt(raw, 1, 1_000_000, 1);
}

export function parsePerPage(raw: string | string[] | undefined, fallback: number = DEFAULT_PER_PAGE): number {
  return boundedInt(raw, 1, MAX_PER_PAGE, fallback);
}

/** One of `values`, or `fallback` — for a filter param such as `?status=`. */
export function parseChoice<T extends string>(
  raw: string | string[] | undefined,
  values: readonly T[],
  fallback: T,
): T {
  const value = firstParam(raw);
  return values.find((candidate) => candidate === value) ?? fallback;
}

export function parseListState<K extends string>(config: ListConfig<K>, params: RawParams): ListState<K> {
  return {
    query: parseListQuery(params.q),
    sort: parseSort(config, params.sort),
    dir: parseDirection(params.dir, config.defaultDir),
    page: parsePage(params.page),
    perPage: parsePerPage(params.per_page, config.defaultPerPage),
  };
}

/** The canonical URL for a table state. Defaults are omitted. */
export function listHref<K extends string>(
  config: ListConfig<K>,
  state: ListState<K>,
  extras: ListExtras = {},
): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  for (const [key, value] of Object.entries(extras)) {
    if (value) params.set(key, value);
  }
  if (state.sort !== config.defaultSort || state.dir !== config.defaultDir) {
    params.set("sort", state.sort);
    params.set("dir", state.dir);
  }
  if (state.page > 1) params.set("page", String(state.page));
  if (state.perPage !== config.defaultPerPage) params.set("per_page", String(state.perPage));
  const search = params.toString();
  return search ? `${config.path}?${search}` : config.path;
}

/**
 * The href a column header links to: the same column flips direction, a new
 * column starts at its natural direction. A new order is a new result set, so it
 * goes back to page one; the search text, filters and page size ride along.
 */
export function sortHref<K extends string>(
  config: ListConfig<K>,
  current: ListState<K>,
  target: SortOption<K>,
  extras: ListExtras = {},
): string {
  const dir: SortDirection =
    current.sort === target.key
      ? current.dir === "asc"
        ? "desc"
        : "asc"
      : target.initialDirection;
  return listHref(config, { ...current, sort: target.key, dir, page: 1 }, extras);
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

/** The rows a page covers, for "Showing 21–40 of 312". */
export function pageSpan(page: number, perPage: number, matching: number): { from: number; to: number } {
  return {
    from: matching === 0 ? 0 : (page - 1) * perPage + 1,
    to: Math.min(page * perPage, matching),
  };
}
