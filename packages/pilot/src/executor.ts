import type { Database } from '@eim/db';

/**
 * The narrowest thing this package needs to talk to the database.
 *
 * The same shape as the queue's executor, and for the same reason: every
 * recording function here is meant to be called from inside the transaction that
 * caused the thing it records. Accepting a transaction and a connection
 * interchangeably is what makes that possible without the caller having to know
 * which one it holds.
 */
export type PilotExecutor = Pick<Database, 'execute'>;
