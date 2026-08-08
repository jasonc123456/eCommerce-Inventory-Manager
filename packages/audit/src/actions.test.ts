import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, SECURITY_NOTIFYING_ACTIONS, isAuditAction } from './actions';

describe('the action catalogue', () => {
  it('has no duplicates', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('matches the shape the database enforces', () => {
    // The CHECK constraint in 0003_identity.sql. Disagreeing with it here would
    // mean an action that passes review and then fails at the moment it is
    // needed most, which is when something has gone wrong.
    //
    // Checked segment by segment rather than with the constraint's own pattern,
    // because a nested quantifier in JavaScript is a backtracking hazard even
    // when PostgreSQL evaluates the equivalent happily.
    for (const action of AUDIT_ACTIONS) {
      const segments = action.split('.');

      expect(segments.length).toBeGreaterThanOrEqual(2);
      for (const segment of segments) {
        expect(segment).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('groups by a meaningful prefix, so a filter is possible', () => {
    const prefixes = new Set(AUDIT_ACTIONS.map((action) => action.split('.')[0]));

    expect([...prefixes].sort()).toEqual([
      'auth',
      'authz',
      'business',
      'connection',
      'installation',
      'inventory',
      'listing',
      'member',
      'order',
      'user',
    ]);
  });

  it('only names real actions in the security-notification set', () => {
    for (const action of SECURITY_NOTIFYING_ACTIONS) {
      expect(isAuditAction(action)).toBe(true);
    }
  });

  it('covers every change section 20 requires a security notification for', () => {
    for (const action of [
      'auth.passkey.registered',
      'auth.totp.enabled',
      'auth.totp.disabled',
      'auth.recovery_codes.regenerated',
      'auth.session.revoked_all',
    ] as const) {
      expect(SECURITY_NOTIFYING_ACTIONS.has(action)).toBe(true);
    }
  });

  it('rejects an identifier that is not in the catalogue', () => {
    expect(isAuditAction('auth.login.succeeded')).toBe(true);
    expect(isAuditAction('auth.login.probably')).toBe(false);
  });
});
