import { Writable } from 'node:stream';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { withContext } from './context';
import { childLogger, loggerOptions, type Logger } from './logger';

/**
 * Captures what the process would actually write.
 *
 * The redaction guarantee is about bytes on stdout, so these tests assert on
 * the serialized line rather than on the object handed to pino. A unit test
 * that inspects the input object would pass even if a formatter were wired up
 * wrongly and never ran.
 */
function captureLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });

  const logger = pino(loggerOptions({ level: 'trace', component: 'test' }), destination);

  return {
    logger,
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('writes the level as a word rather than a number', () => {
    const { logger, lines } = captureLogger();
    logger.info('projection applied');

    expect(lines()[0]?.['level']).toBe('info');
  });

  it('stamps the component on every line', () => {
    const { logger, lines } = captureLogger();
    logger.warn('slow provider');

    expect(lines()[0]?.['component']).toBe('test');
  });

  it('drops a non-allowlisted field written at the call site', () => {
    const { logger, lines } = captureLogger();
    logger.info({ businessId: 'b_1', refreshToken: 'v^1.1#SECRET' }, 'token refreshed');

    const line = lines()[0];
    expect(line?.['businessId']).toBe('b_1');
    expect(line?.['refreshToken']).toBeUndefined();
    expect(line?.['unloggedFields']).toEqual(['refreshToken']);
  });

  it('applies the same policy at trace as at error', () => {
    // Section 22: debug and trace change how much detail is emitted, never
    // whether redaction applies. A logger that loosened at trace would be worse
    // than useless, because trace is exactly when it gets turned on in anger.
    const { logger, lines } = captureLogger();

    logger.trace({ clientSecret: 'shh' }, 'entering');
    logger.error({ clientSecret: 'shh' }, 'failing');

    for (const line of lines()) {
      expect(line['clientSecret']).toBeUndefined();
      expect(JSON.stringify(line)).not.toContain('shh');
    }
  });

  it('serializes a thrown error without its attached request', () => {
    const { logger, lines } = captureLogger();
    const error = Object.assign(new Error('unauthorized'), {
      response: { headers: { authorization: 'Bearer SECRET' } },
    });

    logger.error({ err: error }, 'provider call failed');

    const rendered = JSON.stringify(lines()[0]);
    expect(rendered).toContain('unauthorized');
    expect(rendered).not.toContain('SECRET');
  });

  it('merges the ambient correlation context into a line', () => {
    const { logger, lines } = captureLogger();

    withContext({ correlationId: 'c_42', businessId: 'b_9' }, () => {
      logger.info('inside a request');
    });

    const line = lines()[0];
    expect(line?.['correlationId']).toBe('c_42');
    expect(line?.['businessId']).toBe('b_9');
  });

  it('filters ambient context on the same terms as explicit fields', () => {
    const { logger, lines } = captureLogger();

    withContext({ correlationId: 'c_1', ...{ apiKey: 'leaked' } }, () => {
      logger.info('inside a request');
    });

    expect(JSON.stringify(lines()[0])).not.toContain('leaked');
  });
});

describe('childLogger', () => {
  it('carries an allowlisted binding onto every subsequent line', () => {
    const { logger, lines } = captureLogger();
    const child = childLogger(logger, { connectionId: 'conn_3' });

    child.info('first');
    child.info('second');

    expect(lines().map((line) => line['connectionId'])).toEqual(['conn_3', 'conn_3']);
  });

  it('filters bindings, which pino would otherwise cache past the formatter', () => {
    // pino serializes child bindings once and concatenates the cached fragment
    // onto every later line, so formatters.log never sees them again. If this
    // assertion fails, a secret placed in a binding leaks on every line the
    // child ever writes.
    const { logger, lines } = captureLogger();
    const child = childLogger(logger, { connectionId: 'conn_3', accessToken: 'SECRET' });

    child.info('first');

    const line = lines()[0];
    expect(line?.['connectionId']).toBe('conn_3');
    expect(JSON.stringify(line)).not.toContain('SECRET');
  });
});
