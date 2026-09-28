import "server-only";

// The users table's query, shared by the page (one page of rows + the count) and
// `exportUsersCSV` (every matching row). One definition, so the export is always
// exactly what the table would show across all its pages, in the same order.
//
// It queries MEMBERSHIPS, not users: the table is "people in this workspace",
// and a membership row carries both the scope (`organizationId`) and the
// workspace-specific columns (role, joined).
import type { Prisma } from "@prisma/client";

import type { SortDirection, UserSortKey } from "@/lib/user-list";

/**
 * Tenant scope first, always. Search narrows on the user's name OR email,
 * case-insensitively, in Postgres; with no search text the filter drops out
 * entirely rather than matching "".
 */
export function userListWhere(organizationId: string, query: string): Prisma.MembershipWhereInput {
  return {
    organizationId,
    user: query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined,
  };
}

/**
 * Sorts on the membership row, reaching into the user for the text columns.
 * Every order ends on email, which is unique, so equal keys never shuffle
 * between renders — which pagination depends on: without a total order, a row
 * could appear on two pages or on none.
 */
export function userListOrderBy(
  sort: UserSortKey,
  dir: SortDirection,
): Prisma.MembershipOrderByWithRelationInput[] {
  const tiebreak: Prisma.MembershipOrderByWithRelationInput = { user: { email: "asc" } };
  switch (sort) {
    case "name":
      return [{ user: { name: { sort: dir, nulls: "last" } } }, tiebreak];
    case "email":
      return [{ user: { email: dir } }];
    case "role":
      // Enum order is OWNER, ADMIN, MEMBER, so ascending reads most privileged first.
      return [{ role: dir }, tiebreak];
    case "joined":
      return [{ createdAt: dir }, tiebreak];
  }
}
