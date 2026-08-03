import { describe, expect, it } from 'vitest';

import { authorize, type PermissionGrant, type Subject } from './authorize';
import {
  BUSINESS_PERMISSIONS,
  INSTALLATION_PERMISSIONS,
  STEP_UP_PERMISSIONS,
  UNSCOPABLE_PERMISSIONS,
  isBusinessPermission,
  isInstallationPermission,
} from './permissions';
import { ROLE_TEMPLATES, ownerPermissions } from './roles';

const subject = (grants: readonly PermissionGrant[], isOwner = false): Subject => ({
  userId: 'user-1',
  isOwner,
  grants,
});

describe('catalogue integrity', () => {
  it('has no duplicate identifiers', () => {
    expect(new Set(BUSINESS_PERMISSIONS).size).toBe(BUSINESS_PERMISSIONS.length);
  });

  it('only references real permissions in the unscopable and step-up sets', () => {
    for (const permission of [...UNSCOPABLE_PERMISSIONS, ...STEP_UP_PERMISSIONS]) {
      expect(isBusinessPermission(permission)).toBe(true);
    }
  });

  it('only references real permissions in every role template', () => {
    for (const permissions of Object.values(ROLE_TEMPLATES)) {
      for (const permission of permissions) {
        expect(isBusinessPermission(permission)).toBe(true);
      }
    }
  });

  it('nests the templates, so a higher role never lacks a lower role capability', () => {
    const viewer = new Set(ROLE_TEMPLATES.viewer);
    const operator = new Set(ROLE_TEMPLATES.operator);
    const manager = new Set(ROLE_TEMPLATES.manager);

    for (const permission of viewer) {
      expect(operator.has(permission)).toBe(true);
    }
    for (const permission of operator) {
      expect(manager.has(permission)).toBe(true);
    }
  });

  it('withholds from Manager the capabilities the matrix marks as needing an explicit grant', () => {
    const manager = new Set(ROLE_TEMPLATES.manager);
    for (const permission of [
      'publish_listings',
      'publish_products',
      'change_prices',
      'cancel_jobs',
      'run_reconciliation',
      'apply_reconciliation_repairs',
      'manage_integrations',
      'manage_members',
      'delete_business',
    ] as const) {
      expect(manager.has(permission)).toBe(false);
    }
  });

  it('gives an owner every permission in the catalogue', () => {
    expect(new Set(ownerPermissions())).toEqual(new Set(BUSINESS_PERMISSIONS));
  });

  it('keeps the installation catalogue distinct from the business one', () => {
    expect(new Set(INSTALLATION_PERMISSIONS).size).toBe(INSTALLATION_PERMISSIONS.length);

    // Installation administration is a separate authority. An identifier
    // appearing in both catalogues would make it ambiguous which one a check
    // meant, and business owners must never be able to reach installation scope.
    for (const permission of INSTALLATION_PERMISSIONS) {
      expect(isBusinessPermission(permission)).toBe(false);
      expect(isInstallationPermission(permission)).toBe(true);
    }
    for (const permission of BUSINESS_PERMISSIONS) {
      expect(isInstallationPermission(permission)).toBe(false);
    }
  });

  it('omits host-level operations that no web session may invoke', () => {
    // Backup restoration, keyring rotation, and break-glass recovery are
    // deliberately absent (section 20). Their appearance here would mean someone
    // had exposed them to the application.
    for (const forbidden of ['restore_backup', 'rotate_keyring', 'break_glass_recovery']) {
      expect(isInstallationPermission(forbidden)).toBe(false);
    }
  });

  it('rejects an unknown identifier rather than treating it as valid', () => {
    expect(isBusinessPermission('not_a_permission')).toBe(false);
    expect(isInstallationPermission('not_a_permission')).toBe(false);
  });
});

