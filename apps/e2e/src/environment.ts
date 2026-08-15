/**
 * What the browser tier needs to know about the stack it is driving.
 *
 * This is the one module in the suite allowed to read the environment, for the
 * same reason `@eim/config` is the one module in the application allowed to:
 * configuration read in ten places is configuration half-checked in nine. It
 * cannot use `@eim/config` itself, because these are the test harness's own
 * settings rather than the installation's, and adding them to the installation
 * schema would put test-only keys in the production `.env.example`.
 */

function required(name: string): string {
  // eslint-disable-next-line no-restricted-properties -- see the module comment
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. The browser tier runs through ./scripts/e2e.sh, which brings up ` +
        'docker-compose.e2e.yml and supplies it.',
    );
  }

  return value;
}

export const environment = {
  /** Where the browser reaches the application. HTTPS, through the terminator. */
  baseUrl: required('EIM_E2E_BASE_URL'),
  /** Mailpit's HTTP API. Every authentication test reads its mail from here. */
  mailpitUrl: required('EIM_E2E_MAILPIT_URL'),
  /** Matches EIM_INITIAL_ADMIN_EMAIL, so the installation can be claimed. */
  adminEmail: required('EIM_E2E_ADMIN_EMAIL'),
  /** Matches EIM_SETUP_SECRET, the second factor on the bootstrap. */
  setupSecret: required('EIM_E2E_SETUP_SECRET'),
  /** The application's own connection string, reused to reset between runs. */
  databaseUrl: required('EIM_DATABASE_URL'),
} as const;

/**
 * Where the signed-in owner's cookies are kept between the setup and the specs.
 *
 * Relative to this package, because Playwright resolves both the write and the
 * read against the working directory the run started in. It holds a live
 * session token, so `.gitignore` excludes every `.auth` directory rather than
 * this one path — a file this shape must not be able to reach a commit because
 * somebody moved it.
 */
export const OWNER_STATE_PATH = '.auth/owner.json';

/** The business the setup project creates and every other spec expects to find. */
export const BUSINESS_NAME = 'Pilot Supplies Ltd';
