import { describe, expect, it } from 'vitest';

import {
  alertPayload,
  alertSentence,
  signPayload,
  verifySignature,
  wireRequest,
  type AlertFacts,
} from './payloads';

/**
 * What leaves the building (sections 13, 22).
 *
 * The assertions worth making here are about absence. A chat service is the
 * least controlled place this application's data can end up, and buyer data
 * that has gone to one is data section 13's erasure obligations can no longer
 * reach.
 */

const facts: AlertFacts = {
  id: 'alert-1',
  event: 'alert.raised',
  kind: 'oversold',
  severity: 'critical',
  scope: 'business',
  summary: 'an order could not be filled in full: 2 units short',
  recommendedAction: 'Check the item for uncounted stock.',
  occurrences: 3,
  firstSeenAt: new Date('2026-08-05T12:00:00.000Z'),
  lastSeenAt: new Date('2026-08-05T14:00:00.000Z'),
  url: 'https://inventory.example/alerts',
};

describe('alertPayload', () => {
  it('carries exactly the fields it is built from', () => {
    // Spelled out rather than spread, so a column added to the alert table next
    // year does not silently start being posted into somebody's chat channel.
    expect(Object.keys(alertPayload(facts)).sort()).toEqual([
      'event',
      'firstSeenAt',
      'id',
      'kind',
      'lastSeenAt',
      'occurrences',
      'recommendedAction',
      'scope',
      'severity',
      'summary',
      'url',
    ]);
  });

  it('has no field an order, a buyer, or a price could live in', () => {
    const serialized = JSON.stringify(alertPayload(facts)).toLowerCase();

    for (const forbidden of [
      'buyer',
      'customer',
      'email',
      'address',
      'order',
      'price',
      'quantity',
      'sku',
      'detail',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}`);
    }
  });
});

describe('wireRequest', () => {
  const options = { deliveryId: 'delivery-1', sentAt: new Date('2026-08-05T14:00:00.000Z') };
  const payload = alertPayload(facts);

  it('gives Slack and Discord the envelope each of them insists on', () => {
    const slack = wireRequest('slack', payload, options);
    const discord = wireRequest('discord', payload, options);

    expect(JSON.parse(slack.body)).toEqual({ text: alertSentence(payload) });
    expect(JSON.parse(discord.body)).toEqual({ content: alertSentence(payload) });
  });

  it('does not sign a chat webhook, which authenticates by being secret', () => {
    // Anybody with the URL can already post; anybody without it cannot. A
    // signature there would be ceremony.
    expect(wireRequest('slack', payload, options).headers['x-eim-signature']).toBeUndefined();
    expect(wireRequest('discord', payload, options).headers['x-eim-signature']).toBeUndefined();
  });

  it('signs a generic webhook and gives it an idempotency identifier', () => {
    const request = wireRequest('webhook', payload, { ...options, signingKey: 'k'.repeat(32) });

    expect(JSON.parse(request.body)).toEqual(payload);
    expect(request.headers['x-eim-delivery']).toBe('delivery-1');
    expect(request.headers['x-eim-event']).toBe('alert.raised');
    expect(request.headers['x-eim-signature']).toMatch(/^sha256=[0-9a-f]{64}$/u);
  });

  it('sends an unsigned generic webhook rather than no webhook at all', () => {
    // A destination configured before signing keys existed still works; it just
    // has nothing for its receiver to check.
    const request = wireRequest('webhook', payload, options);

    expect(request.headers['x-eim-signature']).toBeUndefined();
    expect(request.headers['x-eim-timestamp']).toBe('1785938400');
  });
});

describe('signPayload', () => {
  const key = 'a-signing-key';

  it('changes when anything signed changes', () => {
    const base = signPayload(key, '1000', '{"a":1}');

    expect(signPayload(key, '1000', '{"a":1}')).toBe(base);
    expect(signPayload(key, '1001', '{"a":1}')).not.toBe(base);
    expect(signPayload(key, '1000', '{"a":2}')).not.toBe(base);
    expect(signPayload('other', '1000', '{"a":1}')).not.toBe(base);
  });

  it('covers the timestamp, so a captured request cannot be replayed next week', () => {
    // The timestamp is inside the signed string rather than only in a header.
    const body = '{"a":1}';

    expect(verifySignature(key, '1000', body, signPayload(key, '1000', body))).toBe(true);
    expect(verifySignature(key, '9999', body, signPayload(key, '1000', body))).toBe(false);
  });

  it('refuses a malformed candidate without throwing', () => {
    expect(verifySignature(key, '1000', '{}', 'nonsense')).toBe(false);
    expect(verifySignature(key, '1000', '{}', '')).toBe(false);
  });
});

describe('alertSentence', () => {
  it('says how often when it has happened more than once', () => {
    expect(alertSentence(alertPayload(facts))).toContain('seen 3 times');
  });

  it('says nothing about repetition the first time', () => {
    const once = alertPayload({ ...facts, occurrences: 1, recommendedAction: null });

    expect(alertSentence(once)).not.toContain('seen');
    expect(alertSentence(once)).toContain('[CRITICAL]');
  });
});
