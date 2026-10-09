import "server-only";

// Who hears about what. Only a person's overrides are stored
// (NotificationPreference); everything else is the default for their role in
// the workspace the notification belongs to (lib/notification-catalog.ts).
import type { NotificationType, Role } from "@prisma/client";

import { defaultChannels, type Channels } from "@/lib/notification-catalog";
import { prisma } from "@/lib/prisma";

export interface Recipient {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/** Notification types this person has turned off in the app (any workspace). */
export async function mutedInAppTypes(userId: string): Promise<NotificationType[]> {
  const rows = await prisma.notificationPreference.findMany({
    where: { userId, inApp: false },
    select: { type: true },
  });
  return rows.map((row) => row.type);
}

/** The effective channels for each type, for one person in one role. */
export async function effectiveChannels(
  userId: string,
  role: Role,
  types: readonly NotificationType[],
): Promise<Record<string, Channels>> {
  const overrides = await prisma.notificationPreference.findMany({
    where: { userId, type: { in: [...types] } },
    select: { type: true, inApp: true, email: true },
  });
  const byType = new Map(overrides.map((row) => [row.type, row]));
  return Object.fromEntries(
    types.map((type) => {
      const override = byType.get(type);
      return [type, override ? { inApp: override.inApp, email: override.email } : defaultChannels(type, role)];
    }),
  );
}

/**
 * Who should get `type` by email in `organizationId`: the one person a personal
 * notification is for, or every member, filtered by their choices (or their
 * role's default). Suspended accounts never get email.
 */
export async function emailRecipients(
  organizationId: string,
  type: NotificationType,
  userId?: string,
): Promise<Recipient[]> {
  const members = await prisma.membership.findMany({
    where: { organizationId, ...(userId ? { userId } : {}), user: { suspendedAt: null } },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          notificationPreferences: { where: { type }, select: { email: true } },
        },
      },
    },
  });
  return members
    .filter(({ role, user }) => user.notificationPreferences[0]?.email ?? defaultChannels(type, role).email)
    .map(({ user }) => ({ id: user.id, name: user.name, email: user.email }));
}
