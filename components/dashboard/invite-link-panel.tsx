"use client";

// The invite link, shown once, with Copy link and Done. The inside of a
// DialogContent — shared by "Add user" (step two) and "Resend invite", which
// are the only two places a raw invite token ever reaches the browser.
//
// The raw token exists only in the action response that produced it (the
// database keeps a hash — lib/invite-token.ts), so this panel is the admin's
// one chance to copy it.
import { useId, useState } from "react";
import type { FocusEvent } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CopyState = "idle" | "copied" | "failed";

interface InviteLinkPanelProps {
  title: string;
  description: string;
  /** The raw invite token from the action result. */
  token: string;
}

export function InviteLinkPanel({ title, description, token }: InviteLinkPanelProps) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const inputId = useId();
  const hintId = useId();

  // Built on the client from the origin the admin is actually using, so the link
  // is right behind a proxy or on a preview deployment without any config. The
  // panel only ever renders after an action has answered, never during SSR.
  const link = `${window.location.origin}/invite/${token}`;

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopy("copied");
    } catch {
      // Clipboard access can be refused (permissions, insecure origin). The link
      // is still on screen and selectable, so say so rather than fail silently.
      setCopy("failed");
    }
  }

  function selectAll(event: FocusEvent<HTMLInputElement>): void {
    event.currentTarget.select();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor={inputId}>Invite link</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            readOnly
            value={link}
            onFocus={selectAll}
            aria-describedby={hintId}
            className="h-11 min-w-0 font-mono text-xs sm:h-8"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleCopy()}
            className="h-11 shrink-0 px-3 sm:h-8"
          >
            {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copy === "copied" ? "Copied" : "Copy link"}
          </Button>
        </div>
        <p
          id={hintId}
          aria-live="polite"
          className={copy === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {copy === "failed"
            ? "Couldn't copy automatically. Select the link and copy it yourself."
            : "Anyone with this link can set this account's password, so send it only to them. It won't be shown again."}
        </p>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button
            type="button"
            className="h-11 bg-brand text-brand-foreground hover:bg-brand/90 sm:h-8"
          >
            Done
          </Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
