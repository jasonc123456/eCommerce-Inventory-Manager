import { UNSCOPABLE_PERMISSIONS, type BusinessPermission } from './permissions';

/**
 * Scoped grants (D-135).
 *
 * A scoped grant is the same permission narrowed at assignment time, never a
 * distinct weaker permission. Every decision here fails closed: if the caller
 * cannot describe what it is acting on, a narrowed grant cannot authorize it.
 */
export type GrantScope =
  | { readonly kind: 'business' }
  | { readonly kind: 'connections'; readonly connectionIds: readonly string[] }
  | { readonly kind: 'locations'; readonly locationIds: readonly string[] }
  | { readonly kind: 'own' };

export interface PermissionGrant {
  readonly permission: BusinessPermission;
  readonly scope: GrantScope;
}

export interface Subject {
  readonly userId: string;
  /** Owners hold every business permission implicitly and unconditionally. */
  readonly isOwner: boolean;
  readonly grants: readonly PermissionGrant[];
}

/** What the caller is acting on. Omitted fields mean "not applicable". */
export interface AuthorizationTarget {
  readonly connectionId?: string;
  /** Every location the action touches. A scoped grant must cover all of them. */
  readonly locationIds?: readonly string[];
  /** The user who owns the record, for own-action scoping. */
  readonly recordOwnerUserId?: string;
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly reason: 'owner' | 'grant' }
  | { readonly allowed: false; readonly reason: DenialReason };

export type DenialReason =
  | 'no_grant'
  | 'scope_does_not_cover_target'
  | 'target_not_specified'
  | 'permission_cannot_be_scoped';

/**
 * The single authorization decision point for business-scoped actions.
 *
 * Callers must treat a denial as final. The UI may hide a disabled action, but
 * hiding is never the control; this function is.
 */
export function authorize(
  subject: Subject,
  permission: BusinessPermission,
  target: AuthorizationTarget = {},
): AuthorizationDecision {
  if (subject.isOwner) {
    return { allowed: true, reason: 'owner' };
  }

  const matching = subject.grants.filter((grant) => grant.permission === permission);
  if (matching.length === 0) {
    return { allowed: false, reason: 'no_grant' };
  }

  if (UNSCOPABLE_PERMISSIONS.has(permission)) {
    const hasWholeBusiness = matching.some((grant) => grant.scope.kind === 'business');
    return hasWholeBusiness
      ? { allowed: true, reason: 'grant' }
      : { allowed: false, reason: 'permission_cannot_be_scoped' };
  }

  let sawUnspecifiedTarget = false;

  for (const grant of matching) {
    const outcome = scopeCovers(grant.scope, subject, target);
    if (outcome === 'covers') {
      return { allowed: true, reason: 'grant' };
    }
    if (outcome === 'target_not_specified') {
      sawUnspecifiedTarget = true;
    }
  }

  return {
    allowed: false,
    reason: sawUnspecifiedTarget ? 'target_not_specified' : 'scope_does_not_cover_target',
  };
}

type ScopeOutcome = 'covers' | 'does_not_cover' | 'target_not_specified';

function scopeCovers(
  scope: GrantScope,
  subject: Subject,
  target: AuthorizationTarget,
): ScopeOutcome {
  switch (scope.kind) {
    case 'business':
      return 'covers';

    case 'connections': {
      const connectionId = target.connectionId;
      if (connectionId === undefined) {
        return 'target_not_specified';
      }
      return scope.connectionIds.includes(connectionId) ? 'covers' : 'does_not_cover';
    }

    case 'locations': {
      const locationIds = target.locationIds;
      if (locationIds === undefined || locationIds.length === 0) {
        return 'target_not_specified';
      }
      // Every touched location must be covered. An order whose allocations span
      // a location the holder cannot see is not partially visible.
      const allowed = new Set(scope.locationIds);
      return locationIds.every((id) => allowed.has(id)) ? 'covers' : 'does_not_cover';
    }

    case 'own': {
      const owner = target.recordOwnerUserId;
      if (owner === undefined) {
        return 'target_not_specified';
      }
      return owner === subject.userId ? 'covers' : 'does_not_cover';
    }
  }
}
