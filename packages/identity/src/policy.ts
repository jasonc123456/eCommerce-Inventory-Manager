/**
 * The session and step-up numbers from section 20, in one place.
 *
 * Every one of these is quoted from the specification rather than chosen here,
 * and they are gathered so that changing one is a visible edit to a file about
 * policy instead of a number adjusted inside a function about mechanism.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SessionPolicy {
  /** Idle timeout for an ordinary session. Section 20: twelve hours. */
  readonly idleMs: number;
  /** Absolute lifetime for an ordinary session. Section 20: seven days. */
  readonly absoluteMs: number;
  /** Idle timeout when the user asked to be remembered. Section 20: seven days. */
  readonly rememberedIdleMs: number;
  /** Absolute lifetime when remembered. Section 20: thirty days. */
  readonly rememberedAbsoluteMs: number;
  /**
   * How recently the user must have authenticated before a sensitive action.
   * Section 20: ten minutes.
   */
  readonly stepUpMs: number;
  /**
   * How stale the idle deadline may get before it is written back.
   *
   * Sliding the deadline on every request would mean an UPDATE per request on
   * the hottest row in the system for a change nobody can observe. A minute of
   * imprecision on a twelve-hour timeout is not a security property.
   */
  readonly idleWriteBackMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMs: 12 * HOUR,
  absoluteMs: 7 * DAY,
  rememberedIdleMs: 7 * DAY,
  rememberedAbsoluteMs: 30 * DAY,
  stepUpMs: 10 * MINUTE,
  idleWriteBackMs: MINUTE,
};

/**
 * The session cookie (section 20).
 *
 * Host-only with no Domain attribute, so a compromised or hostile subdomain
 * cannot read or set it. `__Host-` makes the browser enforce that rather than
 * trusting the server to have got the attributes right: the prefix is only
 * accepted when the cookie is Secure, has no Domain, and has Path=/.
 *
 * SameSite=Lax rather than Strict because a magic link arrives from a mail
 * client, and Strict would withhold the cookie on that first navigation, which
 * is the one request where the session was just created.
 */
export const SESSION_COOKIE_NAME = '__Host-eim_session';

/**
 * The browser-binding cookie for an eight-digit code challenge.
 *
 * Separate from the session cookie because it exists before there is a session,
 * and because it must survive being replaced when the session cookie is set.
 */
export const CHALLENGE_COOKIE_NAME = '__Host-eim_challenge';

export interface CookieAttributes {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

/**
 * Attributes for a session or challenge cookie.
 *
 * `secure` is unconditional, including in development. Browsers treat
 * `http://localhost` as a secure context and accept a Secure cookie from it, so
 * there is no case that needs the attribute relaxed — and making it conditional
 * would create one: a misconfigured `EIM_PUBLIC_URL` in production would then
 * silently drop the protection instead of failing visibly.
 *
 * It also has to be unconditional for the `__Host-` prefix to work at all, since
 * a browser rejects a `__Host-` cookie that is not Secure, has a Domain, or has
 * a path other than `/`.
 */
export function sessionCookieAttributes(maxAgeMs: number): CookieAttributes {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
