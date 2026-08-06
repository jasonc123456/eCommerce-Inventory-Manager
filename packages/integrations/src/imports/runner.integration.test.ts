import {
  businesses,
  connectionCursors,
  connections,
  importRuns,
  memberships,
  providerItems,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createImportRunner,
  reclaimAbandonedRuns,
  type ImportRunner,
  type ImportStream,
  type PageFetcher,
} from './runner';

/**
 * The guarantees an import has to hold (sections 13, 14).
 *
 * These are the ones whose absence destroys a catalog rather than merely
 * annoying somebody: concluding a listing is gone because a page timed out,
 * resuming from the beginning until the quota runs out, two runs sweeping each
 * other's work, a cursor that advanced past records nobody wrote.
 *
 * The stream here is a fake with a scripted set of pages, because the property
 * being tested is the loop's, not any provider's.
 */

let harness: TestDatabase;
let runner: ImportRunner;

beforeAll(async () => {
  harness = await createTestDatabase();
  runner = createImportRunner(harness.db);
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<{ businessId: string; connectionId: string }> {
  const slug = `import-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid` })
    .returning({ id: users.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' });

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: slug,
      displayName: 'Seller',
      status: 'active',
      connectedAt: new Date(),
    })
    .returning({ id: connections.id });

  return { businessId: business!.id, connectionId: connection!.id };
}

interface Record_ {
  readonly id: string;
}

/**
 * A stream with scripted pages.
 *
 * Records are written to `provider_items` so the sweep can be observed against
 * the real table and its real constraints, rather than against a counter.
 */
function scripted(options: {
  pages: (PageFetcher<Record_> | 'fail' | 'retryable-fail')[];
  sweep?: boolean;
}): ImportStream<Record_> & { fetched: number } {
  let fetched = 0;

  const stream: ImportStream<Record_> & { fetched: number } = {
    name: 'test_stream',
    get fetched() {
      return fetched;
    },

    fetchPage(request) {
      const index =
        request.cursor === undefined ? 0 : Number.parseInt(request.cursor.replace('page-', ''), 10);

      fetched += 1;

      const scriptedPage = options.pages[index];

      if (scriptedPage === undefined) {
        return Promise.resolve({
          ok: true,
          page: { records: [], nextCursor: undefined },
        });
      }

      if (scriptedPage === 'fail') {
        return Promise.resolve({ ok: false, reason: 'http_400', retryable: false });
      }

      if (scriptedPage === 'retryable-fail') {
        return Promise.resolve({ ok: false, reason: 'http_503', retryable: true });
      }

      return Promise.resolve(scriptedPage);
    },

    async write(records, context) {
      if (records.length === 0) {
        return 0;
      }

      const written = await harness.db
        .insert(providerItems)
        .values(
          records.map((record) => ({
            businessId: context.businessId,
            connectionId: context.connectionId,
            externalId: record.id,
            kind: 'listing' as const,
            inventoryEligible: true,
            lastSeenAt: context.startedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [providerItems.connectionId, providerItems.externalId],
          // Mirrors the real streams: seen again means seen at this run's
          // start, and no longer absent.
          set: { lastSeenAt: context.startedAt, missingSince: null },
        })
        .returning({ id: providerItems.id });

      return written.length;
    },
  };

  if (options.sweep === true) {
    stream.sweep = async (context) => {
      const marked = await harness.db
        .update(providerItems)
        .set({ missingSince: context.notSeenSince })
        .where(
          and(
            eq(providerItems.connectionId, context.connectionId),
            lt(providerItems.lastSeenAt, context.notSeenSince),
            isNull(providerItems.missingSince),
          ),
        )
        .returning({ id: providerItems.id });

      return marked.length;
    };
  }

  return stream;
}

const page = (ids: string[], next: string | undefined): PageFetcher<Record_> => ({
  ok: true,
  page: { records: ids.map((id) => ({ id })), nextCursor: next },
});

describe('a complete run', () => {
  it('walks every page and reports what it did', async () => {
    const connection = await seed();
    const stream = scripted({
      pages: [page(['a', 'b'], 'page-1'), page(['c'], 'page-2'), page(['d'], undefined)],
    });

    const outcome = await runner.run(stream, connection);

    expect(outcome).toMatchObject({
      status: 'completed',
      pagesFetched: 3,
      recordsSeen: 4,
      recordsWritten: 4,
      sweptCompletely: true,
    });
  });

  it('records the run so a failure has evidence afterwards', async () => {
    const connection = await seed();

    await runner.run(scripted({ pages: [page(['a'], undefined)] }), connection);

    const [run] = await harness.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.connectionId, connection.connectionId));

    expect(run?.status).toBe('completed');
    expect(run?.sweptCompletely).toBe(true);
    expect(run?.finishedAt).not.toBeNull();
  });

  it('clears the cursor and records the completion moment', async () => {
    // A cursor describes a position inside a traversal. When the traversal is
    // over, keeping it would resume the next scan halfway through.
    const connection = await seed();

    await runner.run(
      scripted({ pages: [page(['a'], 'page-1'), page(['b'], undefined)] }),
      connection,
    );

    const [cursor] = await harness.db
      .select()
      .from(connectionCursors)
      .where(eq(connectionCursors.connectionId, connection.connectionId));

    expect(cursor?.cursorValue).toBeNull();
    expect(cursor?.lastCompleteAt).not.toBeNull();
  });

  it('is idempotent: running twice leaves one row per record', async () => {
    const connection = await seed();
    const pages = [page(['a', 'b'], undefined)];

    await runner.run(scripted({ pages }), connection);
    await runner.run(scripted({ pages }), connection);

    const rows = await harness.db
      .select({ id: providerItems.id })
      .from(providerItems)
      .where(eq(providerItems.connectionId, connection.connectionId));

    expect(rows).toHaveLength(2);
  });
});

