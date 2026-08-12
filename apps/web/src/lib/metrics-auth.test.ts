import { describe, expect, it } from 'vitest';

import { assessScrape } from './metrics-auth';

/**
 * Who may scrape (section 22).
 *
 * The case worth being deliberate about is the unconfigured one: it is the
 * default state of every installation that has not thought about metrics, and
 * the wrong answer there is an open endpoint on the public internet.
 */

const TOKEN = 'a'.repeat(32);

describe('assessScrape', () => {
  it('says the endpoint does not exist until somebody configures it', () => {
    // Not "unauthorized": an unconfigured installation should not advertise
    // that there is something here worth finding a token for.
    expect(assessScrape(`Bearer ${TOKEN}`, undefined)).toBe('not_configured');
    expect(assessScrape(null, undefined)).toBe('not_configured');
  });

  it('allows the configured token', () => {
    expect(assessScrape(`Bearer ${TOKEN}`, TOKEN)).toBe('allowed');
  });

  it('refuses a missing, malformed, or wrong credential', () => {
    expect(assessScrape(null, TOKEN)).toBe('unauthorized');
    expect(assessScrape('', TOKEN)).toBe('unauthorized');
    expect(assessScrape(TOKEN, TOKEN)).toBe('unauthorized');
    expect(assessScrape(`Basic ${TOKEN}`, TOKEN)).toBe('unauthorized');
    expect(assessScrape(`bearer ${TOKEN}`, TOKEN)).toBe('unauthorized');
    expect(assessScrape(`Bearer ${'b'.repeat(32)}`, TOKEN)).toBe('unauthorized');
  });

  it('refuses a prefix of the token, which a length comparison alone would not', () => {
    expect(assessScrape(`Bearer ${TOKEN.slice(0, 16)}`, TOKEN)).toBe('unauthorized');
    expect(assessScrape(`Bearer ${TOKEN}extra`, TOKEN)).toBe('unauthorized');
  });
});
