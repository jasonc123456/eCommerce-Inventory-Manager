import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

import type { HttpClient } from '@eim/providers';

import { hostsFor, type EbayEnvironment } from '../environment';
import { parseJsonObject } from './rest';

/**
 * Proving a notification came from eBay (sections 13, 14, 19).
 *
 * Everything downstream of this file acts on what a notification says. An order
 * event moves stock; a deletion event erases a buyer irreversibly. So this is
 * the boundary where an anonymous HTTP request stops being anonymous, and the
 * rules below exist because each of them is a way that boundary is usually
 * drawn wrong:
 *
 *   The signature is verified over the raw request bytes, exactly as received.
 *   Parsing the JSON and re-serializing it changes whitespace and key order,
 *   and the signature is then checked against a body eBay never sent. This
 *   fails closed, which hides it: notifications simply stop being accepted.
 *
 *   The header names the key; the key names the algorithm. The `alg` and
 *   `digest` fields in the header arrive from whoever sent the request, and
 *   trusting them is the classic signature-confusion mistake — an attacker who
 *   picks the algorithm has already won. What is used is eBay's own answer
 *   about the key it published.
 *
 *   An unverifiable notification is never treated as verified-but-unknown.
 *   There is no third state. If eBay did not sign it, or the key cannot be
 *   fetched, the delivery is recorded and not acted on.
 *
 *   The key identifier is checked for shape before it is put in a URL. It is
 *   attacker-controlled text on its way into a path, and section 19's
 *   provider-call rules do not stop being true because the value came from a
 *   notification rather than from configuration.
 */

export interface SignatureHeader {
  /** eBay's identifier for the key that signed this. The only field trusted. */
  readonly keyId: string;
  readonly signature: string;
  /** What the sender claims. Recorded for diagnosis, never used to choose a verifier. */
  readonly claimedAlgorithm: string;
  readonly claimedDigest: string;
}

/**
 * Reads the `x-ebay-signature` header.
 *
 * The header is base64-encoded JSON. Returns null for anything that is not that
 * shape, rather than throwing: a malformed header is an ordinary event on a
 * public endpoint, not an exceptional one.
 */
export function parseSignatureHeader(value: string): SignatureHeader | null {
  // `Buffer.from(..., 'base64')` does not reject invalid input; it decodes what
  // it can and ignores the rest. Whatever comes out then has to survive being
  // read as JSON, which is the check that actually rejects a malformed header.
  const record = parseJsonObject(Buffer.from(value, 'base64').toString('utf8'));

  if (record === null) {
    return null;
  }

  const keyId = record['kid'];
  const signature = record['signature'];

  if (typeof keyId !== 'string' || typeof signature !== 'string') {
    return null;
  }

  if (keyId.length === 0 || signature.length === 0) {
    return null;
  }

  return {
    keyId,
    signature,
    claimedAlgorithm: typeof record['alg'] === 'string' ? record['alg'] : '',
    claimedDigest: typeof record['digest'] === 'string' ? record['digest'] : '',
  };
}

/**
 * What a key identifier may look like.
 *
 * eBay issues opaque identifiers; this is the widest shape that cannot escape a
 * URL path segment. Anything else is refused before a request is made, so an
 * endpoint that anyone on the internet can POST to cannot steer a call.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface NotificationPublicKey {
  readonly keyId: string;
  readonly key: KeyObject;
  /** eBay's answer, not the sender's claim. */
  readonly algorithm: string;
  readonly digest: string;
}

export interface PublicKeyReader {
  read(keyId: string, now?: Date): Promise<NotificationPublicKey | null>;
}

export interface PublicKeyReaderOptions {
  readonly http: HttpClient;
  readonly environment: EbayEnvironment;
  /** Supplies an application token. Public keys are application-scoped, not seller-scoped. */
  readonly applicationToken: (now?: Date) => Promise<string | null>;
  readonly cacheTtlMs?: number;
  readonly maxCached?: number;
}

/** Keys rotate on the order of months, so a few hours of cache is conservative. */
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * A ceiling on cached keys.
 *
 * eBay uses a handful. The bound is here because the identifier comes from the
 * request: without it, a stream of notifications carrying invented key
 * identifiers would be a memory leak with a network amplifier attached.
 */
const DEFAULT_MAX_CACHED = 16;

export function createPublicKeyReader(options: PublicKeyReaderOptions): PublicKeyReader {
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCached = options.maxCached ?? DEFAULT_MAX_CACHED;
  const cache = new Map<
    string,
    { readonly key: NotificationPublicKey; readonly cachedAt: number }
  >();

  return {
    async read(keyId, now = new Date()) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        return null;
      }

      const cached = cache.get(keyId);

      if (cached !== undefined && now.getTime() - cached.cachedAt < ttlMs) {
        return cached.key;
      }

      const credential = await options.applicationToken(now);

      if (credential === null) {
        return null;
      }

      const outcome = await options.http.send({
        method: 'GET',
        url: `${hostsFor(options.environment).apiBase}/commerce/notification/v1/public_key/${keyId}`,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
        },
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });

      if (!outcome.ok || outcome.response.status !== 200) {
        // Deliberately not cached. A failure cached is a working key that stays
        // unusable for hours after a transient outage has passed.
        return null;
      }

      const parsed = parsePublicKeyResponse(keyId, outcome.response.body);

      if (parsed === null) {
        return null;
      }

      if (cache.size >= maxCached) {
        // Oldest insertion first, which is what Map iteration order gives.
        const oldest = cache.keys().next();

        if (!oldest.done) {
          cache.delete(oldest.value);
        }
      }

      cache.set(keyId, { key: parsed, cachedAt: now.getTime() });

      return parsed;
    },
  };
}

