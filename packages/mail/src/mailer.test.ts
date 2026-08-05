import { describe, expect, it } from 'vitest';

import { describeFailure } from './mailer';

/**
 * The failure describer.
 *
 * Section 20 requires delivery failures to be recorded without message secrets,
 * and an SMTP client's error routinely quotes the envelope, the recipient, and
 * sometimes the rejected body. These tests are about what does not survive.
 */

describe('describeFailure', () => {
  it('recognises a credential rejection', () => {
    expect(describeFailure(Object.assign(new Error('x'), { code: 'EAUTH' }))).toMatchObject({
      kind: 'authentication',
    });

    expect(describeFailure(Object.assign(new Error('x'), { responseCode: 535 }))).toMatchObject({
      kind: 'authentication',
    });
  });

  it('recognises a transport problem', () => {
    for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'EDNS']) {
      expect(describeFailure(Object.assign(new Error('x'), { code }))).toMatchObject({
        kind: 'connection',
      });
    }
  });

  it('recognises a refusal by the server', () => {
    expect(describeFailure(Object.assign(new Error('x'), { responseCode: 550 }))).toMatchObject({
      kind: 'rejected',
      responseCode: 550,
    });
  });

  it('falls back to unknown rather than guessing', () => {
    expect(describeFailure(new Error('something else'))).toMatchObject({ kind: 'unknown' });
    expect(describeFailure('a thrown string')).toMatchObject({ kind: 'unknown' });
    expect(describeFailure(null)).toMatchObject({ kind: 'unknown' });
  });

  it('keeps nothing from the error but the code', () => {
    // The whole point. nodemailer hangs the envelope and the response body off
    // the error, and this is written into an audit row that cannot be edited.
    const error = Object.assign(new Error('535 5.7.3 Authentication unsuccessful'), {
      code: 'EAUTH',
      responseCode: 535,
      response: '535 5.7.3 Authentication unsuccessful for noreply@example.invalid',
      command: 'AUTH LOGIN',
      envelope: { from: 'noreply@example.invalid', to: ['victim@example.invalid'] },
    });

    const described = describeFailure(error);
    const serialized = JSON.stringify(described);

    expect(serialized).not.toContain('victim@example.invalid');
    expect(serialized).not.toContain('noreply@example.invalid');
    expect(serialized).not.toContain('AUTH LOGIN');
    expect(Object.keys(described).sort()).toEqual(['kind', 'responseCode', 'summary']);
  });

  it('summarises in a way an operator can act on', () => {
    expect(describeFailure(Object.assign(new Error('x'), { code: 'EAUTH' })).summary).toMatch(
      /credentials/,
    );
    expect(
      describeFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).summary,
    ).toMatch(/could not be reached/);
  });

  it('omits the response code when the server never gave one', () => {
    expect(describeFailure(Object.assign(new Error('x'), { code: 'EDNS' }))).not.toHaveProperty(
      'responseCode',
    );
  });
});
