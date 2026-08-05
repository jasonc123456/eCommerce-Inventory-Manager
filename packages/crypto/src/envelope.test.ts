import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DecryptionError,
  decryptSecret,
  encryptSecret,
  isEnvelope,
  keyVersionOf,
  rewrapSecret,
  type SecretContext,
} from './envelope';
import { loadKeyring, type Keyring } from './keyring';

const KEY_ONE = randomBytes(32).toString('base64');
const KEY_TWO = randomBytes(32).toString('base64');

const singleVersion = (): Keyring =>
  loadKeyring({ keyring: JSON.stringify([{ version: 1, key: KEY_ONE }]), activeVersion: 1 });

const rotated = (activeVersion: number): Keyring =>
  loadKeyring({
    keyring: JSON.stringify([
      { version: 1, key: KEY_ONE },
      { version: 2, key: KEY_TWO },
    ]),
    activeVersion,
  });

const context: SecretContext = {
  businessId: '11111111-1111-4111-8111-111111111111',
  resource: 'ebay_connection:22222222-2222-4222-8222-222222222222',
  secretType: 'refresh_token',
};

describe('encryptSecret and decryptSecret', () => {
  it('round-trips a value', () => {
    const keyring = singleVersion();
    const envelope = encryptSecret(keyring, context, 'v^1.1#abc');

    expect(decryptSecret(keyring, context, envelope)).toBe('v^1.1#abc');
  });

  it('round-trips an empty string and multi-byte characters', () => {
    const keyring = singleVersion();

    for (const plaintext of ['', 'ünïcödé 🔐 secret', 'x'.repeat(4096)]) {
      const envelope = encryptSecret(keyring, context, plaintext);
      expect(decryptSecret(keyring, context, envelope)).toBe(plaintext);
    }
  });

  it('produces a different ciphertext every time, because the nonce is fresh', () => {
    const keyring = singleVersion();
    const envelopes = new Set(
      Array.from({ length: 20 }, () => encryptSecret(keyring, context, 'same')),
    );

    expect(envelopes.size).toBe(20);
  });

  it('never contains the plaintext', () => {
    const keyring = singleVersion();
    const envelope = encryptSecret(keyring, context, 'SUPER_SECRET_VALUE');

    expect(envelope).not.toContain('SUPER_SECRET_VALUE');
    expect(isEnvelope(envelope)).toBe(true);
  });

  it('names the key version it was written with', () => {
    expect(keyVersionOf(encryptSecret(rotated(2), context, 'value'))).toBe(2);
  });
});

describe('context binding', () => {
  const keyring = singleVersion();
  const envelope = encryptSecret(keyring, context, 'value');

  it('refuses a ciphertext moved to another business', () => {
    // The attack this defeats: database write access without the key, copying a
    // competitor's connection secret into your own row and letting the
    // application decrypt it for you.
    const other = { ...context, businessId: '33333333-3333-4333-8333-333333333333' };

    expect(() => decryptSecret(keyring, other, envelope)).toThrow(DecryptionError);
  });

  it('refuses a ciphertext moved to another resource', () => {
    const other = { ...context, resource: 'ebay_connection:99999999-9999-4999-8999-999999999999' };

    expect(() => decryptSecret(keyring, other, envelope)).toThrow(DecryptionError);
  });

  it('refuses a ciphertext read as a different secret type', () => {
    const other = { ...context, secretType: 'access_token' };

    expect(() => decryptSecret(keyring, other, envelope)).toThrow(DecryptionError);
  });

  it('distinguishes contexts that a delimiter-joined encoding would collide', () => {
    // `a` + `b:c` and `a:b` + `c` join to the same string without length
    // prefixes, which would let a ciphertext be read under the wrong context.
    const left = encryptSecret(
      keyring,
      { businessId: null, resource: 'a', secretType: 'b:c' },
      'v',
    );

    expect(() =>
      decryptSecret(keyring, { businessId: null, resource: 'a:b', secretType: 'c' }, left),
    ).toThrow(DecryptionError);
  });

  it('accepts an installation-level secret with no business', () => {
    const installation: SecretContext = {
      businessId: null,
      resource: 'installation',
      secretType: 'smtp_password',
    };

    const sealed = encryptSecret(keyring, installation, 'value');
    expect(decryptSecret(keyring, installation, sealed)).toBe('value');
  });

  it('rejects an empty resource or secret type rather than binding to nothing', () => {
    expect(() =>
      encryptSecret(keyring, { businessId: null, resource: '', secretType: 'x' }, 'v'),
    ).toThrow(/resource and a secret type/);
  });
});

