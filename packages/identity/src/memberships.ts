import {
  ROLE_TEMPLATES,
  isBusinessPermission,
  type BusinessPermission,
  type GrantScope,
  type PermissionGrant as AuthzGrant,
  type Subject,
} from '@eim/authz';
import { generateToken, type KeyedHasher } from '@eim/crypto';
import {
  businesses,
  invitationPermissions,
  invitations,
  memberships,
  permissionGrantConnections,
  permissionGrantLocations,
  permissionGrants,
  users,
  type Database,
  type MembershipRole,
} from '@eim/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { normalizeEmail } from './challenges';

/**
 * Membership, invitations, and permission grants (sections 5 and 20).
 *
 * Every effective permission is a row in `permission_grants`. Role templates are
 * expanded at assignment time rather than consulted at check time, which is the
 * decision worth explaining: it means an authorization check reads one table,
 * and it means editing a template in a later release cannot silently widen what
 * existing members already hold. Re-applying a template is then a deliberate
 * act with an audit record, not a side effect of a deployment.
 *
 * Owners are the exception and hold no grant rows at all. Section 5 gives them
 * every permission implicitly and forbids removing one, so materializing them
 * would create a second source of truth that could drift — and a bug that
 * deleted a row would silently demote an owner.
 */

/** Section 20: invitations expire after seventy-two hours. */
const INVITATION_TTL_MS = 72 * 60 * 60_000;

export type MembershipWriter = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export interface GrantSpecification {
  readonly permission: BusinessPermission;
  readonly scope?: GrantScope;
}

export interface InviteInput {
  readonly businessId: string;
  readonly email: string;
  readonly role: MembershipRole;
  /** Extra grants on top of the role template, or the whole set for a custom role. */
  readonly permissions?: readonly GrantSpecification[];
  readonly invitedByUserId?: string | null;
  readonly now?: Date;
}

export type InviteResult =
  | {
      readonly outcome: 'invited';
      readonly invitationId: string;
      readonly token: string;
      readonly expiresAt: Date;
    }
  /** The business restricts invitations to approved domains (section 20). */
  | { readonly outcome: 'domain_not_allowed' }
  | { readonly outcome: 'already_a_member' }
  | { readonly outcome: 'already_invited' }
  | { readonly outcome: 'unknown_business' };

export type AcceptInvitationResult =
  | {
      readonly outcome: 'accepted';
      readonly membershipId: string;
      readonly userId: string;
      readonly businessId: string;
    }
  /** Unknown, expired, cancelled, or already accepted. One case on purpose. */
  | { readonly outcome: 'invalid' }
  /** The signed-in user is not the person the invitation was addressed to. */
  | { readonly outcome: 'wrong_recipient' };

export interface CreateBusinessInput {
  readonly name: string;
  /** Becomes the first owner. Section 5: a business always has at least one. */
  readonly ownerUserId: string;
  /** IANA zone. Section 9, D-136: quiet hours and the nightly window need one. */
  readonly timezone?: string;
}

export type CreateBusinessResult =
  | { readonly outcome: 'created'; readonly businessId: string; readonly slug: string }
  | { readonly outcome: 'invalid'; readonly reason: string };

