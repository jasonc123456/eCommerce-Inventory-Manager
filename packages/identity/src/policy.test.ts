import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_COOKIE_NAME,
  DEFAULT_SESSION_POLICY,
  SESSION_COOKIE_NAME,
  sessionCookieAttributes,
} from './policy';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the session policy', () => {
  it('matches the numbers section 20 fixes', () => {
    expect(DEFAULT_SESSION_POLICY).toMatchObject({
      idleMs: 12 * HOUR,
      absoluteMs: 7 * DAY,
      rememberedIdleMs: 7 * DAY,
      rememberedAbsoluteMs: 30 * DAY,
      stepUpMs: 10 * MINUTE,
    });
  });

  it('never lets an idle deadline outlast an absolute one', () => {
    expect(DEFAULT_SESSION_POLICY.idleMs).toBeLessThan(DEFAULT_SESSION_POLICY.absoluteMs);
    expect(DEFAULT_SESSION_POLICY.rememberedIdleMs).toBeLessThan(
      DEFAULT_SESSION_POLICY.rememberedAbsoluteMs,
    );
  });

  it('makes remembering a device longer than not remembering it', () => {
    expect(DEFAULT_SESSION_POLICY.rememberedIdleMs).toBeGreaterThan(DEFAULT_SESSION_POLICY.idleMs);
    expect(DEFAULT_SESSION_POLICY.rememberedAbsoluteMs).toBeGreaterThan(
      DEFAULT_SESSION_POLICY.absoluteMs,
    );
  });

  it('keeps the idle write-back far below the timeout it approximates', () => {
    // A minute of imprecision on a twelve-hour timeout is not a security
    // property; an UPDATE per request on the hottest row is a real cost.
    expect(DEFAULT_SESSION_POLICY.idleWriteBackMs * 100).toBeLessThan(
      DEFAULT_SESSION_POLICY.idleMs,
    );
  });
});

describe('the session cookie', () => {
  it('uses the __Host- prefix, so the browser enforces the attributes', () => {
    // The prefix is only accepted when the cookie is Secure, has no Domain, and
    // has Path=/. That makes a hostile or compromised subdomain unable to set
    // or read it, without depending on the server having got it right.
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(CHALLENGE_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  it('separates the challenge cookie from the session cookie', () => {
    // The challenge cookie exists before there is a session and must survive
    // the session cookie being set.
    expect(CHALLENGE_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
  });

  it('is host-only, HttpOnly, Secure, and SameSite=Lax', () => {
    expect(sessionCookieAttributes(HOUR)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    });
  });

  it('is Secure even in development, so there is no branch to get wrong', () => {
    // Browsers accept a Secure cookie from http://localhost, so nothing needs
    // the attribute relaxed, and a conditional would let a misconfigured
    // public URL silently drop the protection in production.
    expect(sessionCookieAttributes(HOUR).secure).toBe(true);
  });

  it('is Lax rather than Strict, because a magic link arrives from a mail client', () => {
    // Strict would withhold the cookie on that first navigation, which is the
    // one request where the session was just created.
    expect(sessionCookieAttributes(HOUR).sameSite).toBe('lax');
  });

  it('expresses max-age in whole seconds', () => {
    expect(sessionCookieAttributes(1500).maxAge).toBe(1);
  });
});
