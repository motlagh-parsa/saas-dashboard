// Profile. Render mode: dynamic — it reads the session cookie, so it is never
// statically rendered.
//
// The caller's OWN account, so it is not scoped to a workspace: no org
// resolution, and it works for someone who belongs to none. `requireSession()` is
// the authorization gate, and the one row it reads is the session's own user.
//
// Writes are lib/profile-actions.ts, driven by two client islands that sit
// inside the cards the same way `WorkspaceDetailsForm` does on Settings.
import type { Metadata } from "next";

import { getActiveOrgId } from "@/lib/active-org";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatInitials, formatPersonName } from "@/lib/format";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PasswordForm } from "@/components/dashboard/password-form";
import { ProfileDetailsForm } from "@/components/dashboard/profile-details-form";
import { SettingsTabs } from "@/components/dashboard/settings-tabs";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your name and password.",
};

/** Eyebrow used on every panel — small mono caps, the label voice of the product. */
const EYEBROW =
  "font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase";

export default async function ProfilePage() {
  const session = await requireSession();

  // `requireSession` has just confirmed this row exists and is not suspended.
  const [user, organizationId] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { name: true, email: true, passwordHash: true },
    }),
    getActiveOrgId(session.user.id),
  ]);
  // Only for the settings tabs: the API keys tab is shown to owners and admins
  // of the active workspace.
  const membership =
    organizationId === null
      ? null
      : await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: session.user.id, organizationId } },
          select: { role: true },
        });
  // Only whether a hash exists crosses into the render — never the hash itself.
  const hasPassword = user.passwordHash !== null;
  const displayName = formatPersonName(user.name, user.email);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            {displayName}
            <span aria-hidden className="px-1.5 text-muted-foreground/40">
              ·
            </span>
            your account, in every workspace
          </p>
        </div>
        <SettingsTabs current="profile" showApiKeys={membership !== null && membership.role !== "MEMBER"} />
      </header>

      <section className="rise mt-3 [animation-delay:60ms]">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              <h2 className={EYEBROW}>Profile</h2>
            </div>
          </CardHeader>

          <CardContent className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid size-11 shrink-0 place-items-center rounded-full bg-muted font-mono text-sm font-medium text-muted-foreground"
            >
              {formatInitials(displayName)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-heading text-base leading-snug font-medium">
                {displayName}
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {user.email}
              </p>
            </div>
          </CardContent>

          <ProfileDetailsForm name={user.name} email={user.email} />
        </Card>
      </section>

      <section className="rise [animation-delay:120ms]">
        <Card>
          <CardHeader>
            <h2 className={EYEBROW}>Password</h2>
          </CardHeader>

          {hasPassword ? (
            <PasswordForm />
          ) : (
            <CardContent>
              <p className="text-[0.8125rem] text-muted-foreground">
                Password login is not available for this account.
              </p>
            </CardContent>
          )}
        </Card>
      </section>
    </main>
  );
}
