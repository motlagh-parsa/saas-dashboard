import "server-only";

// Who the demo cast is — split out of lib/demo.ts so the mailer can check an
// address without importing the demo's reset machinery (and its imports).
import type { Role } from "@prisma/client";

import { env } from "@/lib/env";

interface TeammateSpec {
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly suspendedAt: Date | null;
}

/** Members of Northwind, so /dashboard/users has people to manage. No passwords. */
export const DEMO_TEAMMATES: readonly TeammateSpec[] = [
  { name: "Alice Chen", email: "alice@acme-demo.dev", role: "ADMIN", suspendedAt: null },
  { name: "Bob Martinez", email: "bob@acme-demo.dev", role: "MEMBER", suspendedAt: null },
  { name: "Carol Singh", email: "carol@acme-demo.dev", role: "MEMBER", suspendedAt: new Date("2026-06-01T00:00:00.000Z") },
  { name: "Dan Lee", email: "dan@acme-demo.dev", role: "MEMBER", suspendedAt: null },
];

/** Addresses that never receive email: the demo account and its teammates. */
export function isDemoAddress(email: string): boolean {
  const address = email.trim().toLowerCase();
  return address === env.DEMO_EMAIL.toLowerCase() || DEMO_TEAMMATES.some((teammate) => teammate.email === address);
}