export interface MembershipService {
  /**
   * Creates a business and makes somebody its owner.
   *
   * Both halves in one transaction, because a business with no owner is
   * unreachable: section 5 gives owners every permission implicitly and there is
   * no other way to grant the first one. A partial failure here would leave a
   * row nobody — including an installation administrator — could ever act on.
   */
  createBusiness(db: Database, input: CreateBusinessInput): Promise<CreateBusinessResult>;
  invite(db: Database, input: InviteInput): Promise<InviteResult>;
  cancelInvitation(
    db: MembershipWriter,
    invitationId: string,
    cancelledByUserId: string,
    now?: Date,
  ): Promise<boolean>;
  acceptInvitation(
    db: Database,
    token: string,
    options?: { readonly userId?: string; readonly now?: Date },
  ): Promise<AcceptInvitationResult>;
  changeRole(
    db: Database,
    businessId: string,
    membershipId: string,
    role: MembershipRole,
  ): Promise<void>;
  setGrants(
    db: Database,
    businessId: string,
    membershipId: string,
    grants: readonly GrantSpecification[],
  ): Promise<void>;
  suspend(db: MembershipWriter, membershipId: string, now?: Date): Promise<void>;
  reinstate(db: MembershipWriter, membershipId: string): Promise<void>;
  remove(db: MembershipWriter, membershipId: string): Promise<void>;
  /** The authorization subject for a user in a business, or null if they have none. */
  loadSubject(db: MembershipWriter, businessId: string, userId: string): Promise<Subject | null>;
  listBusinessesFor(
    db: MembershipWriter,
    userId: string,
  ): Promise<{ businessId: string; name: string; slug: string; role: MembershipRole }[]>;
}

