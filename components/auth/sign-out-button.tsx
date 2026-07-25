"use client";

// Client leaf for signing out. Calls NextAuth's client `signOut`, which clears the
// session cookie via /api/auth/signout and redirects to the sign-in page.
import * as React from "react";
import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";

import { Button } from "@/components/ui/button";

type SignOutButtonProps = React.ComponentProps<typeof Button> & {
  /** Hide the leading icon when the surrounding context already implies it. */
  showIcon?: boolean;
};

export function SignOutButton({
  variant = "outline",
  showIcon = true,
  children = "Sign out",
  ...props
}: SignOutButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      {...props}
      onClick={() => signOut({ callbackUrl: "/sign-in" })}
    >
      {showIcon ? <LogOut /> : null}
      {children}
    </Button>
  );
}