describe('authorize', () => {
  it('allows an owner every permission without a grant record', () => {
    for (const permission of BUSINESS_PERMISSIONS) {
      expect(authorize(subject([], true), permission).allowed).toBe(true);
    }
  });

  it('denies a permission the subject was never granted', () => {
    const decision = authorize(subject([]), 'adjust_inventory');
    expect(decision).toStrictEqual({ allowed: false, reason: 'no_grant' });
  });

  it('allows a whole-business grant regardless of target', () => {
    const grants = [{ permission: 'adjust_inventory', scope: { kind: 'business' } }] as const;
    expect(authorize(subject(grants), 'adjust_inventory').allowed).toBe(true);
    expect(
      authorize(subject(grants), 'adjust_inventory', { locationIds: ['anything'] }).allowed,
    ).toBe(true);
  });

  describe('connection scoping', () => {
    const grants = [
      { permission: 'retry_jobs', scope: { kind: 'connections', connectionIds: ['conn-a'] } },
    ] as const;

    it('allows a job on a covered connection', () => {
      expect(authorize(subject(grants), 'retry_jobs', { connectionId: 'conn-a' }).allowed).toBe(
        true,
      );
    });

    it('denies a job on an uncovered connection', () => {
      expect(authorize(subject(grants), 'retry_jobs', { connectionId: 'conn-b' })).toStrictEqual({
        allowed: false,
        reason: 'scope_does_not_cover_target',
      });
    });

    it('fails closed when the caller does not say which connection', () => {
      expect(authorize(subject(grants), 'retry_jobs')).toStrictEqual({
        allowed: false,
        reason: 'target_not_specified',
      });
    });
  });

  describe('location scoping', () => {
    const grants = [
      {
        permission: 'view_order_pii',
        scope: { kind: 'locations', locationIds: ['north', 'south'] },
      },
    ] as const;

    it('allows an order allocated entirely within the scope', () => {
      expect(authorize(subject(grants), 'view_order_pii', { locationIds: ['north'] }).allowed).toBe(
        true,
      );
      expect(
        authorize(subject(grants), 'view_order_pii', { locationIds: ['north', 'south'] }).allowed,
      ).toBe(true);
    });

    it('denies an order that also touches an uncovered location', () => {
      expect(
        authorize(subject(grants), 'view_order_pii', { locationIds: ['north', 'east'] }).allowed,
      ).toBe(false);
    });

    it('fails closed on an empty location list rather than treating it as "no restriction"', () => {
      expect(authorize(subject(grants), 'view_order_pii', { locationIds: [] })).toStrictEqual({
        allowed: false,
        reason: 'target_not_specified',
      });
    });
  });

  describe('own-action scoping', () => {
    const grants = [{ permission: 'create_drafts', scope: { kind: 'own' } }] as const;

    it('allows the subject to act on their own record', () => {
      expect(
        authorize(subject(grants), 'create_drafts', { recordOwnerUserId: 'user-1' }).allowed,
      ).toBe(true);
    });

    it("denies acting on another user's record", () => {
      expect(
        authorize(subject(grants), 'create_drafts', { recordOwnerUserId: 'user-2' }).allowed,
      ).toBe(false);
    });
  });

  describe('unscopable permissions', () => {
    it('rejects a narrowed grant for every unscopable permission', () => {
      for (const permission of UNSCOPABLE_PERMISSIONS) {
        const narrowed = [
          { permission, scope: { kind: 'connections', connectionIds: ['conn-a'] } },
        ] as const satisfies readonly PermissionGrant[];

        expect(authorize(subject(narrowed), permission, { connectionId: 'conn-a' })).toStrictEqual({
          allowed: false,
          reason: 'permission_cannot_be_scoped',
        });
      }
    });

    it('accepts the whole-business grant for the same permissions', () => {
      for (const permission of UNSCOPABLE_PERMISSIONS) {
        const whole = [
          { permission, scope: { kind: 'business' } },
        ] as const satisfies readonly PermissionGrant[];
        expect(authorize(subject(whole), permission).allowed).toBe(true);
      }
    });

    it('still allows an owner, whose authority is not expressed as grants', () => {
      for (const permission of UNSCOPABLE_PERMISSIONS) {
        expect(authorize(subject([], true), permission).allowed).toBe(true);
      }
    });
  });

  it('allows when any one of several grants covers the target', () => {
    const grants = [
      { permission: 'retry_jobs', scope: { kind: 'connections', connectionIds: ['conn-a'] } },
      { permission: 'retry_jobs', scope: { kind: 'connections', connectionIds: ['conn-b'] } },
    ] as const;

    expect(authorize(subject(grants), 'retry_jobs', { connectionId: 'conn-b' }).allowed).toBe(true);
    expect(authorize(subject(grants), 'retry_jobs', { connectionId: 'conn-c' }).allowed).toBe(
      false,
    );
  });

  it('never allows a permission belonging to a different capability', () => {
    const grants = [{ permission: 'view_inventory', scope: { kind: 'business' } }] as const;
    expect(authorize(subject(grants), 'adjust_inventory').allowed).toBe(false);
  });
});
