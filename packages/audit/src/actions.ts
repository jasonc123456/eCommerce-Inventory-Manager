/**
 * The audit action catalogue (section 19).
 *
 * A closed union rather than a free string, for the same reason the permission
 * catalogue is one: an audit trail whose vocabulary anybody can extend in
 * passing cannot be filtered, alerted on, or reviewed. Adding an action is a
 * deliberate change here, and the reviewer of that change is being asked
 * "should this be evidence?" rather than discovering it later in a query that
 * missed half the rows because they were spelled differently.
 *
 * Identifiers are dotted, lowercase, and ordered subject-first, so a prefix is a
 * meaningful filter: `auth.` is every authentication event, `auth.passkey.` is
 * every passkey event. The database enforces the shape; this enforces the set.
 *
 * Section 19 also requires audit coverage of inventory, publication, pricing,
 * shipping-label, and retention mutations. Those actions arrive with the
 * milestones that perform them, rather than being declared here in advance and
 * left unused.
 */

export const AUDIT_ACTIONS = [
  // --- Authentication ------------------------------------------------------
  'auth.challenge.issued',
  'auth.challenge.consumed',
  'auth.challenge.failed',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.logout',
  'auth.session.rotated',
  'auth.session.revoked',
  'auth.session.revoked_all',
  'auth.step_up.succeeded',
  'auth.step_up.failed',
  'auth.rate_limited',

  // --- Second factors and devices -----------------------------------------
  'auth.passkey.registered',
  'auth.passkey.renamed',
  'auth.passkey.removed',
  'auth.passkey.login_succeeded',
  'auth.passkey.login_failed',
  'auth.totp.enabled',
  'auth.totp.disabled',
  'auth.totp.failed',
  'auth.recovery_code.consumed',
  'auth.recovery_codes.regenerated',
  'auth.trusted_device.created',
  'auth.trusted_device.revoked',

  // --- Authorization -------------------------------------------------------
  'authz.denied',

  // --- Membership ----------------------------------------------------------
  'member.invited',
  'member.invitation_cancelled',
  'member.invitation_accepted',
  'member.role_changed',
  'member.permissions_changed',
  'member.suspended',
  'member.reinstated',
  'member.removed',

  // --- Business ------------------------------------------------------------
  'business.created',
  'business.settings_changed',
  'business.security_changed',

  // --- Accounts ------------------------------------------------------------
  'user.suspended',
  'user.reinstated',
  'user.deleted',

  // --- Connections ---------------------------------------------------------
  //
  // Sections 13 and 14. A connection is a credential to somebody's shop, so the
  // whole lifecycle is recorded: who started an authorization, what came back,
  // who tested it, who rotated its secrets, and who took it out of service.
  // `rejected` is here because a credential that failed to be adopted is the
  // interesting half — it is either a typo or somebody else's key.
  'connection.authorization_started',
  'connection.connected',
  'connection.rejected',
  'connection.tested',
  'connection.paused',
  'connection.resumed',
  'connection.webhooks_reconciled',
  'connection.webhook_rotation_started',
  'connection.disconnected',

  // --- Inventory -----------------------------------------------------------
  //
  // Sections 7, 8, 9, and 10. The ledger already records every stock movement
  // with its actor and reason, so these are the decisions *around* the stock
  // rather than the movements themselves: what may be sold where, what a kit is
  // made of, and which mapping is allowed to write to a live storefront.
  // Activation is the one that matters most — it is the moment a mapping starts
  // changing what a customer sees.
  'inventory.location.created',
  'inventory.location.updated',
  'inventory.location.archived',
  'inventory.item.created',
  'inventory.item.updated',
  'inventory.adjusted',
  'inventory.transferred',
  'inventory.entry_reversed',
  'inventory.settings.updated',
  'inventory.consumption_mode.switched',
  'inventory.mapping.proposed',
  'inventory.mapping.approved',
  'inventory.mapping.revised',
  'inventory.mapping.activated',
  'inventory.mapping.paused',
  'inventory.mapping.archived',
  'inventory.kit.recipe_drafted',
  'inventory.kit.recipe_approved',
  'inventory.reservation.released',

  // --- Installation --------------------------------------------------------
  'installation.bootstrap.completed',
  'installation.bootstrap.failed',
  'installation.administrator.added',
  'installation.administrator.removed',
  'installation.administrator.break_glass_reset',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Actions that are security-relevant regardless of outcome.
 *
 * Section 20 requires a notification for new passkeys, second-factor and
 * recovery changes, account recovery, suspicious login, global sign-out, and
 * sensitive administrator actions. Naming them here means the notification
 * routing reads one list instead of each writer remembering to ask for one.
 */
export const SECURITY_NOTIFYING_ACTIONS: ReadonlySet<AuditAction> = new Set([
  'auth.passkey.registered',
  'auth.passkey.removed',
  'auth.totp.enabled',
  'auth.totp.disabled',
  'auth.recovery_code.consumed',
  'auth.recovery_codes.regenerated',
  'auth.session.revoked_all',
  'auth.trusted_device.created',
  'user.suspended',
  'installation.administrator.added',
  'installation.administrator.removed',
  'installation.administrator.break_glass_reset',
]);
