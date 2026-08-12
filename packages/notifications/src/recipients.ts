import { ownerPermissions } from '@eim/authz';
import { memberships, permissionGrants, users, type Database } from '@eim/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { Recipient } from './routing';

/**
 * Who is in a shop, and what they may be told (sections 5, 20, 22).
 *
 * Read at send time rather than kept as a list, because a stored recipient list
 * is a copy of the membership table that goes stale the moment somebody leaves
 * — and the stale copy keeps sending a former employee the shop's alerts.
 *
 * Two rules from section 20 apply here without being visible in the shape of
 * the query, so they are worth stating.
 *
 * A suspended membership is not a weaker membership. It is no membership at
 * all, and the filter below says so; a suspended member who kept receiving
 * critical alerts would be an access removal that did not remove access.
 *
 * Scope is deliberately ignored. A grant narrowed to one location still holds
 * the permission, and "may this person be told there is a problem" is not a
 * question about which location the problem is in. Narrowing what an alert says
 * would mean writing a second, quieter summary for scoped members, which is how
 * two versions of the truth get sent about one event.
 */
export async function listRecipients(
  db: Database,
  businessId: string,
): Promise<readonly Recipient[]> {
  const members = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      role: memberships.role,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, businessId), eq(memberships.status, 'active')));

  if (members.length === 0) {
    return [];
  }

  const grants = await db
    .select({
      membershipId: permissionGrants.membershipId,
      permission: permissionGrants.permission,
    })
    .from(permissionGrants)
    .where(
      and(
        eq(permissionGrants.businessId, businessId),
        inArray(
          permissionGrants.membershipId,
          members.map((member) => member.membershipId),
        ),
      ),
    );

  const byMembership = new Map<string, Set<string>>();
  for (const grant of grants) {
    const held = byMembership.get(grant.membershipId) ?? new Set<string>();
    held.add(grant.permission);
    byMembership.set(grant.membershipId, held);
  }

  // Section 5 gives owners every business permission implicitly, which is why
  // section 11's "notify all owners and users with
  // `receive_critical_inventory_alerts`" needs no special case anywhere.
  const owner: ReadonlySet<string> = new Set<string>(ownerPermissions());

  return members.map((member) => ({
    userId: member.userId,
    email: member.email,
    permissions:
      member.role === 'owner'
        ? owner
        : (byMembership.get(member.membershipId) ?? new Set<string>()),
  }));
}
