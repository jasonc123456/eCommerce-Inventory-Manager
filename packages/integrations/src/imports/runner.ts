import { connectionCursors, importRuns, type Database } from '@eim/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Running an import (sections 13, 14, 15).
 *
 * Every provider paginates differently and every stream carries different
 * records, but the shape of an import is the same one each time, and the
 * dangerous parts are in that shape rather than in any provider's API. So the
 * loop lives here, once, and each stream supplies only the two things that are
 * genuinely its own: how to fetch a page, and how to write what is in it.
 *
 * Four rules, each of which is a way an import quietly corrupts a catalog:
 *
 *   A partial scan never concludes anything is gone. Section 13 permits
 *   declaring a disappearance only after a complete successful scan. An import
 *   that fetched three pages of five and then timed out has not discovered that
 *   two pages' worth of listings were withdrawn — but a sweep keyed on "not
 *   seen during this run" cannot tell the difference. So the sweep runs only
 *   when the run actually reached the end.
 *
 *   Resumption is from a checkpoint, not from the beginning. A catalog of five
 *   thousand listings that restarts from page one on every failure never
 *   finishes, and the pages it re-fetches are quota the seller does not get
 *   back.
 *
 *   One run per stream at a time. Two concurrent imports interleave their
 *   cursors, and each ends up treating the pages the other fetched as records
 *   it never saw — which, combined with a sweep, deletes half the catalog.
 *
 *   The cursor advances only on success. A cursor moved before the records are
 *   written is a window where a crash loses everything in between, and nothing
 *   later notices, because the cursor says that ground has been covered.
 */

export interface PageRequest {
  /** Where the previous run stopped, or undefined on a fresh start. */
  readonly cursor: string | undefined;
  /** Partial progress inside the stream, as the fetcher last described it. */
  readonly checkpoint: Readonly<Record<string, unknown>>;
}

export interface PageResult<T> {
  readonly records: readonly T[];
  /** Where to resume. Undefined means this page was the last one. */
  readonly nextCursor: string | undefined;
  /** Replaces the stored checkpoint. */
  readonly checkpoint?: Readonly<Record<string, unknown>>;
}

export type PageFetcher<T> =
  | { readonly ok: true; readonly page: PageResult<T> }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface ImportStream<T> {
  /** Names the cursor and the run. Stable: it is a database key. */
  readonly name: string;
  fetchPage(request: PageRequest): Promise<PageFetcher<T>>;
  /**
   * Writes one page. Returns how many rows it actually wrote, which is not the
   * same as how many were in the page: an unchanged record is seen but not
   * written, and the difference is what tells an operator whether an import did
   * anything.
   */
  write(records: readonly T[], context: WriteContext): Promise<number>;
  /**
   * Marks whatever a complete scan did not see. Called only after a run reaches
   * the end of the stream, and not at all for streams where absence means
   * nothing — orders are never withdrawn, so an order missing from a scan is
   * simply an order outside its window.
   */
  sweep?(context: SweepContext): Promise<number>;
}

export interface WriteContext {
  readonly businessId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly startedAt: Date;
}

export interface SweepContext extends WriteContext {
  /** Records last seen before this are absent from a scan that reached the end. */
  readonly notSeenSince: Date;
}

export interface RunImportInput {
  readonly businessId: string;
  readonly connectionId: string;
  /** Stops the run cleanly after this many pages, leaving a resumable checkpoint. */
  readonly maxPages?: number;
  readonly now?: Date;
  /** Starts from the beginning, ignoring the stored cursor. */
  readonly fromStart?: boolean;
}

export type ImportOutcome =
  | {
      readonly status: 'completed';
      readonly runId: string;
      readonly pagesFetched: number;
      readonly recordsSeen: number;
      readonly recordsWritten: number;
      readonly recordsMissing: number;
      readonly sweptCompletely: true;
    }
  | {
      readonly status: 'incomplete';
      readonly runId: string;
      readonly pagesFetched: number;
      readonly recordsSeen: number;
      readonly recordsWritten: number;
      /** Why it stopped: a page budget, or a failure. */
      readonly reason: string;
      readonly resumable: boolean;
    }
  | { readonly status: 'already_running'; readonly runId: string };

