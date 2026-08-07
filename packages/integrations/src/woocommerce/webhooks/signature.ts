import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proving a delivery came from the store (section 14).
 *
 * WooCommerce signs a webhook with `X-WC-Webhook-Signature`: the base64
 * HMAC-SHA256 of the request body under the secret that registration was created
 * with. There is no algorithm field and no key identifier inside the signature,
 * which removes the whole family of confusion attacks that the eBay verifier has
 * to defend against — and replaces them with a different question, which is
 * which secret to check against.
 *
 * The answer is not the `X-WC-Webhook-ID` header. That header is written by
 * whoever sent the request, so using it to pick a secret lets the sender choose
 * which key they are checked against; during a rotation, when two secrets are
 * live, that is a real choice. So every live secret for the connection is tried
 * and the one that matches *identifies* the registration. Identification comes
 * out of verification rather than being an input to it.
 *
 * Three things this file is careful about:
 *
 *   The body is bytes, not an object. `request.json()` parses and re-serializes,
 *   and the result is equivalent and not identical — `{"a":1.0}` comes back as
 *   `{"a":1}` — so every delivery would fail for a reason nothing reports.
 *
 *   The comparison is constant-time, and on buffers of equal length. Node's
 *   `timingSafeEqual` throws on a length mismatch, which would turn a
 *   wrong-length signature into an exception instead of a refusal, so length is
 *   checked first and separately.
 *
 *   Every candidate is tried even after one matches. Stopping early makes the
 *   time taken depend on which secret matched, which over enough deliveries
 *   distinguishes "the first secret" from "the second" — not a catastrophe here,
 *   and not worth the microseconds saved.
 */

export interface SigningSecret {
  /** The registration this secret belongs to. */
  readonly webhookId: string;
  readonly secret: string;
}

export type WebhookVerification =
  | { readonly verified: true; readonly webhookId: string }
  | { readonly verified: false; readonly reason: WebhookVerificationFailure };

export type WebhookVerificationFailure =
  | 'missing_signature'
  | 'malformed_signature'
  /** No live secret for this connection produced that signature. */
  | 'mismatch'
  /** The connection has no registration whose secret could be tried. */
  | 'no_secrets';

/** HMAC-SHA256 is 32 bytes, so a valid signature is always exactly this long. */
const SIGNATURE_BYTES = 32;

export function verifyWebhookSignature(input: {
  /** The bytes exactly as received. */
  readonly body: string;
  readonly signatureHeader: string | null | undefined;
  readonly secrets: readonly SigningSecret[];
}): WebhookVerification {
  const header = input.signatureHeader;

  if (header === null || header === undefined || header.length === 0) {
    return { verified: false, reason: 'missing_signature' };
  }

  const provided = decodeSignature(header);

  if (provided === null) {
    return { verified: false, reason: 'malformed_signature' };
  }

  if (input.secrets.length === 0) {
    // Distinguished from a mismatch because the two mean opposite things: this
    // is a registration this application has lost track of, and a mismatch is a
    // body that is not what it claims to be.
    return { verified: false, reason: 'no_secrets' };
  }

  const body = Buffer.from(input.body, 'utf8');
  let matched: string | null = null;

  for (const candidate of input.secrets) {
    const expected = createHmac('sha256', candidate.secret).update(body).digest();

    // Both are exactly 32 bytes here — `provided` was length-checked in
    // `decodeSignature` — so this cannot throw.
    if (timingSafeEqual(expected, provided) && matched === null) {
      matched = candidate.webhookId;
    }
  }

  return matched === null
    ? { verified: false, reason: 'mismatch' }
    : { verified: true, webhookId: matched };
}

/**
 * Reads the header into the 32 bytes it must be.
 *
 * Node's base64 decoder is permissive: it skips characters it does not
 * recognize rather than failing, so `"not a signature!!"` decodes to *something*
 * and would otherwise be compared. Requiring the exact byte length afterwards is
 * what turns that into a refusal, and it is also what makes the constant-time
 * comparison below safe to call.
 */
export function decodeSignature(header: string): Buffer | null {
  const trimmed = header.trim();

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return null;
  }

  const decoded = Buffer.from(trimmed, 'base64');

  return decoded.length === SIGNATURE_BYTES ? decoded : null;
}

/** Signs a body the way WooCommerce does. Used to prove the verifier, and to test a delivery. */
export function signWebhookBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
}
