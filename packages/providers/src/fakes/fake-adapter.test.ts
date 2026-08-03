import { describe, expect, it } from 'vitest';

import { isRetryable } from '../outcomes';
import { FakeChannelAdapter, entityKey } from './fake-adapter';

/**
 * The fake is test infrastructure, so it gets tested itself. A fake that
 * silently stops honouring `failNext` would turn every retry test into a test
 * of the happy path, and all of them would still pass.
 */

const ITEM = { externalId: 'sku-1' };
const VARIATION = { externalId: 'prod-9', variationId: 'var-3' };

function adapter(): FakeChannelAdapter {
  return new FakeChannelAdapter({
    initialQuantities: new Map([
      [entityKey(ITEM), 10],
      [entityKey(VARIATION), 4],
    ]),
    entities: [ITEM, VARIATION],
  });
}

describe('entityKey', () => {
  it('distinguishes a variation from its parent', () => {
    expect(entityKey({ externalId: 'p' })).not.toBe(
      entityKey({ externalId: 'p', variationId: 'v' }),
    );
  });
});

describe('reads', () => {
  it('reports the current quantity and a version', async () => {
    const result = await adapter().readQuantities([ITEM]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.value[0]?.quantity).toBe(10);
    expect(result.value[0]?.version).toBe('1');
  });

  it('omits an entity the provider does not have', async () => {
    const result = await adapter().readQuantities([{ externalId: 'missing' }]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.value).toHaveLength(0);
  });

  it('reports negative stock rather than clamping it', async () => {
    // Section 8 as amended by D-130: a backorder-enabled channel records
    // unfulfilled demand as negative stock, and an adapter that helpfully
    // clamped it to zero would destroy the merchant's record of what they owe
    // before the domain ever got to decide.
    const fake = adapter();
    fake.enableBackorders(ITEM).setQuantityOutOfBand(ITEM, -3);

    const result = await fake.readQuantities([ITEM]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.value[0]?.quantity).toBe(-3);
    expect(result.value[0]?.backordersEnabled).toBe(true);
  });
});