export interface ImportRunner {
  run<T>(stream: ImportStream<T>, input: RunImportInput): Promise<ImportOutcome>;
}

const DEFAULT_MAX_PAGES = 200;

export function createImportRunner(db: Database): ImportRunner {
  return {
    async run(stream, input) {
      const now = input.now ?? new Date();
      const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;

      const claimed = await claim(db, input, stream.name, now);

      if (claimed.status === 'already_running') {
        return claimed;
      }

      const runId = claimed.runId;
      const stored = await readCursor(db, input.connectionId, stream.name);

      let cursor = input.fromStart === true ? undefined : stored.cursor;
      let checkpoint = input.fromStart === true ? {} : stored.checkpoint;

      let pagesFetched = 0;
      let recordsSeen = 0;
      let recordsWritten = 0;

      for (;;) {
        if (pagesFetched >= maxPages) {
          // Not a failure. The checkpoint is current, so the next run picks up
          // exactly here, and the stream is left un-swept because it was not
          // finished.
          await finish(db, runId, {
            status: 'completed',
            sweptCompletely: false,
            pagesFetched,
            recordsSeen,
            recordsWritten,
            checkpoint,
            finishedAt: new Date(now.getTime()),
          });

          await saveCursor(db, input, stream.name, { cursor, checkpoint, completedAt: null });

          return {
            status: 'incomplete',
            runId,
            pagesFetched,
            recordsSeen,
            recordsWritten,
            reason: `stopped after ${String(maxPages)} pages`,
            resumable: true,
          };
        }

        const fetched = await stream.fetchPage({ cursor, checkpoint });

        if (!fetched.ok) {
          await finish(db, runId, {
            status: 'failed',
            sweptCompletely: false,
            pagesFetched,
            recordsSeen,
            recordsWritten,
            checkpoint,
            failureSummary: fetched.reason,
            finishedAt: new Date(now.getTime()),
          });

          // The cursor keeps its last good position rather than the failed
          // one, so a resume re-fetches the page that failed instead of
          // skipping it.
          await saveCursor(db, input, stream.name, { cursor, checkpoint, completedAt: null });

          return {
            status: 'incomplete',
            runId,
            pagesFetched,
            recordsSeen,
            recordsWritten,
            reason: fetched.reason,
            resumable: fetched.retryable,
          };
        }

        const page = fetched.page;

        pagesFetched += 1;
        recordsSeen += page.records.length;

        if (page.records.length > 0) {
          recordsWritten += await stream.write(page.records, {
            businessId: input.businessId,
            connectionId: input.connectionId,
            runId,
            startedAt: now,
          });
        }

        checkpoint = page.checkpoint ?? checkpoint;

        // Advanced only after the page's records are written. A cursor moved
        // first is a window where a crash loses everything in between, and
        // nothing later notices because the cursor says that ground is covered.
        cursor = page.nextCursor;

        if (page.nextCursor === undefined) {
          break;
        }
      }

      // The stream ended. Only now may anything be concluded about what was not
      // in it.
      const context: SweepContext = {
        businessId: input.businessId,
        connectionId: input.connectionId,
        runId,
        startedAt: now,
        notSeenSince: now,
      };

      const recordsMissing = stream.sweep === undefined ? 0 : await stream.sweep(context);

      await finish(db, runId, {
        status: 'completed',
        sweptCompletely: true,
        pagesFetched,
        recordsSeen,
        recordsWritten,
        checkpoint: {},
        finishedAt: new Date(),
      });

      await saveCursor(db, input, stream.name, {
        // A completed scan starts fresh next time: the cursor described a
        // position inside a traversal that is over.
        cursor: undefined,
        checkpoint: {},
        completedAt: new Date(),
      });

      return {
        status: 'completed',
        runId,
        pagesFetched,
        recordsSeen,
        recordsWritten,
        recordsMissing,
        sweptCompletely: true,
      };
    },
  };
}

// ---------------------------------------------------------------------------

type Claim = { status: 'claimed'; runId: string } | { status: 'already_running'; runId: string };