export function createMembershipService(hasher: KeyedHasher): MembershipService {
  return {
    async createBusiness(db, input) {
      const name = input.name.trim();

      if (name.length === 0) {
        return { outcome: 'invalid', reason: 'give the business a name' };
      }

      if (name.length > 120) {
        return { outcome: 'invalid', reason: 'that name is too long' };
      }

      const timezone = (input.timezone ?? 'UTC').trim();

      if (!isKnownTimezone(timezone)) {
        return { outcome: 'invalid', reason: `${timezone} is not a time zone this system knows` };
      }

      return db.transaction(async (tx) => {
        const slug = await uniqueSlug(tx, name);

        const [created] = await tx
          .insert(businesses)
          .values({ name, slug, timezone })
          .returning({ id: businesses.id, slug: businesses.slug });

        if (created === undefined) {
          return { outcome: 'invalid', reason: 'the business could not be created' };
        }

        // Owners hold no grant rows by design — section 5 gives them every
        // permission implicitly — so this single row is the whole authority.
        await tx.insert(memberships).values({
          businessId: created.id,
          userId: input.ownerUserId,
          role: 'owner',
          status: 'active',
        });

        return { outcome: 'created', businessId: created.id, slug: created.slug };
      });
    },

    async invite(db, input) {
      const now = input.now ?? new Date();
      const normalized = normalizeEmail(input.email);

      const [business] = await db
        .select({ allowedEmailDomains: businesses.allowedEmailDomains })
        .from(businesses)
        .where(and(eq(businesses.id, input.businessId), isNull(businesses.deletedAt)));

      if (business === undefined) {
        return { outcome: 'unknown_business' };
      }

      if (!domainAllowed(normalized, business.allowedEmailDomains)) {
        return { outcome: 'domain_not_allowed' };
      }

      const [existing] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.businessId, input.businessId),
            eq(sql`lower(${users.email})`, normalized),
            isNull(users.deletedAt),
          ),
        );

      if (existing !== undefined) {
        return { outcome: 'already_a_member' };
      }

      const token = generateToken();
      const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
      const grants = resolveGrants(input.role, input.permissions);

      try {
        return await db.transaction(async (tx) => {
          const [invitation] = await tx
            .insert(invitations)
            .values({
              businessId: input.businessId,
              email: normalized,
              tokenHash: hasher.hash('invitation', token),
              role: input.role,
              invitedByUserId: input.invitedByUserId ?? null,
              createdAt: now,
              expiresAt,
            })
            .returning({ id: invitations.id });

          if (invitation === undefined) {
            throw new Error('the invitation could not be created');
          }

          if (grants.length > 0) {
            await tx.insert(invitationPermissions).values(
              grants.map((grant) => ({
                invitationId: invitation.id,
                permission: grant.permission,
                scopeKind: grant.scope?.kind ?? ('business' as const),
              })),
            );
          }

          return { outcome: 'invited' as const, invitationId: invitation.id, token, expiresAt };
        });
      } catch (error: unknown) {
        // The partial unique index on live invitations. Racing two invitations
        // for the same address is a real case — two owners acting at once — and
        // the second one losing is the correct outcome, not an error page.
        if (isUniqueViolation(error, 'invitations_one_outstanding')) {
          return { outcome: 'already_invited' };
        }

        throw error;
      }
    },

    async cancelInvitation(db, invitationId, cancelledByUserId, now = new Date()) {
      const cancelled = await db
        .update(invitations)
        .set({ cancelledAt: now, cancelledByUserId })
        .where(
          and(
            eq(invitations.id, invitationId),
            isNull(invitations.acceptedAt),
            isNull(invitations.cancelledAt),
          ),
        )
        .returning({ id: invitations.id });

      return cancelled.length > 0;
    },

    async acceptInvitation(db, token, options = {}) {
      const now = options.now ?? new Date();

      const [invitation] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hasher.hash('invitation', token)));

      if (invitation === undefined) {
        return { outcome: 'invalid' };
      }

      // Used, cancelled, and expired collapse to one answer. Distinguishing
      // them would tell whoever holds a stale link whether the address it names
      // ever joined the business.
      if (
        invitation.acceptedAt !== null ||
        invitation.cancelledAt !== null ||
        invitation.expiresAt.getTime() <= now.getTime()
      ) {
        return { outcome: 'invalid' };
      }

      return await db.transaction(async (tx) => {
        // Section 20 verifies the invited email on acceptance. A signed-in user
        // accepting an invitation addressed to somebody else is the case this
        // catches, and it is not hypothetical: forwarded mail is ordinary.
        let userId = options.userId;

        if (userId !== undefined) {
          const [user] = await tx
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId));

          if (user === undefined || normalizeEmail(user.email) !== invitation.email) {
            return { outcome: 'wrong_recipient' as const };
          }
        } else {
          const [existing] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(sql`lower(${users.email})`, invitation.email), isNull(users.deletedAt)));

          if (existing === undefined) {
            // Registration is invitation-only, and this is the invitation. The
            // successful challenge that got here already proved the address.
            const [created] = await tx
              .insert(users)
              .values({ email: invitation.email })
              .returning({ id: users.id });

            if (created === undefined) {
              throw new Error('the invited account could not be created');
            }

            userId = created.id;
          } else {
            userId = existing.id;
          }
        }

        // Conditional, so two acceptances of one invitation cannot both create
        // a membership.
        const accepted = await tx
          .update(invitations)
          .set({ acceptedAt: now, acceptedByUserId: userId })
          .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt)))
          .returning({ id: invitations.id });

        if (accepted.length === 0) {
          return { outcome: 'invalid' as const };
        }

        const [membership] = await tx
          .insert(memberships)
          .values({
            businessId: invitation.businessId,
            userId,
            role: invitation.role,
            invitedByUserId: invitation.invitedByUserId,
          })
          .returning({ id: memberships.id });

        if (membership === undefined) {
          throw new Error('the membership could not be created');
        }

        const proposed = await tx
          .select()
          .from(invitationPermissions)
          .where(eq(invitationPermissions.invitationId, invitation.id));

        // The permissions the owner chose when they sent it, not a template
        // re-derived now: the template may have changed in between.
        await writeGrants(
          tx,
          invitation.businessId,
          membership.id,
          proposed
            .filter((row) => isBusinessPermission(row.permission))
            .map((row) => ({
              permission: row.permission as BusinessPermission,
              scope: { kind: row.scopeKind } as GrantScope,
            })),
          invitation.invitedByUserId,
        );

        return {
          outcome: 'accepted' as const,
          membershipId: membership.id,
          userId,
          businessId: invitation.businessId,
        };
      });
    },

    async changeRole(db, businessId, membershipId, role) {
      await db.transaction(async (tx) => {
        await tx
          .update(memberships)
          .set({ role })
          .where(and(eq(memberships.id, membershipId), eq(memberships.businessId, businessId)));

        await writeGrants(tx, businessId, membershipId, resolveGrants(role), null);
      });
    },

    async setGrants(db, businessId, membershipId, grants) {
      await db.transaction(async (tx) => {
        await writeGrants(tx, businessId, membershipId, grants, null);
      });
    },

    async suspend(db, membershipId, now = new Date()) {
      await db
        .update(memberships)
        .set({ status: 'suspended', suspendedAt: now })
        .where(eq(memberships.id, membershipId));
    },

    async reinstate(db, membershipId) {
      await db
        .update(memberships)
        .set({ status: 'active', suspendedAt: null })
        .where(eq(memberships.id, membershipId));
    },

    async remove(db, membershipId) {
      // The grants go with it by cascade, and the final-owner trigger refuses
      // the delete if this is the last owner.
      await db.delete(memberships).where(eq(memberships.id, membershipId));
    },

    async loadSubject(db, businessId, userId) {
      const [membership] = await db
        .select({ id: memberships.id, role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, userId)));

      // A suspended membership is not a weaker membership. Section 20 removes
      // that business's access immediately, which means no subject at all
      // rather than a subject holding nothing.
      if (membership?.status !== 'active') {
        return null;
      }

      if (membership.role === 'owner') {
        // No grant rows are read. Section 5 gives owners every permission
        // implicitly, and `authorize` short-circuits on this flag.
        return { userId, isOwner: true, grants: [] };
      }

      const rows = await db
        .select()
        .from(permissionGrants)
        .where(
          and(
            eq(permissionGrants.membershipId, membership.id),
            eq(permissionGrants.businessId, businessId),
          ),
        );

      // Only the scopes belonging to this member's own grants. Selecting every
      // scope row in the business would grow with the business rather than with
      // the member, on a query that runs on every authenticated request.
      const grantIds = rows.map((row) => row.id);

      const locationRows =
        grantIds.length === 0
          ? []
          : await db
              .select()
              .from(permissionGrantLocations)
              .where(inArray(permissionGrantLocations.grantId, grantIds));

      const connectionRows =
        grantIds.length === 0
          ? []
          : await db
              .select()
              .from(permissionGrantConnections)
              .where(inArray(permissionGrantConnections.grantId, grantIds));

      const grants: AuthzGrant[] = [];

      for (const row of rows) {
        if (!isBusinessPermission(row.permission)) {
          // A permission this build does not recognise, which happens when a
          // backup written by a newer version is restored. Ignored rather than
          // guessed at: an unknown permission must not become an allowed one.
          continue;
        }

        grants.push({
          permission: row.permission,
          scope: buildScope(row.scopeKind, row.id, locationRows, connectionRows),
        });
      }

      return { userId, isOwner: false, grants };
    },

    async listBusinessesFor(db, userId) {
      return await db
        .select({
          businessId: businesses.id,
          name: businesses.name,
          slug: businesses.slug,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(businesses, eq(businesses.id, memberships.businessId))
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
            isNull(businesses.deletedAt),
          ),
        )
        .orderBy(businesses.name);
    },
  };
}

