import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  businesses,
  installationAdministrators,
  installationBootstrap,
  invitations,
  locations,
  loginChallenges,
  memberships,
  permissionGrantLocations,
  permissionGrants,
  recoveryCodes,
  sessions,
  totpCredentials,
  users,
  webauthnCredentials,
} from './index';

/**
 * Proof that the identity schema enforces what section 20 says it enforces.
 *
 * The same discipline as `schema.integration.test.ts`: almost every assertion
 * here is "this write must be impossible". Authentication is the area where an
 * application-only check is least defensible, because the code paths that reach
 * these tables are the ones an attacker is actively trying to find a way around.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

/** A user with a unique address, since the email unique index is installation-wide. */
async function createUser(label = 'user'): Promise<string> {
  sequence += 1;
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${label}-${String(sequence)}@example.invalid` })
    .returning({ id: users.id });

  return user!.id;
}

/**
 * A business with an owner.
 *
 * The owner is not optional scaffolding. The final-owner trigger from
 * `0001_foundation.sql` fires on every membership change, so a business created
 * without one cannot have any membership updated or removed afterwards, and a
 * test that omitted it would be testing an impossible state.
 */
async function createBusiness(label = 'business'): Promise<string> {
  sequence += 1;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${String(sequence)}`, slug: `${label}-${String(sequence)}` })
    .returning({ id: businesses.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: await createUser('owner'), role: 'owner' });

  return business!.id;
}

async function createMembership(
  businessId: string,
  userId: string,
  role: 'owner' | 'manager' | 'operator' | 'viewer' = 'manager',
): Promise<string> {
  const [membership] = await harness.db
    .insert(memberships)
    .values({ businessId, userId, role })
    .returning({ id: memberships.id });

  return membership!.id;
}

const inAnHour = (): Date => new Date(Date.now() + 3_600_000);

describe('permission grants', () => {
  it('cannot name a membership in another business', async () => {
    // The isolation invariant that has to hold when application authorization is
    // wrong: a grant carries business_id alongside the membership reference, so
    // the pair must exist together or the write fails.
    const businessA = await createBusiness();
    const businessB = await createBusiness();
    const membership = await createMembership(businessA, await createUser());

    const reason = await refuses(() =>
      harness.db.insert(permissionGrants).values({
        businessId: businessB,
        membershipId: membership,
        permission: 'view_inventory',
      }),
    );

    expect(reason).toMatch(/permission_grants_membership_fkey/);
  });

  it('cannot cover a location belonging to another business', async () => {
    const businessA = await createBusiness();
    const businessB = await createBusiness();
    const membership = await createMembership(businessA, await createUser());

    const [grant] = await harness.db
      .insert(permissionGrants)
      .values({
        businessId: businessA,
        membershipId: membership,
        permission: 'view_orders',
        scopeKind: 'locations',
      })
      .returning({ id: permissionGrants.id });

    const [foreignLocation] = await harness.db
      .insert(locations)
      .values({ businessId: businessB, code: 'FOREIGN', name: 'Someone else' })
      .returning({ id: locations.id });

    const reason = await refuses(() =>
      harness.db.insert(permissionGrantLocations).values({
        businessId: businessA,
        grantId: grant!.id,
        locationId: foreignLocation!.id,
      }),
    );

    expect(reason).toMatch(/permission_grant_locations_location_fkey/);
  });

  it('holds one row per membership, permission, and scope kind', async () => {
    const businessId = await createBusiness();
    const membership = await createMembership(businessId, await createUser());

    await harness.db
      .insert(permissionGrants)
      .values({ businessId, membershipId: membership, permission: 'view_inventory' });

    const reason = await refuses(() =>
      harness.db
        .insert(permissionGrants)
        .values({ businessId, membershipId: membership, permission: 'view_inventory' }),
    );

    expect(reason).toMatch(/permission_grants_unique/);
  });

  it('rejects a scope kind the authorization code does not implement', async () => {
    const businessId = await createBusiness();
    const membership = await createMembership(businessId, await createUser());

    const reason = await refuses(() =>
      harness.db.execute(sql`
        insert into permission_grants (business_id, membership_id, permission, scope_kind)
        values (${businessId}, ${membership}, 'view_inventory', 'everything')
      `),
    );

    expect(reason).toMatch(/permission_grants_scope_kind_valid/);
  });

  it('disappears with the membership it belongs to', async () => {
    // Removing someone from a business must not leave their grants behind for a
    // later membership row to inherit by id reuse.
    const businessId = await createBusiness();
    const userId = await createUser();
    const membership = await createMembership(businessId, userId);

    const [grant] = await harness.db
      .insert(permissionGrants)
      .values({ businessId, membershipId: membership, permission: 'view_inventory' })
      .returning({ id: permissionGrants.id });

    await harness.db.delete(memberships).where(eq(memberships.id, membership));

    const remaining = await harness.db
      .select()
      .from(permissionGrants)
      .where(eq(permissionGrants.id, grant!.id));

    expect(remaining).toHaveLength(0);
  });
});

