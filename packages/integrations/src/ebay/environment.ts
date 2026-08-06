/**
 * The two eBay environments, and what tells them apart (section 13).
 *
 * Sandbox and production are strictly isolated: separate keysets, seller
 * accounts, tokens, callbacks, data, and interface states. The isolation is
 * only real if nothing in the code can reach across, which is why every host is
 * derived from the environment on the connection rather than from configuration
 * that could be pointed anywhere, and why the credentials are looked up by
 * environment rather than passed in by whoever is calling.
 *
 * Hosts are hardcoded because they are eBay's, not the operator's. A
 * configurable API host is an SSRF sink with a friendly name: every token this
 * application holds would be sent to whatever it was set to.
 */

export type EbayEnvironment = 'sandbox' | 'production';

export interface EbayHosts {
  /** Where the operator is sent to consent. A browser destination, not an API. */
  readonly authorizeUrl: string;
  /** Token issue and refresh. */
  readonly tokenUrl: string;
  /** The modern REST APIs: Inventory, Fulfillment, Account. */
  readonly apiBase: string;
  /**
   * eBay serves a few APIs — Identity among them — from a different host. Not a
   * mistake in the configuration; two hosts is the actual arrangement.
   */
  readonly apizBase: string;
}

const HOSTS: Readonly<Record<EbayEnvironment, EbayHosts>> = {
  sandbox: {
    authorizeUrl: 'https://auth.sandbox.ebay.com/oauth2/authorize',
    tokenUrl: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    apiBase: 'https://api.sandbox.ebay.com',
    apizBase: 'https://apiz.sandbox.ebay.com',
  },
  production: {
    authorizeUrl: 'https://auth.ebay.com/oauth2/authorize',
    tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
    apiBase: 'https://api.ebay.com',
    apizBase: 'https://apiz.ebay.com',
  },
};

export function hostsFor(environment: EbayEnvironment): EbayHosts {
  return HOSTS[environment];
}

/**
 * The installation's eBay application credentials for one environment.
 *
 * Section 13: the operator supplies these per environment through installation
 * secrets. They are the application's identity, shared by every business in the
 * installation, which is why they live in the environment rather than in the
 * database beside a connection.
 */
export interface EbayCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * eBay's RuName, which is not a URL. It names a redirect configuration
   * registered in eBay's portal, and eBay resolves it to the accept and decline
   * URLs the operator configured there. Sending a URL here fails with an error
   * that does not say so.
   */
  readonly ruName: string;
}

export type CredentialLookup = (environment: EbayEnvironment) => EbayCredentials | null;

/**
 * Reads credentials out of a configuration object.
 *
 * Returns null rather than throwing when an environment is unconfigured, because
 * that is the ordinary state of a deployment that only uses production: the
 * sandbox screens should say "not configured", not fail.
 */
export function credentialsFrom(
  config: Readonly<Record<string, string | undefined>>,
): CredentialLookup {
  return (environment) => {
    const prefix = environment === 'sandbox' ? 'EIM_EBAY_SANDBOX' : 'EIM_EBAY_PRODUCTION';

    const clientId = config[`${prefix}_CLIENT_ID`];
    const clientSecret = config[`${prefix}_CLIENT_SECRET`];
    const ruName = config[`${prefix}_RUNAME`];

    if (
      clientId === undefined ||
      clientSecret === undefined ||
      ruName === undefined ||
      clientId === '' ||
      clientSecret === '' ||
      ruName === ''
    ) {
      return null;
    }

    return { clientId, clientSecret, ruName };
  };
}

/** The HTTP Basic credential eBay's token endpoint expects. */
export function basicAuthorization(credentials: EbayCredentials): string {
  const encoded = Buffer.from(
    `${credentials.clientId}:${credentials.clientSecret}`,
    'utf8',
  ).toString('base64');

  return `Basic ${encoded}`;
}