/**
 * The grants a role and any extras add up to.
 *
 * Owner returns nothing, because an owner's authority does not come from rows.
 */
function resolveGrants(
  role: MembershipRole,
  extra: readonly GrantSpecification[] = [],
): readonly GrantSpecification[] {
  if (role === 'owner') {
    return [];
  }

  const merged = new Map<string, GrantSpecification>();

  for (const permission of ROLE_TEMPLATES[role]) {
    merged.set(`${permission}|business`, { permission });
  }

  // Applied second, so an explicitly narrowed grant replaces the template's
  // unscoped one rather than sitting alongside it and widening it back.
  for (const specification of extra) {
    const kind = specification.scope?.kind ?? 'business';
    merged.delete(`${specification.permission}|business`);
    merged.set(`${specification.permission}|${kind}`, specification);
  }

  return [...merged.values()];
}

/**
 * Replaces a membership's grants with exactly the set given.
 *
 * Delete and re-insert rather than a diff, because the set is small and the
 * alternative is three code paths that have to agree about what "the same
 * grant" means. Runs inside the caller's transaction, so there is no instant at
 * which the member holds nothing.
 */
async function writeGrants(
  tx: MembershipWriter,
  businessId: string,
  membershipId: string,
  grants: readonly GrantSpecification[],
  grantedByUserId: string | null,
): Promise<void> {
  await tx
    .delete(permissionGrants)
    .where(
      and(
        eq(permissionGrants.membershipId, membershipId),
        eq(permissionGrants.businessId, businessId),
      ),
    );

  for (const grant of grants) {
    const scope = grant.scope ?? { kind: 'business' };

    const [row] = await tx
      .insert(permissionGrants)
      .values({
        businessId,
        membershipId,
        permission: grant.permission,
        scopeKind: scope.kind,
        grantedByUserId,
      })
      .returning({ id: permissionGrants.id });

    if (row === undefined) {
      throw new Error(`the grant of ${grant.permission} could not be written`);
    }

    if (scope.kind === 'locations' && scope.locationIds.length > 0) {
      await tx
        .insert(permissionGrantLocations)
        .values(
          scope.locationIds.map((locationId) => ({ businessId, grantId: row.id, locationId })),
        );
    }

    if (scope.kind === 'connections' && scope.connectionIds.length > 0) {
      await tx.insert(permissionGrantConnections).values(
        scope.connectionIds.map((connectionId) => ({
          businessId,
          grantId: row.id,
          connectionId,
        })),
      );
    }
  }
}