describe('invitations', () => {
  it('permits only one outstanding invitation per address per business', async () => {
    const businessId = await createBusiness();

    await harness.db.insert(invitations).values({
      businessId,
      email: 'invitee@example.invalid',
      tokenHash: `hash-${String((sequence += 1))}`,
      role: 'viewer',
      expiresAt: inAnHour(),
    });

    const reason = await refuses(() =>
      harness.db.insert(invitations).values({
        businessId,
        // Case-insensitively the same address: an owner inviting `Invitee@` a
        // second time must not create a second live link.
        email: 'Invitee@example.invalid',
        tokenHash: `hash-${String((sequence += 1))}`,
        role: 'viewer',
        expiresAt: inAnHour(),
      }),
    );

    expect(reason).toMatch(/invitations_one_outstanding/);
  });

  it('allows a fresh invitation once the previous one is cancelled', async () => {
    const businessId = await createBusiness();

    const [first] = await harness.db
      .insert(invitations)
      .values({
        businessId,
        email: 'repeat@example.invalid',
        tokenHash: `hash-${String((sequence += 1))}`,
        role: 'viewer',
        expiresAt: inAnHour(),
      })
      .returning({ id: invitations.id });

    await harness.db
      .update(invitations)
      .set({ cancelledAt: new Date() })
      .where(eq(invitations.id, first!.id));

    await expect(
      harness.db.insert(invitations).values({
        businessId,
        email: 'repeat@example.invalid',
        tokenHash: `hash-${String((sequence += 1))}`,
        role: 'viewer',
        expiresAt: inAnHour(),
      }),
    ).resolves.toBeDefined();
  });

  it('cannot be both accepted and cancelled', async () => {
    const businessId = await createBusiness();

    const [invitation] = await harness.db
      .insert(invitations)
      .values({
        businessId,
        email: 'outcome@example.invalid',
        tokenHash: `hash-${String((sequence += 1))}`,
        role: 'viewer',
        expiresAt: inAnHour(),
      })
      .returning({ id: invitations.id });

    const reason = await refuses(() =>
      harness.db
        .update(invitations)
        .set({ acceptedAt: new Date(), cancelledAt: new Date() })
        .where(eq(invitations.id, invitation!.id)),
    );

    expect(reason).toMatch(/invitations_single_outcome/);
  });

  it('rejects a token hash already in use', async () => {
    const businessId = await createBusiness();
    const tokenHash = `shared-${String((sequence += 1))}`;

    await harness.db.insert(invitations).values({
      businessId,
      email: 'one@example.invalid',
      tokenHash,
      role: 'viewer',
      expiresAt: inAnHour(),
    });

    const reason = await refuses(() =>
      harness.db.insert(invitations).values({
        businessId,
        email: 'two@example.invalid',
        tokenHash,
        role: 'viewer',
        expiresAt: inAnHour(),
      }),
    );

    expect(reason).toMatch(/invitations_token_hash_unique/);
  });
});

