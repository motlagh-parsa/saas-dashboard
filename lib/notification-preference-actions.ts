"use server";

// Saving the caller's own notification choices (Profile → Notifications). One
// row per type, both channels, for exactly the types in the catalogue; the
// form posts a checkbox per type and channel, and an unchecked box is absent.
import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth";
import { NOTIFICATION_KINDS } from "@/lib/notification-catalog";
import { prisma } from "@/lib/prisma";

export interface PreferencesState {
  readonly status: "idle" | "success" | "error";
  readonly message: string | null;
}

export async function saveNotificationPreferences(
  _previous: PreferencesState,
  formData: FormData,
): Promise<PreferencesState> {
  const session = await requireSession();
  const userId = session.user.id;
  await prisma.$transaction(
    NOTIFICATION_KINDS.map(({ type }) => {
      const inApp = formData.get(`${type}:inApp`) === "on";
      const email = formData.get(`${type}:email`) === "on";
      return prisma.notificationPreference.upsert({
        where: { userId_type: { userId, type } },
        create: { userId, type, inApp, email },
        update: { inApp, email },
      });
    }),
  );
  revalidatePath("/dashboard", "layout");
  return { status: "success", message: "Notification settings saved." };
}