describe('writes', () => {
  it('applies an absolute quantity', async () => {
    const fake = adapter();
    await fake.writeQuantities([{ entity: ITEM, quantity: 7, idempotencyKey: 'k1' }]);

    expect(fake.quantityOf(ITEM)).toBe(7);
  });

  it('is idempotent under repetition, because writes are absolute', async () => {
    // The reason section 8 forbids deltas. Applying this twice must leave the
    // same quantity, or an ambiguous timeout becomes an oversell.
    const fake = adapter();
    const write = { entity: ITEM, quantity: 7, idempotencyKey: 'k1' };

    await fake.writeQuantities([write]);
    await fake.writeQuantities([write]);

    expect(fake.quantityOf(ITEM)).toBe(7);
  });

  it('reports a no-op write as unchanged', async () => {
    const fake = adapter();
    const result = await fake.writeQuantities([
      { entity: ITEM, quantity: 10, idempotencyKey: 'k1' },
    ]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const first = result.value[0];
    expect(first?.status).toBe('success');
    if (first?.status !== 'success') return;
    expect(first.value.unchanged).toBe(true);
  });

  it('rejects a stale expected version instead of overwriting', async () => {
    const fake = adapter();
    fake.setQuantityOutOfBand(ITEM, 2);

    const result = await fake.writeQuantities([
      { entity: ITEM, quantity: 9, expectedVersion: '1', idempotencyKey: 'k1' },
    ]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.value[0]?.status).toBe('conflict');
    // The out-of-band value survives: a lost update is exactly what optimistic
    // concurrency exists to prevent.
    expect(fake.quantityOf(ITEM)).toBe(2);
  });

  it('reports per-entity outcomes for a partial batch failure', async () => {
    // A provider accepting one write and refusing another is ordinary. The
    // caller has to record both accurately, so the batch cannot collapse to a
    // single verdict.
    const fake = adapter();

    const result = await fake.writeQuantities([
      { entity: ITEM, quantity: 3, idempotencyKey: 'k1' },
      { entity: { externalId: 'missing' }, quantity: 1, idempotencyKey: 'k2' },
    ]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.value.map((entry) => entry.status)).toEqual(['success', 'not_found']);
    expect(fake.quantityOf(ITEM)).toBe(3);
  });

  it('refuses a batch larger than the provider accepts', async () => {
    const fake = new FakeChannelAdapter({
      capabilities: { maxBatchSize: 2 },
      initialQuantities: new Map([[entityKey(ITEM), 1]]),
    });

    const result = await fake.writeQuantities(
      [1, 2, 3].map((n) => ({ entity: ITEM, quantity: n, idempotencyKey: `k${String(n)}` })),
    );

    expect(result.status).toBe('rejected');
  });

  it('records what was sent, so tests can assert on it', async () => {
    const fake = adapter();
    await fake.writeQuantities([{ entity: ITEM, quantity: 5, idempotencyKey: 'k1' }]);

    expect(fake.writes).toEqual([{ entityKey: 'sku-1', quantity: 5, idempotencyKey: 'k1' }]);
  });
});

describe('queued failures', () => {
  it('fails the next call, then behaves normally', async () => {
    const fake = adapter();
    fake.failNext({ status: 'rate_limited', retryAfterMs: 1_000 });

    const first = await fake.readQuantities([ITEM]);
    const second = await fake.readQuantities([ITEM]);

    expect(first.status).toBe('rate_limited');
    expect(second.status).toBe('success');
  });

  it('queues several, in order', async () => {
    const fake = adapter();
    fake
      .failNext({ status: 'unavailable', message: 'gateway' })
      .failNext({ status: 'rate_limited', retryAfterMs: 500 });

    expect((await fake.readQuantities([ITEM])).status).toBe('unavailable');
    expect((await fake.readQuantities([ITEM])).status).toBe('rate_limited');
    expect((await fake.readQuantities([ITEM])).status).toBe('success');
  });

  it('produces a revoked authorization, which must not be retried', async () => {
    const fake = adapter();
    fake.failNext({
      status: 'unauthorized',
      requiresReauthorization: true,
      message: 'grant revoked',
    });

    const result = await fake.checkCredentials();

    expect(result.status).toBe('unauthorized');
    expect(isRetryable(result)).toBe(false);
  });
});

describe('pagination', () => {
  it('walks pages to the end', async () => {
    const entities = Array.from({ length: 5 }, (_, index) => ({
      externalId: `sku-${String(index)}`,
    }));
    const fake = new FakeChannelAdapter({ entities, pageSize: 2 });

    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await fake.listEntities(cursor);
      expect(result.status).toBe('success');
      if (result.status !== 'success') return;
      seen.push(...result.value.items.map((entity) => entity.externalId));
      cursor = result.value.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(5);
  });

  it('rejects a malformed cursor rather than starting over', async () => {
    // Silently restarting from the beginning would re-import an entire catalog
    // and look like success.
    const result = await adapter().listEntities('not-a-number');

    expect(result.status).toBe('rejected');
  });
});

describe('webhook verification', () => {
  const body = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it('accepts a signed webhook', async () => {
    const result = await adapter().verifyWebhook({
      rawBody: body({ eventId: 'e-1', eventType: 'item.updated', externalId: 'sku-1' }),
      headers: { 'x-fake-signature': 'valid' },
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.value.eventId).toBe('e-1');
    expect(result.value.affects[0]?.externalId).toBe('sku-1');
  });

  it('rejects an unsigned webhook without looking at the body', async () => {
    // Section 19 treats an unverifiable webhook as hostile. Parsing it for
    // content first is how a forged payload gets a foothold.
    const result = await adapter().verifyWebhook({
      rawBody: body({ eventId: 'e-1', eventType: 'item.updated' }),
      headers: {},
    });

    expect(result.status).toBe('rejected');
  });

  it('rejects a signed webhook that is not JSON', async () => {
    const result = await adapter().verifyWebhook({
      rawBody: new TextEncoder().encode('not json'),
      headers: { 'x-fake-signature': 'valid' },
    });

    expect(result.status).toBe('rejected');
  });
});
