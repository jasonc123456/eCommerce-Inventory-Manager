import { describe, expect, it } from 'vitest';

import { cutoffFor, policyOf, DEFAULT_POLICY, DEFAULT_RAW_EVENT_DAYS } from './sweep';

/**
 * How long each class is kept (sections 13, 22, 37).
 *
 * The asymmetry between the two policies is the whole point, and it is the part
 * a test has to hold in place: history may be kept forever, and a raw body
 * holding buyer data may not.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe('policyOf', () => {
  it('uses section 22 and section 37 defaults when nobody has chosen', () => {
    expect(policyOf(null)).toEqual({ historyDays: 180, rawEventDays: 30 });
  });

  it('uses what a business chose when it has', () => {
    expect(
      policyOf({
        businessId: 'b',
        historyDays: 30,
        rawEventDays: 7,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toEqual({ historyDays: 30, rawEventDays: 7 });
  });
});

describe('cutoffFor', () => {
  it('measures history against the history window', () => {
    expect(cutoffFor('notification_deliveries', DEFAULT_POLICY, NOW)?.toISOString()).toBe(
      daysBefore(180),
    );
    expect(cutoffFor('resolved_alerts', DEFAULT_POLICY, NOW)?.toISOString()).toBe(daysBefore(180));
    expect(cutoffFor('ai_suggestions', DEFAULT_POLICY, NOW)?.toISOString()).toBe(daysBefore(180));
  });

  it('measures raw bodies against the shorter window', () => {
    expect(cutoffFor('webhook_deliveries', DEFAULT_POLICY, NOW)?.toISOString()).toBe(
      daysBefore(30),
    );
    expect(cutoffFor('processed_events', DEFAULT_POLICY, NOW)?.toISOString()).toBe(daysBefore(30));
  });

  it('lets an installation keep its own history forever', () => {
    // Null rather than a very old date, so "keep everything" is an answer the
    // caller has to handle rather than a cutoff that matches nothing today.
    const forever = { historyDays: 0, rawEventDays: 30 };

    expect(cutoffFor('notification_deliveries', forever, NOW)).toBeNull();
  });

  it('will not keep a buyer’s data forever, whatever the setting says', () => {
    // Section 13 obliges this application to be able to erase buyer data on a
    // marketplace's instruction, and an erasure that cannot reach every copy is
    // not an erasure. The schema refuses zero here; this refuses to read it.
    const forever = { historyDays: 0, rawEventDays: 0 };

    expect(cutoffFor('webhook_deliveries', forever, NOW)?.toISOString()).toBe(
      daysBefore(DEFAULT_RAW_EVENT_DAYS),
    );
    expect(cutoffFor('processed_events', forever, NOW)?.toISOString()).toBe(
      daysBefore(DEFAULT_RAW_EVENT_DAYS),
    );
  });

  it('honours a business that wants to keep less than the default', () => {
    const brief = { historyDays: 14, rawEventDays: 3 };

    expect(cutoffFor('ai_suggestions', brief, NOW)?.toISOString()).toBe(daysBefore(14));
    expect(cutoffFor('webhook_deliveries', brief, NOW)?.toISOString()).toBe(daysBefore(3));
  });
});