describe('login challenges', () => {
  const challenge = (
    overrides: Partial<typeof loginChallenges.$inferInsert> = {},
  ): typeof loginChallenges.$inferInsert => ({
    emailFingerprint: `fingerprint-${String((sequence += 1))}`,
    method: 'magic_link',
    secretHash: `secret-${String((sequence += 1))}`,
    expiresAt: inAnHour(),
    ...overrides,
  });

  it('accepts a challenge for an address that belongs to no account', async () => {
    // The enumeration defence depends on this. An unknown address must take the
    // same path as a known one, which means writing a row with no user.
    await expect(harness.db.insert(loginChallenges).values(challenge())).resolves.toBeDefined();
  });

  it('permits only one live challenge per address and purpose', async () => {
    const fingerprint = `fingerprint-${String((sequence += 1))}`;

    await harness.db.insert(loginChallenges).values(challenge({ emailFingerprint: fingerprint }));

    const reason = await refuses(() =>
      harness.db.insert(loginChallenges).values(challenge({ emailFingerprint: fingerprint })),
    );

    expect(reason).toMatch(/login_challenges_one_active/);
  });

  it('frees the slot once the previous challenge is superseded', async () => {
    const fingerprint = `fingerprint-${String((sequence += 1))}`;

    const [first] = await harness.db
      .insert(loginChallenges)
      .values(challenge({ emailFingerprint: fingerprint }))
      .returning({ id: loginChallenges.id });

    await harness.db
      .update(loginChallenges)
      .set({ supersededAt: new Date() })
      .where(eq(loginChallenges.id, first!.id));

    await expect(
      harness.db.insert(loginChallenges).values(challenge({ emailFingerprint: fingerprint })),
    ).resolves.toBeDefined();
  });

  it('separates purposes, so a step-up does not evict a login', async () => {
    const fingerprint = `fingerprint-${String((sequence += 1))}`;

    await harness.db.insert(loginChallenges).values(challenge({ emailFingerprint: fingerprint }));

    await expect(
      harness.db
        .insert(loginChallenges)
        .values(challenge({ emailFingerprint: fingerprint, purpose: 'step_up' })),
    ).resolves.toBeDefined();
  });

  it('requires an eight-digit code to be bound to the requesting browser', async () => {
    const reason = await refuses(() =>
      harness.db
        .insert(loginChallenges)
        .values(challenge({ method: 'email_code', browserBindingHash: null })),
    );

    expect(reason).toMatch(/login_challenges_code_is_browser_bound/);
  });

  it('refuses a redirect that leaves this origin', async () => {
    // An open redirect on an authentication callback is the difference between a
    // phishing attempt that fails and one that succeeds.
    for (const redirectPath of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      const reason = await refuses(() =>
        harness.db.insert(loginChallenges).values(challenge({ redirectPath })),
      );

      expect(reason).toMatch(/login_challenges_redirect_is_local/);
    }
  });

  it('accepts a local redirect path', async () => {
    await expect(
      harness.db.insert(loginChallenges).values(challenge({ redirectPath: '/inventory' })),
    ).resolves.toBeDefined();
  });

  it('refuses more attempts than the challenge allows', async () => {
    const reason = await refuses(() =>
      harness.db.insert(loginChallenges).values(challenge({ attempts: 6, maxAttempts: 5 })),
    );

    expect(reason).toMatch(/login_challenges_attempts_bounded/);
  });
});

describe('sessions', () => {
  const session = (
    userId: string,
    overrides: Partial<typeof sessions.$inferInsert> = {},
  ): typeof sessions.$inferInsert => ({
    userId,
    tokenHash: `session-${String((sequence += 1))}`,
    idleExpiresAt: inAnHour(),
    absoluteExpiresAt: inAnHour(),
    ...overrides,
  });

  it('rejects a duplicate token hash', async () => {
    const userId = await createUser();
    const tokenHash = `shared-session-${String((sequence += 1))}`;

    await harness.db.insert(sessions).values(session(userId, { tokenHash }));

    const otherUserId = await createUser();
    const reason = await refuses(() =>
      harness.db.insert(sessions).values(session(otherUserId, { tokenHash })),
    );

    expect(reason).toMatch(/sessions_token_hash_unique/);
  });

  it('rejects an absolute expiry that has already passed at creation', async () => {
    const userId = await createUser();

    const reason = await refuses(() =>
      harness.db
        .insert(sessions)
        .values(session(userId, { absoluteExpiresAt: new Date(Date.now() - 1000) })),
    );

    expect(reason).toMatch(/sessions_absolute_after_creation/);
  });

  it('rejects a revocation reason the code does not produce', async () => {
    const userId = await createUser();
    const [row] = await harness.db
      .insert(sessions)
      .values(session(userId))
      .returning({ id: sessions.id });

    const reason = await refuses(() =>
      harness.db.execute(sql`
        update sessions set revoked_at = now(), revoked_reason = 'because'
        where id = ${row!.id}
      `),
    );

    expect(reason).toMatch(/sessions_revoked_reason_valid/);
  });

  it('disappears with the user, so a deleted account leaves no live session', async () => {
    const userId = await createUser();
    await harness.db.insert(sessions).values(session(userId));

    await harness.db.delete(users).where(eq(users.id, userId));

    const remaining = await harness.db.select().from(sessions).where(eq(sessions.userId, userId));

    expect(remaining).toHaveLength(0);
  });
});

