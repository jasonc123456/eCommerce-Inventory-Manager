import {
  businessNotificationSettings,
  businesses,
  userNotificationPreferences,
  type BusinessNotificationSettings,
  type Database,
  type EmailSeverityFloor,
  type UserNotificationPreference,
} from '@eim/db';
import { and, eq } from 'drizzle-orm';

import type { QuietHours } from './quiet-hours';

/**
 * Reading and writing what people asked for (sections 9, 22).
 *
 * Thin on purpose. The decisions live in `routing.ts`, which has no database;
 * this is the part that fetches rows, and the only judgement it makes is that
 * an absent row means the defaults rather than an error. Section 22's defaults
 * are not silence — somebody who has never opened the settings screen still
 * hears about an oversell — so "no preference" has to be a usable answer.
 */

export interface NotificationSettingsInput {
  readonly quietHoursStart?: string | null;
  readonly quietHoursEnd?: string | null;
  readonly fallbackEmail?: string | null;
}

/** The shop's settings, or null when it has never configured any. */
export async function loadBusinessSettings(
  db: Database,
  businessId: string,
): Promise<BusinessNotificationSettings | null> {
  const rows = await db
    .select()
    .from(businessNotificationSettings)
    .where(eq(businessNotificationSettings.businessId, businessId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The quiet window, ready for the routing decision.
 *
 * Joins the shop's timezone in, because the two halves are useless apart: a
 * wall-clock time without a zone is a time in some unstated place, and every
 * bug that produces is a message sent in the middle of somebody's night.
 */
export async function loadQuietHours(
  db: Database,
  businessId: string,
): Promise<QuietHours | undefined> {
  const rows = await db
    .select({
      start: businessNotificationSettings.quietHoursStart,
      end: businessNotificationSettings.quietHoursEnd,
      timeZone: businesses.timezone,
    })
    .from(businesses)
    .leftJoin(
      businessNotificationSettings,
      eq(businessNotificationSettings.businessId, businesses.id),
    )
    .where(eq(businesses.id, businessId))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    return undefined;
  }

  // A business with no settings row joins to nulls, which is the same answer as
  // a business that has settings but no quiet hours: it has not asked for any.
  if (row.start === null || row.end === null) {
    return undefined;
  }

  return { start: row.start, end: row.end, timeZone: row.timeZone };
}

export async function saveBusinessSettings(
  db: Database,
  businessId: string,
  input: NotificationSettingsInput,
): Promise<void> {
  const values = {
    ...(input.quietHoursStart === undefined ? {} : { quietHoursStart: input.quietHoursStart }),
    ...(input.quietHoursEnd === undefined ? {} : { quietHoursEnd: input.quietHoursEnd }),
    ...(input.fallbackEmail === undefined ? {} : { fallbackEmail: input.fallbackEmail }),
  };

  await db
    .insert(businessNotificationSettings)
    .values({ businessId, ...values })
    .onConflictDoUpdate({
      target: businessNotificationSettings.businessId,
      set: { ...values, updatedAt: new Date() },
    });
}

/** One person's preferences in one business, or null when they have none. */
export async function loadPreference(
  db: Database,
  businessId: string,
  userId: string,
): Promise<UserNotificationPreference | null> {
  const rows = await db
    .select()
    .from(userNotificationPreferences)
    .where(
      and(
        eq(userNotificationPreferences.businessId, businessId),
        eq(userNotificationPreferences.userId, userId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** Everybody's preferences in one business, keyed by user. */
export async function loadPreferences(
  db: Database,
  businessId: string,
): Promise<Map<string, UserNotificationPreference>> {
  const rows = await db
    .select()
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.businessId, businessId));

  return new Map(rows.map((row) => [row.userId, row]));
}

export interface PreferenceInput {
  readonly emailMinSeverity?: EmailSeverityFloor;
  readonly emailOptedInKinds?: readonly string[];
  readonly emailMutedKinds?: readonly string[];
}

/**
 * Saves one person's preferences.
 *
 * Contradictory arrays are refused by the database rather than reconciled here.
 * A screen that submitted a kind as both wanted and muted has a bug, and
 * silently picking a winner would make that bug invisible while making the
 * stored preference depend on which array the code happened to read first.
 */
export async function savePreference(
  db: Database,
  businessId: string,
  userId: string,
  input: PreferenceInput,
): Promise<void> {
  const values = {
    ...(input.emailMinSeverity === undefined ? {} : { emailMinSeverity: input.emailMinSeverity }),
    ...(input.emailOptedInKinds === undefined
      ? {}
      : { emailOptedInKinds: [...input.emailOptedInKinds] }),
    ...(input.emailMutedKinds === undefined ? {} : { emailMutedKinds: [...input.emailMutedKinds] }),
  };

  await db
    .insert(userNotificationPreferences)
    .values({ businessId, userId, ...values })
    .onConflictDoUpdate({
      target: [userNotificationPreferences.businessId, userNotificationPreferences.userId],
      set: { ...values, updatedAt: new Date() },
    });
}
