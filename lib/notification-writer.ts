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
import { revalidatePath } from "next/cache";
import type { NotificationType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export async function createNotification(data: {
  organizationId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Set for a PERSONAL notification; omit for an ORG-WIDE one (see the schema). */
  userId?: string;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      organizationId: data.organizationId,
      type: data.type,
      title: data.title,
      body: data.body,
      userId: data.userId ?? null,
    },
  });

  // Layout scope: the new row changes the bell's count in the dashboard header,
  // not just the notifications page.
  revalidatePath("/dashboard", "layout");
}
