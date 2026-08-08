import type { ConfigKey } from './schema';

/**
 * Human-facing metadata for every configuration key.
 *
 * Keyed by `ConfigKey`, so adding a setting to the schema without describing it
 * here is a compile error rather than an undocumented setting an operator
 * discovers at deployment time. Section 27 requires the configuration reference
 * to be generated from the validated schema; this is the half that carries the
 * prose, and `pnpm env:check` turns both halves into `.env.example`.
 *
 * Sensitivity drives redaction. Anything marked `secret` must never appear in
 * logs, diagnostics bundles, exports, health output, or the web UI.
 */
export type Sensitivity = 'secret' | 'sensitive' | 'public';

export interface FieldMeta {
  readonly description: string;
  readonly sensitivity: Sensitivity;
  /** Placeholder written into `.env.example`. Never a usable value. */
  readonly example: string;
  readonly requiredInProduction: boolean;
}

export const FIELD_METADATA: Readonly<Record<ConfigKey, FieldMeta>> = {
  NODE_ENV: {
    description:
      'Runtime mode. Production enables the strict HTTPS, proxy, and file-permission checks.',
    sensitivity: 'public',
    example: 'production',
    requiredInProduction: false,
  },

  EIM_PUBLIC_URL: {
    description:
      'Canonical public origin. Must be HTTPS in production. Used for OAuth callbacks, webhook destinations, WebAuthn relying-party identity, and email links.',
    sensitivity: 'public',
    example: 'https://inventory.example.com',
    requiredInProduction: true,
  },
  EIM_DATABASE_URL: {
    description:
      'PostgreSQL 18 connection string. Must reach the database directly: a transaction-pooling proxy breaks LISTEN/NOTIFY live updates (D-140).',
    sensitivity: 'secret',
    example: 'postgresql://eim:CHANGE_ME@postgres:5432/eim',
    requiredInProduction: true,
  },
  EIM_SESSION_SECRET: {
    description:
      'Keyed-hash secret for session tokens and authentication challenges. At least 32 characters.',
    sensitivity: 'secret',
    example: 'CHANGE_ME_generate_with_openssl_rand_base64_48',
    requiredInProduction: true,
  },
  EIM_KEYRING: {
    description:
      'Versioned AES-256-GCM master keyring as JSON: [{"version":1,"key":"<base64 32 bytes>"}]. Rotation adds a version; old versions stay until no live data or retained backup needs them (D-069).',
    sensitivity: 'secret',
    example: '[{"version":1,"key":"CHANGE_ME_base64_of_32_random_bytes"}]',
    requiredInProduction: true,
  },
  EIM_KEYRING_ACTIVE_VERSION: {
    description: 'Which keyring version encrypts new values. Must exist in EIM_KEYRING.',
    sensitivity: 'public',
    example: '1',
    requiredInProduction: false,
  },

  EIM_SMTP_HOST: {
    description: 'SMTP server for authentication, invitation, security, and alert mail.',
    sensitivity: 'public',
    example: 'smtp.office365.com',
    requiredInProduction: true,
  },
  EIM_SMTP_PORT: {
    description: 'SMTP port.',
    sensitivity: 'public',
    example: '587',
    requiredInProduction: false,
  },
  EIM_SMTP_USER: {
    description: 'SMTP username. Omit only for a relay that authenticates by network.',
    sensitivity: 'sensitive',
    example: 'inventory@example.com',
    requiredInProduction: false,
  },
  EIM_SMTP_PASSWORD: {
    description: 'SMTP password or application password.',
    sensitivity: 'secret',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_MAIL_FROM_ADDRESS: {
    description: 'Envelope and header sender address.',
    sensitivity: 'public',
    example: 'inventory@example.com',
    requiredInProduction: true,
  },
  EIM_MAIL_FROM_NAME: {
    description: 'Display name on outbound mail.',
    sensitivity: 'public',
    example: 'Inventory Manager',
    requiredInProduction: false,
  },

  EIM_INITIAL_ADMIN_EMAIL: {
    description:
      'Address permitted to claim the first installation administrator. Bootstrap closes permanently after a successful claim.',
    sensitivity: 'sensitive',
    example: 'admin@example.com',
    requiredInProduction: false,
  },
  EIM_SETUP_SECRET: {
    description:
      'High-entropy one-time bootstrap secret. Remove it from this file after the first administrator exists.',
    sensitivity: 'secret',
    example: 'CHANGE_ME_generate_with_openssl_rand_base64_48',
    requiredInProduction: false,
  },

  EIM_EBAY_SANDBOX_CLIENT_ID: {
    description:
      'eBay Sandbox keyset application ID. Sandbox and Production are strictly isolated.',
    sensitivity: 'sensitive',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_EBAY_SANDBOX_CLIENT_SECRET: {
    description: 'eBay Sandbox keyset certificate ID.',
    sensitivity: 'secret',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_EBAY_SANDBOX_RUNAME: {
    description: 'eBay Sandbox RuName bound to this deployment public URL.',
    sensitivity: 'sensitive',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_EBAY_PRODUCTION_CLIENT_ID: {
    description: 'eBay Production keyset application ID.',
    sensitivity: 'sensitive',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_EBAY_PRODUCTION_CLIENT_SECRET: {
    description: 'eBay Production keyset certificate ID.',
    sensitivity: 'secret',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_EBAY_PRODUCTION_RUNAME: {
    description: 'eBay Production RuName bound to this deployment public URL.',
    sensitivity: 'sensitive',
    example: 'CHANGE_ME',
    requiredInProduction: false,
  },
  EIM_EBAY_DELETION_VERIFICATION_TOKEN: {
    description:
      'Random 32 to 80 character token matching the eBay marketplace account-deletion endpoint configuration. Required before Production eBay use (section 13).',
    sensitivity: 'secret',
    example: 'CHANGE_ME_32_to_80_random_characters_no_spaces',
    requiredInProduction: false,
  },

  EIM_DATA_UID: {
    description:
      'Host UID owning every bind-mounted data directory. Containers run as this user so data stays readable without sudo (D-142).',
    sensitivity: 'public',
    example: '1000',
    requiredInProduction: false,
  },
  EIM_DATA_GID: {
    description: 'Host GID owning every bind-mounted data directory (D-142).',
    sensitivity: 'public',
    example: '1000',
    requiredInProduction: false,
  },
  EIM_BACKUP_PUBLIC_KEY: {
    description:
      'Public key backups encrypt to. The matching private key must be held off this host, or the control is defeated (D-143).',
    sensitivity: 'public',
    example: 'age1CHANGE_ME',
    requiredInProduction: false,
  },

  EIM_TRUSTED_PROXY_CIDRS: {
    description:
      'Comma-separated networks whose forwarded headers are trusted. Empty means trust none, which is correct when nothing proxies this deployment.',
    sensitivity: 'public',
    example: '172.16.0.0/12',
    requiredInProduction: false,
  },
  EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS: {
    description:
      'Opt in to private-network integration destinations for a self-hosted WooCommerce or local Ollama. Disabled by default; never permits cloud-metadata targets (D-071).',
    sensitivity: 'public',
    example: 'false',
    requiredInProduction: false,
  },
  EIM_PRIVATE_HOST_ALLOWLIST: {
    description: 'Exact private hosts or CIDRs permitted when the flag above is enabled.',
    sensitivity: 'public',
    example: '192.168.1.50,10.0.0.0/24',
    requiredInProduction: false,
  },
  EIM_MAGIC_LINK_TOKEN_CARRIER: {
    description:
      'Where a sign-in link carries its token. `fragment` keeps it out of every log; `query` is for installations whose mail gateway rewrites links and drops the fragment (section 19).',
    sensitivity: 'public',
    example: 'fragment',
    requiredInProduction: false,
  },
  EIM_LOG_LEVEL: {
    description:
      'Baseline log level. Debug and trace change detail, never redaction policy (section 22).',
    sensitivity: 'public',
    example: 'info',
    requiredInProduction: false,
  },
  EIM_APP_VERSION: {
    description:
      'Build identifier, stamped on every log line, metric, and scheduler lease. Set by the container image so a mixed-version rollout is visible.',
    sensitivity: 'public',
    example: '0.1.0',
    requiredInProduction: false,
  },
};

/**
 * Render order for `.env.example`, grouped by concern rather than alphabetically
 * so the generated file reads as setup instructions.
 *
 * A test asserts this covers every key exactly once; a missing key would silently
 * drop a setting from the operator's reference.
 */
export const FIELD_ORDER: readonly ConfigKey[] = [
  'NODE_ENV',
  'EIM_PUBLIC_URL',
  'EIM_DATABASE_URL',
  'EIM_SESSION_SECRET',
  'EIM_KEYRING',
  'EIM_KEYRING_ACTIVE_VERSION',
  'EIM_SMTP_HOST',
  'EIM_SMTP_PORT',
  'EIM_SMTP_USER',
  'EIM_SMTP_PASSWORD',
  'EIM_MAIL_FROM_ADDRESS',
  'EIM_MAIL_FROM_NAME',
  'EIM_INITIAL_ADMIN_EMAIL',
  'EIM_SETUP_SECRET',
  'EIM_EBAY_SANDBOX_CLIENT_ID',
  'EIM_EBAY_SANDBOX_CLIENT_SECRET',
  'EIM_EBAY_SANDBOX_RUNAME',
  'EIM_EBAY_PRODUCTION_CLIENT_ID',
  'EIM_EBAY_PRODUCTION_CLIENT_SECRET',
  'EIM_EBAY_PRODUCTION_RUNAME',
  'EIM_EBAY_DELETION_VERIFICATION_TOKEN',
  'EIM_DATA_UID',
  'EIM_DATA_GID',
  'EIM_BACKUP_PUBLIC_KEY',
  'EIM_TRUSTED_PROXY_CIDRS',
  'EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS',
  'EIM_PRIVATE_HOST_ALLOWLIST',
  'EIM_MAGIC_LINK_TOKEN_CARRIER',
  'EIM_LOG_LEVEL',
  'EIM_APP_VERSION',
];

/** Keys whose values must never be logged, exported, or rendered. */
export const SECRET_KEYS: readonly ConfigKey[] = FIELD_ORDER.filter(
  (key) => FIELD_METADATA[key].sensitivity === 'secret',
);