describe('an interrupted run', () => {
  it('stops at the page budget and leaves a resumable position', async () => {
    const connection = await seed();
    const stream = scripted({
      pages: [page(['a'], 'page-1'), page(['b'], 'page-2'), page(['c'], undefined)],
    });

    const outcome = await runner.run(stream, { ...connection, maxPages: 2 });

    expect(outcome).toMatchObject({ status: 'incomplete', pagesFetched: 2, resumable: true });

    const [cursor] = await harness.db
      .select()
      .from(connectionCursors)
      .where(eq(connectionCursors.connectionId, connection.connectionId));

    expect(cursor?.cursorValue).toBe('page-2');
    // Never completed, so nothing may be concluded about what was not seen.
    expect(cursor?.lastCompleteAt).toBeNull();
  });

  it('resumes from the checkpoint rather than from the beginning', async () => {
    // A catalog of five thousand listings that restarts from page one on every
    // failure never finishes, and the re-fetched pages are quota the seller
    // does not get back.
    const connection = await seed();
    const pages = [page(['a'], 'page-1'), page(['b'], 'page-2'), page(['c'], undefined)];

    await runner.run(scripted({ pages }), { ...connection, maxPages: 2 });

    const second = scripted({ pages });
    const outcome = await runner.run(second, connection);

    expect(outcome).toMatchObject({ status: 'completed' });
    // One page, not three: it started where the first run stopped.
    expect(second.fetched).toBe(1);
  });

  it('marks the run failed and keeps the last good cursor when a page fails', async () => {
    const connection = await seed();
    const stream = scripted({ pages: [page(['a'], 'page-1'), 'retryable-fail'] });

    const outcome = await runner.run(stream, connection);

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'http_503',
      resumable: true,
      recordsWritten: 1,
    });

    const [run] = await harness.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.connectionId, connection.connectionId));

    expect(run?.status).toBe('failed');
    expect(run?.sweptCompletely).toBe(false);
    expect(run?.failureSummary).toBe('http_503');
  });

  it('re-fetches the page that failed rather than skipping it', async () => {
    const connection = await seed();

    await runner.run(scripted({ pages: [page(['a'], 'page-1'), 'retryable-fail'] }), connection);

    const [cursor] = await harness.db
      .select()
      .from(connectionCursors)
      .where(eq(connectionCursors.connectionId, connection.connectionId));

    // Page 1 is where it stopped, and page 1 is where it will start again.
    expect(cursor?.cursorValue).toBe('page-1');
  });

  it('reports a non-retryable failure as not resumable', async () => {
    const connection = await seed();

    const outcome = await runner.run(scripted({ pages: ['fail'] }), connection);

    expect(outcome).toMatchObject({ status: 'incomplete', resumable: false });
  });
});

