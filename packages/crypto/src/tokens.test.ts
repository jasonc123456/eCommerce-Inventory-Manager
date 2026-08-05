import { describe, expect, it } from 'vitest';

import {
  generateEmailCode,
  generateRecoveryCodes,
  generateToken,
  normalizeRecoveryCode,
} from './tokens';

describe('generateToken', () => {
  it('carries at least 256 bits by default', () => {
    expect(Buffer.from(generateToken(), 'base64url')).toHaveLength(32);
  });

  it('is URL-safe, so it survives a fragment, a cookie, and a header unencoded', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('refuses to issue a token below section 20 entropy floor', () => {
    expect(() => generateToken(16)).toThrow(/at least 32 bytes/);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));

    expect(tokens.size).toBe(500);
  });
});

describe('generateEmailCode', () => {
  const codes = Array.from({ length: 2000 }, () => generateEmailCode());

  it('is always eight decimal digits', () => {
    for (const code of codes) {
      expect(code).toMatch(/^\d{8}$/);
    }
  });

  it('preserves leading zeroes', () => {
    // Roughly one code in ten starts with a zero, so 2000 samples make a missing
    // pad a certain failure rather than a flaky one. Treating the code as a
    // number would drop the digit and reject a user who typed it correctly.
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('covers the whole range rather than a biased slice', () => {
    const leadingDigits = new Set(codes.map((code) => code[0]));

    expect(leadingDigits.size).toBe(10);
  });

  it('does not repeat noticeably', () => {
    // 2000 samples from 10^8 values: birthday collisions are possible but rare,
    // so a duplicate rate above a handful means the generator is not uniform.
    expect(new Set(codes).size).toBeGreaterThan(codes.length - 5);
  });
});

describe('generateRecoveryCodes', () => {
  it('issues ten codes by default', () => {
    expect(generateRecoveryCodes()).toHaveLength(10);
  });

  it('formats each as four groups of eight characters', () => {
    for (const code of generateRecoveryCodes()) {
      const groups = code.split('-');

      expect(groups).toHaveLength(4);
      for (const group of groups) {
        expect(group).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      }
    }
  });

  it('carries at least 128 bits per code', () => {
    // 32 base32 characters is 160 bits, over section 20 floor.
    const [first] = generateRecoveryCodes(1);

    expect(first!.replace(/-/g, '')).toHaveLength(32);
  });

  it('omits the characters people confuse when reading a code off a screen', () => {
    const all = generateRecoveryCodes(200).join('');

    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(all).not.toContain(excluded);
    }
  });

  it('does not repeat', () => {
    expect(new Set(generateRecoveryCodes(200)).size).toBe(200);
  });
});

describe('normalizeRecoveryCode', () => {
  it('leaves a correctly typed code unchanged apart from the separators', () => {
    const [code] = generateRecoveryCodes(1);

    expect(normalizeRecoveryCode(code!)).toBe(code!.replace(/-/g, ''));
  });

  it('accepts lower case, spaces, and missing hyphens', () => {
    const [code] = generateRecoveryCodes(1);
    const stripped = code!.replace(/-/g, '');

    expect(normalizeRecoveryCode(code!.toLowerCase())).toBe(stripped);
    expect(normalizeRecoveryCode(stripped.replace(/(.{4})/g, '$1 '))).toBe(stripped);
  });

  it('maps the confusable characters the alphabet excludes', () => {
    expect(normalizeRecoveryCode('O0I1L')).toBe('00111');
  });

  it('does not alter a legitimate code, because the mapped letters cannot occur in one', () => {
    const all = generateRecoveryCodes(200);

    for (const code of all) {
      expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ''));
    }
  });
});
