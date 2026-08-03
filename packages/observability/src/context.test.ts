import { describe, expect, it } from 'vitest';

import { currentContext, newCorrelationId, withContext } from './context';

describe('correlation context', () => {
  it('has no context outside a scope', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('generates a correlation identifier when the caller supplies none', () => {
    withContext({ businessId: 'b_1' }, () => {
      expect(currentContext()?.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('survives an await, which is the whole reason for using it', async () => {
    await withContext({ correlationId: 'c_1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentContext()?.correlationId).toBe('c_1');
    });
  });

  it('keeps the enclosing correlation identifier through a nested scope', () => {
    // A job started inside a request belongs to that request's trail. Minting a
    // fresh identifier here is what breaks an incident into two halves that
    // nobody can join back up.
    withContext({ correlationId: 'c_outer', businessId: 'b_1' }, () => {
      withContext({ jobId: 'j_9' }, () => {
        expect(currentContext()).toMatchObject({
          correlationId: 'c_outer',
          businessId: 'b_1',
          jobId: 'j_9',
        });
      });
    });
  });

  it('lets a nested scope take a deliberate new identifier', () => {
    withContext({ correlationId: 'c_outer' }, () => {
      withContext({ correlationId: 'c_inner' }, () => {
        expect(currentContext()?.correlationId).toBe('c_inner');
      });
      expect(currentContext()?.correlationId).toBe('c_outer');
    });
  });

  it('does not leak out of its scope', () => {
    withContext({ correlationId: 'c_1' }, () => undefined);
    expect(currentContext()).toBeUndefined();
  });

  it('mints distinct correlation identifiers', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});
