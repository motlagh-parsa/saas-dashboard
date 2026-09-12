"use client";

// Account menu. Identity is handed down from the server shell (which already
// resolved the NextAuth session) — this leaf is a client component only because
// it opens a menu, toggles the theme, and calls `signOut`.
import Link from "next/link";
import { signOut } from "next-auth/react";
import { ChevronsUpDown, LogOut, Moon, Settings } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toggleTheme } from "@/components/dashboard/theme-toggle";

export interface UserMenuProps {
  /** `session.user.name` — null for accounts that never set one. */
  name: string | null;
  /** `session.user.email` — null when the provider withheld it. */
  email: string | null;
  /** `session.user.image` — OAuth avatar, absent for the credentials demo user. */
  image?: string | null;
}

/** Up to two initials, falling back to the email local-part, then a neutral mark. */
function initialsFor(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim().split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return initials ? initials.toUpperCase() : "—";
}

export function UserMenu({ name, email, image }: UserMenuProps) {
  const displayName = name?.trim() || email?.trim() || "Account";
  const displayEmail = email?.trim() ?? "";
  const initials = initialsFor(name, email);

  const identity = (
    <Avatar size="sm">
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback className="bg-brand/15 font-mono text-[0.6875rem] font-medium text-brand">
        {initials}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Open account menu for ${displayName}`}
        className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-w-0 md:justify-start md:pr-2"
      >
        {identity}
        <span className="hidden min-w-0 flex-col leading-tight md:flex">
          <span className="truncate text-xs font-medium">{displayName}</span>
          {displayEmail ? (
            <span className="truncate text-[0.6875rem] text-muted-foreground">
              {displayEmail}
            </span>
          ) : null}
        </span>
        <ChevronsUpDown className="hidden size-3.5 shrink-0 text-muted-foreground md:block" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        {/*
          Identity is a label, not an item: there is nothing to activate here, so
          it must not sit in the menu's focus order. `DropdownMenuLabel` gives it
          the right role and keeps the arrow keys landing on real actions.
        */}
        <DropdownMenuLabel className="flex items-center gap-2.5 py-1.5 font-normal">
          {identity}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            {displayEmail ? (
              <span className="truncate text-xs text-muted-foreground">{displayEmail}</span>
            ) : null}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/dashboard/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          // Keep the menu open so the theme change is visible before dismissing.
          onSelect={(event) => {
            event.preventDefault();
            toggleTheme();
          }}
        >
          <Moon />
          Toggle theme
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: "/" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
