import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './load';
import { FIELD_METADATA, FIELD_ORDER, SECRET_KEYS } from './fields';
import { configSchema, type ConfigKey } from './schema';
import { renderEnvExample } from './env-example';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

const productionEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  EIM_PUBLIC_URL: 'https://inventory.example.com',
  EIM_DATABASE_URL: 'postgresql://eim:secret@postgres:5432/eim',
  EIM_SESSION_SECRET: 'a'.repeat(48),
  EIM_KEYRING: JSON.stringify([{ version: 1, key: VALID_KEY }]),
  EIM_KEYRING_ACTIVE_VERSION: '1',
  EIM_SMTP_HOST: 'smtp.example.com',
  EIM_MAIL_FROM_ADDRESS: 'inventory@example.com',
  ...overrides,
});

describe('field specifications', () => {
  it('documents every schema key exactly once, in render order', () => {
    const schemaKeys = Object.keys(configSchema.shape).sort();
    const orderedKeys = [...FIELD_ORDER].sort();

    expect(new Set(FIELD_ORDER).size).toBe(FIELD_ORDER.length);
    // A key present in the schema but missing here would silently drop a
    // setting from the operator's generated reference.
    expect(orderedKeys).toStrictEqual(schemaKeys);
  });

  it('marks every credential-bearing setting as secret', () => {
    for (const key of [
      'EIM_DATABASE_URL',
      'EIM_SESSION_SECRET',
      'EIM_KEYRING',
      'EIM_SMTP_PASSWORD',
      'EIM_SETUP_SECRET',
      'EIM_EBAY_SANDBOX_CLIENT_SECRET',
      'EIM_EBAY_PRODUCTION_CLIENT_SECRET',
      'EIM_EBAY_DELETION_VERIFICATION_TOKEN',
    ]) {
      expect(SECRET_KEYS).toContain(key);
    }
  });

  it('never puts a real-looking value in the generated example', () => {
    const rendered = renderEnvExample();
    expect(rendered).not.toContain(VALID_KEY);

    for (const key of SECRET_KEYS) {
      // Every secret placeholder must be obviously unusable, so a copied
      // example file cannot accidentally become a working configuration.
      expect(FIELD_METADATA[key].example.toUpperCase()).toContain('CHANGE_ME');
    }
  });

  it('renders every key into the example file', () => {
    const rendered = renderEnvExample();
    for (const key of FIELD_ORDER) {
      expect(rendered).toContain(`\n${key}=`);
    }
  });

  it('marks each secret in the rendered file so an operator can see what to protect', () => {
    const rendered = renderEnvExample();
    for (const key of SECRET_KEYS satisfies readonly ConfigKey[]) {
      const index = rendered.indexOf(`\n${key}=`);
      expect(rendered.slice(Math.max(0, index - 400), index)).toContain('[secret]');
    }
  });
});

describe('loadConfig in production', () => {
  it('accepts a complete configuration', () => {
    const config = loadConfig({ source: productionEnv() });
    expect(config.EIM_PUBLIC_URL).toBe('https://inventory.example.com');
    expect(config.EIM_LOG_LEVEL).toBe('info');
    expect(config.EIM_DATA_UID).toBe(1000);
  });

  it('rejects a plain HTTP public URL', () => {
    expect(() =>
      loadConfig({ source: productionEnv({ EIM_PUBLIC_URL: 'http://inventory.example.com' }) }),
    ).toThrow(/must use HTTPS/);
  });

  it('rejects a missing required setting instead of guessing one', () => {
    const source = productionEnv();
    delete source['EIM_DATABASE_URL'];
    expect(() => loadConfig({ source })).toThrow(ConfigurationError);
  });

  it('rejects a development placeholder that reached production', () => {
    expect(() =>
      loadConfig({
        source: productionEnv({
          EIM_SESSION_SECRET: 'development-only-session-secret-not-for-production',
        }),
      }),
    ).toThrow(/development placeholder/);
  });

  it('rejects a session secret that is too short to be a keyed hash input', () => {
    expect(() => loadConfig({ source: productionEnv({ EIM_SESSION_SECRET: 'short' }) })).toThrow(
      ConfigurationError,
    );
  });
});

describe('keyring validation', () => {
  it('rejects a key that is not 32 bytes', () => {
    const source = productionEnv({
      EIM_KEYRING: JSON.stringify([{ version: 1, key: Buffer.alloc(16, 1).toString('base64') }]),
    });
    expect(() => loadConfig({ source })).toThrow(/32 bytes/);
  });

  it('rejects an active version that is not in the keyring', () => {
    const source = productionEnv({ EIM_KEYRING_ACTIVE_VERSION: '9' });
    expect(() => loadConfig({ source })).toThrow(/not present in EIM_KEYRING/);
  });

  it('rejects duplicate versions, which would make decryption ambiguous', () => {
    const source = productionEnv({
      EIM_KEYRING: JSON.stringify([
        { version: 1, key: VALID_KEY },
        { version: 1, key: Buffer.alloc(32, 9).toString('base64') },
      ]),
    });
    expect(() => loadConfig({ source })).toThrow(/duplicate version/);
  });

  it('accepts several versions during a rotation', () => {
    const source = productionEnv({
      EIM_KEYRING: JSON.stringify([
        { version: 1, key: VALID_KEY },
        { version: 2, key: Buffer.alloc(32, 9).toString('base64') },
      ]),
      EIM_KEYRING_ACTIVE_VERSION: '2',
    });
    expect(loadConfig({ source }).EIM_KEYRING_ACTIVE_VERSION).toBe(2);
  });

  it('rejects malformed JSON with a message that does not echo the value', () => {
    const source = productionEnv({ EIM_KEYRING: 'not json' });
    expect(() => loadConfig({ source })).toThrow(/must be valid JSON/);
    try {
      loadConfig({ source });
    } catch (error) {
      expect((error as Error).message).not.toContain('not json');
    }
  });
});

describe('loadConfig outside production', () => {
  it('boots from a near-empty environment using obvious placeholders', () => {
    const config = loadConfig({ source: { NODE_ENV: 'development' } });
    expect(config.EIM_PUBLIC_URL).toBe('http://localhost:3000');
    expect(config.EIM_SESSION_SECRET).toContain('development-only');
  });

  it('still validates anything the developer did supply', () => {
    expect(() =>
      loadConfig({ source: { NODE_ENV: 'development', EIM_PUBLIC_URL: 'not-a-url' } }),
    ).toThrow(ConfigurationError);
  });

  it('parses list settings into trimmed arrays', () => {
    const config = loadConfig({
      source: {
        NODE_ENV: 'development',
        EIM_TRUSTED_PROXY_CIDRS: ' 10.0.0.0/8 , 172.16.0.0/12 ,, ',
      },
    });
    expect(config.EIM_TRUSTED_PROXY_CIDRS).toStrictEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('treats the private-host escape hatch as disabled unless explicitly enabled', () => {
    expect(
      loadConfig({ source: { NODE_ENV: 'development' } }).EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
    ).toBe(false);
    expect(
      loadConfig({
        source: { NODE_ENV: 'development', EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS: 'true' },
      }).EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
    ).toBe(true);
  });
});