describe('passkeys and second factors', () => {
  it('refuses the same authenticator credential for two users', async () => {
    const credentialId = `credential-${String((sequence += 1))}`;

    await harness.db.insert(webauthnCredentials).values({
      userId: await createUser(),
      credentialId,
      publicKey: Buffer.from('key'),
      name: 'Laptop',
    });

    const otherUserId = await createUser();
    const reason = await refuses(() =>
      harness.db.insert(webauthnCredentials).values({
        userId: otherUserId,
        credentialId,
        publicKey: Buffer.from('key'),
        name: 'Also laptop',
      }),
    );

    expect(reason).toMatch(/webauthn_credentials_credential_id_unique/);
  });

  it('refuses an unnamed credential, because the devices screen has to list it', async () => {
    const userId = await createUser();
    const reason = await refuses(() =>
      harness.db.insert(webauthnCredentials).values({
        userId,
        credentialId: `credential-${String((sequence += 1))}`,
        publicKey: Buffer.from('key'),
        name: '   ',
      }),
    );

    expect(reason).toMatch(/webauthn_credentials_name_present/);
  });

  it('refuses a TOTP credential marked active with no activation time', async () => {
    const userId = await createUser();
    const reason = await refuses(() =>
      harness.db.insert(totpCredentials).values({
        userId,
        encryptedSeed: 'eim1.1.a.b.c',
        status: 'active',
      }),
    );

    expect(reason).toMatch(/totp_credentials_activation_consistent/);
  });

  it('refuses the same recovery code twice for one user', async () => {
    const userId = await createUser();
    const codeHash = `recovery-${String((sequence += 1))}`;
    const batchId = crypto.randomUUID();

    await harness.db.insert(recoveryCodes).values({ userId, codeHash, batchId });

    const reason = await refuses(() =>
      harness.db.insert(recoveryCodes).values({ userId, codeHash, batchId }),
    );

    expect(reason).toMatch(/recovery_codes_hash_unique/);
  });
});

describe('installation administration', () => {
  it('starts with bootstrap open and exactly one state row', async () => {
    const rows = await harness.db.select().from(installationBootstrap);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.completedAt).toBeNull();
  });

  it('cannot hold a second bootstrap row', async () => {
    const reason = await refuses(() =>
      harness.db.execute(sql`insert into installation_bootstrap (id) values (false)`),
    );

    expect(reason).toMatch(/installation_bootstrap_single_row/);
  });

  it('refuses to give up its last active administrator', async () => {
    const userId = await createUser();
    await harness.db.insert(installationAdministrators).values({ userId });

    const reason = await refuses(() =>
      harness.db
        .delete(installationAdministrators)
        .where(eq(installationAdministrators.userId, userId)),
    );

    expect(reason).toMatch(/must retain at least one active administrator/);

    await harness.db
      .delete(installationAdministrators)
      .where(eq(installationAdministrators.userId, userId))
      .catch(() => undefined);
  });

  it('permits a handover inside one transaction', async () => {
    // Deferred to commit precisely so this works: promoting the replacement and
    // removing the incumbent is legal together and illegal apart.
    const outgoing = await createUser();
    const incoming = await createUser();

    await harness.db.insert(installationAdministrators).values({ userId: outgoing });

    await expect(
      harness.db.transaction(async (tx) => {
        await tx.insert(installationAdministrators).values({ userId: incoming });
        await tx
          .delete(installationAdministrators)
          .where(eq(installationAdministrators.userId, outgoing));
      }),
    ).resolves.toBeUndefined();

    const remaining = await harness.db.select().from(installationAdministrators);
    expect(remaining.map((row) => row.userId)).toContain(incoming);
  });

  it('rejects an installation permission the code does not recognise', async () => {
    const userId = await createUser();
    await harness.db.insert(installationAdministrators).values({ userId });

    const reason = await refuses(() =>
      harness.db.execute(sql`
        insert into installation_administrator_permissions (user_id, permission)
        values (${userId}, 'delete_everything')
      `),
    );

    expect(reason).toMatch(/installation_administrator_permissions_valid/);
  });
});

