"use client";

// Workspace switcher in the app header.
//
// Lists every workspace the user belongs to, with the active one checked.
// Choosing another POSTs its id to /api/workspace/switch, which verifies the
// membership and stores the choice in the `meridian_org` cookie; `router.refresh()`
// then re-runs the layout and the current page, which resolve the new workspace
// through lib/active-org.ts. "Create workspace" stays a disabled item.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronsUpDown, Loader2, Plus } from "lucide-react";

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
import { toast } from "@/components/dashboard/use-toast";

/** Shown when the layout had no workspace to resolve. */
const NO_WORKSPACE = "No workspace";

export interface OrgSwitcherProps {
  /** Every workspace the user belongs to, most privileged first. */
  orgs: { id: string; name: string }[];
  /** The workspace the layout resolved for this request. */
  activeOrgId: string;
  /** Layout-owned visibility/spacing for the trigger. */
  className?: string;
}

export function OrgSwitcher({ orgs, activeOrgId, className }: OrgSwitcherProps) {
  const router = useRouter();
  // The org being switched TO, while the request and the refresh are in flight.
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  const isSwitching = pendingOrgId !== null || isRefreshing;
  const name = orgs.find((org) => org.id === activeOrgId)?.name ?? NO_WORKSPACE;

  async function handleValueChange(orgId: string): Promise<void> {
    if (orgId === activeOrgId || isSwitching) return;
    setPendingOrgId(orgId);

    try {
      const res = await fetch("/api/workspace/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });

      // `requireSession()` redirects an expired session to /sign-in, and fetch
      // follows it — so a redirect here means "signed out", not a switch.
      if (res.redirected) {
        window.location.assign(res.url);
        return;
      }
      if (!res.ok) throw new Error(`Switch failed with status ${res.status}`);

      startRefresh(() => router.refresh());
    } catch (error: unknown) {
      console.error(error);
      toast.error("Couldn't switch workspace", {
        description: "Nothing changed. Try again in a moment.",
      });
    } finally {
      setPendingOrgId(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch workspace — currently ${name}`}
        aria-busy={isSwitching}
        className={cn(
          "h-9 items-center gap-2 rounded-md px-2 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent",
          className,
        )}
      >
        {isSwitching ? (
          <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <Building2 className="size-4 text-muted-foreground" />
        )}
        <span className="max-w-40 truncate">{name}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>

        {/*
          `menuitemradio` is what "this is the one you are in" actually means,
          and it carries the checkmark and the checked state for free. While a
          switch is in flight the target is shown checked and the rest are
          disabled, so a second pick cannot race the first.
        */}
        <DropdownMenuRadioGroup
          value={pendingOrgId ?? activeOrgId}
          onValueChange={(value) => void handleValueChange(value)}
        >
          {orgs.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id} disabled={isSwitching}>
              <Building2 className="text-muted-foreground" />
              <span className="truncate">{org.name}</span>
            </DropdownMenuRadioItem>
          ))}
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