function buildScope(
  kind: string,
  grantId: string,
  locationRows: readonly { grantId: string; locationId: string }[],
  connectionRows: readonly { grantId: string; connectionId: string }[],
): GrantScope {
  switch (kind) {
    case 'locations':
      return {
        kind: 'locations',
        locationIds: locationRows
          .filter((row) => row.grantId === grantId)
          .map((row) => row.locationId),
      };
    case 'connections':
      return {
        kind: 'connections',
        connectionIds: connectionRows
          .filter((row) => row.grantId === grantId)
          .map((row) => row.connectionId),
      };
    case 'own':
      return { kind: 'own' };
    default:
      return { kind: 'business' };
  }
}

/**
 * Whether an address may be invited to a business (section 20).
 *
 * An empty list means no restriction, which has to stay distinguishable from
 * "restricted to nothing": a business that has configured no domains must not
 * find that nobody can be invited.
 */
/**
 * Whether the runtime recognizes this zone.
 *
 * Asked of the platform rather than checked against a list, because a list
 * shipped in this repository is a list that is wrong the next time a government
 * moves a clock. Quiet hours and the nightly reconciliation window are computed
 * in the shop's zone (D-136), so storing one nothing can resolve would make both
 * silently wrong rather than loudly broken.
 */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A readable, unique slug for a name somebody typed.
 *
 * The slug is a stable handle in URLs and logs, so it is derived once at
 * creation and never recomputed from a renamed business — a slug that followed
 * the name would break every link that had already been shared.
 *
 * Collisions get a numeric suffix rather than a random one, because the second
 * "Widgets" being `widgets-2` is something a person can read and predict.
 */
async function uniqueSlug(db: MembershipWriter, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      // Strip accents, then anything that is not a letter, digit, or separator.
      .replace(/[̀-ͯ]/gu, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48) || 'business';

  const taken = await db
    .select({ slug: businesses.slug })
    .from(businesses)
    .where(sql`${businesses.slug} = ${base} or ${businesses.slug} like ${`${base}-%`}`);

  const used = new Set(taken.map((row) => row.slug));

  if (!used.has(base)) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  // A thousand businesses sharing one name is not a case worth a cleverer
  // scheme; it is a case worth a name nobody will collide with again.
  return `${base}-${Date.now().toString(36)}`;
}

export function domainAllowed(normalizedEmail: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) {
    return true;
  }

  const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);

  return allowedDomains.some((allowed) => allowed.trim().toLowerCase() === domain);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error, depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      break;
    }

    const candidate = current as Error & { code?: unknown; constraint?: unknown };

    if (candidate.code === '23505' && String(candidate.constraint) === constraint) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}