function parsePublicKeyResponse(keyId: string, body: string): NotificationPublicKey | null {
  const record = parseJsonObject(body);

  if (record === null) {
    return null;
  }

  const material = record['key'];
  const algorithm = record['algorithm'];
  const digest = record['digest'];

  if (typeof material !== 'string' || material.length === 0) {
    return null;
  }

  let key: KeyObject;

  try {
    key = createPublicKey(asPem(material));
  } catch {
    // eBay answered with something that is not a key. Refusing is the only
    // option: there is nothing to verify against.
    return null;
  }

  return {
    keyId,
    key,
    algorithm: typeof algorithm === 'string' ? algorithm : '',
    digest: typeof digest === 'string' ? digest : '',
  };
}

/**
 * Wraps bare base64 key material in PEM armour.
 *
 * eBay has returned this field both ways — with the header and footer, and as
 * bare base64 — and `createPublicKey` accepts only the first.
 */
function asPem(material: string): string {
  const trimmed = material.trim();

  if (trimmed.includes('-----BEGIN')) {
    return trimmed;
  }

  const wrapped = trimmed.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');

  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

export type VerificationFailure =
  /** No signature header at all. */
  | 'missing_signature'
  /** Present, but not base64-encoded JSON with a key identifier and a signature. */
  | 'malformed_signature'
  /** eBay did not publish a key under that identifier, or could not be asked. */
  | 'key_unavailable'
  /** eBay published a key whose algorithm or digest this application cannot verify. */
  | 'unsupported_algorithm'
  /** Everything was in order and the signature does not match the body. */
  | 'mismatch';

export type VerificationResult =
  | { readonly verified: true; readonly keyId: string }
  | { readonly verified: false; readonly reason: VerificationFailure; readonly keyId?: string };

export interface SignatureVerifier {
  /**
   * `body` must be the bytes as received. Not a parsed object, not a
   * re-serialized one.
   */
  verify(input: {
    body: string | Buffer;
    signatureHeader: string | null | undefined;
    now?: Date;
  }): Promise<VerificationResult>;
}

/**
 * Digest names eBay uses, mapped to Node's.
 *
 * SHA-1 is here because eBay signs with it, not because it is a defensible
 * choice in 2026. It is acceptable in this one position: forging a signature
 * would need a chosen-prefix collision against a body that also has to be valid
 * JSON that this application acts on, and the signature is over an ECDSA key
 * eBay holds. It is listed explicitly rather than passed through so that the
 * day eBay moves to SHA-256, that is a one-line change and not a silent
 * acceptance of whatever a request asked for.
 */
const DIGESTS: Readonly<Record<string, string>> = {
  SHA1: 'sha1',
  'SHA-1': 'sha1',
  SHA256: 'sha256',
  'SHA-256': 'sha256',
};

const SUPPORTED_ALGORITHMS = new Set(['ecdsa', 'ec']);

export function createSignatureVerifier(options: { keys: PublicKeyReader }): SignatureVerifier {
  return {
    async verify(input) {
      const header = input.signatureHeader;

      if (header === null || header === undefined || header.length === 0) {
        return { verified: false, reason: 'missing_signature' };
      }

      const parsed = parseSignatureHeader(header);

      if (parsed === null) {
        return { verified: false, reason: 'malformed_signature' };
      }

      const published = await options.keys.read(parsed.keyId, input.now);

      if (published === null) {
        return { verified: false, reason: 'key_unavailable', keyId: parsed.keyId };
      }

      // eBay's answer decides how to verify. The header's claim is not consulted:
      // an attacker who names the algorithm chooses the one they can forge.
      const algorithm = published.algorithm.toLowerCase();
      const digest = DIGESTS[published.digest.toUpperCase()];

      if (!SUPPORTED_ALGORITHMS.has(algorithm) || digest === undefined) {
        return { verified: false, reason: 'unsupported_algorithm', keyId: parsed.keyId };
      }

      const signature = Buffer.from(parsed.signature, 'base64');

      if (signature.length === 0) {
        return { verified: false, reason: 'malformed_signature', keyId: parsed.keyId };
      }

      const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;

      let matched: boolean;

      try {
        matched = createVerify(digest).update(body).verify(published.key, signature);
      } catch {
        // A signature that is not valid DER makes the verifier throw rather
        // than return false. Same conclusion either way.
        matched = false;
      }

      return matched
        ? { verified: true, keyId: parsed.keyId }
        : { verified: false, reason: 'mismatch', keyId: parsed.keyId };
    },
  };
}
