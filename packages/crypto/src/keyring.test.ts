import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { KeyringError, loadKeyring } from './keyring';

const key = (): string => randomBytes(32).toString('base64');

const keyringJson = (...versions: readonly number[]): string =>
  JSON.stringify(versions.map((version) => ({ version, key: key() })));

describe('loadKeyring', () => {
  it('exposes the active key and every version present', () => {
    const keyring = loadKeyring({ keyring: keyringJson(1, 2, 3), activeVersion: 2 });

    expect(keyring.activeVersion).toBe(2);
    expect(keyring.versions).toEqual([1, 2, 3]);
    expect(keyring.active().version).toBe(2);
    expect(keyring.active().key).toHaveLength(32);
  });

  it('sorts versions ascending regardless of the order in the file', () => {
    const keyring = loadKeyring({ keyring: keyringJson(3, 1, 2), activeVersion: 3 });

    expect(keyring.versions).toEqual([1, 2, 3]);
  });

  it('returns the key a superseded version names, so old ciphertext stays readable', () => {
    const keyring = loadKeyring({ keyring: keyringJson(1, 2), activeVersion: 2 });

    expect(keyring.keyFor(1)).toHaveLength(32);
    expect(keyring.keyFor(1).equals(keyring.active().key)).toBe(false);
  });

  it('refuses a version that has been retired while data still names it', () => {
    const keyring = loadKeyring({ keyring: keyringJson(2), activeVersion: 2 });

    expect(() => keyring.keyFor(1)).toThrow(KeyringError);
    expect(() => keyring.keyFor(1)).toThrow(/restored to EIM_KEYRING/);
  });
});

describe('loadKeyring rejects', () => {
  it('a value that is not JSON', () => {
    expect(() => loadKeyring({ keyring: 'not json', activeVersion: 1 })).toThrow(/not valid JSON/);
  });

  it('a JSON value that is not an array', () => {
    expect(() => loadKeyring({ keyring: '{"version":1}', activeVersion: 1 })).toThrow(
      /must be a JSON array/,
    );
  });

  it('an empty keyring', () => {
    expect(() => loadKeyring({ keyring: '[]', activeVersion: 1 })).toThrow(/contains no keys/);
  });

  it('a duplicated version', () => {
    const duplicated = JSON.stringify([
      { version: 1, key: key() },
      { version: 1, key: key() },
    ]);

    expect(() => loadKeyring({ keyring: duplicated, activeVersion: 1 })).toThrow(/more than once/);
  });

  it('a non-integer or non-positive version', () => {
    for (const version of [0, -1, 1.5, '1']) {
      const json = JSON.stringify([{ version, key: key() }]);
      expect(() => loadKeyring({ keyring: json, activeVersion: 1 })).toThrow(/integer "version"/);
    }
  });

  it('an entry that is not an object', () => {
    expect(() => loadKeyring({ keyring: '["nope"]', activeVersion: 1 })).toThrow(
      /is not an object/,
    );
  });

  it('a missing or empty key', () => {
    const json = JSON.stringify([{ version: 1, key: '' }]);
    expect(() => loadKeyring({ keyring: json, activeVersion: 1 })).toThrow(/base64 "key"/);
  });

  it('a key that is not exactly 32 bytes', () => {
    const short = JSON.stringify([{ version: 1, key: randomBytes(16).toString('base64') }]);

    expect(() => loadKeyring({ keyring: short, activeVersion: 1 })).toThrow(/decodes to 16 bytes/);
  });

  it('an active version that is not present, and says which versions are', () => {
    expect(() => loadKeyring({ keyring: keyringJson(1, 2), activeVersion: 7 })).toThrow(
      /Available versions: 1, 2/,
    );
  });
});

describe('keyring failures', () => {
  it('never put key material in the message', () => {
    // A configuration error that prints part of a master key into a container
    // log has turned a typo into a key disclosure.
    const secret = randomBytes(32).toString('base64');
    const malformed = `[{"version":1,"key":"${secret}"`;

    try {
      loadKeyring({ keyring: malformed, activeVersion: 1 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret.slice(0, 8));
    }
  });
});
