import { randomBytes, randomInt } from 'node:crypto';

/**
 * Generation of every authentication secret the user or their browser holds
 * (section 20).
 *
 * One module, because these values share a property that is easy to lose when
 * each is written where it is used: none of them may come from `Math.random`,
 * none may be biased, and each has an entropy floor the specification names.
 * Collecting them here means the floor is visible in one place and testable.
 */

/**
 * Bearer tokens: magic links, session tokens, trusted-device tokens.
 *
 * Section 20 requires at least 256 bits for magic links, and there is no reason
 * for the others to be weaker. base64url so the value is safe in a URL fragment,
 * a cookie, and a header without further encoding.
 */
export function generateToken(byteLength = 32): string {
  if (byteLength < 32) {
    throw new Error('Authentication tokens need at least 32 bytes of entropy.');
  }

  return randomBytes(byteLength).toString('base64url');
}

/**
 * The eight-digit email code (section 20).
 *
 * Returned as a string, and padded, because the leading zero is part of the
 * code: treating it as a number would turn `00481502` into `481502` and make
 * roughly one code in ten fail to verify for a user who typed it correctly.
 *
 * `randomInt` rejects biased samples internally, so every value in the range is
 * equally likely. `randomBytes(4) % 100000000` would not be: 2^32 is not a
 * multiple of 10^8, and the low codes would come up slightly more often.
 */
export function generateEmailCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

/**
 * Crockford's base32 alphabet.
 *
 * Chosen for the characters it leaves out. Recovery codes are read off a screen,
 * often written down, and typed back weeks later under stress, and `I`/`1`,
 * `O`/`0`, and `L`/`1` are exactly the pairs that get confused. `U` is excluded
 * as well, which removes the possibility of a code spelling something
 * unfortunate.
 */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 20 bytes is 160 bits, comfortably over section 20's 128-bit floor, and 20
 * bytes encode to exactly 32 base32 characters, so the display groups evenly. */
const RECOVERY_CODE_BYTES = 20;
const RECOVERY_GROUP_SIZE = 8;

/**
 * The ten one-time recovery codes shown once at 2FA enrollment (section 20).
 *
 * Formatted with hyphens for legibility. `normalizeRecoveryCode` strips them
 * again on entry, so a user who types the groups without separators, or with
 * spaces, or in lower case, still gets in.
 */
export function generateRecoveryCodes(count = 10): readonly string[] {
  return Array.from({ length: count }, () => formatRecoveryCode(randomBase32()));
}

/**
 * Prepares a typed recovery code for comparison.
 *
 * Applies Crockford's confusable mappings, so a user who reads `0` as `O` or `1`
 * as `I` still authenticates. The alphabet excludes the letters being mapped, so
 * no legitimate code is altered by this.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function randomBase32(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let bits = 0;
  let accumulator = 0;
  let output = '';

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((accumulator >>> bits) & 0b11111);
    }
  }

  return output;
}

function formatRecoveryCode(raw: string): string {
  const groups: string[] = [];

  for (let index = 0; index < raw.length; index += RECOVERY_GROUP_SIZE) {
    groups.push(raw.slice(index, index + RECOVERY_GROUP_SIZE));
  }

  return groups.join('-');
}
