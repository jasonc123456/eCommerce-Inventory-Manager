/**
 * The named limits (sections 19 and 20).
 *
 * Declared in one place rather than at each call site, because a limit is a
 * policy decision and a call site is an implementation detail. Section 20 fixes
 * the authentication numbers and adds that they "must not be weakened to
 * in-memory-only for performance"; keeping them here makes weakening one a
 * visible change to a file whose whole purpose is to be read.
 */

export interface RateLimitRule {
  /** The counter family, stored on every window row. */
  readonly bucket: string;
  /** How many operations one subject may perform inside a window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Shown to an operator reading a health or audit surface. */
  readonly description: string;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Authentication limits, keyed per address.
 *
 * The subject is a keyed fingerprint of the normalized address, never the
 * address itself: section 19 keeps routine records on a fingerprint, and a
 * limiter that stored addresses would become a second place they live.
 */
export const EMAIL_CHALLENGE_PER_EMAIL: RateLimitRule = {
  bucket: 'auth:challenge:email',
  limit: 5,
  windowSeconds: 15 * MINUTE,
  description: 'Sign-in requests for one email address',
};

export const EMAIL_CHALLENGE_PER_IP: RateLimitRule = {
  bucket: 'auth:challenge:ip',
  limit: 20,
  windowSeconds: HOUR,
  description: 'Sign-in requests from one network address',
};

/**
 * Verification attempts, counted per address rather than per challenge.
 *
 * The per-challenge count lives on the challenge row and caps one code at five
 * tries. This is the other half: without it, five tries per code and unlimited
 * codes is not a limit at all.
 */
export const CHALLENGE_VERIFICATION_PER_EMAIL: RateLimitRule = {
  bucket: 'auth:verify:email',
  limit: 20,
  windowSeconds: HOUR,
  description: 'Sign-in code and link verification attempts for one email address',
};

export const CHALLENGE_VERIFICATION_PER_IP: RateLimitRule = {
  bucket: 'auth:verify:ip',
  limit: 60,
  windowSeconds: HOUR,
  description: 'Sign-in verification attempts from one network address',
};

/** Second-factor verification, which an attacker reaches only after the first. */
export const SECOND_FACTOR_PER_USER: RateLimitRule = {
  bucket: 'auth:second_factor:user',
  limit: 10,
  windowSeconds: 15 * MINUTE,
  description: 'Second-factor attempts for one account',
};

/**
 * The installation's outbound mail budget (section 20).
 *
 * A circuit breaker rather than a per-user limit: an attacker enumerating a
 * thousand addresses stays under every per-address limit while exhausting the
 * SMTP quota the installation depends on for real sign-ins.
 */
export const AUTHENTICATION_MAIL_BUDGET: RateLimitRule = {
  bucket: 'auth:mail:installation',
  limit: 500,
  windowSeconds: HOUR,
  description: 'Authentication messages this installation will send in an hour',
};

/** Invitations, which cost the same mail budget and are owner-triggered. */
export const INVITATION_PER_BUSINESS: RateLimitRule = {
  bucket: 'member:invite:business',
  limit: 50,
  windowSeconds: HOUR,
  description: 'Invitations one business may send in an hour',
};

export const AUTHENTICATION_RULES: readonly RateLimitRule[] = [
  EMAIL_CHALLENGE_PER_EMAIL,
  EMAIL_CHALLENGE_PER_IP,
  CHALLENGE_VERIFICATION_PER_EMAIL,
  CHALLENGE_VERIFICATION_PER_IP,
  SECOND_FACTOR_PER_USER,
  AUTHENTICATION_MAIL_BUDGET,
  INVITATION_PER_BUSINESS,
];
