import { z } from 'zod';

/**
 * The installation configuration schema (section 19).
 *
 * Written out key by key rather than assembled from a list, because a schema
 * built with `Object.fromEntries` infers an index signature and every value
 * degrades to `unknown`. Explicit keys give callers real types.
 *
 * Documentation and `.env.example` are generated from `fields.ts`, whose
 * metadata record is keyed by this schema's own keys, so the two cannot drift:
 * a setting added here without a description fails to compile.
 */

const nonEmpty = z.string().min(1);
const optionalString = z.string().min(1).optional();

/** A comma-separated list, normalized to a trimmed array with blanks dropped. */
const csv = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? []
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
  );

const boolish = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65_535);
const posixId = z.coerce.number().int().min(0).max(4_294_967_294);

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  EIM_PUBLIC_URL: z.url(),
  EIM_DATABASE_URL: nonEmpty.startsWith('postgres'),
  EIM_SESSION_SECRET: z.string().min(32),
  EIM_KEYRING: nonEmpty,
  EIM_KEYRING_ACTIVE_VERSION: z.coerce.number().int().positive().default(1),

  EIM_SMTP_HOST: nonEmpty,
  EIM_SMTP_PORT: port.default(587),
  EIM_SMTP_USER: optionalString,
  EIM_SMTP_PASSWORD: optionalString,
  EIM_MAIL_FROM_ADDRESS: z.email(),
  EIM_MAIL_FROM_NAME: nonEmpty.default('Inventory Manager'),

  EIM_INITIAL_ADMIN_EMAIL: z.email().optional(),
  EIM_SETUP_SECRET: z.string().min(32).optional(),

  EIM_EBAY_SANDBOX_CLIENT_ID: optionalString,
  EIM_EBAY_SANDBOX_CLIENT_SECRET: optionalString,
  EIM_EBAY_SANDBOX_RUNAME: optionalString,
  EIM_EBAY_PRODUCTION_CLIENT_ID: optionalString,
  EIM_EBAY_PRODUCTION_CLIENT_SECRET: optionalString,
  EIM_EBAY_PRODUCTION_RUNAME: optionalString,
  EIM_EBAY_DELETION_VERIFICATION_TOKEN: z.string().min(32).max(80).optional(),

  EIM_DATA_UID: posixId.default(1000),
  EIM_DATA_GID: posixId.default(1000),
  EIM_BACKUP_PUBLIC_KEY: optionalString,

  EIM_TRUSTED_PROXY_CIDRS: csv,
  EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS: boolish,
  EIM_PRIVATE_HOST_ALLOWLIST: csv,
  /**
   * Where a sign-in link carries its token (sections 19, 20).
   *
   * `fragment` is the default and the safer of the two: a fragment is never sent
   * in an HTTP request, so the token reaches no access log, proxy log, or
   * Referer header. Some mail security gateways — Microsoft Defender Safe Links
   * among them — rewrite every link in a message and do not always carry the
   * fragment through the rewrite, which delivers the recipient to a
   * confirmation page with no token in it.
   *
   * `query` exists for those installations. It is a real reduction in secrecy
   * and is opt-in for that reason. What it does *not* give up is the property
   * that matters most: the token is still only spent by a POST from a button
   * press, so a scanner fetching the link cannot consume it either way.
   */
  EIM_MAGIC_LINK_TOKEN_CARRIER: z.enum(['fragment', 'query']).default('fragment'),

  EIM_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  EIM_APP_VERSION: optionalString,
});

export type InstallationConfig = z.infer<typeof configSchema>;

/** Every configuration key, as a type. Used to key the metadata record. */
export type ConfigKey = keyof InstallationConfig;
