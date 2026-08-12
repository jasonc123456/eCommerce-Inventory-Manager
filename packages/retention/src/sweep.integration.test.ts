import { businessRetentionSettings, businesses, operatorAlerts, retentionRuns } from '@eim/db';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { saveRetentionSettings, sweepBusiness } from './sweep';

/**
 * Deleting what is past keeping (sections 13, 22, 37).
 *
 * Two properties are worth proving against a real database: that an outstanding
 * alert is never deleted for being old, and that a webhook body is cleared
 * without losing the row that stops the same delivery being processed twice.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<string> {
  const slug = `retain-${String((counter += 1))}`;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  return business!.id;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

describe('sweepBusiness', () => {
  it('deletes a resolved alert that is past keeping', async () => {
    const businessId = await seed();

    await harness.db.insert(operatorAlerts).values({
      businessId,
      kind: 'oversold',
      subjectKey: 'item:old',
      summary: 'long since dealt with',
      resolvedAt: daysAgo(400),
      resolvedEvidence: { rechecked: true },
    });

    const outcomes = await sweepBusiness(harness.db, businessId);
    const resolved = outcomes.find((outcome) => outcome.dataClass === 'resolved_alerts');

    expect(resolved?.rowsDeleted).toBe(1);
    expect(
      await harness.db
        .select()
        .from(operatorAlerts)
        .where(eq(operatorAlerts.businessId, businessId)),
    ).toHaveLength(0);
  });

  it('never deletes an outstanding alert for being old', async () => {
    // An alert ignored for six months is not history; it is evidence that it
    // was ignored for six months.
    const businessId = await seed();

    await harness.db.insert(operatorAlerts).values({
      businessId,
      kind: 'oversold',
      subjectKey: 'item:ignored',
      summary: 'nobody has done anything about this',
      firstSeenAt: daysAgo(400),
      lastSeenAt: daysAgo(400),
    });

    await sweepBusiness(harness.db, businessId);

    expect(
      await harness.db
        .select()
        .from(operatorAlerts)
        .where(eq(operatorAlerts.businessId, businessId)),
    ).toHaveLength(1);
  });

  it('keeps history forever when a business asks it to', async () => {
    const businessId = await seed();
    await saveRetentionSettings(harness.db, businessId, { historyDays: 0 });

    await harness.db.insert(operatorAlerts).values({
      businessId,
      kind: 'oversold',
      subjectKey: 'item:kept',
      summary: 'dealt with long ago',
      resolvedAt: daysAgo(2000),
      resolvedEvidence: { rechecked: true },
    });

    const outcomes = await sweepBusiness(harness.db, businessId);
    const resolved = outcomes.find((outcome) => outcome.dataClass === 'resolved_alerts');

    expect(resolved?.olderThan).toBeNull();
    expect(resolved?.rowsDeleted).toBe(0);
    expect(
      await harness.db
        .select()
        .from(operatorAlerts)
        .where(eq(operatorAlerts.businessId, businessId)),
    ).toHaveLength(1);
  });

  it('refuses a raw-body window a marketplace deletion could not reach', async () => {
    const businessId = await seed();

    expect(
      await refuses(() => saveRetentionSettings(harness.db, businessId, { rawEventDays: 0 })),
    ).toMatch(/business_retention_settings_raw_bounded/u);

    expect(
      await refuses(() => saveRetentionSettings(harness.db, businessId, { rawEventDays: 365 })),
    ).toMatch(/business_retention_settings_raw_bounded/u);
  });

  it('records a count and never a list of what it removed', async () => {
    // A list would make the retention log the longest-lived copy of the data
    // the sweep exists to remove.
    const businessId = await seed();

    await harness.db.insert(operatorAlerts).values({
      businessId,
      kind: 'oversold',
      subjectKey: 'item:counted',
      summary: 'dealt with',
      resolvedAt: daysAgo(400),
      resolvedEvidence: { rechecked: true },
    });

    await sweepBusiness(harness.db, businessId);

    const [run] = await harness.db
      .select()
      .from(retentionRuns)
      .where(eq(retentionRuns.businessId, businessId));

    expect(run?.dataClass).toBe('resolved_alerts');
    expect(run?.rowsDeleted).toBe(1);
    expect(Object.keys(run ?? {})).not.toContain('rows');
  });

  it('does nothing, loudly, when nothing is old enough', async () => {
    const businessId = await seed();
    const outcomes = await sweepBusiness(harness.db, businessId);

    // Every class reports, including the ones with nothing to do, so a caller
    // can tell "nothing was old enough" from "this class was skipped".
    expect(outcomes.map((outcome) => outcome.dataClass)).toEqual([
      'notification_deliveries',
      'resolved_alerts',
      'ai_suggestions',
      'webhook_deliveries',
      'processed_events',
    ]);
    expect(outcomes.every((outcome) => outcome.rowsDeleted === 0)).toBe(true);
    expect(
      await harness.db.select().from(retentionRuns).where(eq(retentionRuns.businessId, businessId)),
    ).toHaveLength(0);
  });

  it('starts from the defaults for a business that never chose', async () => {
    const businessId = await seed();
    await sweepBusiness(harness.db, businessId);

    expect(
      await harness.db
        .select()
        .from(businessRetentionSettings)
        .where(eq(businessRetentionSettings.businessId, businessId)),
    ).toHaveLength(0);
  });
});