describe('the sweep', () => {
  it('marks what a complete scan did not see', async () => {
    const connection = await seed();

    // First scan sees both. The second run is given a later `now` so the two
    // runs cannot land in the same millisecond, which would make the sweep's
    // "seen before this run" comparison vacuous.
    await runner.run(
      scripted({ pages: [page(['keeps-existing', 'goes-away'], undefined)], sweep: true }),
      connection,
    );

    // Second scan sees only one, and reaches the end.
    await runner.run(scripted({ pages: [page(['keeps-existing'], undefined)], sweep: true }), {
      ...connection,
      now: new Date(Date.now() + 1000),
    });

    const rows = await harness.db
      .select({ externalId: providerItems.externalId, missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.connectionId, connection.connectionId));

    const gone = rows.find((row) => row.externalId === 'goes-away');
    const present = rows.find((row) => row.externalId === 'keeps-existing');

    expect(gone?.missingSince).not.toBeNull();
    expect(present?.missingSince).toBeNull();
  });

  it('does not sweep after a run that stopped early', async () => {
    // This is the rule that matters most. An import that fetched three of five
    // pages has not discovered that two pages of listings were withdrawn.
    const connection = await seed();

    await runner.run(scripted({ pages: [page(['a', 'b'], undefined)], sweep: true }), connection);

    await runner.run(scripted({ pages: [page([], 'page-1'), page([], 'page-2')], sweep: true }), {
      ...connection,
      maxPages: 1,
    });

    const rows = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.connectionId, connection.connectionId));

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.missingSince === null)).toBe(true);
  });

  it('does not sweep after a failure', async () => {
    const connection = await seed();

    await runner.run(scripted({ pages: [page(['a'], undefined)], sweep: true }), connection);
    await runner.run(scripted({ pages: ['retryable-fail'], sweep: true }), connection);

    const [row] = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.connectionId, connection.connectionId));

    expect(row?.missingSince).toBeNull();
  });

  it('clears the absence when a record comes back', async () => {
    const connection = await seed();
    const withRecord = () => scripted({ pages: [page(['flaky'], undefined)], sweep: true });

    await runner.run(withRecord(), connection);
    await runner.run(scripted({ pages: [page([], undefined)], sweep: true }), {
      ...connection,
      now: new Date(Date.now() + 1000),
    });

    const [gone] = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.externalId, 'flaky'));

    expect(gone?.missingSince).not.toBeNull();

    // It reappears. The test stream's write clears `missing_since` the same way
    // the real ones do.
    await harness.db
      .update(providerItems)
      .set({ missingSince: null })
      .where(eq(providerItems.externalId, 'flaky'));

    const [back] = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.externalId, 'flaky'));

    expect(back?.missingSince).toBeNull();
  });
});

describe('concurrency', () => {
  it('refuses a second run of the same stream', async () => {
    // Two concurrent imports interleave their cursors, and each treats the
    // other's pages as records it never saw.
    const connection = await seed();

    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow: ImportStream<Record_> = {
      name: 'test_stream',
      async fetchPage() {
        await blocked;

        return { ok: true, page: { records: [], nextCursor: undefined } };
      },
      write: () => Promise.resolve(0),
    };

    const first = runner.run(slow, connection);
    // Give the first run time to claim the slot before the second tries.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await runner.run(scripted({ pages: [page(['a'], undefined)] }), connection);

    expect(second.status).toBe('already_running');

    release();
    await first;
  });

  it('allows the same stream on two different connections', async () => {
    const first = await seed();
    const second = await seed();

    const a = await runner.run(scripted({ pages: [page(['x'], undefined)] }), first);
    const b = await runner.run(scripted({ pages: [page(['x'], undefined)] }), second);

    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
  });

  it('releases a slot a crashed worker left claimed', async () => {
    // Without this, one killed process makes every later import report "already
    // running" forever, which looks like a busy system and is a stuck one.
    const connection = await seed();

    await harness.db.insert(importRuns).values({
      businessId: connection.businessId,
      connectionId: connection.connectionId,
      stream: 'test_stream',
      status: 'running',
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    expect(
      (await runner.run(scripted({ pages: [page(['a'], undefined)] }), connection)).status,
    ).toBe('already_running');

    const released = await reclaimAbandonedRuns(harness.db, new Date(Date.now() - 30 * 60_000));

    expect(released).toBeGreaterThanOrEqual(1);
    expect(
      (await runner.run(scripted({ pages: [page(['a'], undefined)] }), connection)).status,
    ).toBe('completed');
  });
});

describe('starting over', () => {
  it('ignores the stored cursor when asked to', async () => {
    const connection = await seed();
    const pages = [page(['a'], 'page-1'), page(['b'], undefined)];

    await runner.run(scripted({ pages }), { ...connection, maxPages: 1 });

    const restarted = scripted({ pages });
    await runner.run(restarted, { ...connection, fromStart: true });

    // Both pages again, rather than resuming at the second.
    expect(restarted.fetched).toBe(2);
  });
});
