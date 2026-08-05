import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  customType,
} from 'drizzle-orm/pg-core';

import { businesses, users, membershipRoles } from './tenancy';

/**
 * Typed access to the identity tables (section 20).
 *
 * As in `tenancy.ts`, `migrations/0003_identity.sql` is the source of truth and
 * this file is the query surface over it. Constraints that Drizzle cannot
 * express — the composite foreign keys, the partial unique on live challenges,
 * the append-only and final-administrator triggers — live only in the SQL and
 * are proven by the integration suite.
 */

/**
 * A PostgreSQL text array.
 *
 * Declared here rather than reached for from `pg-core` so the element type is
 * `string[]` at every call site instead of `unknown[]`.
 */
const textArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'text[]',
});

/** Raw bytes, for a WebAuthn public key. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// ---------------------------------------------------------------------------
// Installation administration
// ---------------------------------------------------------------------------

export const installationPermissions = [
  'view_system_health',
  'manage_installation_settings',
  'view_backup_status',
  'run_backup',
  'view_update_status',
  'download_diagnostics',
  'view_installation_audit',
  'manage_installation_administrators',
] as const;

export const installationAdministrators = pgTable('installation_administrators', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  status: text('status', { enum: ['active', 'suspended'] })
    .notNull()
    .default('active'),
});

export const installationAdministratorPermissions = pgTable(
  'installation_administrator_permissions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => installationAdministrators.userId, { onDelete: 'cascade' }),
    permission: text('permission', { enum: installationPermissions }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'installation_administrator_permissions_pkey',
      columns: [table.userId, table.permission],
    }),
  ],
);

export const installationBootstrap = pgTable('installation_bootstrap', {
  id: boolean('id').primaryKey().default(true),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  /** Keyed hash of the one-time setup link's token (migration 0004). */
  setupTokenHash: text('setup_token_hash'),
  setupTokenIssuedAt: timestamp('setup_token_issued_at', { withTimezone: true }),
  setupTokenExpiresAt: timestamp('setup_token_expires_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Business permission grants
// ---------------------------------------------------------------------------

export const grantScopeKinds = ['business', 'connections', 'locations', 'own'] as const;
export type GrantScopeKind = (typeof grantScopeKinds)[number];

export const permissionGrants = pgTable(
  'permission_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    permission: text('permission').notNull(),
    scopeKind: text('scope_kind', { enum: grantScopeKinds }).notNull().default('business'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    unique('permission_grants_unique').on(table.membershipId, table.permission, table.scopeKind),
    unique('permission_grants_business_scoped').on(table.businessId, table.id),
  ],
);

export const permissionGrantLocations = pgTable(
  'permission_grant_locations',
  {
    businessId: uuid('business_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'permission_grant_locations_pkey',
      columns: [table.grantId, table.locationId],
    }),
  ],
);

export const permissionGrantConnections = pgTable(
  'permission_grant_connections',
  {
    businessId: uuid('business_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'permission_grant_connections_pkey',
      columns: [table.grantId, table.connectionId],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    role: text('role', { enum: membershipRoles }).notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_unique').on(table.tokenHash),
    unique('invitations_business_scoped').on(table.businessId, table.id),
  ],
);

export const invitationPermissions = pgTable(
  'invitation_permissions',
  {
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    scopeKind: text('scope_kind', { enum: grantScopeKinds }).notNull().default('business'),
  },
  (table) => [
    primaryKey({
      name: 'invitation_permissions_pkey',
      columns: [table.invitationId, table.permission, table.scopeKind],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Email authentication challenges
// ---------------------------------------------------------------------------

export const challengeMethods = ['magic_link', 'email_code'] as const;
export type ChallengeMethod = (typeof challengeMethods)[number];

export const challengePurposes = ['login', 'step_up', 'recovery'] as const;
export type ChallengePurpose = (typeof challengePurposes)[number];

export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    emailFingerprint: text('email_fingerprint').notNull(),
    method: text('method', { enum: challengeMethods }).notNull(),
    purpose: text('purpose', { enum: challengePurposes }).notNull().default('login'),
    secretHash: text('secret_hash').notNull(),
    browserBindingHash: text('browser_binding_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    resendCount: integer('resend_count').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    redirectPath: text('redirect_path'),
    requestIp: inet('request_ip'),
    requestUserAgent: text('request_user_agent'),
  },
  (table) => [index('login_challenges_created_at_idx').on(table.createdAt)],
);

export const authenticationPressure = pgTable(
  'authentication_pressure',
  {
    subjectFingerprint: text('subject_fingerprint').primaryKey(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    firstFailureAt: timestamp('first_failure_at', { withTimezone: true }).notNull().defaultNow(),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAllowedAt: timestamp('next_attempt_allowed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('authentication_pressure_expiry_idx').on(table.expiresAt)],
);

// ---------------------------------------------------------------------------
// Sessions and devices
// ---------------------------------------------------------------------------

export const sessionRevocationReasons = [
  'user_signed_out',
  'global_sign_out',
  'session_rotated',
  'account_suspended',
  'security_change',
  'membership_removed',
  'administrator_action',
] as const;
export type SessionRevocationReason = (typeof sessionRevocationReasons)[number];

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    rememberDevice: boolean('remember_device').notNull().default(false),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull().defaultNow(),
    activeBusinessId: uuid('active_business_id').references(() => businesses.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason', { enum: sessionRevocationReasons }),
    deviceLabel: text('device_label'),
    requestIp: inet('request_ip'),
    requestUserAgent: text('request_user_agent'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_absolute_expiry_idx').on(table.absoluteExpiresAt),
  ],
);

export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('trusted_devices_token_hash_unique').on(table.tokenHash)],
);

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: textArray('transports').notNull().default([]),
    backupEligible: boolean('backup_eligible').notNull().default(false),
    backupState: boolean('backup_state').notNull().default(false),
    aaguid: uuid('aaguid'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webauthn_credentials_credential_id_unique').on(table.credentialId),
    index('webauthn_credentials_user_idx').on(table.userId),
  ],
);

export const webauthnChallengeKinds = ['registration', 'authentication'] as const;
export type WebauthnChallengeKind = (typeof webauthnChallengeKinds)[number];

export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    challengeHash: text('challenge_hash').notNull(),
    kind: text('kind', { enum: webauthnChallengeKinds }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [index('webauthn_challenges_expiry_idx').on(table.expiresAt)],
);

// ---------------------------------------------------------------------------
// Second factors and recovery
// ---------------------------------------------------------------------------

export const totpCredentials = pgTable('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedSeed: text('encrypted_seed').notNull(),
  status: text('status', { enum: ['pending', 'active'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    batchId: uuid('batch_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('recovery_codes_hash_unique').on(table.userId, table.codeHash)],
);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export const rateLimitWindows = pgTable(
  'rate_limit_windows',
  {
    bucket: text('bucket').notNull(),
    subject: text('subject').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'rate_limit_windows_pkey',
      columns: [table.bucket, table.subject, table.windowStart],
    }),
    index('rate_limit_windows_expiry_idx').on(table.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type InstallationAdministrator = typeof installationAdministrators.$inferSelect;
export type PermissionGrant = typeof permissionGrants.$inferSelect;
export type NewPermissionGrant = typeof permissionGrants.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type LoginChallenge = typeof loginChallenges.$inferSelect;
export type NewLoginChallenge = typeof loginChallenges.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type TrustedDevice = typeof trustedDevices.$inferSelect;
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
export type TotpCredential = typeof totpCredentials.$inferSelect;
export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type RateLimitWindow = typeof rateLimitWindows.$inferSelect;
