"use client";

// Client leaf for signing out. Calls NextAuth's client `signOut`, which clears the
// session cookie via /api/auth/signout and redirects to the sign-in page.
import { signOut } from "next-auth/react";

import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => signOut({ callbackUrl: "/sign-in" })}
    >
      Sign out
    </Button>
  );
}