describe('tamper detection', () => {
  const keyring = singleVersion();

  it('refuses an altered ciphertext', () => {
    const envelope = encryptSecret(keyring, context, 'value');
    const parts = envelope.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);
    parts[3] = flipped.toString('base64url');

    expect(() => decryptSecret(keyring, context, parts.join('.'))).toThrow(DecryptionError);
  });

  it('refuses an altered authentication tag', () => {
    const envelope = encryptSecret(keyring, context, 'value');
    const parts = envelope.split('.');
    const flipped = Buffer.from(parts[4]!, 'base64url');
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);
    parts[4] = flipped.toString('base64url');

    expect(() => decryptSecret(keyring, context, parts.join('.'))).toThrow(DecryptionError);
  });

  it('refuses a value that is not an envelope at all', () => {
    for (const value of ['', 'plaintext', 'eim1.1.2.3', 'eim2.1.a.b.c']) {
      expect(() => decryptSecret(keyring, context, value)).toThrow(DecryptionError);
    }
  });

  it('refuses an envelope naming an invalid key version', () => {
    expect(() => decryptSecret(keyring, context, 'eim1.zero.a.b.c')).toThrow(/key version/);
  });

  it('refuses a wrong-length nonce before the cipher sees it', () => {
    const envelope = encryptSecret(keyring, context, 'value');
    const parts = envelope.split('.');
    parts[2] = Buffer.alloc(8).toString('base64url');

    expect(() => decryptSecret(keyring, context, parts.join('.'))).toThrow(/malformed/);
  });

  it('reports the same failure whatever the cause, so it is not an oracle', () => {
    const envelope = encryptSecret(keyring, context, 'value');
    const wrongContext = (): unknown => {
      try {
        decryptSecret(keyring, { ...context, secretType: 'other' }, envelope);
      } catch (error) {
        return String(error);
      }
      return null;
    };

    const wrongKey = (): unknown => {
      try {
        decryptSecret(
          loadKeyring({
            keyring: JSON.stringify([{ version: 1, key: KEY_TWO }]),
            activeVersion: 1,
          }),
          context,
          envelope,
        );
      } catch (error) {
        return String(error);
      }
      return null;
    };

    expect(wrongContext()).toBe(wrongKey());
  });
});

describe('rotation', () => {
  it('keeps reading values written under a superseded key', () => {
    const before = rotated(1);
    const envelope = encryptSecret(before, context, 'written before rotation');

    const after = rotated(2);
    expect(decryptSecret(after, context, envelope)).toBe('written before rotation');
  });

  it('re-encrypts a stale value under the active key', () => {
    const after = rotated(2);
    const stale = encryptSecret(rotated(1), context, 'value');

    const rewrapped = rewrapSecret(after, context, stale);

    expect(rewrapped).not.toBeNull();
    expect(keyVersionOf(rewrapped!)).toBe(2);
    expect(decryptSecret(after, context, rewrapped!)).toBe('value');
  });

  it('reports nothing to do for a value already on the active key', () => {
    const after = rotated(2);

    expect(rewrapSecret(after, context, encryptSecret(after, context, 'value'))).toBeNull();
  });

  it('counts stale rows without needing to read them', () => {
    // A rotation pass must be able to measure its own progress with the same
    // permissions it already has, and not by decrypting every row twice.
    const stale = encryptSecret(rotated(1), context, 'value');

    expect(keyVersionOf(stale)).toBe(1);
  });
});