describe('audit events', () => {
  const event = (
    overrides: Partial<typeof auditEvents.$inferInsert> = {},
  ): typeof auditEvents.$inferInsert => ({
    action: 'auth.login.succeeded',
    result: 'success',
    actorKind: 'system',
    ...overrides,
  });

  it('records an installation-level event with no business', async () => {
    await expect(harness.db.insert(auditEvents).values(event())).resolves.toBeDefined();
  });

  it('cannot be updated', async () => {
    const [row] = await harness.db
      .insert(auditEvents)
      .values(event())
      .returning({ id: auditEvents.id });

    const reason = await refuses(() =>
      harness.db.update(auditEvents).set({ result: 'failure' }).where(eq(auditEvents.id, row!.id)),
    );

    expect(reason).toMatch(/append-only/);
  });

  it('cannot be deleted', async () => {
    const [row] = await harness.db
      .insert(auditEvents)
      .values(event())
      .returning({ id: auditEvents.id });

    const reason = await refuses(() =>
      harness.db.delete(auditEvents).where(eq(auditEvents.id, row!.id)),
    );

    expect(reason).toMatch(/append-only/);
  });

  it('refuses a user action with no actor, which would be a gap in the trail', async () => {
    const reason = await refuses(() =>
      harness.db.insert(auditEvents).values(event({ actorKind: 'user', actorUserId: null })),
    );

    expect(reason).toMatch(/audit_events_user_actions_have_an_actor/);
  });

  it('refuses an action identifier that is not a dotted lowercase path', async () => {
    for (const action of ['login', 'Auth.Login', 'auth..login', 'auth.login.']) {
      const reason = await refuses(() => harness.db.insert(auditEvents).values(event({ action })));

      expect(reason).toMatch(/audit_events_action_shaped/);
    }
  });

  it('survives the deletion of the user it describes, unchanged', async () => {
    // The trail has to outlive what it describes. A foreign key here would make
    // deleting a user either impossible, because the append-only trigger refuses
    // the cascading write, or destructive, because it would take the evidence
    // with it. Section 13's retention erasure is the separate, bounded path.
    const userId = await createUser();
    const [row] = await harness.db
      .insert(auditEvents)
      .values(event({ actorKind: 'user', actorUserId: userId }))
      .returning({ id: auditEvents.id });

    await expect(harness.db.delete(users).where(eq(users.id, userId))).resolves.toBeDefined();

    const [after] = await harness.db.select().from(auditEvents).where(eq(auditEvents.id, row!.id));

    expect(after!.actorUserId).toBe(userId);
  });

  it('survives the deletion of the business it belongs to', async () => {
    const businessId = await createBusiness();
    const [row] = await harness.db
      .insert(auditEvents)
      .values(event({ businessId }))
      .returning({ id: auditEvents.id });

    await harness.db.delete(businesses).where(eq(businesses.id, businessId));

    const [after] = await harness.db.select().from(auditEvents).where(eq(auditEvents.id, row!.id));

    expect(after!.businessId).toBe(businessId);
  });
});

describe('membership suspension', () => {
  it('rejects a status the application does not implement', async () => {
    const businessId = await createBusiness();
    const membership = await createMembership(businessId, await createUser());

    const reason = await refuses(() =>
      harness.db.execute(sql`
        update memberships set status = 'paused' where id = ${membership}
      `),
    );

    expect(reason).toMatch(/memberships_status_valid/);
  });

  it('suspends one business without touching the same user elsewhere', async () => {
    const userId = await createUser();
    const businessA = await createBusiness();
    const businessB = await createBusiness();

    await createMembership(businessA, userId);
    await createMembership(businessB, userId);

    await harness.db
      .update(memberships)
      .set({ status: 'suspended', suspendedAt: new Date() })
      .where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessA)));

    const [other] = await harness.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessB)));

    expect(other!.status).toBe('active');
  });
});

describe('business security settings', () => {
  it('rejects a two-factor requirement naming a role that does not exist', async () => {
    const businessId = await createBusiness();

    const reason = await refuses(() =>
      harness.db.execute(sql`
        update businesses set require_two_factor_roles = array['superuser']
        where id = ${businessId}
      `),
    );

    expect(reason).toMatch(/businesses_two_factor_roles_valid/);
  });

  it('defaults to no domain restriction and no two-factor requirement', async () => {
    const businessId = await createBusiness();

    const [business] = await harness.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    expect(business!.allowedEmailDomains).toEqual([]);
    expect(business!.requireTwoFactorRoles).toEqual([]);
  });
});
