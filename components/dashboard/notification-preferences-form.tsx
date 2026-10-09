"use client";

// Profile → Notifications: one row per kind of notification, with an "In app"
// and an "Email" switch. The email column is absent when the deployment sends
// no email. Values start from the person's saved choices or their defaults.
import { useActionState, useState } from "react";

import type { NotificationType } from "@prisma/client";

import { NOTIFICATION_KINDS, type Channels } from "@/lib/notification-catalog";
import { saveNotificationPreferences, type PreferencesState } from "@/lib/notification-preference-actions";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";

interface NotificationPreferencesFormProps {
  initial: Readonly<Record<string, Channels>>;
  emailEnabled: boolean;
}

const IDLE: PreferencesState = { status: "idle", message: null };

export function NotificationPreferencesForm({ initial, emailEnabled }: NotificationPreferencesFormProps) {
  const [values, setValues] = useState<Record<string, Channels>>({ ...initial });
  const [state, formAction, pending] = useActionState(saveNotificationPreferences, IDLE);

  function toggle(type: NotificationType, channel: keyof Channels): void {
    setValues((previous) => ({ ...previous, [type]: { ...previous[type], [channel]: !previous[type][channel] } }));
  }

  return (
    <form action={formAction} data-testid="notification-preferences">
      <CardContent className="px-0">
        <table className="w-full text-[0.8125rem]">
          <caption className="sr-only">Which notifications you get, in the app and by email</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="px-4 pb-2 font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                Notification
              </th>
              <th scope="col" className="w-20 px-2 pb-2 text-center font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                In app
              </th>
              {emailEnabled ? (
                <th scope="col" className="w-20 px-4 pb-2 text-center font-mono text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                  Email
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_KINDS.map((kind) => {
              const channels = values[kind.type];
              return (
                <tr key={kind.type} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <span className="block font-medium text-foreground">{kind.label}</span>
                    <span className="block text-xs text-muted-foreground">{kind.description}</span>
                  </th>
                  <td className="px-2 py-2.5 text-center">
                    <input
                      type="checkbox"
                      name={`${kind.type}:inApp`}
                      checked={channels.inApp}
                      onChange={() => toggle(kind.type, "inApp")}
                      aria-label={`${kind.label} in the app`}
                      className="size-4 accent-[var(--brand)]"
                    />
                  </td>
                  {emailEnabled ? (
                    <td className="px-4 py-2.5 text-center">
                      <input
                        type="checkbox"
                        name={`${kind.type}:email`}
                        checked={channels.email}
                        onChange={() => toggle(kind.type, "email")}
                        aria-label={`${kind.label} by email`}
                        className="size-4 accent-[var(--brand)]"
                      />
                    </td>
                  ) : (
                    // Keep the saved email choice when the column is hidden.
                    channels.email ? <td hidden><input type="hidden" name={`${kind.type}:email`} value="on" /></td> : null
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
      <CardFooter className="flex items-center justify-end gap-3 border-t border-border">
        {state.message ? (
          <span
            role="status"
            className={state.status === "error" ? "text-xs text-destructive" : "text-xs text-positive"}
          >
            {state.message}
          </span>
        ) : null}
        <Button type="submit" variant="outline" aria-disabled={pending ? "true" : undefined} className="h-11 px-4 sm:h-9">
          {pending ? "Saving…" : "Save"}
        </Button>
      </CardFooter>
    </form>
  );
}
