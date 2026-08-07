import { challengeResponse } from '@eim/integrations';
import { describe, expect, it } from 'vitest';

import { buildEndpoint, isEbayEnvironment } from './notifications';

/**
 * The endpoint eBay was told to deliver to.
 *
 * Worth its own test because it is an input to a hash. If this string and the
 * one registered in eBay's portal differ by a slash, the challenge answer is
 * wrong, and the only thing eBay says is that validation failed — with every
 * visible part of the configuration looking correct.
 */

describe('buildEndpoint', () => {
  it('builds the two endpoints for an environment', () => {
    expect(buildEndpoint('https://inventory.example.invalid', 'production', 'notifications')).toBe(
      'https://inventory.example.invalid/api/webhooks/ebay/production',
    );

    expect(buildEndpoint('https://inventory.example.invalid', 'sandbox', 'account-deletion')).toBe(
      'https://inventory.example.invalid/api/webhooks/ebay/sandbox/account-deletion',
    );
  });

  it('tolerates a configured base with trailing slashes or spaces', () => {
    expect(
      buildEndpoint('  https://inventory.example.invalid//  ', 'production', 'notifications'),
    ).toBe('https://inventory.example.invalid/api/webhooks/ebay/production');
  });

  it('gives each endpoint a different challenge answer', () => {
    // The property that lets one verification token serve both endpoints: an
    // answer captured at one is the wrong answer at the other.
    const token = 't'.repeat(40);
    const answers = (['notifications', 'account-deletion'] as const).map((kind) =>
      challengeResponse({
        challengeCode: 'abc123',
        verificationToken: token,
        endpoint: buildEndpoint('https://inventory.example.invalid', 'production', kind),
      }),
    );

    expect(answers[0]).not.toBe(answers[1]);
    expect(answers[0]).toEqual(expect.any(String));
  });

  it('keeps the environments apart', () => {
    expect(buildEndpoint('https://x.invalid', 'sandbox', 'notifications')).not.toBe(
      buildEndpoint('https://x.invalid', 'production', 'notifications'),
    );
  });
});

describe('isEbayEnvironment', () => {
  it('accepts the two environments and nothing else', () => {
    expect(isEbayEnvironment('sandbox')).toBe(true);
    expect(isEbayEnvironment('production')).toBe(true);

    for (const value of ['', 'Production', '../production', 'staging']) {
      expect(isEbayEnvironment(value)).toBe(false);
    }
  });
});
