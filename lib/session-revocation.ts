// Whether a session survives the account's last session revocation. Pure, so
// the rule has one definition — used by lib/auth.ts and checked by
// scripts/verify-email.ts.
//
// `authAt` is when the session signed in (ms since epoch; 0 for a session from
// before the claim existed). A revocation at instant R cuts off every session
// that signed in at or before R.
export function survivesRevocation(authAt: number, sessionsRevokedAt: Date | null): boolean {
  return sessionsRevokedAt === null || authAt > sessionsRevokedAt.getTime();
}