/**
 * Takes the one running slot for this stream.
 *
 * The partial unique index does the deciding, so two callers cannot both
 * believe they claimed it. A caller that loses is told which run holds the slot
 * rather than being handed an error, because the honest answer to "import my
 * catalog" while an import is running is "one already is".
 */
async function claim(
  db: Database,
  input: RunImportInput,
  stream: string,
  now: Date,
): Promise<Claim> {
  const inserted = await db
    .insert(importRuns)
    .values({
      businessId: input.businessId,
      connectionId: input.connectionId,
      stream,
      status: 'running',
      startedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: importRuns.id });

  const claimedRun = inserted[0];

  if (claimedRun !== undefined) {
    return { status: 'claimed', runId: claimedRun.id };
  }

  const [existing] = await db
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.connectionId, input.connectionId),
        eq(importRuns.stream, stream),
        eq(importRuns.status, 'running'),
      ),
    )
    .limit(1);

  // The row vanished between the conflict and the read, which means the other
  // run finished in that instant. Reporting it as running is the safe answer:
  // the caller retries and claims it cleanly.
  return { status: 'already_running', runId: existing?.id ?? 'unknown' };
}

interface FinishInput {
  readonly status: 'completed' | 'failed';
  readonly sweptCompletely: boolean;
  readonly pagesFetched: number;
  readonly recordsSeen: number;
  readonly recordsWritten: number;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly failureSummary?: string;
  readonly finishedAt: Date;
}

async function finish(db: Database, runId: string, input: FinishInput): Promise<void> {
  await db
    .update(importRuns)
    .set({
      status: input.status,
      sweptCompletely: input.sweptCompletely,
      pagesFetched: input.pagesFetched,
      recordsSeen: input.recordsSeen,
      recordsWritten: input.recordsWritten,
      checkpoint: input.checkpoint,
      finishedAt: input.finishedAt,
      ...(input.failureSummary === undefined ? {} : { failureSummary: input.failureSummary }),
    })
    .where(eq(importRuns.id, runId));
}

async function readCursor(
  db: Database,
  connectionId: string,
  stream: string,
): Promise<{ cursor: string | undefined; checkpoint: Record<string, unknown> }> {
  const [row] = await db
    .select()
    .from(connectionCursors)
    .where(
      and(eq(connectionCursors.connectionId, connectionId), eq(connectionCursors.stream, stream)),
    )
    .limit(1);

  return {
    cursor: row?.cursorValue ?? undefined,
    checkpoint: (row?.checkpoint ?? {}) as Record<string, unknown>,
  };
}

async function saveCursor(
  db: Database,
  input: RunImportInput,
  stream: string,
  state: {
    cursor: string | undefined;
    checkpoint: Readonly<Record<string, unknown>>;
    completedAt: Date | null;
  },
): Promise<void> {
  await db
    .insert(connectionCursors)
    .values({
      businessId: input.businessId,
      connectionId: input.connectionId,
      stream,
      cursorValue: state.cursor ?? null,
      checkpoint: state.checkpoint,
      lastCompleteAt: state.completedAt,
    })
    .onConflictDoUpdate({
      target: [connectionCursors.connectionId, connectionCursors.stream],
      set: {
        cursorValue: state.cursor ?? null,
        checkpoint: state.checkpoint,
        // A completed scan records when it completed; an interrupted one leaves
        // the previous completion time alone, because that is still the last
        // moment this stream was known in full.
        ...(state.completedAt === null ? {} : { lastCompleteAt: state.completedAt }),
        updatedAt: new Date(),
      },
    });
}

/**
 * Releases a run that a crashed worker left claimed.
 *
 * Without this, a process killed mid-import holds the stream's only running
 * slot forever and every later import reports "already running" — which looks
 * exactly like a busy system and is in fact a stuck one.
 */
export async function reclaimAbandonedRuns(db: Database, olderThan: Date): Promise<number> {
  const released = await db
    .update(importRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      failureSummary: 'the worker running this import stopped without finishing it',
    })
    .where(
      and(
        eq(importRuns.status, 'running'),
        isNull(importRuns.finishedAt),
        sql`${importRuns.startedAt} < ${olderThan}`,
      ),
    )
    .returning({ id: importRuns.id });

  return released.length;
}
