"use client";

import { ChevronsUpDown, Moon, Settings, User } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { toggleTheme } from "@/components/dashboard/theme-toggle";

// PLACEHOLDER identity. Real session data (name / email / image / initials) is a
// follow-up for nextjs-architect — the layout must stay presentational.
const user = {
  name: "Alex Rivera",
  email: "alex@northwind.co",
  initials: "AR",
};

export function UserMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open account menu"
        className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:min-w-0 md:justify-start md:pr-2"
      >
        <Avatar size="sm">
          <AvatarFallback className="bg-brand/15 font-mono text-[0.6875rem] font-medium text-brand">
            {user.initials}
          </AvatarFallback>
        </Avatar>
        <span className="hidden min-w-0 flex-col leading-tight md:flex">
          <span className="truncate text-xs font-medium">{user.name}</span>
          <span className="truncate text-[0.6875rem] text-muted-foreground">
            {user.email}
          </span>
        </span>
        <ChevronsUpDown className="hidden size-3.5 shrink-0 text-muted-foreground md:block" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <div className="flex items-center gap-2.5 px-1.5 py-1.5">
          <Avatar size="sm">
            <AvatarFallback className="bg-brand/15 font-mono text-[0.6875rem] font-medium text-brand">
              {user.initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {user.email}
            </span>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem>
          <User />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Settings />
          Settings
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

        <div className="p-1">
          <SignOutButton
            variant="ghost"
            className="w-full justify-start px-1.5 font-normal text-muted-foreground hover:text-foreground"
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}