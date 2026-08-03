import { z } from 'zod';

import { configSchema, type InstallationConfig } from './schema';

/**
 * Turns the raw environment into a validated, typed configuration object.
 *
 * This is the only place in the workspace permitted to read `process.env`; the
 * lint configuration enforces that everywhere else. Reading the environment from
 * scattered call sites is how a deployment ends up half-configured and only
 * finds out under load.
 */

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(
      `Installation configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
    this.problems = problems;
  }
}

/**
 * Values substituted for required settings outside production so a contributor
 * can boot from a near-empty file.
 *
 * Every one is deliberately obvious rubbish. Production never applies them, and
 * `refuseDevelopmentSentinels` rejects them outright if one ever reaches a
 * production deployment through a copied file.
 */
const DEVELOPMENT_DEFAULTS: Readonly<Record<string, string>> = {
  EIM_PUBLIC_URL: 'http://localhost:3000',
  EIM_DATABASE_URL: 'postgresql://eim:eim@localhost:5432/eim',
  EIM_SESSION_SECRET: 'development-only-session-secret-not-for-production',
  EIM_KEYRING: '[{"version":1,"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}]',
  EIM_SMTP_HOST: 'localhost',
  EIM_MAIL_FROM_ADDRESS: 'development@example.invalid',
};

function withDevelopmentDefaults(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...source };
  for (const [key, value] of Object.entries(DEVELOPMENT_DEFAULTS)) {
    if (merged[key] === undefined || merged[key] === '') {
      merged[key] = value;
    }
  }
  return merged;
}

function refuseDevelopmentSentinels(source: NodeJS.ProcessEnv): string[] {
  return Object.entries(DEVELOPMENT_DEFAULTS)
    .filter(([key, value]) => source[key] === value)
    .map(
      ([key]) => `${key} still holds its development placeholder and must be set for production.`,
    );
}

function keyringProblems(config: InstallationConfig): string[] {
  const problems: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(config.EIM_KEYRING);
  } catch {
    return [
      'EIM_KEYRING must be valid JSON, for example [{"version":1,"key":"<base64 of 32 bytes>"}].',
    ];
  }

  const entries = z
    .array(z.object({ version: z.number().int().positive(), key: z.string().min(1) }))
    .min(1)
    .safeParse(parsed);

  if (!entries.success) {
    return ['EIM_KEYRING must be a non-empty array of {version, key} objects.'];
  }

  const versions = entries.data.map((entry) => entry.version);
  if (new Set(versions).size !== versions.length) {
    problems.push('EIM_KEYRING contains duplicate version numbers.');
  }
  if (!versions.includes(config.EIM_KEYRING_ACTIVE_VERSION)) {
    problems.push(
      `EIM_KEYRING_ACTIVE_VERSION ${String(config.EIM_KEYRING_ACTIVE_VERSION)} is not present in EIM_KEYRING.`,
    );
  }

  for (const entry of entries.data) {
    if (Buffer.from(entry.key, 'base64').length !== 32) {
      problems.push(
        `EIM_KEYRING version ${String(entry.version)} must decode to exactly 32 bytes for AES-256.`,
      );
    }
  }

  return problems;
}

export interface LoadOptions {
  /** Defaults to `process.env`. Injectable so tests never mutate global state. */
  readonly source?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadOptions = {}): InstallationConfig {
  const source = options.source ?? process.env;
  const isProduction = (source['NODE_ENV'] ?? 'production') === 'production';
  const effective = isProduction ? source : withDevelopmentDefaults(source);

  const parsed = configSchema.safeParse(effective);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const config = parsed.data;
  const problems = [...keyringProblems(config)];

  if (isProduction) {
    problems.push(...refuseDevelopmentSentinels(source));
    if (!config.EIM_PUBLIC_URL.startsWith('https://')) {
      problems.push('EIM_PUBLIC_URL must use HTTPS in production (section 19).');
    }
  }

  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return config;
}
