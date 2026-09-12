"use client";

// Workspace switcher in the app header.
//
// UI ONLY, and honest about it. There is exactly one workspace — the name is a
// placeholder handed down from the server shell, not a tenant read from the
// session — so the menu lists that one workspace as the checked option and
// offers "Create workspace" as a disabled item. Nothing here writes, and nothing
// pretends a second tenant exists until the multi-org data lands.
import { Building2, ChevronsUpDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface OrgSwitcherProps {
  /** Current workspace name. PLACEHOLDER — passed in by the shell, not derived. */
  name: string;
  /** Layout-owned visibility/spacing for the trigger. */
  className?: string;
}

export function OrgSwitcher({ name, className }: OrgSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch workspace — currently ${name}`}
        className={cn(
          "h-9 items-center gap-2 rounded-md px-2 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent",
          className,
        )}
      >
        <Building2 className="size-4 text-muted-foreground" />
        <span className="max-w-40 truncate">{name}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>

        {/*
          A radio group of one. `menuitemradio` is what "this is the one you are
          in" actually means, and it carries the checkmark and the checked state
          for free — an item with a decorative tick would say nothing to a
          screen reader. Uncontrolled: selecting the only workspace is a no-op.
        */}
        <DropdownMenuRadioGroup value={name}>
          <DropdownMenuRadioItem value={name}>
            <Building2 className="text-muted-foreground" />
            <span className="truncate">{name}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        {/*
          Disabled, not silently inert: Radix marks it `aria-disabled` and skips
          it in the roving focus order, so keyboard and pointer users get the
          same answer — this exists, it is not available yet.
        */}
        <DropdownMenuItem disabled>
          <Plus />
          Create workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
