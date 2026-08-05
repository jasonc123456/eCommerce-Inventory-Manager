/**
 * The versioned master keyring (section 19, D-069).
 *
 * PostgreSQL never contains a plaintext master key. The keys live in the
 * deployment host's `.env` as `EIM_KEYRING`, a JSON array of versioned 256-bit
 * values, and this module is the only thing that parses it.
 *
 * Versioning is what makes rotation possible without a flag day. A rotation
 * appends a new version and points `EIM_KEYRING_ACTIVE_VERSION` at it: new
 * ciphertext uses the new key immediately, existing ciphertext keeps naming the
 * version it was written with, and a bounded re-encryption pass moves rows over
 * at its own pace. An old version is removed from the file only when no live row
 * and no retained backup still needs it.
 */

/**
 * Raised for anything wrong with the keyring itself.
 *
 * Every message here describes the shape of the problem and never the value:
 * a startup failure that prints part of a master key to the container log has
 * turned a configuration mistake into a key disclosure.
 */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

/** Master keys are AES-256, so every entry is exactly this many bytes. */
const KEY_BYTES = 32;

export interface KeyringSource {
  /** The raw `EIM_KEYRING` value: a JSON array of `{version, key}` objects. */
  readonly keyring: string;
  /** The `EIM_KEYRING_ACTIVE_VERSION` value. Must name a version present above. */
  readonly activeVersion: number;
}

export interface ActiveKey {
  readonly version: number;
  readonly key: Buffer;
}

export interface Keyring {
  readonly activeVersion: number;
  /** Every version present, ascending. Used by rotation to report progress. */
  readonly versions: readonly number[];
  /** The key new ciphertext is written with. */
  active(): ActiveKey;
  /** The key a given ciphertext names. Throws if that version is gone. */
  keyFor(version: number): Buffer;
}

interface RawEntry {
  version: unknown;
  key: unknown;
}

/**
 * Parses and validates the keyring.
 *
 * Deliberately strict. Every rejection here is a deployment that stops with a
 * clear message, and the alternative to stopping is an installation that starts,
 * accepts credentials, encrypts them with something malformed, and discovers the
 * problem when someone tries to read one back.
 */
export function loadKeyring(source: KeyringSource): Keyring {
  const parsed = parseJson(source.keyring);

  if (!Array.isArray(parsed)) {
    throw new KeyringError('EIM_KEYRING must be a JSON array of {version, key} objects.');
  }

  if (parsed.length === 0) {
    throw new KeyringError('EIM_KEYRING contains no keys.');
  }

  const keys = new Map<number, Buffer>();

  for (const [index, entry] of parsed.entries()) {
    const { version, key } = readEntry(entry, index);

    if (keys.has(version)) {
      throw new KeyringError(`EIM_KEYRING declares version ${String(version)} more than once.`);
    }

    keys.set(version, key);
  }

  const versions = [...keys.keys()].sort((a, b) => a - b);
  const activeVersion = source.activeVersion;
  const activeKey = keys.get(activeVersion);

  if (activeKey === undefined) {
    throw new KeyringError(
      `EIM_KEYRING_ACTIVE_VERSION is ${String(activeVersion)}, which is not present in ` +
        `EIM_KEYRING. Available versions: ${versions.join(', ')}.`,
    );
  }

  return {
    activeVersion,
    versions,
    active(): ActiveKey {
      return { version: activeVersion, key: activeKey };
    },
    keyFor(version: number): Buffer {
      const key = keys.get(version);

      if (key === undefined) {
        // This is the retirement mistake: a key was removed from the file while
        // rows encrypted with it were still live. Say so plainly, because the
        // recovery is to restore that version, not to re-run anything.
        throw new KeyringError(
          `No key for version ${String(version)}. A value encrypted with it cannot be read ` +
            'until that version is restored to EIM_KEYRING.',
        );
      }

      return key;
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // The parser's own message quotes the input, which here is key material.
    throw new KeyringError('EIM_KEYRING is not valid JSON.');
  }
}

function readEntry(entry: unknown, index: number): { version: number; key: Buffer } {
  if (typeof entry !== 'object' || entry === null) {
    throw new KeyringError(`EIM_KEYRING entry ${String(index)} is not an object.`);
  }

  const { version, key } = entry as RawEntry;

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new KeyringError(
      `EIM_KEYRING entry ${String(index)} needs an integer "version" of 1 or more.`,
    );
  }

  if (typeof key !== 'string' || key.length === 0) {
    throw new KeyringError(
      `EIM_KEYRING version ${String(version)} needs a base64 "key" of 32 random bytes.`,
    );
  }

  const decoded = Buffer.from(key, 'base64');

  // Buffer.from is lenient and silently discards anything it cannot decode, so
  // the length check is what actually rejects a truncated or corrupted value.
  if (decoded.byteLength !== KEY_BYTES) {
    throw new KeyringError(
      `EIM_KEYRING version ${String(version)} decodes to ${String(decoded.byteLength)} bytes; ` +
        `AES-256 needs exactly ${String(KEY_BYTES)}. Generate one with ` +
        '`openssl rand -base64 32`.',
    );
  }

  return { version, key: decoded };
}
