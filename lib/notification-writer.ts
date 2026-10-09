import "server-only";

// The ONLY way server code creates a notification.
//
// Deliberately NOT in `lib/notifications.ts`: that module is `"use server"`, so
// every export there is a public endpoint any signed-in member can call from the
// browser — a create there would let anyone post arbitrary rows into their
// workspace's feed. This module is `server-only` with no `"use server"`: it can be
// imported by route handlers, Server Actions and Server Components, never called
// over the wire. Callers are trusted server code and pass an organization id they
// have already resolved and authorized.
//
// After the row is written, the notification is also emailed to whoever wants
// this type by email (lib/notification-preferences.ts). Email failures are
// logged and never fail the caller.
import { revalidatePath } from "next/cache";
import type { NotificationType } from "@prisma/client";

import { appUrl, isMailEnabled } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import { notificationTemplate } from "@/lib/mail-templates";
import { emailRecipients } from "@/lib/notification-preferences";
import { prisma } from "@/lib/prisma";

export interface NewNotification {
  organizationId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Set for a PERSONAL notification; omit for an ORG-WIDE one (see the schema). */
  userId?: string;
}

export interface CreateOptions {
  /**
   * False keeps it in the app only — for alerts about sample data, which must
   * never reach anyone's inbox. Default true.
   */
  readonly email?: boolean;
}

async function emailNotification(data: NewNotification): Promise<void> {
  if (!isMailEnabled) return;
  try {
    const [recipients, organization] = await Promise.all([
      emailRecipients(data.organizationId, data.type, data.userId),
      prisma.organization.findUnique({ where: { id: data.organizationId }, select: { name: true } }),
    ]);
    if (organization === null) return;
    const base = appUrl();
    for (const recipient of recipients) {
      await sendMail({
        to: recipient.email,
        ...notificationTemplate({
          workspaceName: organization.name,
          title: data.title,
          body: data.body,
          url: `${base}/dashboard/notifications`,
          manageUrl: `${base}/dashboard/settings/profile#notifications`,
        }),
      });
    }
  } catch (error: unknown) {
    console.error("[notifications] email fan-out failed", { type: data.type, error });
  }
}

export async function createNotification(data: NewNotification, options: CreateOptions = {}): Promise<void> {
  await prisma.notification.create({
    data: {
      organizationId: data.organizationId,
      type: data.type,
      title: data.title,
      body: data.body,
      userId: data.userId ?? null,
    },
  });

  if (options.email !== false) await emailNotification(data);

  // Layout scope: the new row changes the bell's count in the dashboard header,
  // not just the notifications page. Outside a request (a script) there is no
  // cache to revalidate, and Next throws — nothing to do then.
  try {
    revalidatePath("/dashboard", "layout");
  } catch {
    // Not in a request.
  }
}
