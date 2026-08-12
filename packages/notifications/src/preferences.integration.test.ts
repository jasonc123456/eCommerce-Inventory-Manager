import { businesses, users, userNotificationPreferences } from '@eim/db';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadBusinessSettings,
  loadPreference,
  loadPreferences,
  loadQuietHours,
  savePreference,
  saveBusinessSettings,
} from './preferences';

/**
 * Storing what people asked for (sections 9, 22).
 *
 * The interesting cases are the two the database decides rather than the code:
 * a quiet window with only one end, and a kind that is both wanted and refused.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(timezone = 'UTC'): Promise<{ businessId: string; userId: string }> {
  const slug = `pref-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug, timezone })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  return { businessId: business!.id, userId: user!.id };
}

describe('business settings', () => {
  it('starts with no quiet hours, which is not the same as none configured', async () => {
    const { businessId } = await seed();

    expect(await loadBusinessSettings(harness.db, businessId)).toBeNull();
    expect(await loadQuietHours(harness.db, businessId)).toBeUndefined();
  });

  it('carries the shop timezone alongside the wall-clock times', async () => {
    // The halves are useless apart: a time without a zone is a time somewhere.
    const { businessId } = await seed('Pacific/Auckland');

    await saveBusinessSettings(harness.db, businessId, {
      quietHoursStart: '21:00',
      quietHoursEnd: '07:00',
    });

    expect(await loadQuietHours(harness.db, businessId)).toEqual({
      start: '21:00:00',
      end: '07:00:00',
      timeZone: 'Pacific/Auckland',
    });
  });

  it('updates in place rather than accumulating rows', async () => {
    const { businessId } = await seed();

    await saveBusinessSettings(harness.db, businessId, {
      quietHoursStart: '21:00',
      quietHoursEnd: '07:00',
    });
    await saveBusinessSettings(harness.db, businessId, { fallbackEmail: 'ops@example.invalid' });

    const settings = await loadBusinessSettings(harness.db, businessId);
    expect(settings?.fallbackEmail).toBe('ops@example.invalid');
    expect(settings?.quietHoursStart).toBe('21:00:00');
  });

  it('refuses a quiet period that never ends', async () => {
    const { businessId } = await seed();

    expect(
      await refuses(() =>
        saveBusinessSettings(harness.db, businessId, { quietHoursStart: '21:00' }),
      ),
    ).toMatch(/business_notification_settings_quiet_hours_complete/u);
  });

  it('refuses a window whose length nothing can tell', async () => {
    const { businessId } = await seed();

    expect(
      await refuses(() =>
        saveBusinessSettings(harness.db, businessId, {
          quietHoursStart: '21:00',
          quietHoursEnd: '21:00',
        }),
      ),
    ).toMatch(/business_notification_settings_quiet_hours_nonempty/u);
  });
});

describe('user preferences', () => {
  it('means the defaults when nobody has expressed one', async () => {
    const { businessId, userId } = await seed();

    expect(await loadPreference(harness.db, businessId, userId)).toBeNull();
    expect(await loadPreferences(harness.db, businessId)).toHaveLength(0);
  });

  it('keeps one row per person per business', async () => {
    const { businessId, userId } = await seed();

    await savePreference(harness.db, businessId, userId, { emailMinSeverity: 'warning' });
    await savePreference(harness.db, businessId, userId, {
      emailOptedInKinds: ['channel_stockout'],
    });

    const preference = await loadPreference(harness.db, businessId, userId);
    expect(preference?.emailMinSeverity).toBe('warning');
    expect(preference?.emailOptedInKinds).toEqual(['channel_stockout']);
    expect(await loadPreferences(harness.db, businessId)).toHaveLength(1);
  });

  it('keeps the same person separate in two shops', async () => {
    // "Email me about everything" for the shop somebody runs is a different
    // sentence from the same words about the shop they help out at.
    const mine = await seed();
    const theirs = await seed();

    await savePreference(harness.db, mine.businessId, mine.userId, { emailMinSeverity: 'info' });
    await savePreference(harness.db, theirs.businessId, mine.userId, {
      emailMinSeverity: 'critical',
    });

    expect((await loadPreference(harness.db, mine.businessId, mine.userId))?.emailMinSeverity).toBe(
      'info',
    );
    expect(
      (await loadPreference(harness.db, theirs.businessId, mine.userId))?.emailMinSeverity,
    ).toBe('critical');
  });

  it('refuses a kind that is both wanted and refused', async () => {
    const { businessId, userId } = await seed();

    expect(
      await refuses(() =>
        savePreference(harness.db, businessId, userId, {
          emailOptedInKinds: ['oversold'],
          emailMutedKinds: ['oversold'],
        }),
      ),
    ).toMatch(/user_notification_preferences_no_contradiction/u);
  });

  it('refuses a floor that is not one of the five answers', async () => {
    const { businessId, userId } = await seed();

    expect(
      await refuses(() =>
        harness.db.insert(userNotificationPreferences).values({
          businessId,
          userId,
          emailMinSeverity: 'urgent' as never,
        }),
      ),
    ).toMatch(/user_notification_preferences_floor_known/u);
  });
});
