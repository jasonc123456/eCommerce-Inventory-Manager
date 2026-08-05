import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { KeyringError, type Keyring } from './keyring';

/**
 * Authenticated field encryption for per-business credentials (section 19).
 *
 * Section 19 requires AES-256-GCM, a fresh random nonce for every value, and
 * "authenticated context binding the ciphertext to its business, resource,
 * secret type, and key version". That last requirement is the interesting one:
 * it means a ciphertext is not merely unreadable without the key, it is
 * unusable anywhere other than the row it was written for.
 *
 * Concretely, an attacker with UPDATE on the database but no key cannot copy
 * another business's eBay refresh token into their own connection row and have
 * the application decrypt it for them, because the context is fed to GCM as
 * additional authenticated data and the caller supplies that context from the
 * row it is reading. The tag check fails and the value is refused.
 *
 * The envelope is text rather than bytea so that it survives ordinary tooling:
 * a logical dump, a CSV export during a migration, and a psql session all treat
 * it as an opaque string, and the `eim1` prefix makes it obvious in a dump that
 * the field is encrypted rather than corrupted.
 */

/** GCM's standard nonce length. Anything else costs a rehash inside the cipher. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Distinguishes this envelope layout from whatever replaces it. */
const FORMAT = 'eim1';

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * What a ciphertext is bound to.
 *
 * `businessId` is null for installation-level secrets, which belong to the
 * deployment rather than to a tenant. It is not optional, because "I forgot to
 * pass it" and "this secret genuinely has no business" must not look the same
 * at a call site that is deciding what a ciphertext may be used for.
 */
export interface SecretContext {
  readonly businessId: string | null;
  /** The row this value hangs off, such as `ebay_connection:<uuid>`. */
  readonly resource: string;
  /** Which secret on that row, such as `refresh_token` or `webhook_secret`. */
  readonly secretType: string;
}

export function encryptSecret(keyring: Keyring, context: SecretContext, plaintext: string): string {
  const { version, key } = keyring.active();
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(contextBytes(context, version));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    String(version),
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export function decryptSecret(keyring: Keyring, context: SecretContext, envelope: string): string {
  const parts = parseEnvelope(envelope);
  const key = keyring.keyFor(parts.version);

  const decipher = createDecipheriv('aes-256-gcm', key, parts.nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(contextBytes(context, parts.version));
  decipher.setAuthTag(parts.tag);

  try {
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM gives one failure for every cause: wrong key, tampered ciphertext, or
    // a context that does not match the one it was sealed under. Saying which
    // would be a guessing oracle, and the operator response is the same in
    // every case, so the message stays general.
    throw new DecryptionError(
      'The value could not be decrypted. Either the ciphertext was altered, or it belongs to a ' +
        'different business, resource, or secret type than the one reading it.',
    );
  }
}

/**
 * Which key version sealed a value, without decrypting it.
 *
 * A rotation pass uses this to find the rows that still need re-encrypting, and
 * it must not need the ability to read them in order to count them.
 */
export function keyVersionOf(envelope: string): number {
  return parseEnvelope(envelope).version;
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(`${FORMAT}.`);
}

/**
 * Re-encrypts a value under the active key.
 *
 * The unit of work for a rotation batch (section 19). Returns null when the
 * value is already current, so a caller can skip the write rather than churn
 * every row on every pass.
 */
export function rewrapSecret(
  keyring: Keyring,
  context: SecretContext,
  envelope: string,
): string | null {
  if (keyVersionOf(envelope) === keyring.activeVersion) {
    return null;
  }

  return encryptSecret(keyring, context, decryptSecret(keyring, context, envelope));
}

interface ParsedEnvelope {
  readonly version: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  const [format, versionText, nonceText, ciphertextText, tagText] = envelope.split('.');

  if (
    format !== FORMAT ||
    versionText === undefined ||
    nonceText === undefined ||
    ciphertextText === undefined ||
    tagText === undefined
  ) {
    throw new DecryptionError('The stored value is not an encrypted envelope.');
  }

  const version = Number(versionText);

  if (!Number.isInteger(version) || version < 1) {
    throw new DecryptionError('The encrypted envelope names an invalid key version.');
  }

  const nonce = Buffer.from(nonceText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');

  // Node throws a generic RangeError from deep inside the cipher for a
  // wrong-length nonce or tag. Checking here keeps the failure describable.
  if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new DecryptionError('The encrypted envelope is malformed.');
  }

  return { version, nonce, ciphertext, tag };
}

/**
 * Serializes the authenticated context.
 *
 * Length-prefixed rather than delimiter-joined, because a delimiter that can
 * appear inside a field is not a delimiter. Without this, a resource of `a` with
 * secret type `b:c` and a resource of `a:b` with secret type `c` would produce
 * identical context, and a ciphertext could be moved between the two.
 */
function contextBytes(context: SecretContext, keyVersion: number): Buffer {
  const fields = [
    'eim-secret-context-v1',
    context.businessId ?? '',
    context.resource,
    context.secretType,
    String(keyVersion),
  ];

  if (context.resource.length === 0 || context.secretType.length === 0) {
    throw new KeyringError('A secret context needs both a resource and a secret type.');
  }

  return Buffer.from(
    fields.map((field) => `${String(Buffer.byteLength(field, 'utf8'))}:${field}`).join(''),
    'utf8',
  );
}
