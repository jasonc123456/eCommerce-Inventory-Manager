import { createHasher, loadKeyring, type KeyedHasher, type Keyring } from '@eim/crypto';
import {
  createBootstrapService,
  createChallengeService,
  createMembershipService,
  createPasskeyService,
  createSessionService,
  createTwoFactorService,
  type BootstrapService,
  type ChallengeService,
  type MembershipService,
  type PasskeyService,
  type SessionService,
  type TwoFactorService,
} from '@eim/identity';
import { createMailer, type Mailer } from '@eim/mail';
import { createExhaustionCache, type ExhaustionCache } from '@eim/ratelimit';

import { runtime } from './runtime';

/**
 * The identity services, built once per process.
 *
 * Separate from `runtime()` because these depend on it: the keyring and the
 * hashing secret come from the validated configuration, and building them
 * eagerly at module load would make importing this file enough to fail a
 * process whose `.env` is incomplete. Next.js imports modules for reasons that
 * have nothing to do with serving a request, including collecting page
 * metadata at build time.
 *
 * Pinned to `globalThis` for the same reason as the runtime: development
 * reloads modules on every edit, and a module-level variable would build a new
 * mail transport and a new rate-limit cache each time.
 */

export interface Identity {
  readonly hasher: KeyedHasher;
  readonly keyring: Keyring;
  readonly sessions: SessionService;
  readonly challenges: ChallengeService;
  readonly bootstrap: BootstrapService;
  readonly memberships: MembershipService;
  readonly passkeys: PasskeyService;
  readonly twoFactor: TwoFactorService;
  readonly mailer: Mailer;
  /** The per-replica pre-filter in front of the PostgreSQL rate limiter. */
  readonly rateLimitCache: ExhaustionCache;
  readonly productName: string;
}

const IDENTITY_KEY = Symbol.for('eim.web.identity');

interface GlobalWithIdentity {
  [IDENTITY_KEY]?: Identity;
}

export function identity(): Identity {
  const container = globalThis as unknown as GlobalWithIdentity;
  const existing = container[IDENTITY_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const { config } = runtime();

  const hasher = createHasher(config.EIM_SESSION_SECRET);
  const keyring = loadKeyring({
    keyring: config.EIM_KEYRING,
    activeVersion: config.EIM_KEYRING_ACTIVE_VERSION,
  });

  const publicUrl = new URL(config.EIM_PUBLIC_URL);

  const created: Identity = {
    hasher,
    keyring,
    sessions: createSessionService(hasher),
    challenges: createChallengeService(hasher),
    bootstrap: createBootstrapService(hasher, {
      initialAdminEmail: config.EIM_INITIAL_ADMIN_EMAIL,
      setupSecret: config.EIM_SETUP_SECRET,
    }),
    memberships: createMembershipService(hasher),
    passkeys: createPasskeyService(hasher, {
      // Section 20: a stable relying-party id from the canonical deployment
      // hostname. Derived rather than configured separately, because the two
      // drifting apart invalidates every registered passkey at once.
      id: publicUrl.hostname,
      name: 'Inventory Manager',
      allowedOrigins: [publicUrl.origin],
    }),
    twoFactor: createTwoFactorService(hasher, keyring),
    mailer: createMailer({
      host: config.EIM_SMTP_HOST,
      port: config.EIM_SMTP_PORT,
      user: config.EIM_SMTP_USER,
      password: config.EIM_SMTP_PASSWORD,
      fromAddress: config.EIM_MAIL_FROM_ADDRESS,
      fromName: config.EIM_MAIL_FROM_NAME,
    }),
    rateLimitCache: createExhaustionCache(),
    productName: 'Inventory Manager',
  };

  container[IDENTITY_KEY] = created;
  return created;
}
