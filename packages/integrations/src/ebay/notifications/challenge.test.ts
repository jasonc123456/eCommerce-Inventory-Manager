import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { challengeResponse, isUsableVerificationToken } from './challenge';

/**
 * Answering eBay's endpoint challenge.
 *
 * The expected value is computed here from the concatenation directly rather
 * than by calling the same helper, so the test would still fail if the order of
 * the three inputs changed.
 */

const TOKEN = 'v'.repeat(40);
const ENDPOINT = 'https://inventory.example.invalid/api/webhooks/ebay/account-deletion';

describe('challengeResponse', () => {
  it('hashes the code, the token, and the endpoint in that order', () => {
    const expected = createHash('sha256').update(`abc123${TOKEN}${ENDPOINT}`, 'utf8').digest('hex');

    expect(
      challengeResponse({ challengeCode: 'abc123', verificationToken: TOKEN, endpoint: ENDPOINT }),
    ).toBe(expected);
  });

  it('gives a different answer for a different endpoint', () => {
    // This is what lets one token serve both endpoints: an answer captured from
    // one is the wrong answer at the other.
    const first = challengeResponse({
      challengeCode: 'abc123',
      verificationToken: TOKEN,
      endpoint: ENDPOINT,
    });
    const second = challengeResponse({
      challengeCode: 'abc123',
      verificationToken: TOKEN,
      endpoint: `${ENDPOINT}/notifications`,
    });

    expect(first).not.toBe(second);
  });

  it('refuses to answer with a token eBay would not have accepted', () => {
    for (const verificationToken of ['', 'too-short', 'a'.repeat(81), `${'a'.repeat(40)}!`]) {
      expect(
        challengeResponse({ challengeCode: 'abc', verificationToken, endpoint: ENDPOINT }),
      ).toBeNull();
    }
  });

  it('refuses to answer without a code or an endpoint', () => {
    expect(
      challengeResponse({ challengeCode: '', verificationToken: TOKEN, endpoint: ENDPOINT }),
    ).toBeNull();
    expect(
      challengeResponse({ challengeCode: 'abc', verificationToken: TOKEN, endpoint: '' }),
    ).toBeNull();
  });
});

describe('isUsableVerificationToken', () => {
  it('accepts the range eBay accepts and nothing else', () => {
    expect(isUsableVerificationToken('a'.repeat(32))).toBe(true);
    expect(isUsableVerificationToken('a'.repeat(80))).toBe(true);
    expect(isUsableVerificationToken(`${'a'.repeat(30)}_-`)).toBe(true);

    expect(isUsableVerificationToken('a'.repeat(31))).toBe(false);
    expect(isUsableVerificationToken('a'.repeat(81))).toBe(false);
    expect(isUsableVerificationToken(undefined)).toBe(false);
  });
});
